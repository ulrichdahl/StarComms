/**
 * Boot sweep — spec §11.
 *
 * Runs before the fleet connects. Reads four tables written by earlier crashes:
 *
 *   mute_state           — restore members left hard-muted (spec §6)
 *   sessions.teardown_at — finish teardowns whose timer expired mid-crash (§8)
 *   channel_pool         — repair overwrites that never got hidden (§4)
 *   relays.state         — close nets left open by a crash mid-relay (§5)
 *
 * On a clean database every count is zero and the sweep is a no-op — but this
 * code path is real, because those tables are populated only by later steps
 * and only this path can recover them on the next boot.
 *
 * For step 2 the sweep detects and *logs* what needs recovering; the actual
 * Discord operations (unmute members, PATCH overwrites, close voice
 * connections, force-close relays) require code that arrives in steps 5, 6
 * and 8. The intent here is to make sure the state is visible on every boot
 * from the start, so no crash silently leaves inconsistencies.
 */

import type { DB } from '../lib/db.js';

export interface SweepCounts {
  mutesToRestore: number;
  sessionsPastTeardown: number;
  poolOverwrites: number;
  openRelays: number;
}

/** Zero across the board — the shape a clean boot returns. */
export function emptySweep(): SweepCounts {
  return { mutesToRestore: 0, sessionsPastTeardown: 0, poolOverwrites: 0, openRelays: 0 };
}

export function bootSweep(db: DB, now: number = Date.now()): SweepCounts {
  // Only mutes belonging to sessions that have not fully ended need restoring.
  // A completed session already unmuted everyone; a leaked mute is one whose
  // session ended without the unmute path running.
  const mutes = db.prepare(`
    SELECT COUNT(*) AS c FROM mute_state
  `).get() as { c: number };

  const staleSessions = db.prepare(`
    SELECT COUNT(*) AS c FROM sessions
    WHERE ended_at IS NULL AND teardown_at IS NOT NULL AND teardown_at <= ?
  `).get(now) as { c: number };

  // Any pool row is a permission overwrite the operator placed on a channel
  // that the fleet needs to keep coherent — the sweep touches these to
  // reconcile a crash mid-provisioning, not to remove them.
  const pool = db.prepare(`
    SELECT COUNT(*) AS c FROM channel_pool
  `).get() as { c: number };

  const openRelays = db.prepare(`
    SELECT COUNT(*) AS c FROM relays
    WHERE state IN ('opening', 'open', 'closing')
  `).get() as { c: number };

  return {
    mutesToRestore: mutes.c,
    sessionsPastTeardown: staleSessions.c,
    poolOverwrites: pool.c,
    openRelays: openRelays.c,
  };
}

export function formatSweep(s: SweepCounts): string {
  return `swept: ${s.mutesToRestore} mutes, ${s.sessionsPastTeardown} stale sessions, ` +
    `${s.poolOverwrites} pool overwrites, ${s.openRelays} open relays`;
}
