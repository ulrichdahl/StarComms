import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { reconcile, type ProbeStatus } from './reconcile.js';

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

const OCCUPIED: ProbeStatus = { kind: 'occupied' };
const MISSING: ProbeStatus = { kind: 'missing' };
function emptyProbe(onDelete?: () => void): ProbeStatus {
  return {
    kind: 'empty',
    delete: async () => { if (onDelete !== undefined) onDelete(); },
  };
}

describe('reconcile', () => {
  it('leaves rows alone when their channels are occupied', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chA');
    seedRegistry(db, 'chA');
    const result = await reconcile(db, async () => OCCUPIED);
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 0, vesselsDeletedEmpty: 0 });

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
    const result = await reconcile(db, async () => MISSING);
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 1, vesselsDeletedEmpty: 0 });

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

  it('deletes an orphan empty vessel + drops its registry row', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chEmpty');
    seedRegistry(db, 'chEmpty');
    let deletedCalled = false;
    const result = await reconcile(db, async () => emptyProbe(() => { deletedCalled = true; }));
    expect(deletedCalled).toBe(true);
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 0, vesselsDeletedEmpty: 1 });

    const vessel = db.prepare(
      `SELECT deleted_at FROM vessels WHERE channel_id = ?`,
    ).get('chEmpty') as { deleted_at: number | null };
    expect(vessel.deleted_at).not.toBeNull();
    const registry = db.prepare(
      `SELECT COUNT(*) AS c FROM hail_registry WHERE channel_id = ?`,
    ).get('chEmpty') as { c: number };
    expect(registry.c).toBe(0);
    db.close();
  });

  it('does not mark deleted if the delete thunk throws', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chStuck');
    const result = await reconcile(db, async () => ({
      kind: 'empty',
      delete: async () => { throw new Error('perm'); },
    }));
    expect(result.vesselsDeletedEmpty).toBe(0);

    const vessel = db.prepare(
      `SELECT deleted_at FROM vessels WHERE channel_id = ?`,
    ).get('chStuck') as { deleted_at: number | null };
    expect(vessel.deleted_at).toBeNull();
    db.close();
  });

  it('ignores channels whose probe threw (leaves the row alone)', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chUnknown');
    seedRegistry(db, 'chUnknown');
    const result = await reconcile(db, async () => { throw new Error('timeout'); });
    expect(result).toEqual({ vesselsChecked: 1, vesselsMissing: 0, vesselsDeletedEmpty: 0 });

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
    const result = await reconcile(db, async (id) => {
      probed.push(id);
      return OCCUPIED;
    });
    expect(probed).toEqual(['chLive']);
    expect(result.vesselsChecked).toBe(1);
    db.close();
  });

  it('is idempotent — a second pass over the same state is a no-op', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chGone');
    seedRegistry(db, 'chGone');
    await reconcile(db, async () => MISSING);
    const second = await reconcile(db, async () => MISSING);
    expect(second).toEqual({ vesselsChecked: 0, vesselsMissing: 0, vesselsDeletedEmpty: 0 });
    db.close();
  });

  it('handles mixed occupied/missing/empty channels in one pass', async () => {
    const db = openDb(':memory:');
    seedVessel(db, 'chA');
    seedVessel(db, 'chGone');
    seedVessel(db, 'chEmpty');
    seedRegistry(db, 'chGone');
    seedRegistry(db, 'chEmpty');
    const result = await reconcile(db, async (id) => {
      if (id === 'chA') return OCCUPIED;
      if (id === 'chGone') return MISSING;
      return emptyProbe();
    });
    expect(result).toEqual({ vesselsChecked: 3, vesselsMissing: 1, vesselsDeletedEmpty: 1 });

    const survivors = db.prepare(
      `SELECT channel_id FROM vessels WHERE deleted_at IS NULL ORDER BY channel_id`,
    ).all() as Array<{ channel_id: string }>;
    expect(survivors.map((r) => r.channel_id)).toEqual(['chA']);
    db.close();
  });
});
