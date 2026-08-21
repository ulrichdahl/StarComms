import { describe, expect, it } from 'vitest';
import { levenshtein, matchCallsign, normaliseCallsign } from './matcher.js';
import { openDb } from '../lib/db.js';

describe('normaliseCallsign', () => {
  it('lowercases and strips whitespace + punctuation', () => {
    expect(normaliseCallsign('Alpha')).toBe('alpha');
    expect(normaliseCallsign('Alpha Ops')).toBe('alphaops');
    expect(normaliseCallsign("Alpha's, Ops!")).toBe('alphasops');
  });

  it('preserves Danish letters', () => {
    expect(normaliseCallsign('Ål')).toBe('ål');
  });
});

describe('levenshtein', () => {
  it('is zero for equal strings', () => {
    expect(levenshtein('alpha', 'alpha')).toBe(0);
  });

  it('measures single character edits', () => {
    expect(levenshtein('alpha', 'alph')).toBe(1);    // delete
    expect(levenshtein('alpha', 'alphb')).toBe(1);   // substitute
    expect(levenshtein('alpha', 'alphax')).toBe(1);  // insert
  });

  it('handles empty inputs', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });
});

const ACTIVE = ['Command', 'Alpha', 'Bravo', 'Charlie'] as const;

describe('matchCallsign — exact', () => {
  it('matches an exact spelling', () => {
    const r = matchCallsign('Alpha', { activeCallsigns: ACTIVE });
    expect(r).toMatchObject({ layer: 'exact', callsign: 'Alpha' });
  });

  it('matches regardless of case + whitespace', () => {
    expect(matchCallsign('ALPHA', { activeCallsigns: ACTIVE }).callsign).toBe('Alpha');
    expect(matchCallsign(' alpha ', { activeCallsigns: ACTIVE }).callsign).toBe('Alpha');
  });
});

describe('matchCallsign — Levenshtein', () => {
  it('picks up a single dropped character', () => {
    const r = matchCallsign('alph', { activeCallsigns: ACTIVE });
    expect(r).toMatchObject({ layer: 'levenshtein', callsign: 'Alpha', distance: 1 });
  });

  it('picks up a single wrong character', () => {
    const r = matchCallsign('alpe', { activeCallsigns: ACTIVE });
    expect(r).toMatchObject({ layer: 'levenshtein', callsign: 'Alpha' });
  });

  it('rejects a match beyond the threshold', () => {
    const r = matchCallsign('romeo', { activeCallsigns: ACTIVE });
    expect(r.layer).toBe('miss');
  });

  it('does not confuse similarly-lengthed distinct callsigns', () => {
    // Whisper misheard "Alpha" as "alpaha" — Levenshtein dist 2 for Alpha,
    // > 2 for Bravo/Charlie/Command. Should still resolve to Alpha at
    // threshold 2 for a 6-char input.
    const r = matchCallsign('alpaha', { activeCallsigns: ACTIVE });
    expect(r.callsign).toBe('Alpha');
  });
});

describe('matchCallsign — alias_variants', () => {
  it('resolves via alias_variants when other layers miss', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO alias_variants (guild_id, kind, canonical, variant, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g1', 'callsign', 'Alpha', 'mandelpa', 'operator', Date.now());

    const r = matchCallsign('mandelpa', {
      activeCallsigns: ACTIVE, db, guildId: 'g1',
    });
    expect(r).toMatchObject({ layer: 'alias', callsign: 'Alpha' });
    db.close();
  });

  it('ignores aliases whose canonical is not currently active', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO alias_variants (guild_id, kind, canonical, variant, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g1', 'callsign', 'Delta', 'foobar', 'operator', Date.now());
    // Delta is NOT in the active session
    const r = matchCallsign('foobar', {
      activeCallsigns: ACTIVE, db, guildId: 'g1',
    });
    expect(r.layer).toBe('miss');
    db.close();
  });

  it('scopes aliases by guild', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO alias_variants (guild_id, kind, canonical, variant, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('other-guild', 'callsign', 'Alpha', 'zzz', 'operator', Date.now());

    const r = matchCallsign('zzz', {
      activeCallsigns: ACTIVE, db, guildId: 'g1',
    });
    expect(r.layer).toBe('miss');
    db.close();
  });
});

describe('matchCallsign — misses', () => {
  it('returns miss on empty input', () => {
    expect(matchCallsign('', { activeCallsigns: ACTIVE }).layer).toBe('miss');
    expect(matchCallsign('  ', { activeCallsigns: ACTIVE }).layer).toBe('miss');
  });

  it('returns miss when no callsigns are active', () => {
    expect(matchCallsign('Alpha', { activeCallsigns: [] }).layer).toBe('miss');
  });
});
