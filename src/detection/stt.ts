/**
 * Speech-to-text driver interface — spec §5, §10, §16.6.
 *
 * v1 targets **local Whisper** via the `speaches` HTTP service in a sidecar
 * container (`docker compose --profile stt up`). That driver arrives with
 * the next step-6 commit. This one ships the interface and two references:
 *
 *   • FakeDriver          — deterministic canned responses, used by unit
 *                           tests and by manual verification when we want
 *                           to see the plumbing end-to-end without spinning
 *                           up a Whisper container.
 *   • ScriptedFakeDriver  — advances through a scripted sequence of
 *                           transcripts, so a test can simulate a
 *                           multi-utterance conversation deterministically.
 *
 * Only *call-up* utterances hit the STT (§5). The relay never transcribes
 * the message body — that runs through raw and its transcript is filled
 * in later by an asynchronous pass over the recorded call-up plus a lightly
 * scoped body window. All of that is downstream of this interface.
 */

export interface Transcript {
  text: string;
  /** 0..1, from the driver. Fake returns a fixed value. */
  confidence: number;
  /** BCP-47 (en, da) or 'unknown'. */
  language: string;
  /** Duration of the input audio the driver was asked to transcribe. */
  durationMs: number;
}

export interface SttDriver {
  readonly name: string;
  /** PCM is s16le, 48 kHz, mono at this layer (the receive path downsamples). */
  transcribe(pcm: Buffer, opts?: { hint?: string; language?: string }): Promise<Transcript>;
  /** Optional readiness probe — HTTP driver ends up implementing this. */
  ready?(): Promise<boolean>;
}

/**
 * Returns whatever transcript you configure at construction time. Useful
 * when you want to prove the audio → detection wire works end-to-end
 * without a Whisper container up.
 */
export class FakeDriver implements SttDriver {
  readonly name = 'fake';
  constructor(private readonly canned: string = 'command alpha') {}
  async transcribe(pcm: Buffer): Promise<Transcript> {
    return {
      text: this.canned,
      confidence: 1.0,
      language: 'en',
      durationMs: pcmDurationMs(pcm),
    };
  }
}

/**
 * Advances through a scripted sequence. Wraps around once exhausted so a
 * test does not have to know exactly how many utterances the code will
 * emit. Ordering matches the order utterances are transcribed.
 */
export class ScriptedFakeDriver implements SttDriver {
  readonly name = 'fake-scripted';
  private cursor = 0;
  constructor(private readonly script: readonly string[]) {}
  async transcribe(pcm: Buffer): Promise<Transcript> {
    const text = this.script[this.cursor % this.script.length] ?? '';
    this.cursor++;
    return {
      text,
      confidence: 1.0,
      language: 'en',
      durationMs: pcmDurationMs(pcm),
    };
  }
}

/** s16le mono 48 kHz duration in ms. Kept alongside so drivers do not need audio.ts. */
export function pcmDurationMs(pcm: Buffer, sampleRate = 48_000, channels = 1): number {
  const samples = pcm.length / (2 * channels);
  return (samples / sampleRate) * 1000;
}
