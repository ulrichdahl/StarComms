/**
 * Reading an installed dependency's version.
 *
 * `require('<pkg>/package.json')` fails on packages whose `exports` map does
 * not expose it — @discordjs/voice is one — so this layers three strategies.
 * The version guard in the receive spike depends on this working: a silent
 * "could not determine version" would let 0.19.0 through, and 0.19.0 cannot
 * decrypt received audio at all (spec §15).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

const require = createRequire(import.meta.url);

function readNameAndVersion(file: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** Walk up from `start`, returning the first package.json whose name matches. */
function walkUpFor(start: string, name: string): string | null {
  let dir = start;
  const { root } = parsePath(dir);
  for (;;) {
    const candidate = join(dir, 'package.json');
    const pkg = readNameAndVersion(candidate);
    if (pkg?.name === name && typeof pkg.version === 'string') return pkg.version;
    const parent = dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

export function packageVersion(name: string): string | null {
  // 1. Exported package.json, when the package allows it.
  try {
    const pkg = require(`${name}/package.json`) as { version?: string };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall through
  }

  // 2. Resolve the entry point and walk up to the package root.
  try {
    const entry = require.resolve(name);
    const found = walkUpFor(dirname(entry), name);
    if (found !== null) return found;
  } catch {
    // fall through
  }

  // 3. Direct read from node_modules, searching upward from the cwd.
  let dir = process.cwd();
  for (;;) {
    const pkg = readNameAndVersion(join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (typeof pkg?.version === 'string') return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return null;
  return {
    major: Number.parseInt(m[1] as string, 10),
    minor: Number.parseInt(m[2] as string, 10),
    patch: Number.parseInt(m[3] as string, 10),
  };
}

/** True when `version` is >= the given major.minor.patch. */
export function atLeast(version: string, min: Semver): boolean {
  const v = parseSemver(version);
  if (v === null) return false;
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}
