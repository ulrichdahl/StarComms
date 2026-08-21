import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db.js';
import {
  CallsignError, getCallsign, registerCallsign, unregisterCallsign, validateCallsign,
} from './callsigns.js';

describe('validateCallsign', () => {
  it('accepts a normal name', () => {
    expect(validateCallsign('Firefly')).toBe('Firefly');
  });

  it('trims surrounding whitespace', () => {
    expect(validateCallsign('  Serenity  ')).toBe('Serenity');
  });

  it('accepts names with spaces + apostrophes', () => {
    expect(validateCallsign("Jayne's Ride")).toBe("Jayne's Ride");
  });

  it('accepts non-ASCII letters', () => {
    expect(validateCallsign('Ålkroken')).toBe('Ålkroken');
  });

  it('rejects too short', () => {
    expect(() => validateCallsign('A')).toThrow(CallsignError);
  });

  it('rejects too long', () => {
    expect(() => validateCallsign('A'.repeat(25))).toThrow(CallsignError);
  });

  it('rejects illegal leading/trailing character', () => {
    expect(() => validateCallsign('-Firefly')).toThrow(CallsignError);
    expect(() => validateCallsign('Firefly-')).toThrow(CallsignError);
    expect(() => validateCallsign(' Firefly ')).not.toThrow();     // trimmed first
  });

  it('rejects punctuation in the middle', () => {
    expect(() => validateCallsign('Fire!fly')).toThrow(CallsignError);
  });
});

describe('registerCallsign', () => {
  it('inserts the row and returns the accepted callsign', () => {
    const db = openDb(':memory:');
    expect(registerCallsign(db, 'g1', 'u1', 'Firefly')).toBe('Firefly');
    const row = getCallsign(db, 'g1', 'u1');
    expect(row?.callsign).toBe('Firefly');
    db.close();
  });

  it('overwrites the caller\'s own prior registration', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    registerCallsign(db, 'g1', 'u1', 'Serenity');
    expect(getCallsign(db, 'g1', 'u1')?.callsign).toBe('Serenity');
    db.close();
  });

  it('rejects a callsign already taken by someone else', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    expect(() => registerCallsign(db, 'g1', 'u2', 'Firefly'))
      .toThrow(/already registered/);
    db.close();
  });

  it('treats callsign uniqueness case-insensitively', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    expect(() => registerCallsign(db, 'g1', 'u2', 'FIREFLY')).toThrow();
    expect(() => registerCallsign(db, 'g1', 'u2', 'fireFly')).toThrow();
    db.close();
  });

  it('does not conflict across guilds', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    // Different guild, same callsign, different user — fine.
    registerCallsign(db, 'g2', 'u2', 'Firefly');
    expect(getCallsign(db, 'g1', 'u1')?.callsign).toBe('Firefly');
    expect(getCallsign(db, 'g2', 'u2')?.callsign).toBe('Firefly');
    db.close();
  });
});

describe('unregisterCallsign', () => {
  it('returns null for a member who was not registered', () => {
    const db = openDb(':memory:');
    expect(unregisterCallsign(db, 'g1', 'u1')).toBeNull();
    db.close();
  });

  it('removes the row and returns the previous callsign', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    expect(unregisterCallsign(db, 'g1', 'u1')).toBe('Firefly');
    expect(getCallsign(db, 'g1', 'u1')).toBeNull();
    db.close();
  });

  it('drops hail_registry rows for the caller\'s vessels', () => {
    const db = openDb(':memory:');
    registerCallsign(db, 'g1', 'u1', 'Firefly');
    db.prepare(
      `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run('g1', 'ch1', 'u1', Date.now());
    db.prepare(
      `INSERT INTO hail_registry (channel_id, guild_id, callsign, registered_at) VALUES (?, ?, ?, ?)`,
    ).run('ch1', 'g1', 'Firefly', Date.now());
    // Someone else's vessel + registration — must NOT be dropped.
    db.prepare(
      `INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run('g1', 'ch2', 'u2', Date.now());
    db.prepare(
      `INSERT INTO hail_registry (channel_id, guild_id, callsign, registered_at) VALUES (?, ?, ?, ?)`,
    ).run('ch2', 'g1', 'Serenity', Date.now());

    unregisterCallsign(db, 'g1', 'u1');

    const remaining = db.prepare(`SELECT channel_id FROM hail_registry`).all() as { channel_id: string }[];
    expect(remaining.map((r) => r.channel_id)).toEqual(['ch2']);
    db.close();
  });
});
