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

// ---------------------------------------------------------------------------
// Whisper local driver — speaches sidecar over HTTP.
// ---------------------------------------------------------------------------

import { pcmToWav } from '../lib/audio.js';

export interface WhisperLocalOptions {
  /** e.g. `http://stt:8000/v1`. Trailing slash tolerated. */
  url: string;
  /** Faster-Whisper model id. Default: what speaches has cached. */
  model?: string;
  /** BCP-47 hint (`en`, `da`). Whisper autodetects if omitted. */
  language?: string;
  /** HTTP timeout per transcription. */
  timeoutMs?: number;
  /** Sample rate of incoming PCM. Detection ships 48 kHz mono. */
  sampleRate?: number;
  /**
   * Baked-in bias prompt sent with every transcription. Whisper's decoder
   * is far more likely to emit tokens that appear in the prompt, so
   * priming with our vocabulary (verbs + callsigns) turns "mandelpa" into
   * "Command Alpha" for free. Explicit `opts.hint` on a call still wins.
   * See DEFAULT_BIAS_PROMPTS for language defaults.
   */
  prompt?: string;
}

/**
 * Per-language biasing prompts. Short, all-vocabulary, no punctuation
 * (punctuation in the prompt tends to leak into the output).
 */
export const DEFAULT_BIAS_PROMPTS: Record<string, string> = {
  en: 'Command Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima hail command alert broadcast out over Head Ops',
  da: 'Kommando Alpha Bravo Charlie Delta kald ordre alarm udsend slut over Hovedops',
};

/**
 * Talks to a Speaches (formerly faster-whisper-server) sidecar over its
 * OpenAI-compatible transcriptions endpoint. Each call ships the utterance
 * as an in-memory WAV blob to POST {url}/audio/transcriptions. Server-side
 * resampling handles whatever rate we send.
 */
export class WhisperLocalDriver implements SttDriver {
  readonly name = 'whisper_local';
  private readonly base: string;
  private readonly model: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly sampleRate: number;
  private readonly biasPrompt: string;

  constructor(opts: WhisperLocalOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.model = opts.model ?? 'Systran/faster-whisper-tiny';
    this.language = opts.language ?? '';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sampleRate = opts.sampleRate ?? 48_000;
    if (opts.prompt !== undefined && opts.prompt !== '') {
      this.biasPrompt = opts.prompt;
    } else {
      this.biasPrompt = DEFAULT_BIAS_PROMPTS[this.language] ?? DEFAULT_BIAS_PROMPTS['en'] ?? '';
    }
  }

  get prompt(): string { return this.biasPrompt; }

  async transcribe(pcm: Buffer, opts?: { hint?: string; language?: string }): Promise<Transcript> {
    const wav = pcmToWav(pcm, { sampleRate: this.sampleRate, channels: 1, bitsPerSample: 16 });
    const lang = opts?.language ?? this.language;

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', this.model);
    if (lang !== '') form.append('language', lang);
    form.append('response_format', 'json');
    const prompt = opts?.hint !== undefined && opts.hint !== '' ? opts.hint : this.biasPrompt;
    if (prompt !== '') form.append('prompt', prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`whisper ${res.status}: ${body.slice(0, 200)}`);
      }
      const body = (await res.json()) as { text?: string; language?: string };
      return {
        text: (body.text ?? '').trim(),
        confidence: 1.0,           // speaches does not return per-utterance confidence
        language: body.language ?? lang ?? 'unknown',
        durationMs: pcmDurationMs(pcm, this.sampleRate, 1),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cheap readiness probe — hits /v1/models. Non-2xx → not ready. */
  async ready(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(`${this.base}/models`, { method: 'GET', signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
