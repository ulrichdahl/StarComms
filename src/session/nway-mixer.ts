/**
 * N-way audio mixer — spec §16 "future work" pulled forward.
 *
 * Every 20 ms:
 *
 *   • Each source's decoder pops the oldest queued PCM frame (or
 *     silence if the queue is empty). This is the "current frame"
 *     for that source at this tick.
 *   • For every sink, we sum the PCM samples of every source **except
 *     the sink's own source** (no self-echo), clip to int16, then
 *     encode a single opus frame per sink.
 *   • Each sink's opus frame is pushed into the sink's PassThrough,
 *     which is already wrapped in an AudioResource playing on that
 *     sink's outbound AudioPlayer.
 *
 * This replaces last-speaker-wins. Every active speaker is audible
 * simultaneously on every other channel. The trade-off is decode +
 * mix + encode CPU per tick — negligible on modern hardware for
 * N ≤ 5 or so.
 *
 * Discord voice runs at 48 kHz stereo 20 ms frames. That is 960
 * samples per channel = 1920 int16 samples = 3840 bytes per frame.
 *
 * NB: the CLAUDE.md rule "no `.on('data')` on a receive stream that
 * is also fed to `createAudioResource(StreamType.Opus)`" is honoured
 * because the mixer never wraps a receive stream in an
 * AudioResource — it only wraps its per-sink PassThrough.
 */

import { EndBehaviorType, type AudioReceiveStream } from '@discordjs/voice';
// @discordjs/opus is a native CJS module — its .d.ts declares named
// exports but the runtime under ESM has no default. Bridge via
// createRequire so both the runtime resolve and TypeScript's type
// info stay accurate.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OpusEncoder } = require('@discordjs/opus') as typeof import('@discordjs/opus');
type OpusEncoderT = InstanceType<typeof OpusEncoder>;
import type { PassThrough } from 'node:stream';

const FRAME_MS = 20;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_MS) / 1_000; // 960
const BYTES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS * 2;    // 3840
const SILENCE = Buffer.alloc(BYTES_PER_FRAME);
/** Cap per-source queue depth to bound backlog if a sink stalls. */
const QUEUE_MAX_FRAMES = 10;

export interface MixerLeg {
  channelId: string;
  ownerUserId: string;
  /** Receiver on this leg's connection (source side). */
  receiverSubscribe: () => AudioReceiveStream;
  /** Where mixed opus for this leg goes (sink side). */
  sinkPassthrough: PassThrough;
  /** Called on DAVE-tolerant decode failures — increments the leg's counter. */
  onDaveError: () => void;
  /**
   * Called every time an opus packet arrives on this leg's source
   * subscription — i.e., the owner is currently transmitting audio.
   * The hail service uses this to re-arm the silence timer on any
   * owner's real speech, not just Discord's SPEAKING-flag transitions
   * (which fire only on silence → speech, missing continuous talk).
   */
  onAudio: () => void;
}

interface Source {
  channelId: string;
  decoder: OpusEncoderT;
  queue: Buffer[];
  stream: AudioReceiveStream;
  packetsIn: number;
  decodesOk: number;
  decodesFailed: number;
  /** Wall-clock ms since the last packet arrived on this stream. */
  lastPacketAt: number;
  /** Ticks up when we detect the stream has ended and resubscribe. */
  resubscribes: number;
}

interface Sink {
  channelId: string;
  encoder: OpusEncoderT;
  passthrough: PassThrough;
  framesWritten: number;
}

export interface MixerStats {
  sources: Array<{
    channelId: string; in: number; decoded: number; failed: number;
    queued: number; sinceLastMs: number; resubscribes: number;
  }>;
  sinks: Array<{ channelId: string; written: number }>;
}

export class NwayMixer {
  private sources = new Map<string, Source>();
  private sinks = new Map<string, Sink>();
  private tickTimer: NodeJS.Timeout | null = null;
  private closed = false;

  /** Legs we've attached — kept so we can rebuild a source subscription
   * after a stream dies mid-hail. */
  private readonly legs = new Map<string, MixerLeg>();

  /**
   * Attach a leg as both a source (its owner's audio joins the mix)
   * and a sink (mixed audio of every OTHER source lands here).
   */
  attachLeg(leg: MixerLeg): void {
    if (this.closed) return;
    this.legs.set(leg.channelId, leg);
    this.attachSource(leg);
    this.attachSink(leg);
  }

