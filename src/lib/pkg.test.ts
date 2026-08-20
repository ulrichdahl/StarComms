import { describe, expect, it } from 'vitest';
import { atLeast, packageVersion, parseSemver } from './pkg.js';

describe('packageVersion', () => {
  // Regression guard: @discordjs/voice does not export its package.json, and
  // an earlier implementation returned null for it. A null here would disable
  // the spike's version check and let a receive-broken version through.
  it('reads a version for a package that does not export package.json', () => {
    const v = packageVersion('@discordjs/voice');
    expect(v).not.toBeNull();
    expect(parseSemver(v as string)).not.toBeNull();
  });

  it('reads a version for a transitive dependency', () => {
    expect(packageVersion('@snazzah/davey')).not.toBeNull();
  });

  it('returns null for a package that is not installed', () => {
    expect(packageVersion('this-package-does-not-exist-42')).toBeNull();
  });
});

describe('atLeast', () => {
  const min = { major: 0, minor: 19, patch: 2 };

  it('accepts the exact minimum', () => {
    expect(atLeast('0.19.2', min)).toBe(true);
  });

  it('rejects the receive-broken versions', () => {
    expect(atLeast('0.19.0', min)).toBe(false);
    expect(atLeast('0.19.1', min)).toBe(false);
  });

  it('accepts later patch, minor and major', () => {
    expect(atLeast('0.19.3', min)).toBe(true);
    expect(atLeast('0.20.0', min)).toBe(true);
    expect(atLeast('1.0.0', min)).toBe(true);
  });

  it('handles prerelease suffixes by their numeric core', () => {
    expect(atLeast('1.0.0-dev.1786968995', min)).toBe(true);
    expect(atLeast('0.19.1-pr-11005.123', min)).toBe(false);
  });

  it('rejects unparseable versions', () => {
    expect(atLeast('not-a-version', min)).toBe(false);
  });
});

describe('parseSemver', () => {
  it('parses a plain version', () => {
    expect(parseSemver('0.19.2')).toEqual({ major: 0, minor: 19, patch: 2 });
  });

  it('ignores a prerelease suffix', () => {
    expect(parseSemver('1.0.0-dev.42')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('returns null on garbage', () => {
    expect(parseSemver('x.y.z')).toBeNull();
  });
});
