/**
 * Blind relay — spec §16.3.
 *
 * A hardcoded, unconditional audio bridge from one voice channel to another:
 * one fleet member listens on the source, another transmits into the target,
 * every non-fleet speaker's audio is forwarded as-is. No call-up detection,
 * no cues, no session lifecycle. The point of this step is to measure the
 * baseline additive latency of the routing plumbing and to prove operationally
 * that the connection can be held open across silence without emitting the
 * join chime on every transmission (spec §6).
 *
 * Design choices worth their own line:
 *
 *   • Forward opus packets directly. `receiver.subscribe(userId)` produces a
 *     stream of already-decrypted opus frames; `createAudioResource(stream,
 *     { inputType: Opus })` accepts them. Skipping the decode/re-encode cycle
 *     saves CPU and, more importantly, preserves the source encoding — a
 *     transcode step would introduce measurable additional latency that step
 *     3 is meant to expose.
 *
 *   • Last-speaker-wins. `AudioPlayer.play()` replaces the current resource.
 *     If two humans transmit at once on the source, the more recent one
 *     interrupts. A blind relay does not attempt to mix; the call-up
 *     protocol arriving in step 6 introduces a per-net lock instead (§5).
 *
 *   • Fleet suppression is enforced at `speaking.on('start')`, before we
 *     subscribe. §5 hard constraint: dropped bytes never touch the relay.
 *
 *   • `selfDeaf: true` on the target side, `selfDeaf: false` on source,
 *     `selfMute: false` on both. Send-only nets may `selfDeaf` (§3); no bot
 *     is ever `selfMute` because every bot must be able to play cues
 *     eventually (§6). Step 3 does not play cues, but wiring in the correct
 *     posture now avoids a rediscovery later.
 *
 *   • Never `VoiceConnection.destroy()` on transient disconnect. The
 *     recommended pattern is a Signalling/Connecting race — Discord routes
 *     voice through a different node during a region change and the client
 *     transitions through Disconnected without actually needing a rejoin.
 *     Destroying prematurely triggers a fresh join, which emits the chime.
 *
 * Not yet: STT, cues, ducking, callsigns, session state, mirror embeds.
 */

import {
  AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior,
  StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  type AudioPlayer, type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, type Client, type VoiceBasedChannel } from 'discord.js';
import { createCueResource, type Cue, type CueSet } from '../lib/cues.js';
import { RelayMetrics, isFleetAudio, type RelayStatsSnapshot } from './metrics.js';

export interface BlindRelayConfig {
  sourceClient: Client;
  targetClient: Client;
  sourceChannelId: string;
  targetChannelId: string;
  fleetUserIds: () => Set<string>;
  /** Optional in step 3; supplied in step 4 to enable cue playback. */
  cues?: CueSet;
}

export class BlindRelay {
  private readonly metrics: RelayMetrics;
  /** Target-side player: handles relay audio and target cues (attention, horn). */
  private readonly targetPlayer: AudioPlayer;
  /** Source-side player: handles source cues only (ready, negative, busy). */
  private readonly sourcePlayer: AudioPlayer;
  private sourceConnection: VoiceConnection | null = null;
  private targetConnection: VoiceConnection | null = null;
  private stopping = false;

