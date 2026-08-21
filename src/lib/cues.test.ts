import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CUE_NAMES, CueLoadError, loadCueSet, resolveCuePaths, type CuePaths,
} from './cues.js';

/**
 * These tests shell out to ffmpeg to synthesise fixture WAVs at controlled
 * durations, then run the loader against them. Feeding the loader real
 * audio (rather than mocking prism-media) is what actually exercises the
 * decode→encode pipeline that would break in production.
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

skip('loadCueSet', () => {
  it('loads all five cues at the expected duration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const set = await loadCueSet(mkPaths(dir), 1200);
    expect(set.summary()).toHaveLength(5);
    for (const c of set.summary()) {
      expect(c.durationMs).toBeGreaterThanOrEqual(1160);
      expect(c.durationMs).toBeLessThanOrEqual(1240);
      expect(c.packets).toBeGreaterThan(0);
    }
  }, 30_000);

  // Ready and attention play concurrently and must end together.
  it('rejects a strict-set cue whose duration exceeds the strict tolerance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const paths = mkPaths(dir, { attention: 1.4 });
    await expect(loadCueSet(paths, 1200)).rejects.toBeInstanceOf(CueLoadError);
  }, 30_000);

  it('accepts a loose-set cue at 100 ms drift (within loose tolerance)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    // busy at 1300 ms — 100 ms out, under the loose 200 ms band.
    const paths = mkPaths(dir, { busy: 1.3 });
    const set = await loadCueSet(paths, 1200);
    expect(set.get('busy').durationMs).toBeGreaterThan(1200);
  }, 30_000);

  it('rejects a missing file with a clear error', async () => {
    const paths: CuePaths = {
      ready: '/nonexistent/ready.wav', attention: 'x', ring: 'x', busy: 'x', end: 'x',
    };
    await expect(loadCueSet(paths, 1200)).rejects.toThrow(/file not found|ready/);
  });

  it('caches opus packets without re-reading the file for each get()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const set = await loadCueSet(mkPaths(dir), 1200);
    const a = set.get('ready').packets;
    const b = set.get('ready').packets;
    expect(a).toBe(b); // same buffer reference means truly cached
  }, 30_000);

  it('produces on the order of 60 opus frames for a 1200 ms cue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-'));
    dirs.push(dir);
    const set = await loadCueSet(mkPaths(dir), 1200);
    // 1200 ms / 20 ms per frame = 60. Allow ±2 for encoder tail behaviour.
    const packets = set.get('ready').packets.length;
    expect(packets).toBeGreaterThanOrEqual(58);
    expect(packets).toBeLessThanOrEqual(62);
  }, 30_000);
});

describe('resolveCuePaths', () => {
  const raw = {
    cue_sets: {
      default: {
        en: {
          ready: 'cues/en/ready.wav',
          attention: 'cues/en/attention.wav',
          busy: 'cues/en/busy.wav',
        },
        shared: {
          ring: 'cues/ring.wav',
          end: 'cues/end.wav',
        },
      },
    },
  };

  it('resolves relative paths against the yaml file directory when they exist there', () => {
    const paths = resolveCuePaths(raw, 'default', 'en', '/etc/starcomms/fleet.yaml');
    expect(paths.ready).toMatch(/cues\/en\/ready\.wav$/);
  });

  it('respects absolute paths as-is', () => {
    const abs = {
      cue_sets: {
        default: {
          en: {
            ready: '/absolute/ready.wav',
            attention: '/absolute/attention.wav',
            busy: '/absolute/busy.wav',
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
  });

  it('fails when the cue set is missing', () => {
    expect(() => resolveCuePaths(raw, 'militant', 'en', 'config/fleet.yaml')).toThrow(/cue_sets\.militant/);
  });

  it('fails when the locale is missing', () => {
    expect(() => resolveCuePaths(raw, 'default', 'fr', 'config/fleet.yaml')).toThrow(/fr missing/);
  });

  it('fails when a shared cue path is missing', () => {
    const partial = {
      cue_sets: {
        default: {
          en: { ready: 'x.wav', attention: 'x.wav', busy: 'x.wav' },
          shared: { end: 'x.wav' /* ring missing */ },
        },
      },
    };
    expect(() => resolveCuePaths(partial, 'default', 'en', 'config/fleet.yaml')).toThrow(/ring/);
  });
});

describe('placeholder cue files', () => {
  it('cues/en/ready.wav exists and is roughly 1200 ms at 48 kHz stereo', () => {
    const p = 'cues/en/ready.wav';
    if (!existsSync(p)) {
      // Skip when the placeholders have not been generated yet; the loader
      // integration test above covers the shape.
      return;
    }
    // 48000 Hz * 2 ch * 2 bytes * 1.2 s = 230400 audio bytes + WAV header (44).
    const size = statSync(p).size;
    expect(size).toBeGreaterThan(230_000);
    expect(size).toBeLessThan(231_000);
  });
});
