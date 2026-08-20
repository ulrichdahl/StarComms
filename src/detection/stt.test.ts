import { describe, expect, it } from 'vitest';
import { FakeDriver, ScriptedFakeDriver, pcmDurationMs } from './stt.js';

const oneSecondPcm48kMono = (): Buffer => Buffer.alloc(48_000 * 2);

describe('FakeDriver', () => {
  it('returns the canned text at full confidence', async () => {
    const d = new FakeDriver('command alpha');
    const r = await d.transcribe(oneSecondPcm48kMono());
    expect(r.text).toBe('command alpha');
    expect(r.confidence).toBe(1);
    expect(r.language).toBe('en');
  });

  it('reports the audio duration back to the caller', async () => {
    const d = new FakeDriver();
    const r = await d.transcribe(oneSecondPcm48kMono());
    expect(r.durationMs).toBeCloseTo(1000, 0);
  });
});

describe('ScriptedFakeDriver', () => {
  it('emits each scripted line in order', async () => {
    const d = new ScriptedFakeDriver(['command alpha', 'hail bravo', 'out']);
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      texts.push((await d.transcribe(oneSecondPcm48kMono())).text);
    }
    expect(texts).toEqual(['command alpha', 'hail bravo', 'out']);
  });

  it('wraps around once the script is exhausted', async () => {
    const d = new ScriptedFakeDriver(['a', 'b']);
    const texts: string[] = [];
    for (let i = 0; i < 5; i++) {
      texts.push((await d.transcribe(oneSecondPcm48kMono())).text);
    }
    expect(texts).toEqual(['a', 'b', 'a', 'b', 'a']);
  });
});

describe('pcmDurationMs', () => {
  it('measures a 1 s 48 kHz mono buffer as ~1000 ms', () => {
    expect(pcmDurationMs(Buffer.alloc(48_000 * 2))).toBeCloseTo(1000, 3);
  });

  it('measures a 500 ms 48 kHz mono buffer as ~500 ms', () => {
    expect(pcmDurationMs(Buffer.alloc(24_000 * 2))).toBeCloseTo(500, 3);
  });

  it('handles stereo by dividing samples by the channel count', () => {
    expect(pcmDurationMs(Buffer.alloc(48_000 * 2 * 2), 48_000, 2)).toBeCloseTo(1000, 3);
  });
});
