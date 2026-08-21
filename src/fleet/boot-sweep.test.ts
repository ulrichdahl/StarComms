import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { bootSweep, formatSweep } from './boot-sweep.js';

describe('bootSweep', () => {
  it('returns all zeros on a clean database', () => {
    const db = openDb(':memory:');
    const s = bootSweep(db);
    expect(s).toEqual({
      hailsForceClosed: 0, vesselsPresent: 0, registryEntries: 0,
    });
    db.close();
  });

  it('force-closes any un-closed active_hails', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at)
       VALUES (?, ?, ?)`,
    ).run('g1', 'c1', 1_000);
    // A second, already-closed hail: sweep must not touch it.
    db.prepare(
      `INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at, closed_at, close_reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('g1', 'c2', 500, 900, 'button');

    const s = bootSweep(db, 5_000);
    expect(s.hailsForceClosed).toBe(1);

    const row = db.prepare(
      `SELECT closed_at, close_reason FROM active_hails WHERE initiator_channel_id = 'c1'`,
    ).get() as { closed_at: number; close_reason: string };
    expect(row.closed_at).toBe(5_000);
    expect(row.close_reason).toBe('drain');
    db.close();
  });

  it('counts live vessels and hail registry rows', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('g1', 'ch1', 'user1', 1);
    // A deleted vessel should not count.
    db.prepare(
      `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('g1', 'ch2', 'user2', 1, 2);
    db.prepare(
      `INSERT INTO hail_registry (channel_id, guild_id, callsign, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run('ch1', 'g1', 'Firefly', 1);
    const s = bootSweep(db);
    expect(s.vesselsPresent).toBe(1);
    expect(s.registryEntries).toBe(1);
    db.close();
  });

  it('formats zero counts as a single-line summary', () => {
    const db = openDb(':memory:');
    expect(formatSweep(bootSweep(db))).toBe(
      'swept: 0 hails force-closed, 0 vessel(s) present, 0 hail registrations',
    );
    db.close();
  });
});