  /**
   * Subscribe the source, wire the data + error + end handlers. Also
   * called when a previous source stream dies mid-hail (Node's
   * Readable auto-destroys on emit('error') even with a listener; the
   * underlying @discordjs/voice `subscriptions` map holds the old
   * dead reference and packets stop arriving). Reusing the decoder
   * preserves opus decode state across the reattach.
   */
  private attachSource(leg: MixerLeg): void {
    if (this.closed) return;
    const existing = this.sources.get(leg.channelId);
    const decoder = existing?.decoder ?? new OpusEncoder(SAMPLE_RATE, CHANNELS);
    const queue = existing?.queue ?? [];
    const prevPacketsIn = existing?.packetsIn ?? 0;
    const prevDecodesOk = existing?.decodesOk ?? 0;
    const prevDecodesFailed = existing?.decodesFailed ?? 0;
    const prevResubs = existing?.resubscribes ?? 0;

    if (existing !== undefined) {
      try { existing.stream.destroy(); } catch { /* already dead */ }
    }

    const stream = leg.receiverSubscribe();
    const source: Source = {
      channelId: leg.channelId, decoder, queue, stream,
      packetsIn: prevPacketsIn,
      decodesOk: prevDecodesOk,
      decodesFailed: prevDecodesFailed,
      lastPacketAt: Date.now(),
      resubscribes: prevResubs + (existing !== undefined ? 1 : 0),
    };

    stream.on('data', (packet: Buffer) => {
      if (this.closed) return;
      source.packetsIn += 1;
      source.lastPacketAt = Date.now();
      leg.onAudio();
      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet);
      } catch (err) {
        if (isDaveError(err)) { leg.onDaveError(); source.decodesFailed += 1; return; }
        source.decodesFailed += 1;
        return;
      }
      source.decodesOk += 1;
      source.queue.push(pcm);
      if (source.queue.length > QUEUE_MAX_FRAMES) source.queue.shift();
    });
    stream.on('error', (err) => {
      if (isDaveError(err)) { leg.onDaveError(); return; }
    });

    // Node's Readable destroys itself on 'end' / 'close'. Both events
    // mean the underlying @discordjs/voice AudioReceiveStream is dead
    // and future packets from this user will be dropped. Resubscribe
    // to bring the flow back.
    const onEnded = (why: 'end' | 'close'): void => {
      console.log(`mixer: source ${leg.channelId} stream ${why} — resubscribing`);
      // Guard against a race where the mixer has closed since.
      if (this.closed) return;
      // If a fresh attachSource has already replaced this stream
      // (because two events fired), the source in the map will point
      // to a different stream. Only reattach if we are still current.
      if (this.sources.get(leg.channelId)?.stream === stream) {
        setImmediate(() => this.attachSource(leg));
      }
    };
    stream.once('end', () => onEnded('end'));
    stream.once('close', () => onEnded('close'));

    this.sources.set(leg.channelId, source);
  }

  private attachSink(leg: MixerLeg): void {
    if (this.sinks.has(leg.channelId)) return;
    const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    this.sinks.set(leg.channelId, {
      channelId: leg.channelId,
      encoder,
      passthrough: leg.sinkPassthrough,
      framesWritten: 0,
    });
  }

  /** Snapshot per-source and per-sink counters for the heartbeat. */
  stats(): MixerStats {
    const now = Date.now();
    return {
      sources: [...this.sources.values()].map((s) => ({
        channelId: s.channelId,
        in: s.packetsIn,
        decoded: s.decodesOk,
        failed: s.decodesFailed,
        queued: s.queue.length,
        sinceLastMs: now - s.lastPacketAt,
        resubscribes: s.resubscribes,
      })),
      sinks: [...this.sinks.values()].map((s) => ({
        channelId: s.channelId,
        written: s.framesWritten,
      })),
    };
  }

  start(): void {
    if (this.closed) return;
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const src of this.sources.values()) {
      try { src.stream.destroy(); } catch { /* ok */ }
    }
    this.sources.clear();
    this.sinks.clear();
  }

  /** For heartbeat diagnostics — total queued PCM frames across sources. */
  totalQueued(): number {
    let n = 0;
    for (const s of this.sources.values()) n += s.queue.length;
    return n;
  }

  private tick(): void {
    if (this.closed || this.sinks.size === 0) return;
    // Snapshot the next PCM frame per source. Silence if empty.
    const frames = new Map<string, Buffer>();
    let anyAudio = false;
    for (const [channelId, src] of this.sources) {
      const frame = src.queue.shift();
      if (frame !== undefined && frame.length === BYTES_PER_FRAME) {
        frames.set(channelId, frame);
        anyAudio = true;
      } else {
        frames.set(channelId, SILENCE);
      }
    }
    if (!anyAudio) return; // No one speaking — don't push anything.

    for (const [sinkChannelId, sink] of this.sinks) {
      const mixed = Buffer.alloc(BYTES_PER_FRAME);
      let contributed = false;
      for (const [sourceChannelId, frame] of frames) {
        if (sourceChannelId === sinkChannelId) continue; // no self-echo
        if (frame === SILENCE) continue;
        contributed = true;
        for (let i = 0; i < BYTES_PER_FRAME; i += 2) {
          const sample = mixed.readInt16LE(i) + frame.readInt16LE(i);
          const clipped = sample > 32_767 ? 32_767 : sample < -32_768 ? -32_768 : sample;
          mixed.writeInt16LE(clipped, i);
        }
      }
      if (!contributed) continue;
      try {
        const opus = sink.encoder.encode(mixed);
        sink.passthrough.write(opus);
        sink.framesWritten += 1;
      } catch {
        // Encoder error — swallow this frame; next tick will try again.
      }
    }
  }
}

/**
 * `Manual` factory helper — mirrors the subscribe call sites so the
 * mixer stays independent of the caller's leg shape.
 */
export function subscribeManual(
  connection: import('@discordjs/voice').VoiceConnection,
  userId: string,
): AudioReceiveStream {
  return connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
}

function isDaveError(err: unknown): boolean {
  return err instanceof Error && /DecryptionFailed|Unencrypted/i.test(err.message);
}
