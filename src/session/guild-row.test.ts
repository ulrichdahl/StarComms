import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { ensureGuildRow, getJoinToCreateChannel, setJoinToCreateChannel } from './guild-row.js';
import type { FleetDefaults } from '../lib/config.js';

const DEFAULTS: FleetDefaults = {
  locale: 'en',
  cueSet: 'default',
  cueDurationMs: 1200,
  ringIntervalMs: 4_000,
  ringMaxMs: 20_000,
  hailSilenceCloseMs: 10_000,
  hailMaxHoldMs: 1_800_000,
};

const guild = (overrides: Partial<{ id: string; name: string; ownerId: string }> = {}) => ({
  id: 'g1', name: 'Test Guild', ownerId: 'owner-1',
  ...overrides,
});

describe('ensureGuildRow', () => {
  it('inserts a row using fleet defaults on first call', () => {
    const db = openDb(':memory:');
    ensureGuildRow(db, guild(), DEFAULTS, 'operator-42');
    const row = db.prepare(`SELECT * FROM guilds WHERE id = 'g1'`).get() as Record<string, unknown>;
    expect(row.name).toBe('Test Guild');
    expect(row.added_by).toBe('operator-42');
    expect(row.locale).toBe('en');
    expect(row.cue_duration_ms).toBe(1200);
    expect(row.ring_interval_ms).toBe(4_000);
    expect(row.hail_silence_close_ms).toBe(10_000);
    expect(row.status).toBe('active');
    expect(row.join_to_create_channel_id).toBeNull();
    db.close();
  });

  it('is idempotent — second call does not overwrite added_by or timestamps', () => {
    const db = openDb(':memory:');
    ensureGuildRow(db, guild(), DEFAULTS, 'first-invoker');
    const before = db.prepare(`SELECT added_at, added_by FROM guilds WHERE id = 'g1'`).get();
    ensureGuildRow(db, guild(), DEFAULTS, 'second-invoker');
    const after = db.prepare(`SELECT added_at, added_by FROM guilds WHERE id = 'g1'`).get();
    expect(after).toEqual(before);
    db.close();
  });
});

describe('setJoinToCreateChannel / getJoinToCreateChannel', () => {
  it('round-trips a channel id', () => {
    const db = openDb(':memory:');
    ensureGuildRow(db, guild(), DEFAULTS, 'invoker');
    expect(getJoinToCreateChannel(db, 'g1')).toBeNull();
    setJoinToCreateChannel(db, 'g1', 'chan-99');
    expect(getJoinToCreateChannel(db, 'g1')).toBe('chan-99');
  });

  it('returns null for a guild that was never initialised', () => {
    const db = openDb(':memory:');
    expect(getJoinToCreateChannel(db, 'unknown-guild')).toBeNull();
    db.close();
  });

  it('overwrites a previous value', () => {
    const db = openDb(':memory:');
    ensureGuildRow(db, guild(), DEFAULTS, 'invoker');
    setJoinToCreateChannel(db, 'g1', 'chan-a');
    setJoinToCreateChannel(db, 'g1', 'chan-b');
    expect(getJoinToCreateChannel(db, 'g1')).toBe('chan-b');
    db.close();
  });
});
