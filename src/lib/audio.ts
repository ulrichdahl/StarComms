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
