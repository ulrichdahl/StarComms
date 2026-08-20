import { describe, expect, it } from 'vitest';
import { MAX_SQUADS, netsFor } from './model.js';

describe('netsFor', () => {
  it('command mode with 3 squads is Command + Alpha + Bravo + Charlie', () => {
    expect(netsFor('command', 3)).toEqual([
      { callsign: 'Command', role: 'command', botKey: 'main' },
      { callsign: 'Alpha',   role: 'squad',   botKey: 'alfa' },
      { callsign: 'Bravo',   role: 'squad',   botKey: 'bravo' },
      { callsign: 'Charlie', role: 'squad',   botKey: 'charlie' },
    ]);
  });

  it('command mode with 1 squad is Command + Alpha only', () => {
    expect(netsFor('command', 1)).toEqual([
      { callsign: 'Command', role: 'command', botKey: 'main' },
      { callsign: 'Alpha',   role: 'squad',   botKey: 'alfa' },
    ]);
  });

  it('joint mode with 3 squads is Head Ops + Alpha Ops + Bravo Ops + Charlie Ops', () => {
    expect(netsFor('joint', 3)).toEqual([
      { callsign: 'Head Ops',    role: 'ops', botKey: 'main' },
      { callsign: 'Alpha Ops',   role: 'ops', botKey: 'alfa' },
      { callsign: 'Bravo Ops',   role: 'ops', botKey: 'bravo' },
      { callsign: 'Charlie Ops', role: 'ops', botKey: 'charlie' },
    ]);
  });

  it('clamps zero or negative to the minimum one squad', () => {
    // A commander typing 0 or -1 gets the smallest legal shape rather than
    // a session with no squad nets. There is no legitimate reason to open
    // a session with just the primary net, so we fold that mistake into
    // the smallest viable operation.
    expect(netsFor('command', 0)).toHaveLength(2);
    expect(netsFor('command', -5)).toHaveLength(2);
  });

  it(`clamps above ${MAX_SQUADS} to the fleet ceiling`, () => {
    expect(netsFor('command', 99)).toHaveLength(MAX_SQUADS + 1);
    expect(netsFor('joint', 99)).toHaveLength(MAX_SQUADS + 1);
  });

  it('always starts with the primary net', () => {
    expect(netsFor('command', 2)[0]?.role).toBe('command');
    expect(netsFor('joint', 2)[0]?.role).toBe('ops');
  });
});
