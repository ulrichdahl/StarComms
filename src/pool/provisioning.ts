/**
 * Guild provisioning — the base setup that `/star-bridge init` performs.
 *
 * v1 design change (20 Aug 2026): voice channels are **not** created here.
 * Init only lays down the container structure — a category and a single
 * operations text channel where the session wizard is invoked from. Voice
 * nets are created on demand when a session opens (step 5b), sized and
 * named to the mode's callsigns from §17.2, and deleted at teardown.
 *
 * This supersedes the "hidden pool of N voice channels with hide/reveal
 * overwrites" model in §4 of the spec draft. The pool concept avoided
 * Discord's ~2 rename per 10 min PATCH limit (§4 risk box), but that
 * limit was only a problem if you renamed. Creating fresh channels per
 * session hits a different, much looser bucket and gives a cleaner UX:
 * nothing lingers in the sidebar between sessions.
 *
 * Idempotent: re-running init returns the existing category and control
 * channel unchanged. If either has been deleted by hand, this recreates
 * it. Never renames — the guild may rename the category freely without
 * this code fighting them.
 */

import {
  ChannelType, OverwriteType, PermissionFlagsBits,
  type CategoryChannel, type Guild, type TextChannel,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { FleetDefaults } from '../lib/config.js';

const CATEGORY_NAME = 'Star Bridge';
const CONTROL_CHANNEL_NAME = 'star-bridge-ops';

export interface InitSummary {
  guildId: string;
  guildName: string;
  categoryId: string;
  categoryCreated: boolean;
  controlChannelId: string;
  controlChannelCreated: boolean;
}

/**
 * Ensure the guild has a Star Bridge category and a control text channel
 * for slash-command invocations. Persists a `guilds` row on first run.
 */
export async function provisionGuild(
  guild: Guild,
  defaults: FleetDefaults,
  db: DB,
): Promise<InitSummary> {
  ensureGuildRow(db, guild, defaults);

  const { category, created: categoryCreated } = await ensureCategory(guild, db);
  const { channel, created: controlCreated } = await ensureControlChannel(guild, category, db);

  return {
    guildId: guild.id,
    guildName: guild.name,
    categoryId: category.id,
    categoryCreated,
    controlChannelId: channel.id,
    controlChannelCreated: controlCreated,
  };
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

async function ensureCategory(
  guild: Guild,
  db: DB,
): Promise<{ category: CategoryChannel; created: boolean }> {
  const row = db.prepare(`SELECT category_id FROM guilds WHERE id = ?`).get(guild.id) as
    { category_id: string | null } | undefined;
  if (row?.category_id !== null && row?.category_id !== undefined) {
    const existing = await guild.channels.fetch(row.category_id).catch(() => null);
    if (existing !== null && existing.type === ChannelType.GuildCategory) {
      return { category: existing, created: false };
    }
    db.prepare(`UPDATE guilds SET category_id = NULL WHERE id = ?`).run(guild.id);
  }

  const category = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: 'Star Bridge: init (category)',
  });
  db.prepare(`UPDATE guilds SET category_id = ? WHERE id = ?`).run(category.id, guild.id);
  return { category, created: true };
}

async function ensureControlChannel(
  guild: Guild,
  category: CategoryChannel,
  db: DB,
): Promise<{ channel: TextChannel; created: boolean }> {
  const row = db.prepare(`SELECT control_channel_id FROM guilds WHERE id = ?`).get(guild.id) as
    { control_channel_id: string | null } | undefined;
  if (row?.control_channel_id !== null && row?.control_channel_id !== undefined) {
    const existing = await guild.channels.fetch(row.control_channel_id).catch(() => null);
    if (existing !== null && existing.type === ChannelType.GuildText) {
      return { channel: existing, created: false };
    }
    db.prepare(`UPDATE guilds SET control_channel_id = NULL WHERE id = ?`).run(guild.id);
  }

  // Hidden from @everyone by default: only Manage-Guild users need to see the
  // ops console until the wizard opens sessions and posts mirror embeds
  // (§7). The wizard adjusts overwrites per session — this is just the base.
  const channel = await guild.channels.create({
    name: CONTROL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'Star Bridge operations console. Use /star-bridge here.',
    reason: 'Star Bridge: init (control channel)',
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });
  db.prepare(`UPDATE guilds SET control_channel_id = ? WHERE id = ?`).run(channel.id, guild.id);
  return { channel, created: true };
}
