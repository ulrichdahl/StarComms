/**
 * Callsign registry — Spec 1.0 §5.
 *
 * Per-member, guild-scoped ship names. One row per (guild, member); a
 * callsign is unique per guild. Registration is orthogonal to vessel
 * ownership — a member registers once and can go through many vessels
 * over time without re-typing.
 *
 * Unregistering also drops the member's `hail_registry` rows (via the
 * vessels join), so any vessel they own stops being hailable the moment
 * they retire their callsign.
 */

import type { DB } from '../lib/db.js';

export const CALLSIGN_MIN = 2;
export const CALLSIGN_MAX = 24;

/** Discord channel names cap at 100 chars, but we prepend `🛰️ ` — 24 keeps things readable. */
const CALLSIGN_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '_-]*[\p{L}\p{N}]$/u;

/**
 * Why a callsign was refused. The message on the Error is English for
 * logs; handlers render the user-facing text from the guild's string
 * table via `code` + `callsign`.
 */
export type CallsignErrorCode = 'too_short' | 'too_long' | 'pattern' | 'taken';

export class CallsignError extends Error {
  constructor(
    message: string,
    readonly code: CallsignErrorCode,
    /** The offending callsign, present for `taken`. */
    readonly callsign: string | null = null,
  ) { super(message); this.name = 'CallsignError'; }
}

export interface CallsignRow {
  callsign: string;
  registered_at: number;
}

/** Sanity-check the shape only; server-side uniqueness is enforced by the DB. */
export function validateCallsign(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < CALLSIGN_MIN) {
    throw new CallsignError(`callsign must be at least ${CALLSIGN_MIN} characters`, 'too_short');
  }
  if (trimmed.length > CALLSIGN_MAX) {
    throw new CallsignError(`callsign must be at most ${CALLSIGN_MAX} characters`, 'too_long');
  }
  if (!CALLSIGN_PATTERN.test(trimmed)) {
    throw new CallsignError(
      'callsign may contain letters, numbers, spaces, hyphens, underscores and apostrophes only, and must start and end with a letter or number',
      'pattern',
    );
  }
  return trimmed;
}

/** Register or replace the caller's callsign. Throws CallsignError on conflict / invalid. */
export function registerCallsign(
  db: DB, guildId: string, userId: string, raw: string,
): string {
  const callsign = validateCallsign(raw);
  const conflict = db.prepare(
    `SELECT user_id FROM callsigns WHERE guild_id = ? AND callsign = ? COLLATE NOCASE AND user_id != ?`,
  ).get(guildId, callsign, userId) as { user_id: string } | undefined;
  if (conflict !== undefined) {
    throw new CallsignError(`callsign "${callsign}" is already registered by another member in this guild`, 'taken', callsign);
  }
  db.prepare(`
    INSERT INTO callsigns (guild_id, user_id, callsign, registered_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      callsign = excluded.callsign,
      registered_at = excluded.registered_at
  `).run(guildId, userId, callsign, Date.now());
  return callsign;
}

/**
 * Remove the caller's callsign. Cascades: drops hail_registry rows for
 * any vessel the caller owns so their vessels stop being hailable.
 * Returns the callsign that was removed, or null if none was registered.
 */
export function unregisterCallsign(
  db: DB, guildId: string, userId: string,
): string | null {
  const row = db.prepare(
    `SELECT callsign FROM callsigns WHERE guild_id = ? AND user_id = ?`,
  ).get(guildId, userId) as { callsign: string } | undefined;
  if (row === undefined) return null;

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM hail_registry
      WHERE channel_id IN (
        SELECT channel_id FROM vessels
        WHERE guild_id = ? AND owner_user_id = ? AND deleted_at IS NULL
      )
    `).run(guildId, userId);
    db.prepare(`DELETE FROM callsigns WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
  });
  tx();
  return row.callsign;
}

/** Look up the caller's current callsign. */
export function getCallsign(
  db: DB, guildId: string, userId: string,
): CallsignRow | null {
  const row = db.prepare(
    `SELECT callsign, registered_at FROM callsigns WHERE guild_id = ? AND user_id = ?`,
  ).get(guildId, userId) as CallsignRow | undefined;
  return row ?? null;
}
