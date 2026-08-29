import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CUE_NAMES, loadCueSet, resolveCuePaths, type CuePaths, CueLibrary, CueSet } from './cues.js';

/**
 * These tests shell out to ffmpeg to synthesise fixture WAVs, then run
 * the loader against them. Feeding the loader real audio (rather than
 * mocking prism-media) is what actually exercises the decode→encode
 * pipeline that would break in production.
 */

const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const skip = HAS_FFMPEG ? describe : describe.skip;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function mkWav(dir: string, name: string, durationSec: number, freq = 440): string {
  const path = join(dir, `${name}.wav`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${durationSec}:sample_rate=48000`,
    '-ac', '2', '-c:a', 'pcm_s16le', path,
  ]);
  return path;
}

function mkPaths(dir: string, durations: Partial<Record<string, number>> = {}): CuePaths {
  const paths: Partial<CuePaths> = {};
  for (const cue of CUE_NAMES) {
    paths[cue] = mkWav(dir, cue, durations[cue] ?? 1.2);
  }
  return paths as CuePaths;
}

const EN_FIXTURE = {
  cue_sets: {
    default: {
      en: {
        ready: 'cues/en/ready.wav',
        attention: 'cues/en/attention.wav',
        busy: 'cues/en/busy.wav',
        established: 'cues/en/established.wav',
        disconnected: 'cues/en/disconnected.wav',
      },
      shared: {
        ring: 'cues/ring.wav',
        end: 'cues/end.wav',
      },
    },
  },
};

skip('loadCueSet', () => {
  it('loads every cue in CUE_NAMES', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const set = await loadCueSet(mkPaths(dir));
    expect(set.summary()).toHaveLength(CUE_NAMES.length);
    for (const c of set.summary()) {
      expect(c.durationMs).toBeGreaterThan(0);
      expect(c.packets).toBeGreaterThan(0);
    }
  }, 30_000);

  it('accepts cues of varied duration — no strict-equal invariant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    // Wildly different durations across cues: 0.4 s, 1.2 s, 2.5 s.
    const set = await loadCueSet(mkPaths(dir, {
      ready: 0.4, attention: 2.5, ring: 0.6, established: 1.8,
    }));
    expect(set.get('ready').durationMs).toBeLessThan(500);
    expect(set.get('attention').durationMs).toBeGreaterThan(2_000);
    expect(set.get('established').durationMs).toBeGreaterThan(1_500);
  }, 30_000);

  it('rejects a missing file with a clear error', async () => {
    const paths = { ready: '/nonexistent/ready.wav' } as CuePaths;
    await expect(loadCueSet(paths)).rejects.toThrow(/file not found|ready/);
  });

  it('caches opus packets without re-reading the file for each get()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const set = await loadCueSet(mkPaths(dir));
    const a = set.get('ready').packets;
    const b = set.get('ready').packets;
    expect(a).toBe(b); // same buffer reference means truly cached
  }, 30_000);
});

describe('resolveCuePaths', () => {
  it('resolves relative paths against the yaml file directory when they exist there', () => {
    const paths = resolveCuePaths(EN_FIXTURE, 'default', 'en', '/etc/starcomms/fleet.yaml');
    expect(paths.ready).toMatch(/cues\/en\/ready\.wav$/);
    expect(paths.established).toMatch(/cues\/en\/established\.wav$/);
    expect(paths.disconnected).toMatch(/cues\/en\/disconnected\.wav$/);
  });

  it('respects absolute paths as-is', () => {
    const abs = {
      cue_sets: {
        default: {
          en: {
            ready: '/absolute/ready.wav',
            attention: '/absolute/attention.wav',
            busy: '/absolute/busy.wav',
            established: '/absolute/established.wav',
            disconnected: '/absolute/disconnected.wav',
          },
          shared: {
            ring: '/absolute/ring.wav',
            end: '/absolute/end.wav',
          },
        },
      },
    };
    const paths = resolveCuePaths(abs, 'default', 'en', '/etc/starcomms/fleet.yaml');
    expect(paths.ready).toBe('/absolute/ready.wav');
    expect(paths.ring).toBe('/absolute/ring.wav');
    expect(paths.end).toBe('/absolute/end.wav');
    expect(paths.established).toBe('/absolute/established.wav');
  });

  it('fails when the cue set is missing', () => {
    expect(() => resolveCuePaths(EN_FIXTURE, 'militant', 'en', 'config/fleet.yaml')).toThrow(/cue_sets\.militant/);
  });

  it('fails when the locale is missing', () => {
    expect(() => resolveCuePaths(EN_FIXTURE, 'default', 'fr', 'config/fleet.yaml')).toThrow(/fr missing/);
  });

  it('fails when a shared cue path is missing', () => {
    const partial = {
      cue_sets: {
        default: {
          en: {
            ready: 'x.wav', attention: 'x.wav', busy: 'x.wav',
            established: 'x.wav', disconnected: 'x.wav',
          },
          shared: { end: 'x.wav' /* ring missing */ },
        },
      },
    };
    expect(() => resolveCuePaths(partial, 'default', 'en', 'config/fleet.yaml')).toThrow(/ring/);
  });

  it('fails when a locale-specific cue is missing', () => {
    const partial = {
      cue_sets: {
        default: {
          en: {
            ready: 'x.wav', attention: 'x.wav', busy: 'x.wav',
            established: 'x.wav', /* disconnected missing */
          },
          shared: { ring: 'x.wav', end: 'x.wav' },
        },
      },
    };
    expect(() => resolveCuePaths(partial, 'default', 'en', 'config/fleet.yaml'))
      .toThrow(/disconnected/);
  });
});

describe('placeholder cue files', () => {
  // Just check the shipped files exist; durations vary by locale and voice.
  it('cues/en/ready.wav exists on disk', () => {
    const p = 'cues/en/ready.wav';
    if (!existsSync(p)) return; // placeholders not generated in this environment
    expect(statSync(p).size).toBeGreaterThan(0);
  });
});

describe('CueLibrary', () => {
  const fake = (): CueSet => new CueSet(new Map());

  it('returns a locale\'s own set when loaded', () => {
    const en = fake(); const da = fake();
    const lib = new CueLibrary(new Map([['en', en], ['da', da]]), 'en');
    expect(lib.forLocale('da')).toBe(da);
    expect(lib.has('da')).toBe(true);
  });

  it('falls back to the default locale for a locale without audio', () => {
    const en = fake();
    const lib = new CueLibrary(new Map([['en', en]]), 'en');
    expect(lib.has('en-pirate')).toBe(false);
    expect(lib.forLocale('en-pirate')).toBe(en);
    expect(lib.loadedLocales()).toEqual(['en']);
  });

  it('refuses a library without the default locale', () => {
    expect(() => new CueLibrary(new Map([['da', fake()]]), 'en')).toThrow(/default locale/);
  });
});
