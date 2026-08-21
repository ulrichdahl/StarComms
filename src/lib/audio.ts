/** PCM helpers. Discord voice receive decodes to signed 16-bit LE, 48 kHz, stereo. */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960;

/**
 * Root-mean-square amplitude of an s16le buffer, normalised to 0..1.
 *
 * This is the spike's proof of decryption: a failed DAVE handshake yields no
 * packets at all rather than garbage, so any sustained non-zero RMS on a
 * decoded stream means the AEAD open succeeded.
 */
export function rms(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2) / 32_768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/** Approximate dBFS from a normalised RMS value. Floors at -90 for silence. */
export function dbfs(rmsValue: number): number {
  if (rmsValue <= 0) return -90;
  return Math.max(-90, 20 * Math.log10(rmsValue));
}

/** Milliseconds of audio in an s16le stereo 48 kHz buffer. */
export function durationMs(byteLength: number): number {
  return (byteLength / (2 * CHANNELS)) / (SAMPLE_RATE / 1000);
}

/** Fixed-width level meter for terminal output. */
export function meter(rmsValue: number, width = 20): string {
  const db = dbfs(rmsValue);
  const filled = Math.max(0, Math.min(width, Math.round(((db + 60) / 60) * width)));
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

/**
 * Wrap raw s16le PCM in a canonical 44-byte-header WAV container.
 * Sample-rate defaults to 48 kHz mono, matching what the detection listener
 * downmixes to before shipping to STT. Whisper is trained on 16 kHz internally
 * but Speaches accepts arbitrary rates and resamples server-side.
 */
export function pcmToWav(
  pcm: Buffer,
  opts: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? 48_000;
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM fmt chunk size
  header.writeUInt16LE(1, 20);         // AudioFormat = 1 (PCM, no compression)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
