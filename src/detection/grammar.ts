/**
 * Call-up grammar — spec §5.
 *
 * A call-up is a verb followed by an optional callsign:
 *
 *   command <callsign>   → open a squad net (command mode)
 *   hail    <callsign>   → open a peer / ops net (guild-wide)
 *   alert   [callsign]   → session-wide horn, preempts busy nets
 *   broadcast [callsign] → session-wide attention, skips busy nets
 *   out / over / slut    → close the current net (§14)
 *
 * Whisper transcripts are noisy. The parser strips punctuation, lowercases,
 * collapses whitespace, then scans left-to-right for the first token that
 * is a verb in the guild's locale. Everything after that verb is treated
 * as the callsign candidate (with a NATO-callsign matcher in matcher.ts
 * doing the actual resolution — the parser only isolates the *heard*
 * string, it does not decide validity).
 *
 * Locale is per guild (§17.5). Verbs are locale-specific; NATO callsigns
 * are locale-neutral so the parser needs no callsign vocabulary.
 */

export type Locale = 'en' | 'da';

export type Verb = 'command' | 'hail' | 'alert' | 'broadcast' | 'terminator';

export interface CallupParsed {
  verb: Verb;
  /** Raw callsign text as heard, null if the verb does not carry one. */
  callsignHeard: string | null;
  /** Original transcript, retained for logs / miss reporting. */
  raw: string;
}

const VERB_MAPS: Record<Locale, ReadonlyMap<string, Verb>> = {
  en: new Map<string, Verb>([
    ['command', 'command'],
    ['hail', 'hail'],
    ['alert', 'alert'],
    ['broadcast', 'broadcast'],
    ['out', 'terminator'],
    ['over', 'terminator'],
  ]),
  da: new Map<string, Verb>([
    ['ordre', 'command'],
    ['kald', 'hail'],
    ['alarm', 'alert'],
    ['udsend', 'broadcast'],
    ['slut', 'terminator'],
    // "Over" is used in Danish comms too, per §17.10.
    ['over', 'terminator'],
  ]),
};

/** Verbs that MUST have a callsign to be actionable. */
const CALLSIGN_REQUIRED = new Set<Verb>(['command', 'hail']);

/**
 * Strip characters that Whisper occasionally emits (punctuation, quotes),
 * collapse whitespace, lowercase. Keeps Unicode letters + numbers via the
 * `\p{L}\p{N}` classes so Danish æ/ø/å survive.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a transcript into a call-up, or return null if no verb is present
 * (in which case the utterance is not a call-up — could be conversational).
 */
export function parseCallup(text: string, locale: Locale = 'en'): CallupParsed | null {
  const norm = normalise(text);
  if (norm === '') return null;
  const tokens = norm.split(' ');
  const verbs = VERB_MAPS[locale];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const verb = verbs.get(token);
    if (verb === undefined) continue;

    if (verb === 'terminator') {
      return { verb, callsignHeard: null, raw: text };
    }

    const tail = tokens.slice(i + 1).join(' ').trim();

    if (CALLSIGN_REQUIRED.has(verb)) {
      if (tail === '') return null;    // "hail" alone is not a valid call-up
      return { verb, callsignHeard: tail, raw: text };
    }

    // alert / broadcast: callsign is optional
    return { verb, callsignHeard: tail === '' ? null : tail, raw: text };
  }

  return null;
}
