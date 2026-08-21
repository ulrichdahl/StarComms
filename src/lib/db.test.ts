import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from './db.js';

const dirs: string[] = [];

function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'starcomms-db-'));
  dirs.push(d);
  return join(d, 'test.db');
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates every §10 table', () => {
    const db = openDb(':memory:');
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'guilds', 'bots',
      'callsigns', 'vessels', 'hail_registry',
      'active_hails', 'hail_participants', 'hail_events',
      'audit', 'cue_sets', 'cue_assets',
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('drops the legacy tables from earlier iterations', () => {
    const db = openDb(':memory:');
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'guild_bots', 'channel_pool',
      'sessions', 'session_nets',
      'relays', 'relay_targets', 'acks',
      'alias_variants', 'misses',
      'mute_state', 'usage_daily',
    ]) {
      expect(names).not.toContain(t);
    }
    db.close();
  });

  it('is idempotent — a second open on the same file does not fail', () => {
    const path = tmpDbPath();
    const a = openDb(path);
    a.close();
    const b = openDb(path);
    expect(b.prepare(`SELECT COUNT(*) AS c FROM guilds`).get()).toEqual({ c: 0 });
    b.close();
  });

  it('enables WAL journal mode on a file-backed database', () => {
    const path = tmpDbPath();
    const db = openDb(path);
    const jm = db.pragma('journal_mode', { simple: true });
    expect(jm).toBe('wal');
    db.close();
  });

  it('creates the parent directory if it does not exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'starcomms-db-'));
    dirs.push(d);
    const path = join(d, 'nested', 'more', 'test.db');
    const db = openDb(path);
    db.close();
  });
});
