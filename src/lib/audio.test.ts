import { describe, expect, it } from 'vitest';
import { dbfs, durationMs, meter, rms } from './audio.js';

function tone(samples: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / 48) * Math.PI * 2) * amplitude * 32_767), i * 2);
  }
  return buf;
}

describe('rms', () => {
  it('is zero for an empty buffer', () => {
    expect(rms(Buffer.alloc(0))).toBe(0);
  });

  it('is zero for digital silence', () => {
    expect(rms(Buffer.alloc(960 * 2 * 2))).toBe(0);
  });

  it('approximates 1/sqrt(2) of peak for a full-scale sine', () => {
    expect(rms(tone(4800, 1))).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('scales with amplitude', () => {
    expect(rms(tone(4800, 0.25))).toBeLessThan(rms(tone(4800, 0.5)));
  });
});

describe('dbfs', () => {
  it('floors silence at -90', () => {
    expect(dbfs(0)).toBe(-90);
  });

  it('maps unity to 0 dBFS', () => {
    expect(dbfs(1)).toBeCloseTo(0, 6);
  });
});

describe('durationMs', () => {
  it('measures one 960-sample stereo frame as 20 ms', () => {
    expect(durationMs(960 * 2 * 2)).toBeCloseTo(20, 6);
  });
});

describe('meter', () => {
  it('renders a fixed width', () => {
    expect(meter(0, 20)).toHaveLength(20);
    expect(meter(1, 20)).toHaveLength(20);
  });

  it('is empty at silence and full at unity', () => {
    expect(meter(0, 10)).toBe('..........');
    expect(meter(1, 10)).toBe('##########');
  });
});

describe('pcmToWav', () => {
  it('produces a 44-byte header plus the PCM payload', async () => {
    const { pcmToWav } = await import('./audio.js');
    const pcm = Buffer.alloc(48_000 * 2); // 1 s mono s16le at 48 kHz
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
  });

  it('encodes the sample rate + channels + bits-per-sample', async () => {
    const { pcmToWav } = await import('./audio.js');
    const wav = pcmToWav(Buffer.alloc(0), { sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect(wav.readUInt16LE(22)).toBe(1);           // channels
    expect(wav.readUInt32LE(24)).toBe(16_000);      // sample rate
    expect(wav.readUInt32LE(28)).toBe(32_000);      // byte rate = 16000 * 1 * 2
    expect(wav.readUInt16LE(32)).toBe(2);           // block align
    expect(wav.readUInt16LE(34)).toBe(16);          // bits per sample
  });

  it('records the data chunk size', async () => {
    const { pcmToWav } = await import('./audio.js');
    const pcm = Buffer.alloc(2000);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(40)).toBe(2000);
    expect(wav.readUInt32LE(4)).toBe(36 + 2000);    // RIFF chunk size
  });
});
