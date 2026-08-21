/**
 * Session-driven audio relay — the manual precursor to step 6c.
 *
 * `runSessionRelay` opens a one-shot voice route from the primary net to
 * a target net inside an already-open session. It:
 *
 *   1. Plays `Ready` on the source (commander hears their go-ahead).
 *   2. Plays `Attention` on the target simultaneously (target hears the
 *      alert). Same instant, equal duration D_c (§5).
 *   3. Waits D_c so cues finish before the message starts (no first-word
 *      clipping).
 *   4. Subscribes to the commander's SSRC on the source connection's
 *      receiver, wraps the opus stream in a StreamType.Opus AudioResource,
 *      plays it through the target's player.
 *   5. Closes when the opus stream ends (`EndBehavior.AfterSilence`) or
 *      after `maxHoldMs`, whichever comes first.
 *   6. Plays `Out` on both sides, then unsubscribes.
 *
 * The relay primitive is retained across the design pivot. Step 6 of
 * the new build order (spec §15) generalises this one-way function into
 * `runHailLeg`, a per-channel bidirectional leg that the allocator wires
 * together to bridge two or more channels.
 */

import {
  AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType,
  VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, getVoiceConnection,
  type AudioPlayer, type AudioResource, type VoiceConnection,
} from '@discordjs/voice';
import { createCueResource, type CueSet } from '../lib/cues.js';

export interface SessionRelayResult {
  closedBy: 'silence' | 'max_hold' | 'error';
  durationMs: number;
  opusPackets: number;
  errorMessage: string | null;
}

export interface SessionRelayConfig {
  sourceConnection: VoiceConnection;
  targetConnection: VoiceConnection;
  cues: CueSet;
  commanderUserId: string;
  /** From guilds.silence_close_ms — spec §5. */
  silenceCloseMs: number;
  /** From guilds.max_hold_ms — spec §5. */
  maxHoldMs: number;
}

