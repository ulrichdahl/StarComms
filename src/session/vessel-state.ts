/**
 * Read-side helpers for the vessel + control-panel state.
 *
 * Every button handler needs to know: is this the owner? is the vessel
 * currently locked? what user limit is set? is the vessel in the hail
 * directory? does the owner have a callsign to enable hails with? This
 * module bundles those questions into a single lookup keyed by the
 * vessel's channel id.
 */

import type { DB } from '../lib/db.js';

export interface VesselState {
  vesselId: number;
  guildId: string;
  channelId: string;
  ownerUserId: string;
  locked: boolean;
  userLimit: number;
  hailsEnabled: boolean;
  /** Present when the owner has a callsign registered in this guild. */
  callsign: string | null;
}

export function getVesselState(db: DB, channelId: string): VesselState | null {
  const vessel = db.prepare(`
    SELECT id, guild_id, channel_id, owner_user_id, locked, user_limit
    FROM vessels
    WHERE channel_id = ? AND deleted_at IS NULL
  `).get(channelId) as
    | { id: number; guild_id: string; channel_id: string; owner_user_id: string;
        locked: number; user_limit: number }
    | undefined;
  if (vessel === undefined) return null;

  const hail = db.prepare(
    `SELECT 1 AS present FROM hail_registry WHERE channel_id = ?`,
  ).get(channelId) as { present: number } | undefined;

  const callsign = db.prepare(
    `SELECT callsign FROM callsigns WHERE guild_id = ? AND user_id = ?`,
  ).get(vessel.guild_id, vessel.owner_user_id) as { callsign: string } | undefined;

  return {
    vesselId: vessel.id,
    guildId: vessel.guild_id,
    channelId: vessel.channel_id,
    ownerUserId: vessel.owner_user_id,
    locked: vessel.locked === 1,
    userLimit: vessel.user_limit,
    hailsEnabled: hail !== undefined,
    callsign: callsign?.callsign ?? null,
  };
}

export function setVesselLocked(db: DB, channelId: string, locked: boolean): void {
  db.prepare(`UPDATE vessels SET locked = ? WHERE channel_id = ?`).run(locked ? 1 : 0, channelId);
}

export function setVesselUserLimit(db: DB, channelId: string, limit: number): void {
  db.prepare(`UPDATE vessels SET user_limit = ? WHERE channel_id = ?`).run(limit, channelId);
}

export function registerVesselForHails(
  db: DB, channelId: string, guildId: string, callsign: string,
): void {
  db.prepare(`
    INSERT INTO hail_registry (channel_id, guild_id, callsign, registered_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET callsign = excluded.callsign, registered_at = excluded.registered_at
  `).run(channelId, guildId, callsign, Date.now());
}

export function unregisterVesselFromHails(db: DB, channelId: string): void {
  db.prepare(`DELETE FROM hail_registry WHERE channel_id = ?`).run(channelId);
}
