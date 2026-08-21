import { describe, expect, it } from 'vitest';
import { normalise, parseCallup } from './grammar.js';

describe('normalise', () => {
  it('lowercases + strips punctuation + collapses whitespace', () => {
    expect(normalise('Command, Alpha!')).toBe('command alpha');
    expect(normalise('  HAIL   BRAVO  ')).toBe('hail bravo');
  });

  it('preserves Danish letters', () => {
    expect(normalise('Kald Ål')).toBe('kald ål');
  });

  it('handles an empty string', () => {
    expect(normalise('')).toBe('');
    expect(normalise('   ')).toBe('');
  });
});

describe('parseCallup (en)', () => {
  it('recognises command + callsign', () => {
    expect(parseCallup('Command Alpha', 'en')).toEqual({
      verb: 'command', callsignHeard: 'alpha', raw: 'Command Alpha',
    });
  });

  it('recognises hail + multi-token callsign', () => {
    expect(parseCallup('Hail Alpha Ops', 'en')).toEqual({
      verb: 'hail', callsignHeard: 'alpha ops', raw: 'Hail Alpha Ops',
    });
  });

  it('recognises alert with no callsign', () => {
    expect(parseCallup('Alert', 'en')).toEqual({
      verb: 'alert', callsignHeard: null, raw: 'Alert',
    });
  });

  it('recognises broadcast with a callsign', () => {
    expect(parseCallup('Broadcast Bravo', 'en')).toEqual({
      verb: 'broadcast', callsignHeard: 'bravo', raw: 'Broadcast Bravo',
    });
  });

  it('recognises terminators', () => {
    expect(parseCallup('Over', 'en')?.verb).toBe('terminator');
    expect(parseCallup('Out', 'en')?.verb).toBe('terminator');
  });

  it('drops "hail" alone (no callsign target)', () => {
    expect(parseCallup('Hail', 'en')).toBeNull();
  });

  it('drops non-callups', () => {
    expect(parseCallup('Testing testing', 'en')).toBeNull();
    expect(parseCallup('', 'en')).toBeNull();
  });

  it('scans past leading noise', () => {
    // Whisper often prepends "Uh" or "Okay". We do NOT want to fail on it.
    expect(parseCallup('Uh command alpha', 'en')?.verb).toBe('command');
  });
});

describe('parseCallup (da)', () => {
  it('recognises Danish verbs', () => {
    expect(parseCallup('Ordre Alpha', 'da')?.verb).toBe('command');
    expect(parseCallup('Kald Bravo', 'da')?.verb).toBe('hail');
    expect(parseCallup('Alarm', 'da')?.verb).toBe('alert');
    expect(parseCallup('Udsend', 'da')?.verb).toBe('broadcast');
    expect(parseCallup('Slut', 'da')?.verb).toBe('terminator');
    expect(parseCallup('Over', 'da')?.verb).toBe('terminator');
  });

  it('does not accept English verbs in Danish mode', () => {
    expect(parseCallup('Hail Alpha', 'da')).toBeNull();
    expect(parseCallup('Command Alpha', 'da')).toBeNull();
  });

  it('carries the callsign through', () => {
    expect(parseCallup('Ordre Alfa', 'da')).toEqual({
      verb: 'command', callsignHeard: 'alfa', raw: 'Ordre Alfa',
    });
  });
});
