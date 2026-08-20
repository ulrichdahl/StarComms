import { describe, expect, it } from 'vitest';
import { Vad, type VadEvent } from './vad.js';

const FRAME_SAMPLES = 960; // 20 ms at 48 kHz mono

function frame(rmsTarget: number): Buffer {
  // Fill a 20 ms mono s16le frame with a constant amplitude that produces
  // the requested RMS. For a DC/constant signal, |amp| == RMS on 0..1.
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  const value = Math.round(rmsTarget * 32_767);
  for (let i = 0; i < FRAME_SAMPLES; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

function feed(vad: Vad, frames: Buffer[]): VadEvent[] {
  return frames.map((f) => vad.onFrame(f));
}

describe('Vad', () => {
  it('stays silent under threshold', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05 });
    const events = feed(v, [frame(0.01), frame(0.02), frame(0.03)]);
    expect(events.every((e) => e === 'silent')).toBe(true);
    expect(v.status).toBe('silent');
  });

  it('opens on a frame above the start threshold', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05 });
    expect(v.onFrame(frame(0.2))).toBe('speech-start');
    expect(v.status).toBe('speaking');
  });

  it('emits speech-continue while sustained', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05, hangoverMs: 200 });
    v.onFrame(frame(0.2));
    for (let i = 0; i < 3; i++) {
      expect(v.onFrame(frame(0.2))).toBe('speech-continue');
    }
  });

  it('closes after the hangover elapses in continuous silence', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05, hangoverMs: 100 });
    // 5 hangover frames = 100 ms exactly. The 5th frame's quietMs reaches
    // hangoverMs and triggers speech-end.
    v.onFrame(frame(0.2)); // speaking, 20 ms
    // First quiet frame enters hangover, quiet=20
    // Then 4 more quiet frames: quiet=40,60,80,100 → 5th triggers end
    const events = [
      v.onFrame(frame(0.01)),
      v.onFrame(frame(0.01)),
      v.onFrame(frame(0.01)),
      v.onFrame(frame(0.01)),
      v.onFrame(frame(0.01)),
    ];
    expect(events[events.length - 1]).toBe('speech-end');
    expect(v.status).toBe('silent');
  });

  it('cancels an in-flight hangover if speech resumes', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05, hangoverMs: 200 });
    v.onFrame(frame(0.2));      // start
    v.onFrame(frame(0.01));     // hangover
    v.onFrame(frame(0.2));      // rebound
    expect(v.status).toBe('speaking');
  });

  it('force-ends after maxUtteranceMs', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05, maxUtteranceMs: 60 });
    v.onFrame(frame(0.2));       // 20 ms
    v.onFrame(frame(0.2));       // 40 ms
    // Third frame reaches 60 ms → force end
    expect(v.onFrame(frame(0.2))).toBe('speech-end');
    expect(v.status).toBe('silent');
  });

  it('resets cleanly for a new speaker', () => {
    const v = new Vad({ startThreshold: 0.1, stopThreshold: 0.05 });
    v.onFrame(frame(0.2));
    expect(v.status).toBe('speaking');
    v.reset();
    expect(v.status).toBe('silent');
  });
});
