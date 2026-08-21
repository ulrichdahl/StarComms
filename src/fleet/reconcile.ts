/**
 * Post-login reconciliation — the second half of the boot sweep.
 *
 * `bootSweep` runs before the fleet connects and can only count DB
 * rows; it cannot ask Discord whether a channel still exists. Once the
 * controller Client is ready, this pass:
 *
 *   • drops rows whose channel Discord no longer has,
 *   • deletes vessels that are currently empty on Discord — a previous
 *     process may have crashed before the 30 s empty-cleanup fired,
 *     leaving an orphan channel sitting empty. Reconciliation is that
 *     recovery.
 *
 * The heavy lifting is a pure function that takes a `probe(channelId)`
 * callable returning a small status — trivially testable with an
 * in-memory Map. `runReconciliation` is the thin wrapper that turns
 * the controller Client into such a probe.
 */

import type { Client, GuildBasedChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { DB } from '../lib/db.js';
import { reconcileChannelGone } from '../session/vessel.js';

export type ProbeStatus =
  | { kind: 'missing' }
  | { kind: 'occupied' }
  | { kind: 'empty'; delete: () => Promise<void> };

export interface ReconcileResult {
  vesselsChecked: number;
  vesselsMissing: number;
  vesselsDeletedEmpty: number;
}

/**
 * Pure reconciliation over the DB. `probe(channelId)` resolves to one
 * of `missing` / `occupied` / `empty`; the empty branch carries a
 * `delete` thunk the caller uses to remove the channel. Rejections are
 * treated as "unknown, do not touch" — we only act on rows we are
 * confident about.
 */
export async function reconcile(
  db: DB,
  probe: (channelId: string) => Promise<ProbeStatus>,
): Promise<ReconcileResult> {
  const rows = db.prepare(`
    SELECT channel_id FROM vessels WHERE deleted_at IS NULL
  `).all() as Array<{ channel_id: string }>;

  let missing = 0;
  let deletedEmpty = 0;
  for (const row of rows) {
    let status: ProbeStatus;
    try {
      status = await probe(row.channel_id);
    } catch {
      continue;
    }
    if (status.kind === 'missing') {
      reconcileChannelGone(db, row.channel_id);
      missing += 1;
      continue;
    }
    if (status.kind === 'empty') {
      try {
        await status.delete();
        reconcileChannelGone(db, row.channel_id);
        deletedEmpty += 1;
      } catch {
        // Delete failed (perm change, etc). Leave the row alone; the
        // vessel service's live listeners will pick it up if the state
        // changes later.
      }
    }
  }

  return {
    vesselsChecked: rows.length,
    vesselsMissing: missing,
    vesselsDeletedEmpty: deletedEmpty,
  };
}

/**
 * Wire `reconcile` to a live controller Client. Missing → Unknown
 * Channel (10003); Empty → voice channel with no non-bot members;
 * Occupied → anything else.
 */
export async function runReconciliation(db: DB, controller: Client): Promise<ReconcileResult> {
  return reconcile(db, async (channelId) => {
    let channel: GuildBasedChannel | null;
    try {
      channel = (await controller.channels.fetch(channelId)) as GuildBasedChannel | null;
    } catch (err) {
      if (isUnknownChannelError(err)) return { kind: 'missing' };
      throw err;
    }
    if (channel === null) return { kind: 'missing' };
    if (channel.type !== ChannelType.GuildVoice) {
      // A non-voice channel with this id means either a schema drift
      // or a channel replaced by hand. Treat as occupied — do not
      // touch it.
      return { kind: 'occupied' };
    }
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans > 0) return { kind: 'occupied' };
    return {
      kind: 'empty',
      delete: async () => {
        await channel!.delete('Star Comms: boot cleanup of empty vessel');
      },
    };
  });
}

function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 10003;
}
