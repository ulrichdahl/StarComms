/**
 * Channel pool provisioning — spec §4 & §16.5.
 *
 * On `/star-bridge init` we ensure that a guild has:
 *
 *   1. A "Star Bridge" category (created once, cached in `guilds.category_id`).
 *   2. One voice channel per fleet member (`Command Alfa`, `Command Bravo`, …)
 *      under that category, with the base permission overwrite set:
 *
 *        @everyone   →  DENY view_channel
 *        controller  →  ALLOW view_channel, manage_channels
 *        squad-k     →  ALLOW view_channel, connect, speak, priority_speaker
 *                        on channel k only
 *
 *      Humans are revealed at session open with a per-channel overwrite PATCH
 *      (§4). That is step 5b's job; step 5a establishes the base state.
 *
 *   3. A row in `guilds` capturing per-guild defaults.
 *   4. A row in `channel_pool` per created channel.
 *
 * Idempotency matters: an operator running init twice must not create
 * duplicate channels. §4 hard constraint: channels must never be renamed
 * (Discord rate-limits channel PATCH to ~2 per 10 min). We check the
 * channel_pool row exists AND the channel still exists on the API before
 * deciding to skip; a missing channel (someone deleted it) is recreated.
 */

import {
  ChannelType, OverwriteType, PermissionFlagsBits,
  type CategoryChannel, type Client, type Guild,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { FleetDefaults, FleetMember } from '../lib/config.js';

const CATEGORY_NAME = 'Star Bridge';

/** Human-facing channel name for a nato. Never changed after creation (§4). */
export function channelName(nato: string): string {
  return `Command ${nato[0]?.toUpperCase() ?? ''}${nato.slice(1)}`;
}

export interface ProvisionSummary {
  guildId: string;
  guildName: string;
  categoryId: string;
  created: { nato: string; channelId: string; name: string }[];
  reused: { nato: string; channelId: string; name: string }[];
  errors: { nato: string; message: string }[];
}

/**
 * Provision the pool for `guild`, given the fleet. `controllerClient` is
 * the client that will perform the Discord operations — it holds
 * MANAGE_CHANNELS/MANAGE_ROLES. `squadUserIds` maps nato → user id so we
 * can grant per-channel access to the squad member that will fly it.
 */
export async function provisionGuild(
  guild: Guild,
  controllerClient: Client,
  squadUserIds: Map<string, string>,
  fleet: readonly FleetMember[],
  defaults: FleetDefaults,
  db: DB,
): Promise<ProvisionSummary> {
  const summary: ProvisionSummary = {
    guildId: guild.id,
    guildName: guild.name,
    categoryId: '',
    created: [],
    reused: [],
    errors: [],
  };

  ensureGuildRow(db, guild, defaults);

  const category = await ensureCategory(guild, db);
  summary.categoryId = category.id;

  const controllerUserId = controllerClient.user?.id;
  if (controllerUserId === undefined) {
    throw new Error('provisioning: controller client has not reached ready');
  }

  for (const m of fleet) {
    try {
      const squadUserId = squadUserIds.get(m.nato);
      if (squadUserId === undefined) {
        summary.errors.push({ nato: m.nato, message: 'squad user id not resolved yet' });
        continue;
      }
      const result = await ensureVoiceChannel(
        guild, category, m.nato, controllerUserId, squadUserId, db,
      );
      (result.created ? summary.created : summary.reused).push({
        nato: m.nato, channelId: result.channel.id, name: result.channel.name,
      });
    } catch (err) {
      summary.errors.push({
        nato: m.nato,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function ensureGuildRow(db: DB, guild: Guild, defaults: FleetDefaults): void {
  const existing = db.prepare(`SELECT id FROM guilds WHERE id = ?`).get(guild.id);
  if (existing !== undefined) return;
  db.prepare(`
    INSERT INTO guilds (
      id, name, added_at, added_by, slot_quota, status, mode_default, locale,
      mute_mode, stt_driver, cue_set, cue_duration_ms, open_timeout_ms,
      silence_close_ms, max_hold_ms, close_cue_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guild.id,
    guild.name,
    Date.now(),
    guild.ownerId ?? 'unknown',
    3,               // slot_quota — default to build-against N=3 per spec §2
    'active',
    'command',       // mode_default
    defaults.locale,
    defaults.muteMode,
    defaults.sttDriver,
    defaults.cueSet,
    defaults.cueDurationMs,
    defaults.openTimeoutMs,
    defaults.silenceCloseMs,
    defaults.maxHoldMs,
    defaults.closeCueEnabled ? 1 : 0,
  );
}

async function ensureCategory(guild: Guild, db: DB): Promise<CategoryChannel> {
  const row = db.prepare(`SELECT category_id FROM guilds WHERE id = ?`).get(guild.id) as
    { category_id: string | null } | undefined;
  if (row?.category_id !== null && row?.category_id !== undefined) {
    const existing = await guild.channels.fetch(row.category_id).catch(() => null);
    if (existing !== null && existing.type === ChannelType.GuildCategory) {
      return existing;
    }
    // Category row exists but the actual channel was deleted; fall through
    // and recreate. Clear the stale id first.
    db.prepare(`UPDATE guilds SET category_id = NULL WHERE id = ?`).run(guild.id);
  }

  const category = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: 'Star Bridge: pool provisioning (§4)',
  });
  db.prepare(`UPDATE guilds SET category_id = ? WHERE id = ?`).run(category.id, guild.id);
  return category;
}

async function ensureVoiceChannel(
  guild: Guild,
  category: CategoryChannel,
  nato: string,
  controllerUserId: string,
  squadUserId: string,
  db: DB,
): Promise<{ channel: { id: string; name: string }; created: boolean }> {
  const row = db.prepare(
    `SELECT channel_id FROM channel_pool WHERE guild_id = ? AND nato = ?`,
  ).get(guild.id, nato) as { channel_id: string } | undefined;

  if (row !== undefined) {
    const existing = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (existing !== null && existing.type === ChannelType.GuildVoice) {
      return { channel: { id: existing.id, name: existing.name }, created: false };
    }
    // Row exists but the channel was deleted out from under us. Recreate.
    db.prepare(
      `DELETE FROM channel_pool WHERE guild_id = ? AND nato = ?`,
    ).run(guild.id, nato);
  }

  // Overwrites are deliberately minimal. Discord's rule: you can only grant
  // permissions you hold yourself. If we grant SPEAK or PRIORITY_SPEAKER
  // here, the controller must also have those guild-wide — an unnecessary
  // scope expansion for the invite. Squad bots receive CONNECT/SPEAK from
  // their own guild-level bot permissions (see README squad invite URL);
  // this overwrite only needs to reveal the channel to squad-k and hide it
  // from everyone else. The controller has MANAGE_CHANNELS at guild level
  // so it needs no per-channel grant to modify the channel later.
  //
  // controllerUserId is retained in the signature because we may reintroduce
  // an explicit controller overwrite when the wizard needs to hide/reveal
  // the channel — step 5b.
  void controllerUserId;
  const created = await guild.channels.create({
    name: channelName(nato),
    type: ChannelType.GuildVoice,
    parent: category.id,
    reason: `Star Bridge: pool provisioning for ${nato} (§4)`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: squadUserId,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });

  db.prepare(`
    INSERT INTO channel_pool (guild_id, nato, channel_id, kind)
    VALUES (?, ?, ?, ?)
  `).run(guild.id, nato, created.id, 'squad');

  return { channel: { id: created.id, name: created.name }, created: true };
}
