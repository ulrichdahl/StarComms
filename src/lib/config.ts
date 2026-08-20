/**
 * Fleet configuration loader.
 *
 * `config/fleet.yaml` names the fleet: one entry per Discord application, with
 * the env var that holds its token. Tokens themselves live in the environment,
 * not the file — the file is checked into infra, the tokens are not.
 *
 * The loader fails loud on shape errors. A silent shrug here strands a member
 * at boot, and a stranded member breaks the callsign→net map (spec §2).
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export type Locale = 'en' | 'da';
export type MuteMode = 'priority_speaker' | 'hard_mute';
export type SttDriver = 'whisper_local' | 'deepgram' | 'fake';

export interface FleetMember {
  /** NATO name in lowercase: alfa..lima. Doubles as the callsign in that guild. */
  nato: string;
  applicationId: string;
  /** Resolved from the env var named by `token_env`. Not persisted anywhere. */
  token: string;
}

/**
 * The 4-bot controller (see CLAUDE.md "Divergence from spec"). A separate
 * Discord application that registers `/star-bridge` and holds all channel-
 * management permissions. Not a squad member — never joins voice.
 */
export interface ControllerConfig {
  applicationId: string;
  token: string;
}

export interface FleetDefaults {
  locale: Locale;
  muteMode: MuteMode;
  sttDriver: SttDriver;
  cueSet: string;
  cueDurationMs: number;
  openTimeoutMs: number;
  silenceCloseMs: number;
  maxHoldMs: number;
  closeCueEnabled: boolean;
}

export interface FleetConfig {
  controller: ControllerConfig;
  fleet: FleetMember[];
  defaults: FleetDefaults;
  /** Untyped for step 2 — locales and cue_sets are consumed in later steps. */
  raw: unknown;
}

interface RawEntry {
  nato?: unknown;
  application_id?: unknown;
  token_env?: unknown;
}

interface RawController {
  application_id?: unknown;
  token_env?: unknown;
}

interface RawDefaults {
  locale?: unknown;
  mute_mode?: unknown;
  stt_driver?: unknown;
  cue_set?: unknown;
  cue_duration_ms?: unknown;
  open_timeout_ms?: unknown;
  silence_close_ms?: unknown;
  max_hold_ms?: unknown;
  close_cue_enabled?: unknown;
}

interface RawConfig {
  controller?: unknown;
  fleet?: unknown;
  defaults?: unknown;
}

const DEFAULTS: FleetDefaults = {
  locale: 'en',
  muteMode: 'priority_speaker',
  sttDriver: 'whisper_local',
  cueSet: 'default',
  cueDurationMs: 1200,
  openTimeoutMs: 5000,
  silenceCloseMs: 2000,
  maxHoldMs: 60_000,
  closeCueEnabled: true,
};

// Names are lowercased in state and on the wire; the operator may write any
// case in yaml. Order also fixes the wizard's slot-offering order (spec §2).
const NATO_ORDER = [
  'alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
  'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
];

