import { describe, expect, it } from 'vitest';
import { LOCALES } from './config.js';
import { LOCALE_META, stringsFor, type Strings } from './i18n.js';

/**
 * Walk a Strings table and yield every leaf, invoking function leaves
 * with representative arguments so their output is length-checked too.
 */
function* leaves(obj: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof obj === 'function') {
    const fn = obj as (...a: unknown[]) => string;
    yield [path.join('.'), fn(24, 24, 24)];
    yield [path.join('.'), fn('123456789012345678', 'x')];
    return;
  }
  if (typeof obj === 'string') { yield [path.join('.'), obj]; return; }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) yield* leaves(v, [...path, k]);
}

describe('i18n tables', () => {
  it('every locale resolves to its own table', () => {
    const seen = new Set<Strings>();
    for (const l of LOCALES) {
      const s = stringsFor(l);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  it('unknown locales fall back to English', () => {
    expect(stringsFor('xx')).toBe(stringsFor('en'));
  });

  it('every locale has selector metadata', () => {
    for (const l of LOCALES) {
      expect(LOCALE_META[l].label.length).toBeGreaterThan(0);
      expect(LOCALE_META[l].label.length).toBeLessThanOrEqual(100);
      expect(LOCALE_META[l].description.length).toBeLessThanOrEqual(100);
    }
  });

  it('no leaf is empty and every leaf respects Discord limits', () => {
    for (const l of LOCALES) {
      for (const [path, text] of leaves(stringsFor(l))) {
        expect(text.length, `${l}:${path}`).toBeGreaterThan(0);
        if (path.startsWith('cmd.')) expect(text.length, `${l}:${path}`).toBeLessThanOrEqual(100);
        if (/\.btn[A-Z]/.test(path)) expect(text.length, `${l}:${path}`).toBeLessThanOrEqual(80);
        if (/Title$|Label$/.test(path) && path.startsWith('panelHandlers.')) {
          expect(text.length, `${l}:${path}`).toBeLessThanOrEqual(45);
        }
        if (/Placeholder/.test(path)) expect(text.length, `${l}:${path}`).toBeLessThanOrEqual(150);
        expect(text.length, `${l}:${path}`).toBeLessThanOrEqual(2000);
      }
    }
  });

  it('pirate tables differ from their base language', () => {
    const en = [...leaves(stringsFor('en'))].map(([, t]) => t).join('\n');
    const enP = [...leaves(stringsFor('en-pirate'))].map(([, t]) => t).join('\n');
    const da = [...leaves(stringsFor('da'))].map(([, t]) => t).join('\n');
    const daP = [...leaves(stringsFor('da-pirate'))].map(([, t]) => t).join('\n');
    expect(enP).not.toBe(en);
    expect(daP).not.toBe(da);
  });
});
