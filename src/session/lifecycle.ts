/**
 * Session lifecycle — open and close.
 *
 * Open (spec §8):
 *   1. Refuse if the guild already has an unfinished session.
 *   2. Refuse if the invoker is not currently in a voice channel — a
 *      commander who is not in voice cannot be MOVE_MEMBER'd into the
 *      command net, and starting a session without moving them is
 *      confusing (the wizard finished but nothing visibly happened).
 *   3. Create one voice channel per net in the mode's callsign order,
 *      under the guild's Star Bridge category (populated by init).
 *   4. Insert a `sessions` row + one `session_nets` row per created net.
 *   5. Have each assigned bot join its channel — main into the primary,
 *      squad members in fleet order into the rest.
 *   6. MOVE_MEMBERS the invoker into the primary channel.
 *
 * Close (spec §8):
 *   1. Fetch the guild's open session and its nets.
 *   2. Move any humans still in the voice channels to the guild's AFK
 *      channel (if configured) — never leave a member stranded in a
 *      channel we are about to delete.
 *   3. Destroy each net's VoiceConnection (deliberate teardown — the
 *      "never destroy on transient" rule from CLAUDE.md is about network
 *      flaps, not session end).
 *   4. Delete the voice channels.
 *   5. Mark the session `ended_at` and clear `teardown_at`.
 *
 * Neither this module nor `provisioning.ts` touches the channel_pool
 * table: v1 creates and deletes per session (CLAUDE.md divergence note).
 */

import {
  ChannelType, PermissionFlagsBits,
  type CategoryChannel, type Client, type Guild, type VoiceBasedChannel,
} from 'discord.js';
import {
  VoiceConnectionStatus, entersState, joinVoiceChannel, getVoiceConnection,
  type VoiceConnection,
} from '@discordjs/voice';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import { netsFor, type NetRole, type NetSpec, type SessionMode, type SessionNet } from './model.js';

export interface OpenResult {
  sessionId: number;
  guildId: string;
  mode: SessionMode;
  ownerId: string;
  nets: SessionNet[];
}

export interface CloseResult {
  sessionId: number;
  netsClosed: number;
  strandedMoved: number;
}

/** Public error class so the interaction handler can format cleanly. */
export class SessionError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionError'; }
}

