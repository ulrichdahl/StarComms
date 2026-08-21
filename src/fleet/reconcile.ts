/**
 * Post-login reconciliation — the second half of the boot sweep.
 *
 * `bootSweep` runs before the fleet connects and can only count DB
 * rows; it cannot ask Discord whether a channel still exists. Once the
 * controller Client is ready, this pass fetches each tracked vessel
 * channel and drops rows for channels that Discord no longer has.
 *
 * The heavy lifting is a pure function that takes a `probe(channelId)`
 * callable returning a boolean — makes the DB half trivially testable
 * with an in-memory Map. `runReconciliation` is the thin wrapper that
 * turns the controller Client into such a probe.
 */

import type { Client } from 'discord.js';
import type { DB } from '../lib/db.js';
import { reconcileChannelGone } from '../session/vessel.js';

export interface ReconcileResult {
  vesselsChecked: number;
  vesselsMissing: number;
}

/**
 * Pure reconciliation over the DB. `probe(channelId)` should resolve
 * `true` if the channel still exists on Discord, `false` if it does
 * not, and reject if the probe itself failed (network etc.). Rejections
 * are treated as "unknown, do not drop" — we only remove rows we are
 * confident are gone.
 */
export async function reconcile(
  db: DB,
  probe: (channelId: string) => Promise<boolean>,
): Promise<ReconcileResult> {
  const rows = db.prepare(`
    SELECT channel_id FROM vessels WHERE deleted_at IS NULL
  `).all() as Array<{ channel_id: string }>;

  let missing = 0;
  for (const row of rows) {
    let exists: boolean;
    try {
      exists = await probe(row.channel_id);
    } catch {
      continue; // unknown, leave the row alone
    }
    if (!exists) {
      reconcileChannelGone(db, row.channel_id);
      missing += 1;
    }
  }

  return { vesselsChecked: rows.length, vesselsMissing: missing };
}

/**
 * Wire `reconcile` to a live controller Client. A channel fetch that
 * throws with the Discord "Unknown Channel" code is treated as the
 * channel being gone; anything else is treated as "unknown".
 */
export async function runReconciliation(db: DB, controller: Client): Promise<ReconcileResult> {
  return reconcile(db, async (channelId) => {
    try {
      const channel = await controller.channels.fetch(channelId);
      return channel !== null;
    } catch (err) {
      // Discord uses code 10003 for Unknown Channel. Any DiscordAPIError
      // carrying that code means the channel is really gone.
      if (isUnknownChannelError(err)) return false;
      throw err;
    }
  });
}

function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 10003;
}
