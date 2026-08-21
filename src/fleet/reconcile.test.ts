import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { reconcile } from './reconcile.js';

function seedVessel(
  db: ReturnType<typeof openDb>,
  channelId: string,
  guildId = 'g1',
  ownerUserId = 'u1',
): void {
  db.prepare(
    `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(guildId, channelId, ownerUserId, 1);
}

function seedRegistry(
  db: ReturnType<typeof openDb>,
  channelId: string,
  guildId = 'g1',
  callsign = 'Firefly',
): void {
  db.prepare(
    `INSERT INTO hail_registry (channel_id, guild_id, callsign, registered_at)
     VALUES (?, ?, ?, ?)`,
  ).run(channelId, guildId, callsign, 1);
}

describe('reconcile', () => {
  it('leaves rows alone when their channels still exist', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chA');
    seedRegistry(db, 'chA');
    const result = await reconcile(db, async () => true);
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 0 });

    const vessel = db.prepare(
      `SELECT deleted_at FROM vessels WHERE channel_id = ?`,
    ).get('chA') as { deleted_at: number | null };
    expect(vessel.deleted_at).toBeNull();
    const registry = db.prepare(
      `SELECT COUNT(*) AS c FROM hail_registry WHERE channel_id = ?`,
    ).get('chA') as { c: number };
    expect(registry.c).toBe(1);
    db.close();
  });

  it('drops hail_registry + marks vessel deleted for missing channels', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chGone');
    seedRegistry(db, 'chGone');
    const result = await reconcile(db, async () => false);
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 1 });

    const vessel = db.prepare(
      `SELECT deleted_at FROM vessels WHERE channel_id = ?`,
    ).get('chGone') as { deleted_at: number | null };
    expect(vessel.deleted_at).not.toBeNull();
    const registry = db.prepare(
      `SELECT COUNT(*) AS c FROM hail_registry WHERE channel_id = ?`,
    ).get('chGone') as { c: number };
    expect(registry.c).toBe(0);
    db.close();
  });

  it('ignores channels whose probe threw (leaves the row alone)', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chUnknown');
    seedRegistry(db, 'chUnknown');
    const result = await reconcile(db, async () => { throw new Error('timeout'); });
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 0 });

    const vessel = db.prepare(
      `SELECT deleted_at FROM vessels WHERE channel_id = ?`,
    ).get('chUnknown') as { deleted_at: number | null };
    expect(vessel.deleted_at).toBeNull();
    db.close();
  });

  it('skips already-deleted vessels', async () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('g1', 'chOld', 'u1', 1, 2);
    seedVessel(db, 'chLive');
    const probed: string[] = [];
    const result = await reconcile(db, async (id) => { probed.push(id); return true; });
    expect(probed).toEqual(['chLive']);
    expect(result.vesselsChecked).toBe(1);
    db.close();
  });

  it('is idempotent — a second pass over the same state is a no-op', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chGone');
    seedRegistry(db, 'chGone');
    await reconcile(db, async () => false);
    const second = await reconcile(db, async () => false);
    // The row is deleted_at set, so the second pass sees no live rows.
    expect(second).toEqual({ vesselsChecked: 0, vesselsMissing: 0 });
    db.close();
  });

  it('handles mixed present/missing channels in one pass', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chA');
    seedVessel(db, 'chGone');
    seedVessel(db, 'chB');
    seedRegistry(db, 'chGone');
    const alive = new Set(['chA', 'chB']);
    const result = await reconcile(db, async (id) => alive.has(id));
    expect(result).toEqual({ vesselsChecked: 3, vesselsMissing: 1 });

    const survivors = db.prepare(
      `SELECT channel_id FROM vessels WHERE deleted_at IS NULL ORDER BY channel_id`,
    ).all() as Array<{ channel_id: string }>;
    expect(survivors.map((r) => r.channel_id)).toEqual(['chA', 'chB']);
    db.close();
  });
});