export async function openSession(args: {
  guild: Guild;
  ownerId: string;
  mode: SessionMode;
  squads: number;
  fleet: Fleet;
  db: DB;
}): Promise<OpenResult> {
  const { guild, ownerId, mode, squads, fleet, db } = args;

  const existing = db.prepare(
    `SELECT id FROM sessions WHERE guild_id = ? AND ended_at IS NULL`,
  ).get(guild.id) as { id: number } | undefined;
  if (existing !== undefined) {
    throw new SessionError(`a session is already open in this guild (id=${existing.id}). Close it first.`);
  }

  const category = await categoryFor(guild, db);

  const ownerMember = await guild.members.fetch(ownerId).catch(() => null);
  if (ownerMember === null) {
    throw new SessionError('could not resolve the invoker in this guild');
  }
  if (ownerMember.voice.channelId === null) {
    throw new SessionError('join a voice channel first, then run /star-bridge open — we cannot move you into the command net from outside voice.');
  }

  const specs = netsFor(mode, squads);
  const nets: SessionNet[] = [];

  // Create the channels first, before any DB inserts, so a failure mid-way
  // leaves no half-inserted session row. Individual channel-create failures
  // are surfaced as a SessionError with partial cleanup.
  const created: VoiceBasedChannel[] = [];
  try {
    for (const spec of specs) {
      const channel = await guild.channels.create({
        name: spec.callsign,
        type: ChannelType.GuildVoice,
        parent: category.id,
        reason: `Star Bridge session (${mode})`,
      });
      created.push(channel);
      nets.push({ ...spec, channelId: channel.id });
    }
  } catch (err) {
    // Best-effort cleanup: delete anything we did create before rethrowing.
    for (const c of created) await c.delete('Star Bridge session open failed').catch(() => {});
    throw new SessionError(`channel create failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const insertSession = db.prepare(
    `INSERT INTO sessions (guild_id, mode, lead_user_id, started_at, mute_others)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertNet = db.prepare(
    `INSERT INTO session_nets (session_id, nato, channel_id, bot_id, role)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const info = insertSession.run(guild.id, mode, ownerId, Date.now(), 0);
  const sessionId = Number(info.lastInsertRowid);
  for (const n of nets) {
    insertNet.run(sessionId, n.callsign.toLowerCase().replace(/\s+/g, '-'), n.channelId, n.botKey, n.role as NetRole);
  }

  // Join each assigned bot into its channel. Failures here do not roll back
  // — a squad bot that failed to join will show up in /healthz and can be
  // repaired by /star-bridge close and re-open. Fail-hard was worse: it
  // left the operator with channels they could see but no bot presence, and
  // no way to close cleanly.
  for (const net of nets) {
    const client = clientForBotKey(fleet, net.botKey);
    const channel = created.find((c) => c.id === net.channelId);
    if (channel === undefined) continue;
    try {
      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: selfDeafFor(net.role),
        selfMute: false,           // never selfMute — must be able to play cues
        group: requireUserId(client, net.botKey),
      });
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      console.error(`session ${sessionId}: ${net.botKey} failed to join ${net.callsign}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Move the owner into the primary net. Requires MOVE_MEMBERS on the
  // controller (part of the invite scope in the README).
  const primary = nets[0];
  if (primary !== undefined) {
    try {
      await ownerMember.voice.setChannel(primary.channelId, `Star Bridge: session ${sessionId} owner`);
    } catch (err) {
      console.error(`session ${sessionId}: MOVE_MEMBERS failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { sessionId, guildId: guild.id, mode, ownerId, nets };
}

export async function closeSession(args: {
  guild: Guild;
  fleet: Fleet;
  db: DB;
}): Promise<CloseResult> {
  const { guild, fleet, db } = args;

  const row = db.prepare(
    `SELECT id FROM sessions WHERE guild_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
  ).get(guild.id) as { id: number } | undefined;
  if (row === undefined) {
    throw new SessionError('no session is open in this guild');
  }
  const sessionId = row.id;

  const netRows = db.prepare(
    `SELECT nato, channel_id, bot_id FROM session_nets WHERE session_id = ?`,
  ).all(sessionId) as { nato: string; channel_id: string; bot_id: string }[];

  let strandedMoved = 0;
  const afkChannelId = guild.afkChannelId;

  for (const nr of netRows) {
    const channel = await guild.channels.fetch(nr.channel_id).catch(() => null);
    if (channel !== null && channel.type === ChannelType.GuildVoice) {
      // Move any humans still in the channel to AFK if configured. Bots
      // are also in the channel but they leave via VoiceConnection.destroy
      // just below.
      if (afkChannelId !== null) {
        for (const [uid, member] of channel.members) {
          if (member.user.bot) continue;
          if (uid === (await guild.members.fetch(uid).catch(() => null))?.id) {
            try {
              await member.voice.setChannel(afkChannelId, `Star Bridge: session ${sessionId} close`);
              strandedMoved++;
            } catch { /* fall through */ }
          }
        }
      }
    }

    // Destroy the assigned bot's VoiceConnection for this guild.
    const client = clientForBotKey(fleet, nr.bot_id as 'main' | 'alfa' | 'bravo' | 'charlie');
    const group = client.user?.id;
    if (group !== undefined) {
      const conn = getVoiceConnection(guild.id, group) as VoiceConnection | undefined;
      conn?.destroy();
    }

    if (channel !== null) {
      await channel.delete(`Star Bridge: session ${sessionId} close`).catch(() => {});
    }
  }

  db.prepare(`UPDATE sessions SET ended_at = ?, teardown_at = NULL WHERE id = ?`)
    .run(Date.now(), sessionId);

  return { sessionId, netsClosed: netRows.length, strandedMoved };
}

// ---------------------------------------------------------------------------

function selfDeafFor(role: NetRole): boolean {
  // §3: selfDeaf on send-only squad nets; primary nets receive.
  // Joint-ops nets receive too. Only command mode's squad nets are deaf.
  return role === 'squad';
}

function clientForBotKey(fleet: Fleet, key: 'main' | 'alfa' | 'bravo' | 'charlie'): Client {
  return key === 'main' ? fleet.controllerClient() : fleet.clientFor(key);
}

function requireUserId(client: Client, label: string): string {
  const id = client.user?.id;
  if (id === undefined) throw new SessionError(`bot ${label} has not reached ready`);
  return id;
}

async function categoryFor(guild: Guild, db: DB): Promise<CategoryChannel> {
  const row = db.prepare(`SELECT category_id FROM guilds WHERE id = ?`).get(guild.id) as
    { category_id: string | null } | undefined;
  if (row?.category_id === null || row?.category_id === undefined) {
    throw new SessionError('this guild has not been initialised — run /star-bridge init first.');
  }
  const c = await guild.channels.fetch(row.category_id).catch(() => null);
  if (c === null || c.type !== ChannelType.GuildCategory) {
    throw new SessionError('Star Bridge category was deleted — run /star-bridge init again.');
  }
  // Sanity-check: controller must actually be able to manage this category.
  // Without ManageChannels here we would fail at create with a confusing
  // Discord error; better to fail early with a readable message.
  const me = await guild.members.fetchMe();
  if (!me.permissionsIn(c).has(PermissionFlagsBits.ManageChannels)) {
    throw new SessionError('controller lacks MANAGE_CHANNELS on the Star Bridge category.');
  }
  return c;
}