  constructor(private readonly cfg: BlindRelayConfig) {
    this.metrics = new RelayMetrics(cfg.sourceChannelId, cfg.targetChannelId);
    if (cfg.cues !== undefined) this.metrics.markCuesLoaded();

    this.targetPlayer = createAudioPlayer({
      // Keep transmitting silence when no VoiceConnection is subscribed —
      // matters only in the milliseconds between subscribe and connection
      // ready, but consistent with "hold the stream open" (§16.3).
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.targetPlayer.on('stateChange', (from, to) => {
      if (from.status !== AudioPlayerStatus.Playing && to.status === AudioPlayerStatus.Playing) {
        this.metrics.onPlayingBegan();
      }
      if (to.status === AudioPlayerStatus.Idle && from.status !== AudioPlayerStatus.Idle) {
        this.metrics.onPlaybackEnded();
      }
    });
    this.targetPlayer.on('error', (err) => {
      this.metrics.onError(`target player: ${err.message}`);
      console.error(`relay: target player error: ${err.message}`);
    });

    this.sourcePlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.sourcePlayer.on('error', (err) => {
      this.metrics.onError(`source player: ${err.message}`);
      console.error(`relay: source player error: ${err.message}`);
    });
  }

  async start(): Promise<void> {
    const source = await this.resolveChannel(this.cfg.sourceClient, this.cfg.sourceChannelId, 'source');
    const target = await this.resolveChannel(this.cfg.targetClient, this.cfg.targetChannelId, 'target');

    this.sourceConnection = this.join(this.cfg.sourceClient, source, { selfDeaf: false });
    this.wireConnection(this.sourceConnection, 'source');
    await entersState(this.sourceConnection, VoiceConnectionStatus.Ready, 20_000);
    this.metrics.sourceReady = true;
    console.log(`relay: source ready — listening on ${source.name}`);

    this.targetConnection = this.join(this.cfg.targetClient, target, { selfDeaf: true });
    this.wireConnection(this.targetConnection, 'target');
    await entersState(this.targetConnection, VoiceConnectionStatus.Ready, 20_000);
    this.metrics.targetReady = true;
    console.log(`relay: target ready — transmitting on ${target.name}`);

    if (this.sourceConnection === this.targetConnection) {
      // A regression guard for the bug this fix repaired: if joinVoiceChannel
      // returned the same object for both legs, either both `group`s got the
      // same value or the SDK's keying changed and this whole module is a lie.
      throw new Error('relay: source and target ended up sharing a VoiceConnection — group scoping is broken');
    }

    this.targetConnection.subscribe(this.targetPlayer);
    this.sourceConnection.subscribe(this.sourcePlayer);
    this.attachReceiver(this.sourceConnection);
  }

  /**
   * Fire two cues at the same instant — `sourceCue` into the source
   * channel, `targetCue` into the target channel. Spec §5: `Ready` on the
   * commander's net and `Attention` on the receivers' net start together
   * so that the go-ahead ends exactly when the alert ends.
   *
   * `AudioPlayer.play` returns immediately after registering the resource
   * — the actual audio starts on the next Discord write, ~20 ms later.
   * We measure the delta between the two players' Playing state
   * transitions and surface it via /healthz. Anything > 50 ms is a bug.
   */
  playCuePair(sourceCue: Cue, targetCue: Cue): void {
    if (this.cfg.cues === undefined) {
      throw new Error('relay: cue engine not configured');
    }
    const source = this.cfg.cues.get(sourceCue);
    const target = this.cfg.cues.get(targetCue);

    let sourceAt: number | null = null;
    let targetAt: number | null = null;
    const record = (): void => {
      if (sourceAt !== null && targetAt !== null) {
        this.metrics.onCueSyncError(Math.abs(sourceAt - targetAt));
      }
    };
    const onSourcePlaying = (from: { status: AudioPlayerStatus }, to: { status: AudioPlayerStatus }): void => {
      if (from.status !== AudioPlayerStatus.Playing && to.status === AudioPlayerStatus.Playing) {
        sourceAt = Date.now();
        this.sourcePlayer.off('stateChange', onSourcePlaying);
        record();
      }
    };
    const onTargetPlaying = (from: { status: AudioPlayerStatus }, to: { status: AudioPlayerStatus }): void => {
      if (from.status !== AudioPlayerStatus.Playing && to.status === AudioPlayerStatus.Playing) {
        targetAt = Date.now();
        this.targetPlayer.off('stateChange', onTargetPlaying);
        record();
      }
    };
    this.sourcePlayer.on('stateChange', onSourcePlaying);
    this.targetPlayer.on('stateChange', onTargetPlaying);

    // Kicked off in the same tick — the closest to simultaneous we can be.
    this.sourcePlayer.play(createCueResource(source));
    this.targetPlayer.play(createCueResource(target));
    this.metrics.onCuePairFired(sourceCue, targetCue);
  }

  hasCues(): boolean { return this.cfg.cues !== undefined; }

  private async resolveChannel(client: Client, id: string, label: string): Promise<VoiceBasedChannel> {
    const c = await client.channels.fetch(id);
    if (c === null || c.type !== ChannelType.GuildVoice) {
      throw new Error(`relay ${label} channel ${id} is not a guild voice channel (or bot cannot see it)`);
    }
    return c;
  }

  private join(client: Client, channel: VoiceBasedChannel, { selfDeaf }: { selfDeaf: boolean }): VoiceConnection {
    const userId = client.user?.id;
    if (userId === undefined) {
      throw new Error('relay: cannot join before the client has logged in');
    }
    return joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf,
      selfMute: false, // never selfMute (§3)
      // @discordjs/voice keys connections by (guildId, group), default
      // 'default'. When N bots share a guild — the fleet's whole reason
      // for existing — a second join with the same key rebinds the first
      // bot's connection to the second channel instead of opening a new
      // one for the second bot. Scoping by the joining bot's user id is
      // the natural per-connection key. See CLAUDE.md.
      group: userId,
    });
  }

  /**
   * Reconnect strategy from the @discordjs/voice guide: on Disconnected, race
   * a transition to Signalling or Connecting. If either wins within 5s the
   * lib is already recovering (usually a region change) and we let it. If
   * both time out, the disconnect is real — for step 3 we log and leave the
   * connection destroyed rather than open-coding a rejoin; a full rejoin path
   * belongs with the session lifecycle in step 8.
   */
  private wireConnection(c: VoiceConnection, label: 'source' | 'target'): void {
    c.on(VoiceConnectionStatus.Disconnected, () => {
      if (this.stopping) return;
      void (async () => {
        try {
          await Promise.race([
            entersState(c, VoiceConnectionStatus.Signalling, 5_000),
            entersState(c, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          console.log(`relay: ${label} recovering — letting discord.js reconnect`);
        } catch {
          this.metrics.onError(`${label}: hard disconnect, no auto-recovery`);
          console.error(`relay: ${label} hard disconnect — not rejoining in step 3`);
          if (label === 'source') this.metrics.sourceReady = false;
          else this.metrics.targetReady = false;
        }
      })();
    });
    c.on('error', (err) => {
      this.metrics.onError(`${label}: ${err.message}`);
      console.error(`relay: ${label} error: ${err.message}`);
    });
    c.on(VoiceConnectionStatus.Ready, () => {
      if (label === 'source') this.metrics.sourceReady = true;
      else this.metrics.targetReady = true;
    });
  }

  private attachReceiver(c: VoiceConnection): void {
    const receiver = c.receiver;

    receiver.speaking.on('start', (userId: string) => {
      // §5 hard constraint — the highest-consequence check in the product.
      if (isFleetAudio(userId, this.cfg.fleetUserIds())) {
        this.metrics.onFleetDrop();
        return;
      }
      this.metrics.onSpeakerStart(userId);
      const opus = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const resource = createAudioResource(opus, { inputType: StreamType.Opus });
      this.targetPlayer.play(resource);
    });
  }

  snapshot(): RelayStatsSnapshot {
    return this.metrics.snapshot(true);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.targetPlayer.stop(true);
    this.sourcePlayer.stop(true);
    this.sourceConnection?.destroy();
    this.targetConnection?.destroy();
    this.sourceConnection = null;
    this.targetConnection = null;
  }
}
