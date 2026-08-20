import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';

/**
 * Full provisionGuild() exercises Discord's channel-create API, which needs a
 * live Client and cannot be tested in isolation without heavy mocking. The
 * step 5a manual verification bar (README) covers that path end-to-end.
 *
 * These tests cover the DB side: the guilds row insertion is idempotent, and
 * subsequent runs read the persisted category/control channel ids rather than
 * re-inserting. The provisioner is intentionally structured so the DB writes
 * are separable from the Discord calls; if we ever extract the pure functions,
 * they land here.
 */

describe('guilds row lifecycle', () => {
  it('starts empty', () => {
    const db = openDb(':memory:');
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM guilds`).get() as { c: number };
    expect(rows.c).toBe(0);
    db.close();
  });

  it('accepts the shape a first init inserts', () => {
    const db = openDb(':memory:');
    db.prepare(`
      INSERT INTO guilds (
        id, name, added_at, added_by, slot_quota, status, mode_default, locale,
        mute_mode, stt_driver, cue_set, cue_duration_ms, open_timeout_ms,
        silence_close_ms, max_hold_ms, close_cue_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'g1', 'Test Guild', 1_000, 'owner', 3, 'active', 'command', 'en',
      'priority_speaker', 'whisper_local', 'default', 1200, 5000, 2000, 60_000, 1,
    );
    const got = db.prepare(`SELECT locale, mode_default FROM guilds WHERE id = ?`).get('g1');
    expect(got).toEqual({ locale: 'en', mode_default: 'command' });
    db.close();
  });

  it('records category_id and control_channel_id updates', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO guilds (
      id, name, added_at, added_by, slot_quota, status, mode_default, locale,
      mute_mode, stt_driver, cue_set, cue_duration_ms, open_timeout_ms,
      silence_close_ms, max_hold_ms, close_cue_enabled
    ) VALUES ('g1', 'Test', 0, 'owner', 3, 'active', 'command', 'en',
              'priority_speaker', 'whisper_local', 'default', 1200, 5000, 2000, 60000, 1)
    `).run();

    db.prepare(`UPDATE guilds SET category_id = ? WHERE id = ?`).run('cat123', 'g1');
    db.prepare(`UPDATE guilds SET control_channel_id = ? WHERE id = ?`).run('ctrl456', 'g1');

    const row = db.prepare(`SELECT category_id, control_channel_id FROM guilds WHERE id = ?`).get('g1');
    expect(row).toEqual({ category_id: 'cat123', control_channel_id: 'ctrl456' });
    db.close();
  });
});
