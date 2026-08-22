import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import { pickTwo, SQUAD_NATOS } from './hail.js';

describe('pickTwo', () => {
  const never = () => false;
  const always = () => true;

  it('returns the first two natos when none are busy', () => {
    expect(pickTwo(SQUAD_NATOS, never, always)).toEqual(['alfa', 'bravo']);
  });

  it('skips busy natos', () => {
    const busy = new Set(['alfa']);
    expect(pickTwo(SQUAD_NATOS, (n) => busy.has(n), always))
      .toEqual(['bravo', 'charlie']);
  });

  it('skips unreachable natos', () => {
    // charlie's client hasn't come online yet
    const online = new Set(['alfa', 'bravo']);
    expect(pickTwo(SQUAD_NATOS, never, (n) => online.has(n)))
      .toEqual(['alfa', 'bravo']);
  });

  it('returns null when fewer than two are free', () => {
    const busy = new Set(['alfa', 'bravo']);
    expect(pickTwo(SQUAD_NATOS, (n) => busy.has(n), always)).toBeNull();
  });

  it('returns null when the pool is empty', () => {
    expect(pickTwo([], never, always)).toBeNull();
  });

  it('honors input order — deterministic assignment for logs', () => {
    const custom = ['charlie', 'alfa', 'bravo'] as const;
    expect(pickTwo(custom, never, always)).toEqual(['charlie', 'alfa']);
  });
});

describe('hail schema shape', () => {
  it('active_hails + hail_participants + hail_events all take the columns hail.ts writes', () => {
    const db = openDb(':memory:');
    const opened = db.prepare(`
      INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at)
      VALUES ('g1', 'chA', 1000)
    `).run();
    const hailId = Number(opened.lastInsertRowid);

    db.prepare(`
      INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, decision)
      VALUES (?, ?, ?, ?, ?)
    `).run(hailId, 'chA', 'alfa', 1001, 'accepted');

    db.prepare(`
      INSERT INTO hail_events (hail_id, ts, kind, actor_user_id, target_channel_id, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hailId, 1002, 'opened', 'user1', 'chB', null);

    // Close it — the shape written by _close.
    db.prepare(
      `UPDATE active_hails SET closed_at = ?, close_reason = ? WHERE id = ?`,
    ).run(2000, 'silence', hailId);
    db.prepare(
      `UPDATE hail_participants SET left_at = ? WHERE hail_id = ? AND channel_id = ?`,
    ).run(2000, hailId, 'chA');

    const closed = db.prepare(
      `SELECT closed_at, close_reason FROM active_hails WHERE id = ?`,
    ).get(hailId) as { closed_at: number; close_reason: string };
    expect(closed).toEqual({ closed_at: 2000, close_reason: 'silence' });

    const events = db.prepare(
      `SELECT kind FROM hail_events WHERE hail_id = ?`,
    ).all(hailId) as Array<{ kind: string }>;
    expect(events).toEqual([{ kind: 'opened' }]);
    db.close();
  });

  it('refused-hail path: ring_started + declined + ended_all events, target decision declined', () => {
    const db = openDb(':memory:');
    const opened = db.prepare(`
      INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at)
      VALUES ('g1', 'chA', 1000)
    `).run();
    const hailId = Number(opened.lastInsertRowid);

    // The events refuseHail path writes, in order.
    for (const [ts, kind, actor, target, note] of [
      [1001, 'opened', 'user1', 'chB', null],
      [1002, 'ring_started', null, 'chB', null],
      [1010, 'declined', null, 'chB', null],
      [1010, 'ended_all', null, null, 'all_declined'],
    ] as const) {
      db.prepare(`
        INSERT INTO hail_events (hail_id, ts, kind, actor_user_id, target_channel_id, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(hailId, ts, kind, actor, target, note);
    }

    // Participants: initiator accepted with left_at, target declined with left_at.
    db.prepare(`
      INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, left_at, decision)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hailId, 'chA', 'alfa', 1010, 1010, 'accepted');
    db.prepare(`
      INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, left_at, decision)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hailId, 'chB', 'bravo', 1010, 1010, 'declined');

    db.prepare(
      `UPDATE active_hails SET closed_at = ?, close_reason = ? WHERE id = ?`,
    ).run(1010, 'all_declined', hailId);

    const closed = db.prepare(
      `SELECT close_reason FROM active_hails WHERE id = ?`,
    ).get(hailId) as { close_reason: string };
    expect(closed.close_reason).toBe('all_declined');

    const target = db.prepare(
      `SELECT decision FROM hail_participants WHERE hail_id = ? AND channel_id = 'chB'`,
    ).get(hailId) as { decision: string };
    expect(target.decision).toBe('declined');

    const kinds = db.prepare(
      `SELECT kind FROM hail_events WHERE hail_id = ? ORDER BY ts, id`,
    ).all(hailId) as Array<{ kind: string }>;
    expect(kinds.map((r) => r.kind))
      .toEqual(['opened', 'ring_started', 'declined', 'ended_all']);
    db.close();
  });
});
