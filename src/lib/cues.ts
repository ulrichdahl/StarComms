/**
 * Cue engine — spec §5 & §16.4.
 *
 * Cues are pre-decoded to raw Opus frames at startup and cached in memory,
 * so playback allocates only the enclosing stream — no disk read, no
 * transcode. Every cue in the active set must be exactly the same length as
 * `cue_duration_ms` within a small tolerance. The spec calls this out
 * because the caller's `Ready` and the receivers' `Attention` are started
 * on the same instant; unequal assets clip the first word of every
 * transmission (§5). Startup fails loud on a mismatch — a soft warning
 * would let a broken pair through undetected.
 *
 * Playback is object-mode: the loaded packets are re-emitted one per data
 * event via `StreamType.Opus`. That matches the `receiver.subscribe` shape
 * used by the blind relay, so the same audio-out path handles both.
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import {
  createAudioResource, StreamType, type AudioResource,
} from '@discordjs/voice';

export const CUE_NAMES = ['ready', 'attention', 'horn', 'negative', 'busy', 'out'] as const;
export type Cue = typeof CUE_NAMES[number];

/** Per-frame duration in ms at 48 kHz with frameSize 960. */
const FRAME_MS = 20;

export interface LoadedCue {
  name: Cue;
  path: string;
  packets: Buffer[];
  durationMs: number;
}

export type CuePaths = Record<Cue, string>;

/**
 * `ready`, `attention` and `horn` are the strict trio per §5. `negative`,
 * `busy` and `out` are diagnostic; they play alone and are not subject to
 * the equal-duration invariant. We still validate them against the same
 * target because a mismatched `busy` sounds unprofessional at best and
 * hides operator errors at worst — but we do not want a stray recording
 * mistake here to keep the fleet from booting, so they use a wider
 * tolerance than the strict trio.
 */
const STRICT_CUES = new Set<Cue>(['ready', 'attention', 'horn']);
const STRICT_TOLERANCE_MS = 40;   // 2 opus frames
const LOOSE_TOLERANCE_MS = 200;

export class CueLoadError extends Error {
  constructor(message: string) { super(`cues: ${message}`); this.name = 'CueLoadError'; }
}

/**
 * Load and validate every cue named in `paths`. Missing files, wrong
 * format, or a duration outside tolerance all raise CueLoadError before
 * the fleet touches Discord.
 */
export async function loadCueSet(
  paths: CuePaths,
  expectedDurationMs: number,
): Promise<CueSet> {
  const loaded = new Map<Cue, LoadedCue>();
  for (const name of CUE_NAMES) {
    const p = paths[name];
    if (typeof p !== 'string' || p === '') {
      throw new CueLoadError(`${name}: no path configured`);
    }
    try {
      await stat(p);
    } catch {
      throw new CueLoadError(`${name}: file not found at ${p}`);
    }
    const packets = await encodeToOpus(p);
    const durationMs = packets.length * FRAME_MS;
    const tolerance = STRICT_CUES.has(name) ? STRICT_TOLERANCE_MS : LOOSE_TOLERANCE_MS;
    if (Math.abs(durationMs - expectedDurationMs) > tolerance) {
      throw new CueLoadError(
        `${name} (${basename(p)}) is ${durationMs} ms, expected ${expectedDurationMs} ± ${tolerance} ms. ` +
        (STRICT_CUES.has(name)
          ? 'ready/attention/horn must match exactly or Ready ends before Attention and the first word clips (§5).'
          : 'this cue plays alone, but is still validated to catch operator mistakes.'),
      );
    }
    loaded.set(name, { name, path: p, packets, durationMs });
  }
  return new CueSet(loaded, expectedDurationMs);
}

/**
 * Decode an audio file with ffmpeg to 48 kHz stereo s16le, then encode
 * to Opus frames of frameSize 960 (20 ms). Returns the packet array.
 */
