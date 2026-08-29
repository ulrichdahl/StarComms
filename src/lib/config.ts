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

/**
 * Guild-selectable languages. Text (buttons, replies, command
 * descriptions) and voice cues are both keyed by this id. The pirate
 * variants exist for event weeks; they are full locales, not flags on
 * en/da, so the cue loader and the string tables treat them uniformly.
 */
export const LOCALES = ['en', 'da', 'en-pirate', 'da-pirate'] as const;
export type Locale = typeof LOCALES[number];
export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x);
}

export interface FleetMember {
  /** NATO identifier for a relay bot — alfa/bravo/charlie/… Also the token_env key. */
  nato: string;
  applicationId: string;
  /** Resolved from the env var named by `token_env`. Not persisted anywhere. */
  token: string;
}

/**
 * Controller application — registers slash commands, creates + moves vessels,
 * holds channel-management permissions. Not part of the relay pool.
 */
export interface ControllerConfig {
  applicationId: string;
  token: string;
}

export interface FleetDefaults {
  locale: Locale;
  cueSet: string;
  cueDurationMs: number;
  ringIntervalMs: number;
  ringMaxMs: number;
  hailSilenceCloseMs: number;
  hailMaxHoldMs: number;
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
  cue_set?: unknown;
  cue_duration_ms?: unknown;
  ring_interval_ms?: unknown;
  ring_max_ms?: unknown;
  hail_silence_close_ms?: unknown;
  hail_max_hold_ms?: unknown;
}

interface RawConfig {
  controller?: unknown;
  fleet?: unknown;
  defaults?: unknown;
}

const DEFAULTS: FleetDefaults = {
  locale: 'en',
  cueSet: 'default',
  cueDurationMs: 1200,
  ringIntervalMs: 4_000,
  ringMaxMs: 20_000,
  hailSilenceCloseMs: 10_000,
  hailMaxHoldMs: 1_800_000,
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

  // The controller is a separate Discord application from any relay member.
  // It registers /star-comms and holds channel-management permissions;
  // relay bots only join voice channels for the duration of a hail.
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
    locale: pickEnum(rd.locale, 'defaults.locale', LOCALES, DEFAULTS.locale),
    cueSet: typeof rd.cue_set === 'string' ? rd.cue_set : DEFAULTS.cueSet,
    cueDurationMs: pickInt(rd.cue_duration_ms, 'defaults.cue_duration_ms', DEFAULTS.cueDurationMs),
    ringIntervalMs: pickInt(rd.ring_interval_ms, 'defaults.ring_interval_ms', DEFAULTS.ringIntervalMs),
    ringMaxMs: pickInt(rd.ring_max_ms, 'defaults.ring_max_ms', DEFAULTS.ringMaxMs),
    hailSilenceCloseMs: pickInt(rd.hail_silence_close_ms, 'defaults.hail_silence_close_ms', DEFAULTS.hailSilenceCloseMs),
    hailMaxHoldMs: pickInt(rd.hail_max_hold_ms, 'defaults.hail_max_hold_ms', DEFAULTS.hailMaxHoldMs),
  };

  return { controller, fleet, defaults, raw: parsed };
}

/** For logging: never emit the token. */
export function redactMember(m: FleetMember): Omit<FleetMember, 'token'> {
  const { token: _token, ...rest } = m;
  return rest;
}

export { NATO_ORDER };
