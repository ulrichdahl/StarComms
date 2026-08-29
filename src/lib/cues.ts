/**
 * Cue engine — spec §5 & §16.4.
 *
 * Cues are pre-decoded to raw Opus frames at startup and cached in memory,
 * so playback allocates only the enclosing stream — no disk read, no
 * transcode. Cues play in full — the strict-equal-duration invariant that
 * used to govern Ready + Attention was retired when the hail flow moved
 * to `entersState(player, Idle)` for cue-end sync; length now varies per
 * asset and per locale.
 *
 * Playback is object-mode: the loaded packets are re-emitted one per data
 * event via `StreamType.Opus`. That matches the `receiver.subscribe` shape
 * used by the mixer path, so the same audio-out plumbing handles both.
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import {
  createAudioResource, StreamType, type AudioResource,
} from '@discordjs/voice';
import { LOCALES, type Locale } from './config.js';

export const CUE_NAMES = [
  'ready', 'attention', 'ring', 'busy', 'end',
  'established', 'disconnected',
] as const;
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

export class CueLoadError extends Error {
  constructor(message: string) { super(`cues: ${message}`); this.name = 'CueLoadError'; }
}

/**
 * Load every cue named in `paths`. Missing files or a decoder failure raise
 * CueLoadError before the fleet touches Discord. Duration is recorded per
 * cue but not validated against a target — cues play to completion.
 */
export async function loadCueSet(paths: CuePaths): Promise<CueSet> {
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
    loaded.set(name, { name, path: p, packets, durationMs });
  }
  return new CueSet(loaded);
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
  constructor(private readonly cues: Map<Cue, LoadedCue>) {}

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
 * Every locale's CueSet, keyed by locale, plus the fallback rule.
 *
 * Guilds pick their language at runtime (`/star-comms set-language`),
 * so the fleet must hold cue audio for every locale it might be asked
 * for. A locale that has no cue block in fleet.yaml, or whose assets
 * failed to load, is absent from the map; `forLocale` then returns the
 * default locale's set so a hail still plays *something* rather than
 * failing at cue-lookup time. The text side of that guild is still in
 * its chosen language — only the audio degrades.
 */
export class CueLibrary {
  constructor(
    private readonly sets: Map<Locale, CueSet>,
    readonly defaultLocale: Locale,
  ) {
    if (!sets.has(defaultLocale)) {
      throw new CueLoadError(`default locale ${defaultLocale} has no loaded cue set`);
    }
  }

  /** True when this locale has its own audio (no fallback needed). */
  has(locale: Locale): boolean { return this.sets.has(locale); }

  /** Locales with their own audio, in LOCALES order. */
  loadedLocales(): Locale[] { return LOCALES.filter((l) => this.sets.has(l)); }

  /** The locale's own set, or the default locale's set when absent. */
  forLocale(locale: Locale): CueSet {
    return this.sets.get(locale) ?? this.sets.get(this.defaultLocale)!;
  }
}

/**
 * Load a CueSet for every locale that has a block under
 * `cue_sets.<cueSet>` in fleet.yaml. The default locale is mandatory
 * and fails loud; any other locale that fails to resolve or load is
 * skipped with a warning via `onSkip` so a missing pirate set does not
 * take the fleet down.
 */
export async function loadCueLibrary(
  rawConfig: unknown,
  cueSet: string,
  defaultLocale: Locale,
  configPath: string,
  onSkip: (locale: Locale, reason: string) => void = () => {},
): Promise<CueLibrary> {
  const sets = new Map<Locale, CueSet>();
  for (const locale of LOCALES) {
    try {
      const paths = resolveCuePaths(rawConfig, cueSet, locale, configPath);
      sets.set(locale, await loadCueSet(paths));
    } catch (err) {
      if (locale === defaultLocale) throw err;
      onSkip(locale, err instanceof Error ? err.message : String(err));
    }
  }
  return new CueLibrary(sets, defaultLocale);
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
  const localizedNames: readonly Cue[] = [
    'ready', 'attention', 'busy', 'established', 'disconnected',
  ];
  const sharedNames: readonly Cue[] = ['ring', 'end'];

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
