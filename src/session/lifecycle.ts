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
  ChannelType, OverwriteType, PermissionFlagsBits,
  type CategoryChannel, type Client, type Guild, type VoiceBasedChannel,
} from 'discord.js';
import {
  VoiceConnectionStatus, entersState, joinVoiceChannel, getVoiceConnection,
  type VoiceConnection,
} from '@discordjs/voice';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import { DetectionListener, type Detection } from '../detection/listener.js';
import type { SttDriver } from '../detection/stt.js';
import type { CueSet } from '../lib/cues.js';
import type { Locale } from '../detection/grammar.js';
import { netsFor, type NetRole, type NetSpec, type SessionMode, type SessionNet } from './model.js';
import { SessionRouter } from './router.js';

export type MoveOwnerResult =
  | { moved: true }
  | { moved: false; reason: string };

export interface OpenResult {
  sessionId: number;
  guildId: string;
  mode: SessionMode;
  ownerId: string;
  nets: SessionNet[];
  /** Whether the invoker was moved into the primary net, and why not if
   * skipped. Discord blocks bots from moving the guild owner regardless
   * of the bot's permissions, so this is a legitimate soft-fail. */
  moveOwner: MoveOwnerResult;
  /** Present when an STT driver was supplied — the detection listener on
   * the primary net. Held so closeSession can tear it down. */
  detection: DetectionListener | null;
}

/**
 * Per-session runtime state. `openSession` returns this via `OpenResult`
 * and stashes it in a module-scope map keyed by guildId; `closeSession`
 * looks it up. Kept out of SQLite because it holds live JS handles.
 */
interface SessionRuntime {
  sessionId: number;
  detection: DetectionListener | null;
  router: SessionRouter | null;
}
const runtime = new Map<string, SessionRuntime>();

/** Access the live detection listener for a guild's session, if any. */
export function detectionFor(guildId: string): DetectionListener | null {
  return runtime.get(guildId)?.detection ?? null;
}

