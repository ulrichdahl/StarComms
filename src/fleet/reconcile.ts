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
  log: (msg: string) => void = () => {},
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
    } catch (err) {
      log(`reconcile: probe threw for ${row.channel_id}: ${errMsg(err)} — leaving row alone`);
      continue;
    }
    if (status.kind === 'missing') {
      log(`reconcile: ${row.channel_id} missing on Discord — dropping row`);
      reconcileChannelGone(db, row.channel_id);
      missing += 1;
      continue;
    }
    if (status.kind === 'occupied') {
      log(`reconcile: ${row.channel_id} occupied — keeping`);
      continue;
    }
    // empty
    try {
      await status.delete();
      reconcileChannelGone(db, row.channel_id);
      log(`reconcile: ${row.channel_id} empty — deleted`);
      deletedEmpty += 1;
    } catch (err) {
      log(`reconcile: ${row.channel_id} empty but delete FAILED: ${errMsg(err)} — leaving row alone`);
    }
  }

  return {
    vesselsChecked: rows.length,
    vesselsMissing: missing,
    vesselsDeletedEmpty: deletedEmpty,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wire `reconcile` to a live controller Client. Missing → Unknown
 * Channel (10003); Empty → voice channel with no non-bot members;
 * Occupied → anything else.
 */
export async function runReconciliation(db: DB, controller: Client): Promise<ReconcileResult> {
  return reconcile(db, async (channelId) => {
    // GUILD_CREATE hydrates `guild.channels.cache` and
    // `guild.voiceStates.cache` for every channel the bot has View
    // on. Prefer that over a REST fetch — a REST fetch on a channel
    // whose member-overwrite View grant was silently dropped by
    // Discord (category-level @everyone deny bypasses the child's
    // member allow in some setups) returns 50001, and the row would
    // then be treated as unknown even though we have full local
    // information about it.
    const row = db.prepare(
      `SELECT guild_id FROM vessels WHERE channel_id = ? AND deleted_at IS NULL`,
    ).get(channelId) as { guild_id: string } | undefined;
    if (row !== undefined) {
      const guild = controller.guilds.cache.get(row.guild_id);
      if (guild !== undefined) {
        const cached = guild.channels.cache.get(channelId);
        if (cached !== undefined) {
          return probeFromCached(cached as GuildBasedChannel);
        }
      }
    }

    // Not in the guild cache — REST fetch as a fallback. Missing
    // Access here means the channel exists but the controller cannot
    // see it: report unknown (probe throws), which the caller logs
    // and leaves the row alone.
    let fetched: GuildBasedChannel | null;
    try {
      fetched = (await controller.channels.fetch(channelId)) as GuildBasedChannel | null;
    } catch (err) {
      if (isUnknownChannelError(err)) return { kind: 'missing' };
      throw err;
    }
    if (fetched === null) return { kind: 'missing' };
    return probeFromCached(fetched);
  }, (msg) => console.log(msg));
}

function probeFromCached(channel: GuildBasedChannel): ProbeStatus {
  if (channel.type !== ChannelType.GuildVoice) return { kind: 'occupied' };
  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans > 0) return { kind: 'occupied' };
  return {
    kind: 'empty',
    delete: async () => {
      await channel.delete('Star Comms: boot cleanup of empty vessel');
    },
  };
}

function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 10003;
}
