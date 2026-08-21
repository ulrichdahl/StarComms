/**
 * Boot sweep — Spec 1.0 §10.
 *
 * Runs before the fleet connects. Reads three tables that later steps
 * write into and reports what needs recovering:
 *
 *   active_hails   — rows without closed_at are force-closed with
 *                    close_reason = 'drain'. A crash mid-hail leaves
 *                    such a row; this is the recovery path.
 *   vessels        — rows whose channel_id no longer exists on Discord
 *                    should be marked deleted_at. Recovery requires the
 *                    fleet to be logged in, so this step only reports
 *                    the count; the actual Discord fetch happens later.
 *   hail_registry  — rows whose channel no longer exists should be
 *                    dropped. Same fetch caveat as vessels.
 *
 * On a fresh install every count is zero. The code path is real from
 * day one so a later crash finds a working recovery.
 */

import type { DB } from '../lib/db.js';

export interface SweepCounts {
  hailsForceClosed: number;
  vesselsPresent: number;
  registryEntries: number;
}

export function emptySweep(): SweepCounts {
  return { hailsForceClosed: 0, vesselsPresent: 0, registryEntries: 0 };
}

export function bootSweep(db: DB, now: number = Date.now()): SweepCounts {
  // Force-close any un-closed hails from a previous run. Runs synchronously
  // before any Discord I/O; no bot has connected yet, so nobody is affected
  // in-flight.
  const forceClose = db.prepare(`
    UPDATE active_hails
    SET closed_at = ?, close_reason = 'drain'
    WHERE closed_at IS NULL
  `).run(now);

  const vessels = db.prepare(`
    SELECT COUNT(*) AS c FROM vessels WHERE deleted_at IS NULL
  `).get() as { c: number };

  const registry = db.prepare(`
    SELECT COUNT(*) AS c FROM hail_registry
  `).get() as { c: number };

  return {
    hailsForceClosed: forceClose.changes,
    vesselsPresent: vessels.c,
    registryEntries: registry.c,
  };
}

export function formatSweep(s: SweepCounts): string {
  return `swept: ${s.hailsForceClosed} hails force-closed, ` +
    `${s.vesselsPresent} vessel(s) present, ${s.registryEntries} hail registrations`;
}