/** Access the live router (auto-hail) for a guild's session, if any. */
export function routerFor(guildId: string): SessionRouter | null {
  return runtime.get(guildId)?.router ?? null;
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
  /** Optional in step 6a — when supplied, detection listens on the primary net. */
  stt?: SttDriver;
  /** Callback for every recognised utterance; step 6b routes these into the state machine. */
  onDetection?: (d: Detection) => void;
  /**
   * When supplied together with `stt`, the SessionRouter auto-opens a
   * route from the primary net to a recognised target callsign. Contains
   * the cue set + locale (per-guild) + timers.
   */
  autoHail?: { cues: CueSet; locale: Locale };
}): Promise<OpenResult> {
  const { guild, ownerId, mode, squads, fleet, db, stt, onDetection, autoHail } = args;

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

  // Resolve every assigned bot's user id up front so we can attach explicit
  // permission overwrites on each session channel. That protects us against a
  // category inherited from an earlier design that had @everyone deny
  // VIEW_CHANNEL — the child channel's per-member allow trumps category deny.
  const assignedUserIds = new Map<string, string>();
  for (const spec of specs) {
    const client = clientForBotKey(fleet, spec.botKey);
    const id = client.user?.id;
    if (id !== undefined) assignedUserIds.set(spec.botKey, id);
  }

  // Create the channels first, before any DB inserts, so a failure mid-way
  // leaves no half-inserted session row. Individual channel-create failures
  // are surfaced as a SessionError with partial cleanup.
  const created: VoiceBasedChannel[] = [];
  try {
    for (const spec of specs) {
      const botUserId = assignedUserIds.get(spec.botKey);
      const overwrites = botUserId === undefined ? [] : [
        {
          id: botUserId,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        },
        // Give the session owner an explicit allow too. If a stale category
        // inherits deny VIEW_CHANNEL from an earlier design, the owner would
        // be moved into an invisible channel — a confusing UX. This is a no-op
        // when the category is transparent.
        {
          id: ownerId,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        },
      ];
      const channel = await guild.channels.create({
        name: spec.callsign,
        type: ChannelType.GuildVoice,
        parent: category.id,
        reason: `Star Bridge session (${mode})`,
        permissionOverwrites: overwrites,
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

  // Join each assigned bot into its channel. Adapter routing is subtle in
  // a multi-Client setup: the adapter binds to a specific Client's gateway
  // and only observes VOICE_SERVER_UPDATE + VOICE_STATE_UPDATE on that
  // Client's shard. If we passed the controller's adapter for alfa, alfa's
  // gateway events would never reach the connection and entersState would
  // fail with "The operation was aborted." Use the joining bot's own guild
  // view. See CLAUDE.md constraint on adapterCreator.
  //
  // Failures here do not roll back — a squad bot that failed to join will
  // show up in /healthz and can be repaired by /star-bridge close and
  // re-open. Fail-hard was worse: it left the operator with channels they
  // could see but no bot presence, and no way to close cleanly.
  for (const net of nets) {
    const client = clientForBotKey(fleet, net.botKey);
    const channel = created.find((c) => c.id === net.channelId);
    if (channel === undefined) continue;
    const botGuild = client.guilds.cache.get(guild.id)
      ?? await client.guilds.fetch(guild.id).catch(() => null);
    if (botGuild === null || botGuild === undefined) {
      console.error(`session ${sessionId}: ${net.botKey} is not in guild ${guild.id}, cannot join ${net.callsign}`);
      continue;
    }
    try {
      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: botGuild.voiceAdapterCreator,
        selfDeaf: selfDeafFor(net.role),
        selfMute: false,           // never selfMute — must be able to play cues
        group: requireUserId(client, net.botKey),
      });
      // Diagnostic logging — this bit us twice in step 5b. Leave in for now;
      // move to debug-only later.
      const tag = `[${net.botKey}/${net.callsign}]`;
      conn.on('stateChange', (from, to) => {
        const extra = 'reason' in to ? ` reason=${String((to as { reason: unknown }).reason)}` : '';
        console.log(`session ${sessionId} ${tag} ${from.status} -> ${to.status}${extra}`);
      });
      conn.on('error', (e) => console.error(`session ${sessionId} ${tag} error: ${e.message}`));
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      console.log(`session ${sessionId} ${tag} ready`);
    } catch (err) {
      console.error(`session ${sessionId}: ${net.botKey} failed to join ${net.callsign}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Move the owner into the primary net. Requires MOVE_MEMBERS on the
  // controller (part of the invite scope in the README) AND the target
  // must not be the guild owner — Discord protects the guild owner from
  // any bot-driven member modification, regardless of permissions or
  // Administrator status.
  const primary = nets[0];
  let moveOwner: MoveOwnerResult = { moved: false, reason: 'no primary net' };
  if (primary !== undefined) {
    if (ownerMember.id === guild.ownerId) {
      moveOwner = {
        moved: false,
        reason: 'you are the guild owner — Discord blocks bots from moving the guild owner. Join the primary net manually.',
      };
      console.warn(`session ${sessionId}: skipping MOVE_MEMBERS — invoker is the guild owner`);
    } else {
      try {
        await ownerMember.voice.setChannel(primary.channelId, `Star Bridge: session ${sessionId} owner`);
        moveOwner = { moved: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        moveOwner = { moved: false, reason };
        console.error(`session ${sessionId}: MOVE_MEMBERS failed: ${reason}`);
      }
    }
  }

  // Attach the detection listener to the primary net's VoiceConnection.
  // Only main's connection carries detection; squad nets are voice out-only
  // (§5). If no STT driver was supplied, skip — the fleet still opens
  // fine, just doesn't recognise call-ups yet.
  let detection: DetectionListener | null = null;
  let router: SessionRouter | null = null;
  if (stt !== undefined && primary !== undefined) {
    const mainUserId = fleet.controllerClient().user?.id;
    if (mainUserId !== undefined) {
      const conn = getVoiceConnection(guild.id, mainUserId) as VoiceConnection | undefined;
      if (conn !== undefined) {
        detection = new DetectionListener({
          connection: conn,
          stt,
          fleetUserIds: () => fleet.botUserIds(),
        });
        if (onDetection !== undefined) {
          detection.on('detection', onDetection);
        }
        console.log(`session ${sessionId}: detection attached to ${primary.callsign} (stt=${stt.name})`);

        // Auto-hail: recognised call-ups drive runSessionRelay without
        // waiting for /star-bridge hail. Requires stt + autoHail config.
        if (autoHail !== undefined) {
          const gRow = db.prepare(
            `SELECT silence_close_ms, max_hold_ms FROM guilds WHERE id = ?`,
          ).get(guild.id) as { silence_close_ms: number; max_hold_ms: number } | undefined;
          router = new SessionRouter({
            sessionId,
            guildId: guild.id,
            locale: autoHail.locale,
            fleet,
            nets,
            cues: autoHail.cues,
            db,
            silenceCloseMs: gRow?.silence_close_ms ?? 2000,
            maxHoldMs: gRow?.max_hold_ms ?? 60_000,
            detection,
          });
          console.log(`session ${sessionId}: auto-hail router armed (locale=${autoHail.locale})`);
        }
      }
    }
  }

  runtime.set(guild.id, { sessionId, detection, router });
  return { sessionId, guildId: guild.id, mode, ownerId, nets, moveOwner, detection };
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

  // Tear down router + detection first so no in-flight utterance tries to
  // route to channels we are about to delete.
  const rt = runtime.get(guild.id);
  if (rt !== undefined) {
    rt.router?.stop();
    rt.detection?.stop();
    runtime.delete(guild.id);
  }

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
