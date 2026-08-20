import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { bootSweep, formatSweep } from './boot-sweep.js';

describe('bootSweep', () => {
  it('returns all zeros on a clean database', () => {
    const db = openDb(':memory:');
    const s = bootSweep(db);
    expect(s).toEqual({
      mutesToRestore: 0, sessionsPastTeardown: 0, poolOverwrites: 0, openRelays: 0,
    });
    db.close();
  });

  it('counts unrestored mutes', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO mute_state (session_id, user_id, channel_id, prev_mute, set_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(1, 'u1', 'c1', 0, 1);
    expect(bootSweep(db).mutesToRestore).toBe(1);
    db.close();
  });

  it('counts sessions whose teardown_at is in the past and not yet ended', () => {
    const db = openDb(':memory:');
    const now = 10_000;
    db.prepare(
      `INSERT INTO sessions (guild_id, mode, lead_user_id, started_at, teardown_at, mute_others)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g', 'command', 'u', 1_000, 5_000, 0);
    // Not counted: teardown_at in the future.
    db.prepare(
      `INSERT INTO sessions (guild_id, mode, lead_user_id, started_at, teardown_at, mute_others)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g', 'command', 'u', 1_000, 99_999, 0);
    // Not counted: already ended.
    db.prepare(
      `INSERT INTO sessions (guild_id, mode, lead_user_id, started_at, ended_at, teardown_at, mute_others)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('g', 'command', 'u', 1_000, 6_000, 5_000, 0);
    expect(bootSweep(db, now).sessionsPastTeardown).toBe(1);
    db.close();
  });

  it('counts pool overwrites and open relays', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO channel_pool (guild_id, nato, channel_id, kind) VALUES (?, ?, ?, ?)`,
    ).run('g', 'alfa', 'c', 'command');
    db.prepare(
      `INSERT INTO relays (session_id, verb, source_nato, speaker_user_id, state, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'hail', 'alfa', 'u', 'open', 1);
    db.prepare(
      `INSERT INTO relays (session_id, verb, source_nato, speaker_user_id, state, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'hail', 'alfa', 'u', 'closed', 1);
    const s = bootSweep(db);
    expect(s.poolOverwrites).toBe(1);
    expect(s.openRelays).toBe(1);
    db.close();
  });

  it('formats zero counts as a single-line summary', () => {
    const db = openDb(':memory:');
    expect(formatSweep(bootSweep(db))).toBe(
      'swept: 0 mutes, 0 stale sessions, 0 pool overwrites, 0 open relays',
    );
    db.close();
  });
});