export async function runSessionRelay(cfg: SessionRelayConfig): Promise<SessionRelayResult> {
  // Guard: both connections must be Ready. A rejoin in flight would drop
  // audio and make the caller think the relay silently failed.
  if (cfg.sourceConnection.state.status !== VoiceConnectionStatus.Ready) {
    return errorResult(`source connection not ready (status=${cfg.sourceConnection.state.status})`);
  }
  if (cfg.targetConnection.state.status !== VoiceConnectionStatus.Ready) {
    return errorResult(`target connection not ready (status=${cfg.targetConnection.state.status})`);
  }

  const sourcePlayer = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
      // Default is 5. On a receiver-stream relay a brief inter-word pause
      // is easily 5+ missed 20 ms frames — the player would then abandon
      // the resource even though the stream is still alive. Infinity keeps
      // the resource attached across natural speech pauses.
      maxMissedFrames: Infinity,
    },
  });
  const targetPlayer = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
      maxMissedFrames: Infinity,
    },
  });
  // DAVE decryption occasionally fails at key-rotation boundaries (spec §15;
  // `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`), and the error
  // propagates through AudioReceiveStream → AudioResource → AudioPlayer. If
  // no listener is attached, Node crashes the process on the "Unhandled
  // 'error' event". Swallow the transient; the next packet usually decrypts
  // fine. See CLAUDE.md.
  let daveDropped = 0;
  const onPlayerError = (label: string) => (err: Error) => {
    if (/DecryptionFailed|Unencrypted/i.test(err.message)) {
      daveDropped++;
      return;
    }
    console.error(`hail: ${label} error: ${err.message}`);
  };
  sourcePlayer.on('error', onPlayerError('sourcePlayer'));
  targetPlayer.on('error', onPlayerError('targetPlayer'));
  const sourceSubscription = cfg.sourceConnection.subscribe(sourcePlayer);
  const targetSubscription = cfg.targetConnection.subscribe(targetPlayer);

  const started = Date.now();
  let opusPackets = 0;
  let errorMessage: string | null = null;
  const hlog = (msg: string): void => {
    const t = Date.now() - started;
    const s = String(t).padStart(6);
    console.log(`hail +${s}ms ${msg}`);
  };

  try {
    // Cues, same tick — spec §5 equal-duration invariant means source's
    // Ready and target's Attention end on the same instant regardless of
    // whichever AudioPlayer reaches Playing first.
    sourcePlayer.play(createCueResource(cfg.cues.get('ready')));
    targetPlayer.play(createCueResource(cfg.cues.get('attention')));
    await sleep(cfg.cues.expectedDurationMs);

    // Subscribe to the commander's SSRC. `AfterSilence` gives us the
    // natural close on silence; the max-hold is a separate race below.
    // NB: do NOT attach a `.on('data')` listener to this stream —
    // AudioResource with StreamType.Opus reads via `.read()`, and adding
    // a data listener flips the Readable into flowing mode where read()
    // returns null. The player then transmits nothing. Diagnostics come
    // from AudioPlayer state transitions and `AudioResource.playbackDuration`
    // instead.
    hlog(`subscribing to opus from ${cfg.commanderUserId} (silenceClose=${cfg.silenceCloseMs}ms)`);
    const opusStream = cfg.sourceConnection.receiver.subscribe(cfg.commanderUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.silenceCloseMs },
    });
    opusStream.on('error', (err: Error) => {
      if (/DecryptionFailed|Unencrypted/i.test(err.message)) {
        daveDropped++;
        return;
      }
      console.error(`hail: opusStream error: ${err.message}`);
    });
    opusStream.on('end', () => hlog('opusStream end'));
    opusStream.on('close', () => hlog('opusStream close'));

    const resource: AudioResource = createAudioResource(opusStream, { inputType: StreamType.Opus });
    targetPlayer.on('stateChange', (from, to) => {
      if (from.status !== to.status) {
        hlog(`targetPlayer ${from.status} -> ${to.status} (resource.ended=${resource.ended})`);
      }
    });
    targetPlayer.play(resource);

    // Race silence-close against max-hold. AfterSilence's cleanup path
    // destroys the AudioReceiveStream, which emits `'close'` — NOT `'end'`
    // — so both events are treated as silence. Not listening for 'close'
    // was why previous runs reported closedBy=max_hold even after the
    // player had gone Idle a long time ago.
    const closedBy = await new Promise<'silence' | 'max_hold'>((resolve) => {
      const done = (value: 'silence' | 'max_hold'): void => {
        clearTimeout(timer);
        opusStream.removeListener('end', onEnd);
        opusStream.removeListener('close', onClose);
        resolve(value);
      };
      const onEnd = (): void => done('silence');
      const onClose = (): void => done('silence');
      opusStream.once('end', onEnd);
      opusStream.once('close', onClose);
      const timer = setTimeout(() => done('max_hold'), cfg.maxHoldMs);
    });
    opusPackets = Math.round(resource.playbackDuration / 20);
    hlog(`closed=${closedBy} playbackMs=${resource.playbackDuration} ~packets=${opusPackets} daveDropped=${daveDropped}`);

    // End cue on both sides. On max_hold we cut the stream first so the
    // End cue is not fighting the still-flowing opus for target's player.
    if (closedBy === 'max_hold') {
      opusStream.destroy();
    }
    sourcePlayer.play(createCueResource(cfg.cues.get('end')));
    targetPlayer.play(createCueResource(cfg.cues.get('end')));
    await sleep(cfg.cues.expectedDurationMs);

    return {
      closedBy,
      durationMs: Date.now() - started,
      opusPackets,
      errorMessage: null,
    };
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    return {
      closedBy: 'error',
      durationMs: Date.now() - started,
      opusPackets,
      errorMessage,
    };
  } finally {
    // Clean up subscriptions so future relays start from a known state.
    // Do NOT destroy the underlying VoiceConnections — they belong to the
    // session and outlive individual relays.
    sourcePlayer.stop(true);
    targetPlayer.stop(true);
    sourceSubscription?.unsubscribe();
    targetSubscription?.unsubscribe();
    void ensureIdle(sourcePlayer);
    void ensureIdle(targetPlayer);
  }
}

function errorResult(message: string): SessionRelayResult {
  return { closedBy: 'error', durationMs: 0, opusPackets: 0, errorMessage: message };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureIdle(player: AudioPlayer): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 200);
    player.once(AudioPlayerStatus.Idle, () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Look up a bot's live VoiceConnection by botKey. Session channels are
 * joined with `group: user.id`, so this is a direct getVoiceConnection.
 */
export function connectionFor(guildId: string, userId: string): VoiceConnection | null {
  return getVoiceConnection(guildId, userId) ?? null;
}
