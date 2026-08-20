/**
 * Utterance segmenter — energy-based VAD.
 *
 * Spec §5 says the detection pipeline uses silero VAD. Silero is a small
 * ONNX model; it is worth the dependency once we have real Danish audio
 * to tune against, but not before. This first pass is a plain RMS-over-
 * threshold gate with hangover, which is enough to prove the wiring and
 * often enough for clean, close-miked comms voice.
 *
 * The gate maintains a per-SSRC state:
 *
 *   SILENT      no speech detected
 *   SPEAKING    RMS crossed the start threshold; frames accumulate
 *   HANGOVER    RMS below stop threshold; wait N ms for a rebound
 *
 * Transitions are surfaced as events so the caller can accumulate the
 * PCM in a buffer and, on utterance-end, ship it to STT. The VAD itself
 * does not buffer audio — it stays cheap and stateless per-frame.
 *
 * All frames arriving here are 20 ms of s16le mono 48 kHz (960 samples).
 * The receive-path downsamples from stereo 48 kHz before calling us.
 */

export type VadEvent = 'silent' | 'speech-start' | 'speech-continue' | 'speech-end';

export interface VadOptions {
  /** RMS on 0..1 that flips SILENT → SPEAKING. Voice above the room floor. */
  startThreshold: number;
  /** RMS on 0..1 below which we enter HANGOVER. Slightly lower than start. */
  stopThreshold: number;
  /** ms of continuous quiet below stopThreshold before end fires. §5 silence_close_ms is a related but per-net timer. */
  hangoverMs: number;
  /** Cap on how long a single utterance can be before we force an end. Prevents runaway open microphones. */
  maxUtteranceMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  startThreshold: 0.02,   // ~ -34 dBFS
  stopThreshold: 0.008,   // ~ -42 dBFS, sits above typical room floor
  hangoverMs: 400,
  maxUtteranceMs: 8_000,  // callups are short; anything past this is not a callup
};

const FRAME_MS = 20; // one @discordjs/voice opus frame at 48 kHz / 960 samples

interface State {
  status: 'silent' | 'speaking' | 'hangover';
  quietMs: number;
  utteranceMs: number;
}

export class Vad {
  private readonly opts: VadOptions;
  private state: State = { status: 'silent', quietMs: 0, utteranceMs: 0 };

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
  }

  /**
   * Feed one 20 ms mono s16le frame. Returns the transition event, or
   * 'silent' when nothing changed and no speech is in progress.
   */
  onFrame(pcm: Buffer): VadEvent {
    const level = rms(pcm);
    switch (this.state.status) {
      case 'silent': {
        if (level >= this.opts.startThreshold) {
          this.state = { status: 'speaking', quietMs: 0, utteranceMs: FRAME_MS };
          return 'speech-start';
        }
        return 'silent';
      }
      case 'speaking': {
        this.state.utteranceMs += FRAME_MS;
        if (this.state.utteranceMs >= this.opts.maxUtteranceMs) {
          this.state = { status: 'silent', quietMs: 0, utteranceMs: 0 };
          return 'speech-end';
        }
        if (level < this.opts.stopThreshold) {
          this.state = { status: 'hangover', quietMs: FRAME_MS, utteranceMs: this.state.utteranceMs };
          return 'speech-continue';
        }
        return 'speech-continue';
      }
      case 'hangover': {
        this.state.utteranceMs += FRAME_MS;
        if (this.state.utteranceMs >= this.opts.maxUtteranceMs) {
          this.state = { status: 'silent', quietMs: 0, utteranceMs: 0 };
          return 'speech-end';
        }
        if (level >= this.opts.startThreshold) {
          this.state = { status: 'speaking', quietMs: 0, utteranceMs: this.state.utteranceMs };
          return 'speech-continue';
        }
        this.state.quietMs += FRAME_MS;
        if (this.state.quietMs >= this.opts.hangoverMs) {
          this.state = { status: 'silent', quietMs: 0, utteranceMs: 0 };
          return 'speech-end';
        }
        return 'speech-continue';
      }
    }
  }

  /** Reset the state machine — used when a speaker drops off the SSRC. */
  reset(): void {
    this.state = { status: 'silent', quietMs: 0, utteranceMs: 0 };
  }

  /** For diagnostics only. */
  get status(): State['status'] { return this.state.status; }
}

/**
 * s16le mono RMS in [0, 1]. Kept alongside so vad.ts is self-contained —
 * lib/audio.ts's rms() operates on the same shape but lives with the spike.
 */
function rms(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2) / 32_768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}