function encodeToOpus(path: string): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const packets: Buffer[] = [];
    const ffArgs = [
      '-i', path,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
    ];
    const ff = new prism.FFmpeg({ args: ffArgs });
    const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });

    const cleanup = (): void => {
      ff.removeAllListeners();
      encoder.removeAllListeners();
    };

    ff.on('error', (err: Error) => { cleanup(); reject(new CueLoadError(`ffmpeg: ${err.message}`)); });
    encoder.on('error', (err: Error) => { cleanup(); reject(new CueLoadError(`opus encoder: ${err.message}`)); });
    encoder.on('data', (packet: Buffer) => packets.push(Buffer.from(packet)));
    encoder.on('end', () => { cleanup(); resolve(packets); });

    // prism-media's FFmpeg is a Duplex — writing a file stream to it works,
    // but with `-i <path>` it reads the file directly. We use the path form
    // because it lets ffmpeg pick the container and codec on its own.
    createReadStream(path); // no-op, kept explicit so the intent is legible
    ff.pipe(encoder);
  });
}

export class CueSet {
  constructor(
    private readonly cues: Map<Cue, LoadedCue>,
    public readonly expectedDurationMs: number,
  ) {}

  /** Cached opus packets for the named cue. Throws if never loaded. */
  get(name: Cue): LoadedCue {
    const c = this.cues.get(name);
    if (c === undefined) throw new CueLoadError(`${name}: not loaded`);
    return c;
  }

  /** For /healthz surface. */
  summary(): { name: Cue; durationMs: number; packets: number; path: string }[] {
    return [...this.cues.values()].map((c) => ({
      name: c.name, durationMs: c.durationMs, packets: c.packets.length, path: c.path,
    }));
  }
}

/**
 * Build a fresh AudioResource for a cached cue. Every playback needs a new
 * Readable — a stream is single-use — but the underlying packet buffers are
 * shared, so this is cheap.
 */
export function createCueResource(cue: LoadedCue): AudioResource {
  const stream = new Readable({ objectMode: true, read() {} });
  for (const p of cue.packets) stream.push(p);
  stream.push(null);
  return createAudioResource(stream, { inputType: StreamType.Opus });
}

/**
 * Extract the cue paths for a locale from the parsed fleet.yaml. Not
 * folded into the config parser because the shape is loose and we want
 * cue loading to fail with its own error class, not ConfigError.
 *
 * Path resolution:
 *   1. Absolute paths are used as-is.
 *   2. Relative paths resolve against the yaml file's directory. This is
 *      the natural ops layout: `fleet.yaml` and `cues/` sit in the same
 *      config tree, so `cues/en/ready.wav` in the yaml means "next to me".
 *   3. If yaml-relative does not exist on disk, fall back to cwd-relative.
 *      This lets `npm run dev` from the repo root work with the shipped
 *      `fleet.example.yaml`, whose paths read like repo-rooted strings.
 */
export function resolveCuePaths(
  rawConfig: unknown,
  cueSet: string,
  locale: string,
  configPath: string,
): CuePaths {
  const raw = rawConfig as Record<string, unknown>;
  const sets = raw['cue_sets'] as Record<string, unknown> | undefined;
  if (sets === undefined) throw new CueLoadError('fleet.yaml has no cue_sets');
  const set = sets[cueSet] as Record<string, unknown> | undefined;
  if (set === undefined) throw new CueLoadError(`fleet.yaml has no cue_sets.${cueSet}`);
  const localized = set[locale] as Record<string, string> | undefined;
  const shared = set['shared'] as Record<string, string> | undefined;
  if (localized === undefined) throw new CueLoadError(`cue_sets.${cueSet}.${locale} missing`);

  const configDir = dirname(resolve(configPath));

  const resolveOne = (raw: string): string => {
    if (isAbsolute(raw)) return raw;
    const yamlRelative = resolve(configDir, raw);
    if (existsSync(yamlRelative)) return yamlRelative;
    return resolve(process.cwd(), raw);
  };

  const paths: Partial<CuePaths> = {};
  const localizedNames: readonly Cue[] = ['ready', 'attention', 'negative', 'busy'];
  const sharedNames: readonly Cue[] = ['horn', 'out'];

  for (const n of localizedNames) {
    const v = localized[n];
    if (typeof v !== 'string') throw new CueLoadError(`cue_sets.${cueSet}.${locale}.${n} must be a string path`);
    paths[n] = resolveOne(v);
  }
  for (const n of sharedNames) {
    const v = shared?.[n];
    if (typeof v !== 'string') throw new CueLoadError(`cue_sets.${cueSet}.shared.${n} must be a string path`);
    paths[n] = resolveOne(v);
  }
  return paths as CuePaths;
}
