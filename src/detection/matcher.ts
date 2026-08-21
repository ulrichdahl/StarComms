/**
 * Callsign matcher — spec §5, three-layer.
 *
 *   1. Normalised **exact** match against the currently allocated
 *      callsigns in the session (≤ N per guild, N ≤ 12 in v1).
 *   2. Normalised **Levenshtein** at a tight threshold, restricted to
 *      the same small candidate list. Threshold scales with length so
 *      "alph" → "alpha" (dist 1) matches but "alpha" → "bravo" does not.
 *   3. Per-guild `alias_variants` DB lookup. Rows are added as operators
 *      accept misrecognitions ("record as variant" step-6b follow-up).
 *      An alias only wins if its canonical is currently allocated.
 *
 * Deliberately excluded: double-metaphone. Spec §5 calls this out —
 * double-metaphone is tuned to English orthography and misfires on
 * Danish STT output.
 */

import type { DB } from '../lib/db.js';

export type MatchLayer = 'exact' | 'levenshtein' | 'alias' | 'miss';

export interface MatchResult {
  layer: MatchLayer;
  callsign: string | null;
  heard: string;
  /** For diagnostics: distance if layer='levenshtein', undefined otherwise. */
  distance?: number;
}

export interface MatcherOptions {
  /** Callsigns currently allocated in this session, e.g. ['Alpha','Bravo']. */
  activeCallsigns: readonly string[];
  /** For the alias_variants lookup layer. Both must be present or layer 3 skips. */
  db?: DB;
  guildId?: string;
  /**
   * Explicit Levenshtein cap. Defaults to 2. The v1 callsign set (Command,
   * Alpha, Bravo, Charlie, Head Ops + `Ops` variants) has pairwise edit
   * distance ≥ 4 between any two, so a threshold of 2 is safe against
   * cross-matches while catching a dropped-char or a wrong-char miss.
   * If future callsigns become similar (e.g. two-letter add-ons), lower this.
   */
  levenshteinThreshold?: number;
}

const NORM_STRIP = /[^\p{L}\p{N}]/gu;

/**
 * Callsign normalisation. Strip all non-letter/digit chars (whitespace,
 * hyphens, apostrophes, Whisper artefacts), lowercase. "Alpha Ops" ->
 * "alphaops". This is looser than the verb-grammar normaliser on purpose:
 * callsigns are single tokens semantically, but STT emits them with
 * arbitrary word-boundaries.
 */
export function normaliseCallsign(s: string): string {
  return s.toLowerCase().replace(NORM_STRIP, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

const DEFAULT_THRESHOLD = 2;

export function matchCallsign(heard: string, opts: MatcherOptions): MatchResult {
  const normHeard = normaliseCallsign(heard);
  if (normHeard === '') return { layer: 'miss', callsign: null, heard };
  const active = opts.activeCallsigns.map((c) => ({ orig: c, norm: normaliseCallsign(c) }));

  // Layer 1: exact
  for (const a of active) {
    if (a.norm === normHeard) return { layer: 'exact', callsign: a.orig, heard };
  }

  // Layer 2: Levenshtein
  const threshold = opts.levenshteinThreshold ?? DEFAULT_THRESHOLD;
  let best: { orig: string; dist: number } | null = null;
  for (const a of active) {
    const dist = levenshtein(normHeard, a.norm);
    if (dist <= threshold && (best === null || dist < best.dist)) {
      best = { orig: a.orig, dist };
    }
  }
  if (best !== null) {
    return { layer: 'levenshtein', callsign: best.orig, heard, distance: best.dist };
  }

  // Layer 3: alias_variants
  if (opts.db !== undefined && opts.guildId !== undefined) {
    const row = opts.db.prepare(
      `SELECT canonical FROM alias_variants
       WHERE guild_id = ? AND kind = 'callsign' AND variant = ?`,
    ).get(opts.guildId, normHeard) as { canonical: string } | undefined;
    if (row !== undefined) {
      const canonicalNorm = normaliseCallsign(row.canonical);
      const activeMatch = active.find((a) => a.norm === canonicalNorm);
      if (activeMatch !== undefined) {
        return { layer: 'alias', callsign: activeMatch.orig, heard };
      }
    }
  }

  return { layer: 'miss', callsign: null, heard };
}