class ConfigError extends Error {
  constructor(message: string) {
    super(`fleet.yaml: ${message}`);
    this.name = 'ConfigError';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function requireString(value: unknown, field: string, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${at}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function pickEnum<T extends string>(
  value: unknown, field: string, allowed: readonly T[], fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${field} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function pickInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function pickBool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${field} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Read and validate a fleet config file.
 *
 * Env is read via the provided `env` map — normally `process.env`, but tests
 * pass a fixture map so they never mutate the ambient environment.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): FleetConfig {
  const source = readFileSync(path, 'utf8');
  const parsed = parseYaml(source) as unknown;
  if (!isRecord(parsed)) {
    throw new ConfigError('top-level must be a mapping');
  }
  const raw = parsed as RawConfig;

  // The controller is a separate Discord application from any squad member —
  // see CLAUDE.md "Divergence from spec". It registers /star-bridge and holds
  // all channel-management permissions; squad bots only join voice.
  if (!isRecord(raw.controller)) {
    throw new ConfigError(
      'controller: block missing. The controller is a separate Discord ' +
      'application from any squad member; see fleet.example.yaml and CLAUDE.md.',
    );
  }
  const rc = raw.controller as RawController;
  const controllerAppId = requireString(rc.application_id, 'application_id', 'controller');
  if (!/^\d{15,20}$/.test(controllerAppId)) {
    throw new ConfigError(`controller: application_id must be a Discord snowflake, got ${controllerAppId}`);
  }
  const controllerTokenEnv = requireString(rc.token_env, 'token_env', 'controller');
  const controllerTokenRaw = env[controllerTokenEnv];
  if (controllerTokenRaw === undefined || controllerTokenRaw.trim() === '') {
    throw new ConfigError(`controller: env var ${controllerTokenEnv} is not set`);
  }
  const controller: ControllerConfig = {
    applicationId: controllerAppId,
    token: controllerTokenRaw.trim(),
  };

  if (!Array.isArray(raw.fleet) || raw.fleet.length === 0) {
    throw new ConfigError('fleet: must be a non-empty list');
  }

  const fleet: FleetMember[] = [];
  const seenNato = new Set<string>();
  const seenAppId = new Set<string>([controllerAppId]);
  const seenTokenEnv = new Set<string>([controllerTokenEnv]);

  for (let i = 0; i < raw.fleet.length; i++) {
    const entry = raw.fleet[i];
    const at = `fleet[${i}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`${at}: must be a mapping`);
    }
    const e = entry as RawEntry;
    if ('controller' in e) {
      throw new ConfigError(
        `${at}: controller flag is no longer supported on squad members. ` +
        'Define the controller in a top-level `controller:` block instead — see CLAUDE.md.',
      );
    }

    const natoRaw = requireString(e.nato, 'nato', at).toLowerCase();
    if (!NATO_ORDER.includes(natoRaw)) {
      throw new ConfigError(`${at}: nato ${JSON.stringify(natoRaw)} is not one of ${NATO_ORDER.join(', ')}`);
    }
    if (seenNato.has(natoRaw)) {
      throw new ConfigError(`${at}: duplicate nato ${natoRaw}`);
    }
    seenNato.add(natoRaw);

    const applicationId = requireString(e.application_id, 'application_id', at);
    if (!/^\d{15,20}$/.test(applicationId)) {
      throw new ConfigError(`${at}: application_id must be a Discord snowflake, got ${applicationId}`);
    }
    if (seenAppId.has(applicationId)) {
      throw new ConfigError(`${at}: application_id ${applicationId} is already used (controller or another squad member)`);
    }
    seenAppId.add(applicationId);

    const tokenEnv = requireString(e.token_env, 'token_env', at);
    if (seenTokenEnv.has(tokenEnv)) {
      throw new ConfigError(`${at}: token_env ${tokenEnv} is already used (controller or another squad member)`);
    }
    seenTokenEnv.add(tokenEnv);
    const token = env[tokenEnv];
    if (token === undefined || token.trim() === '') {
      throw new ConfigError(`${at}: env var ${tokenEnv} is not set`);
    }

    fleet.push({ nato: natoRaw, applicationId, token: token.trim() });
  }

  fleet.sort((a, b) => NATO_ORDER.indexOf(a.nato) - NATO_ORDER.indexOf(b.nato));

  const rd = (isRecord(raw.defaults) ? raw.defaults : {}) as RawDefaults;
  const defaults: FleetDefaults = {
    locale: pickEnum(rd.locale, 'defaults.locale', ['en', 'da'] as const, DEFAULTS.locale),
    muteMode: pickEnum(rd.mute_mode, 'defaults.mute_mode', ['priority_speaker', 'hard_mute'] as const, DEFAULTS.muteMode),
    sttDriver: pickEnum(rd.stt_driver, 'defaults.stt_driver', ['whisper_local', 'deepgram', 'fake'] as const, DEFAULTS.sttDriver),
    cueSet: typeof rd.cue_set === 'string' ? rd.cue_set : DEFAULTS.cueSet,
    cueDurationMs: pickInt(rd.cue_duration_ms, 'defaults.cue_duration_ms', DEFAULTS.cueDurationMs),
    openTimeoutMs: pickInt(rd.open_timeout_ms, 'defaults.open_timeout_ms', DEFAULTS.openTimeoutMs),
    silenceCloseMs: pickInt(rd.silence_close_ms, 'defaults.silence_close_ms', DEFAULTS.silenceCloseMs),
    maxHoldMs: pickInt(rd.max_hold_ms, 'defaults.max_hold_ms', DEFAULTS.maxHoldMs),
    closeCueEnabled: pickBool(rd.close_cue_enabled, 'defaults.close_cue_enabled', DEFAULTS.closeCueEnabled),
  };

  return { controller, fleet, defaults, raw: parsed };
}

/** For logging: never emit the token. */
export function redactMember(m: FleetMember): Omit<FleetMember, 'token'> {
  const { token: _token, ...rest } = m;
  return rest;
}

export { NATO_ORDER };
