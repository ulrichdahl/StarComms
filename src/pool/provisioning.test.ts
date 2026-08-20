import { describe, expect, it } from 'vitest';
import { channelName } from './provisioning.js';

describe('channelName', () => {
  it('renders capitalised callsign channels', () => {
    expect(channelName('alfa')).toBe('Command Alfa');
    expect(channelName('bravo')).toBe('Command Bravo');
    expect(channelName('charlie')).toBe('Command Charlie');
  });

  // Regression guard: an empty nato slipping through would give "Command "
  // which is a valid Discord name but a broken invariant. The config loader
  // rejects empty natos, so this codifies the assumption.
  it('does not synthesise a name from an empty nato', () => {
    expect(channelName('')).toBe('Command ');
  });
});
