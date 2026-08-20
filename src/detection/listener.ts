/**
 * Detection listener — spec §5, §16.6.
 *
 * Attaches to the primary net's VoiceConnection (Command in command mode,
 * Head Ops in joint mode). For every non-fleet speaker on that channel:
 *
 *   1. Subscribe to their opus stream via receiver.subscribe.
 *   2. Decode to s16le 48 kHz stereo via prism.opus.Decoder.
 *   3. Downmix to mono in 20 ms frames (the shape the VAD expects).
 *   4. Feed the VAD; on `speech-end`, ship the accumulated PCM to STT.
 *   5. Emit a Detection event with the transcript.
 *
 * Fleet audio is dropped at receiver.speaking.on('start') — the same §5
 * hard constraint the blind relay enforces. Without it, cues re-trigger
 * detection.
 *
 * This module does *not* yet parse verb + callsign or route audio. That
 * lands in step 6b (grammar + state machine) and 6c (session-driven
 * relay). Step 6a is the wire: microphone → transcript.
 */

import {
  EndBehaviorType,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { EventEmitter } from 'node:events';
import { Vad, type VadEvent } from './vad.js';
import type { SttDriver, Transcript } from './stt.js';

export interface Detection {
  userId: string;
  transcript: Transcript;
  /** UTC ms when the utterance was detected as ended (before STT ran). */
  detectedAt: number;
  /** Peak RMS observed during the utterance, 0..1. Diagnostic. */
  peakRms: number;
}

export interface DetectionListenerOptions {
  connection: VoiceConnection;
  stt: SttDriver;
  /** Called on `speaking.start` to decide whether to subscribe. */
  fleetUserIds: () => Set<string>;
}

const FRAME_SAMPLES = 960;                    // 20 ms at 48 kHz
const STEREO_FRAME_BYTES = FRAME_SAMPLES * 2 * 2; // s16le stereo
const MONO_FRAME_BYTES = FRAME_SAMPLES * 2;    // s16le mono after downmix

interface SpeakerState {
  vad: Vad;
  utterance: Buffer[]; // accumulated mono frames while speech is in progress
  peakRms: number;
  scratch: Buffer;     // spillover between decoded chunks that were not a multiple of a frame
}

export class DetectionListener extends EventEmitter {
  private readonly speakers = new Map<string, SpeakerState>();
  private stopping = false;

  constructor(private readonly cfg: DetectionListenerOptions) {
    super();
    this.attach();
  }

  private attach(): void {
    const receiver = this.cfg.connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      if (this.stopping) return;
      // §5: drop fleet audio at the earliest edge. Without this, cues we
      // play on this same connection re-trigger detection.
      if (this.cfg.fleetUserIds().has(userId)) return;
      if (this.speakers.has(userId)) return;

      const state: SpeakerState = {
        vad: new Vad(),
        utterance: [],
        peakRms: 0,
        scratch: Buffer.alloc(0),
      };
      this.speakers.set(userId, state);

      const opus = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });

      decoder.on('data', (chunk: Buffer) => this.onDecoded(userId, chunk));
      decoder.on('error', () => { /* stream will close; state cleaned in release */ });
      opus.on('error', () => { /* same */ });

      const release = (): void => {
        this.speakers.delete(userId);
        decoder.destroy();
      };
      opus.on('end', release);
      opus.on('close', release);
      opus.pipe(decoder);
    });
  }

  /**
   * `data` events from prism.opus.Decoder arrive as arbitrary-length s16le
   * stereo buffers. Slice into 20 ms stereo frames, downmix to mono, feed
   * the VAD, buffer PCM while speech is in flight, and dispatch to STT on
   * `speech-end`.
   */
  private onDecoded(userId: string, chunk: Buffer): void {
    const state = this.speakers.get(userId);
    if (state === undefined) return;

    const stereo = state.scratch.length > 0 ? Buffer.concat([state.scratch, chunk]) : chunk;
    const wholeFrames = Math.floor(stereo.length / STEREO_FRAME_BYTES);
    for (let i = 0; i < wholeFrames; i++) {
      const stereoFrame = stereo.subarray(i * STEREO_FRAME_BYTES, (i + 1) * STEREO_FRAME_BYTES);
      const monoFrame = downmixToMono(stereoFrame);
      const evt = state.vad.onFrame(monoFrame);
      this.handleVad(userId, state, monoFrame, evt);
    }
    state.scratch = stereo.subarray(wholeFrames * STEREO_FRAME_BYTES);
  }

  private handleVad(userId: string, state: SpeakerState, frame: Buffer, evt: VadEvent): void {
    if (evt === 'speech-start') {
      state.utterance = [frame];
      state.peakRms = rms(frame);
      return;
    }
    if (evt === 'speech-continue') {
      state.utterance.push(frame);
      const r = rms(frame);
      if (r > state.peakRms) state.peakRms = r;
      return;
    }
    if (evt === 'speech-end') {
      const pcm = Buffer.concat(state.utterance);
      const peakRms = state.peakRms;
      state.utterance = [];
      state.peakRms = 0;
      void this.runStt(userId, pcm, peakRms);
      return;
    }
    // 'silent' → nothing to do
  }

  private async runStt(userId: string, pcm: Buffer, peakRms: number): Promise<void> {
    const detectedAt = Date.now();
    try {
      const transcript = await this.cfg.stt.transcribe(pcm);
      const detection: Detection = { userId, transcript, detectedAt, peakRms };
      this.emit('detection', detection);
    } catch (err) {
      console.error(`detection: STT failed for ${userId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  stop(): void {
    this.stopping = true;
    this.speakers.clear();
    this.removeAllListeners();
  }
}

/** Two s16le channels interleaved → one s16le mono via arithmetic mean. */
function downmixToMono(stereo: Buffer): Buffer {
  const out = Buffer.alloc(MONO_FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((l + r) / 2), i * 2);
  }
  return out;
}

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
