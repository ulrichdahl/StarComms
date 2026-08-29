/**
 * Small DB helpers for the per-guild config row.
 *
 * `guilds` carries what the operator sets via `/star-comms watch-channel`
 * and `/star-comms set-language` plus
 * every timing/locale default that the fleet.yaml provides. Every
 * downstream module (vessel creation, hail flow, boot sweep) reads
 * from this table; only two places write to it — this file, from the
 * admin subcommands, and boot sweep on a schema migration.
 */

import type { DB } from '../lib/db.js';
import { isLocale, type FleetDefaults, type Locale } from '../lib/config.js';

/**
 * Insert the guild's row with fleet-configured defaults, if it does
 * not already exist. Callers may then UPDATE individual columns (see
 * `setJoinToCreateChannel`).
 */
export function ensureGuildRow(
  db: DB,
  guild: { id: string; name: string; ownerId: string | null },
  defaults: FleetDefaults,
  addedBy: string,
): void {
  const existing = db.prepare(`SELECT id FROM guilds WHERE id = ?`).get(guild.id);
  if (existing !== undefined) return;
  db.prepare(`
    INSERT INTO guilds (
      id, name, added_at, added_by,
      locale, cue_set, cue_duration_ms,
      ring_interval_ms, ring_max_ms,
      hail_silence_close_ms, hail_max_hold_ms,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guild.id,
    guild.name,
    Date.now(),
    addedBy,
    defaults.locale,
    defaults.cueSet,
    defaults.cueDurationMs,
    defaults.ringIntervalMs,
    defaults.ringMaxMs,
    defaults.hailSilenceCloseMs,
    defaults.hailMaxHoldMs,
    'active',
  );
}

export function setJoinToCreateChannel(db: DB, guildId: string, channelId: string): void {
  db.prepare(`UPDATE guilds SET join_to_create_channel_id = ? WHERE id = ?`).run(channelId, guildId);
}

/**
 * The guild's language. Falls back to `fallback` when the guild has no
 * row yet (nothing configured) or the stored value is not a known
 * locale (fleet.yaml shrank its list). Every user-facing string and
 * every cue lookup goes through here.
 */
export function getGuildLocale(db: DB, guildId: string, fallback: Locale): Locale {
  const row = db.prepare(`SELECT locale FROM guilds WHERE id = ?`).get(guildId) as
    | { locale: string } | undefined;
  return row !== undefined && isLocale(row.locale) ? row.locale : fallback;
}

export function setGuildLocale(db: DB, guildId: string, locale: Locale): void {
  db.prepare(`UPDATE guilds SET locale = ? WHERE id = ?`).run(locale, guildId);
}

export function getJoinToCreateChannel(db: DB, guildId: string): string | null {
  const row = db.prepare(
    `SELECT join_to_create_channel_id FROM guilds WHERE id = ?`,
  ).get(guildId) as { join_to_create_channel_id: string | null } | undefined;
  return row?.join_to_create_channel_id ?? null;
}
