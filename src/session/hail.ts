/**
 * Hail service — Spec 1.0 §6, 2-way variant.
 *
 * An owner in vessel A picks vessel B from the hail directory. The
 * service:
 *
 *   1. Allocates two free relay bots — one per vessel.
 *   2. Both bots join their respective voices (`selfDeaf:false`,
 *      `selfMute:false`, `group: bot.user.id` per CLAUDE.md).
 *   3. Concurrently plays `ready` on the initiator side and
 *      `attention` on the target side. Same tick, equal duration D_c,
 *      so the cues end together.
 *   4. Subscribes each side's receiver to the local *owner's* SSRC
 *      and pipes the opus stream into the far side's outbound
 *      AudioPlayer. Owner audio only crosses the bridge — every other
 *      speaker in either channel stays local.
 *   5. Posts a per-channel `[End hail]` button in each vessel's
 *      voice-text chat.
 *   6. Watches `receiver.speaking.start` for both owners. Any speech
 *      re-arms a `silenceCloseMs` timer; the timer expiring closes the
 *      hail. A max-hold timer bounds the absolute duration.
 *
 * Close is single-entry (`_close`). Whatever path triggers it — silence
 * timer, End button, initiator leaves, max-hold, allocator error — the
 * cleanup runs once, in order:
 *
 *   • destroy receive streams so no more opus flows into the players
 *   • play `end` on both outbound players; wait D_c
 *   • VoiceConnection.destroy on both
 *   • delete End-hail messages
 *   • active_hails.closed_at + hail_events row
 *   • release the bots back to the allocator
 *
 * CLAUDE.md invariants relevant here:
 *   • `adapterCreator` MUST come from the joining bot's own Guild view.
 *   • `AudioPlayer.maxMissedFrames = Infinity` on any player fed from a
 *     `receiver.subscribe` stream — the default of 5 kills the resource
 *     during natural inter-word pauses.
 *   • 'error' listener on every AudioPlayer *and* AudioReceiveStream —
 *     DAVE decryption occasionally fails at key rotation and an
 *     unhandled 'error' crashes the whole process. Swallow the
 *     DAVE-specific message, log anything else.
 *   • `AudioReceiveStream` fires 'close' — not 'end' — on
 *     `AfterSilence` cleanup. Both are treated as end-of-stream here.
 *   • Never `.on('data')` on the receive stream feeding an
 *     `AudioResource(StreamType.Opus)` — it flips the Readable into
 *     flowing mode and `.read()` returns null.
 */

import {
  AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType,
  VoiceConnectionStatus, createAudioPlayer, createAudioResource,
  entersState, joinVoiceChannel,
  type AudioPlayer, type VoiceConnection,
} from '@discordjs/voice';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  type Client, type Message, type VoiceBasedChannel,
} from 'discord.js';
import { PassThrough } from 'node:stream';
import { NwayMixer, subscribeManual } from './nway-mixer.js';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import type { CueLibrary, CueSet } from '../lib/cues.js';
import { createCueResource } from '../lib/cues.js';
import type { Locale } from '../lib/config.js';
import { stringsFor, type Strings } from '../lib/i18n.js';

export type HailCloseReason =
  | 'silence' | 'button' | 'initiator_left' | 'max_hold'
  | 'drain' | 'error' | 'all_declined';

export type RingDecision = 'accepted' | 'declined' | 'timeout';

export interface HailServiceConfig {
  db: DB;
  fleet: Fleet;
  /** Every locale's cue audio; picked per guild via `localeFor`. */
  cues: CueLibrary;
  /** The guild's current language — selects cue audio and button text. */
  localeFor: (guildId: string) => Locale;
  silenceCloseMs: number;
  maxHoldMs: number;
  ringIntervalMs: number;
  ringMaxMs: number;
}

export interface OpenHailInput {
  guildId: string;
  initiator: HailChannelSpec;
  /** 1..N targets. Locked ones ring; unlocked auto-accept. */
  targets: HailChannelSpec[];
}

export interface HailChannelSpec {
  channelId: string;
  ownerUserId: string;
}

export type OpenHailResult =
  | { ok: true; hailId: number }
  | {
      ok: false;
      reason:
        | 'no_relays' | 'not_in_guild' | 'target_gone' | 'already_hailing'
        | 'target_busy' | 'no_targets' | 'all_declined' | 'declined'
        | 'timeout' | string;
    };

interface HailLeg {
  role: 'initiator' | 'target';
  channelId: string;
  guildId: string;
  ownerUserId: string;
  botNato: string;
  botClient: Client;
  connection: VoiceConnection;
  outboundPlayer: AudioPlayer;
  /** Sink-side resource for playbackDuration display in the heartbeat. */
  receiveResource: import('@discordjs/voice').AudioResource | null;
  endMessage: Message | null;
  cueRole: 'ready' | 'attention';
  /** DAVE decryption failures swallowed on this leg since the hail opened. */
  daveDrops: number;
  /** Speaking-start events observed for the leg's owner. */
  speakingStarts: number;
}

/** Per-target ring state, indexed by channel_id. */
interface RingState {
  resolver: (d: RingDecision) => void;
  message: Message | null;
}

interface Hail {
  hailId: number;
  guildId: string;
  /** legs[0] is the initiator; legs[1..] are targets. */
  legs: HailLeg[];
  silenceTimer: NodeJS.Timeout | null;
  maxHoldTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  openedAt: number;
  /**
   * Ring state per locked target channelId. Present entries mean a
   * ring is in flight; `handleAcceptDecline` calls the resolver.
   */
  rings: Map<string, RingState>;
  /**
   * Permanent per-sink output: a PassThrough fed by the mixer,
   * wrapped once in an AudioResource so the sink's player never
   * restarts.
   */
  sinkOutputs: Map<string, SinkOutput>;
  /** N-way mixer — every source PCM sums into every non-self sink. */
  mixer: NwayMixer | null;
  closing: boolean;
  closed: boolean;
}

interface SinkOutput {
  passthrough: import('stream').PassThrough;
  resource: import('@discordjs/voice').AudioResource;
}

export const HAIL_END_PREFIX = 'sc:hail:end:';
export const HAIL_ACCEPT_PREFIX = 'sc:hail:accept:';
export const HAIL_DECLINE_PREFIX = 'sc:hail:decline:';

/**
 * Small helper — the fleet exposes `clientFor(nato)` but not the list
 * of squad natos. Derived here from the config file's shape via
 * botUserIds diff isn't ideal, so we just try the well-known names.
 * Extend as new relays are added.
 */
export const SQUAD_NATOS = ['alfa', 'bravo', 'charlie'] as const;

/**
 * Pure allocator: pick the first `count` available relay natos,
 * skipping those that are busy or whose Client is not reachable.
 * Returns null if fewer than `count` are free. Extracted from
 * HailManager so the picking logic can be tested without touching
 * Discord or the DB.
 */
export function pickN(
  natos: readonly string[],
  count: number,
  isBusy: (nato: string) => boolean,
  isReachable: (nato: string) => boolean,
): string[] | null {
  const free = natos.filter((n) => !isBusy(n) && isReachable(n));
  if (free.length < count) return null;
  return free.slice(0, count);
}

/** Compat shim so the existing pickTwo tests still pass. */
export function pickTwo(
  natos: readonly string[],
  isBusy: (nato: string) => boolean,
  isReachable: (nato: string) => boolean,
): [string, string] | null {
  const picked = pickN(natos, 2, isBusy, isReachable);
  return picked === null ? null : [picked[0]!, picked[1]!];
}

export class HailManager {
  private readonly hails = new Map<number, Hail>();
  private readonly busyNatos = new Set<string>();
  /**
   * Channels currently occupied by a hail — initiator OR target,
   * in-flight open() OR fully established. Keyed by
   * `${guildId}/${channelId}` so a channelId collision across guilds
   * can never wrongly block. Populated synchronously at the start of
   * open() before any await, so two concurrent opens where each
   * targets the other cannot both slip past the check.
   */
  private readonly busyChannels = new Set<string>();

  constructor(private readonly cfg: HailServiceConfig) {}

  private chanKey(guildId: string, channelId: string): string {
    return `${guildId}/${channelId}`;
  }

  activeCount(): number { return this.hails.size; }

  silenceCloseMs(): number { return this.cfg.silenceCloseMs; }

  /** Number of relays currently free and reachable in the given guild. */
  freeBotCount(guildId: string): number {
    return this.freeBotNatos(guildId).length;
  }

  /** Cue audio for a guild's language (falls back to the default locale's set). */
  private cuesFor(guildId: string): CueSet {
    return this.cfg.cues.forLocale(this.cfg.localeFor(guildId));
  }

  private strings(guildId: string): Strings {
    return stringsFor(this.cfg.localeFor(guildId));
  }

  /**
   * One-shot cue visit — a free relay joins the channel, plays the cue
   * to completion, and disconnects. Fire-and-forget; if no relay is
   * free the visit is skipped silently. Used for `established` on Allow
   * hails and `disconnected` on Disable hails.
   */
  async playAnnouncement(
    guildId: string,
    channelId: string,
    cueName: 'established' | 'disconnected',
  ): Promise<void> {
    const free = this.freeBotNatos(guildId);
    const nato = free[0];
    if (nato === undefined) return; // no relay to send — nicety, not critical.
    this.busyNatos.add(nato);
    try {
      const botClient = this.cfg.fleet.clientFor(nato);
      const botGuild = botClient.guilds.cache.get(guildId)
        ?? await botClient.guilds.fetch(guildId);
      const botUserId = botClient.user?.id;
      if (botUserId === undefined) return;

      const connection = joinVoiceChannel({
        channelId, guildId,
        adapterCreator: botGuild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        group: botUserId,
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (err) {
        connection.destroy();
        console.warn(`announcement: bot ${nato} could not reach Ready on ${channelId}: ${errMsg(err)}`);
        return;
      }
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      player.on('error', (err) => {
        if (isDaveError(err)) return;
        console.error(`announcement: player error on ${channelId}: ${err.message}`);
      });
      connection.subscribe(player);
      try {
        player.play(createCueResource(this.cuesFor(guildId).get(cueName)));
        await waitForPlayerIdle(player);
      } catch (err) {
        console.error(`announcement: play ${cueName} failed on ${channelId}: ${errMsg(err)}`);
      } finally {
        try { player.stop(true); } catch { /* ok */ }
        try { connection.destroy(); } catch { /* ok */ }
      }
    } finally {
      this.busyNatos.delete(nato);
    }
  }

  isBusyBot(nato: string): boolean { return this.busyNatos.has(nato); }

  freeBotNatos(guildId?: string): string[] {
    return [...SQUAD_NATOS].filter((n) => {
      if (this.busyNatos.has(n)) return false;
      const client = this.tryClient(n);
      if (client === null) return false;
      if (guildId === undefined) return true;
      return client.guilds.cache.has(guildId);
    });
  }

  private tryClient(nato: string): Client | null {
    try {
      return this.cfg.fleet.clientFor(nato);
    } catch {
      return null;
    }
  }

  /**
   * End-hail button dispatch. Route from the top-level component
   * dispatcher: `sc:hail:end:<hailId>` → this method.
   */
  async handleEndButton(hailId: number, actorUserId: string | null): Promise<void> {
    const hail = this.hails.get(hailId);
    if (hail === undefined) return;
    logHailEvent(this.cfg.db, hailId, 'ended_channel', actorUserId, null);
    await this._close(hail, 'button');
  }

  /**
   * Accept / Decline button dispatch. Route from the top-level
   * component dispatcher: `sc:hail:accept:<hailId>` and
   * `sc:hail:decline:<hailId>` → this method with the matching
   * decision. Owner-only: only the target vessel's owner may respond.
   * Non-owners get an ephemeral refuse via the returned status; the
   * dispatcher reads that and replies.
   */
  handleAcceptDecline(
    hailId: number, decision: 'accepted' | 'declined', actorUserId: string,
  ): 'ok' | 'not_owner' | 'not_ringing' {
    const hail = this.hails.get(hailId);
    if (hail === undefined) return 'not_ringing';
    // Find the target whose owner matches this actor and whose ring is
    // currently in flight.
    const targetLeg = hail.legs.find(
      (l) => l.role === 'target' && l.ownerUserId === actorUserId,
    );
    if (targetLeg === undefined) {
      // The actor is not the owner of any target with an active ring.
      // Distinguish "you don't own a hail target" from "your ring is
      // already resolved" so the ephemeral is accurate.
      const anyRingActive = hail.rings.size > 0;
      return anyRingActive ? 'not_owner' : 'not_ringing';
    }
    const ring = hail.rings.get(targetLeg.channelId);
    if (ring === undefined) return 'not_ringing';
    ring.resolver(decision);
    return 'ok';
  }

  /**
   * Called by the vessel service on channelLeave: if the initiator or
   * a target owner leaves their channel while a hail is open, close it.
   */
  async handleOwnerLeft(guildId: string, ownerUserId: string, channelId: string): Promise<void> {
    for (const hail of this.hails.values()) {
      if (hail.guildId !== guildId) continue;
      const leg = hail.legs.find((l) => l.channelId === channelId && l.ownerUserId === ownerUserId);
      if (leg === undefined) continue;
      logHailEvent(this.cfg.db, hail.hailId, 'ended_channel', ownerUserId, channelId);
      await this._close(hail, 'initiator_left');
    }
  }

  /**
   * Drain all open hails — spec §12 pre-deploy. Sequential to keep
   * cue playback distinct in logs; each close is ~D_c long.
   */
  async drain(): Promise<void> {
    for (const hail of [...this.hails.values()]) {
      await this._close(hail, 'drain');
    }
  }

  async open(input: OpenHailInput): Promise<OpenHailResult> {
    if (input.targets.length === 0) return { ok: false, reason: 'no_targets' };

    // In-hail block: any channel this hail would touch — initiator or
    // target — must not already be a leg of another hail. Covers both:
    //   1. User A in an active hail (initiator or target) clicks Hail
    //      on their own panel → refused as 'already_hailing'.
    //   2. A and B hail each other simultaneously → whichever open()
    //      reserves the channels first wins; the other refuses with
    //      'already_hailing' (if the caller's own channel was reserved
    //      by the winner as a target) or 'target_busy' (if only the
    //      chosen target was reserved).
    // Check and reserve run in one synchronous section — no await
    // between check and add — so the race in scenario 2 is atomic.
    const wanted = [
      input.initiator.channelId,
      ...input.targets.map((t) => t.channelId),
    ];
    for (let i = 0; i < wanted.length; i += 1) {
      const ch = wanted[i]!;
      if (this.busyChannels.has(this.chanKey(input.guildId, ch))) {
        return { ok: false, reason: i === 0 ? 'already_hailing' : 'target_busy' };
      }
    }
    for (const ch of wanted) this.busyChannels.add(this.chanKey(input.guildId, ch));

    const totalBots = 1 + input.targets.length;
    const pick = pickN(
      SQUAD_NATOS,
      totalBots,
      (n) => this.busyNatos.has(n),
      (n) => {
        const client = this.tryClient(n);
        return client !== null && client.guilds.cache.has(input.guildId);
      },
    );
    if (pick === null) {
      // Release the channel reservations — this open() is not going to
      // reach the try/catch that would otherwise clean them up.
      for (const ch of wanted) this.busyChannels.delete(this.chanKey(input.guildId, ch));
      const reachable = [...SQUAD_NATOS].filter((n) => {
        const c = this.tryClient(n);
        return c !== null && c.guilds.cache.has(input.guildId);
      });
      if (reachable.length < totalBots) {
        return { ok: false, reason: 'not_in_guild' };
      }
      return { ok: false, reason: 'no_relays' };
    }
    const initiatorNato = pick[0]!;
    const targetNatos = pick.slice(1);

    // Reserve immediately so a second concurrent open sees them busy.
    for (const n of pick) this.busyNatos.add(n);

    const now = Date.now();
    const insert = this.cfg.db.prepare(`
      INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at)
      VALUES (?, ?, ?)
    `).run(input.guildId, input.initiator.channelId, now);
    const hailId = Number(insert.lastInsertRowid);
    for (const t of input.targets) {
      logHailEvent(this.cfg.db, hailId, 'opened', input.initiator.ownerUserId, t.channelId);
    }

    let hail: Hail | null = null;
    try {
      const initiatorLeg = await this.joinLeg({
        role: 'initiator',
        botNato: initiatorNato,
        guildId: input.guildId,
        channelId: input.initiator.channelId,
        ownerUserId: input.initiator.ownerUserId,
        cueRole: 'ready',
      });
      const targetLegs: HailLeg[] = [];
      for (let i = 0; i < input.targets.length; i += 1) {
        const t = input.targets[i]!;
        const nato = targetNatos[i]!;
        targetLegs.push(await this.joinLeg({
          role: 'target',
          botNato: nato,
          guildId: input.guildId,
          channelId: t.channelId,
          ownerUserId: t.ownerUserId,
          cueRole: 'attention',
        }));
      }

      const legs: HailLeg[] = [initiatorLeg, ...targetLegs];
      hail = {
        hailId, guildId: input.guildId, legs,
        silenceTimer: null, maxHoldTimer: null, heartbeatTimer: null,
        rings: new Map(),
        openedAt: Date.now(),
        sinkOutputs: new Map(),
        mixer: null,
        closing: false, closed: false,
      };
      this.hails.set(hailId, hail);

      // Ring phase — every locked target rings in parallel. Unlocked
      // targets are auto-accepted. The hail proceeds if at least one
      // target ends up accepted.
      const ringOutcomes = await Promise.all(targetLegs.map(async (leg) => {
        if (!isChannelLocked(this.cfg.db, leg.channelId)) {
          return { leg, decision: 'accepted' as RingDecision };
        }
        logHailEvent(this.cfg.db, hailId, 'ring_started', null, leg.channelId);
        const decision = await this.ringForAccept(hail!, leg);
        return { leg, decision };
      }));

      const accepted = ringOutcomes.filter((r) => r.decision === 'accepted').map((r) => r.leg);
      const refused = ringOutcomes.filter((r) => r.decision !== 'accepted');

      // Log per-target outcomes + write hail_participants rows.
      const resolveTs = Date.now();
      this.cfg.db.prepare(`
        INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, decision)
        VALUES (?, ?, ?, ?, ?)
      `).run(hailId, initiatorLeg.channelId, initiatorLeg.botNato, resolveTs, 'accepted');
      for (const r of ringOutcomes) {
        const decisionValue =
          r.decision === 'accepted' ? 'accepted' :
          r.decision === 'declined' ? 'declined' : 'timed_out';
        if (r.decision === 'accepted') {
          this.cfg.db.prepare(`
            INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, decision)
            VALUES (?, ?, ?, ?, ?)
          `).run(hailId, r.leg.channelId, r.leg.botNato, resolveTs, 'accepted');
        } else {
          this.cfg.db.prepare(`
            INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, left_at, decision)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(hailId, r.leg.channelId, r.leg.botNato, resolveTs, resolveTs, decisionValue);
          logHailEvent(
            this.cfg.db, hailId,
            r.decision === 'declined' ? 'declined' : 'timeout',
            null, r.leg.channelId,
          );
        }
      }

      if (accepted.length === 0) {
        // Everyone refused. Drop refused legs, play Busy on initiator, close.
        await this.refuseHail(hail, initiatorLeg, refused.map((r) => r.leg));
        return { ok: false, reason: 'all_declined' };
      }

      // Drop refused target legs immediately — bots leave silently.
      // Free their channel reservations so a fresh hail to that same
      // vessel isn't blocked by the just-refused attempt.
      for (const r of refused) {
        try { r.leg.outboundPlayer.stop(true); } catch { /* ok */ }
        try { r.leg.connection.destroy(); } catch { /* ok */ }
        this.busyNatos.delete(r.leg.botNato);
        this.busyChannels.delete(this.chanKey(hail.guildId, r.leg.channelId));
      }
      // Reset legs to only initiator + accepted targets. Subsequent
      // audio wiring + End buttons ignore refused legs.
      hail.legs = [initiatorLeg, ...accepted];

      for (const leg of accepted) {
        logHailEvent(this.cfg.db, hailId, 'accepted', leg.ownerUserId, leg.channelId);
      }

      // Cues concurrent on every accepted leg, then wait for every one
      // to reach Idle so the mixer path doesn't step on cue playback.
      // Cues vary in length across locales — no fixed D_c anymore.
      const cuePlays = hail.legs.map((leg) => {
        leg.outboundPlayer.play(createCueResource(this.cuesFor(leg.guildId).get(leg.cueRole)));
        return waitForPlayerIdle(leg.outboundPlayer);
      });
      await Promise.all(cuePlays);

      // Wire the N-way audio graph.
      this.wireHailAudio(hail);

      // End buttons via the controller — one per surviving leg.
      const controller = this.cfg.fleet.controllerClient();
      for (const leg of hail.legs) {
        leg.endMessage = await postEndButton(controller, leg.channelId, hailId, this.strings(leg.guildId)).catch((err) => {
          console.error(`hail ${hailId}: end-button post failed on ${leg.channelId}: ${errMsg(err)}`);
          return null;
        });
      }

      this.armSilence(hail);
      hail.maxHoldTimer = setTimeout(() => {
        void this._close(hail!, 'max_hold').catch(() => {});
      }, this.cfg.maxHoldMs);
      this.startHeartbeat(hail);

      return { ok: true, hailId };
    } catch (err) {
      console.error(`hail ${hailId}: open failed: ${errMsg(err)}`);
      if (hail !== null) {
        await this._close(hail, 'error');
      } else {
        for (const n of pick) this.busyNatos.delete(n);
        for (const ch of wanted) this.busyChannels.delete(this.chanKey(input.guildId, ch));
        this.cfg.db.prepare(
          `UPDATE active_hails SET closed_at = ?, close_reason = 'error' WHERE id = ?`,
        ).run(Date.now(), hailId);
      }
      return { ok: false, reason: errMsg(err) };
    }
  }

  private async joinLeg(spec: {
    role: 'initiator' | 'target';
    botNato: string;
    guildId: string;
    channelId: string;
    ownerUserId: string;
    cueRole: 'ready' | 'attention';
  }): Promise<HailLeg> {
    const botClient = this.cfg.fleet.clientFor(spec.botNato);
    // Adapter MUST come from the joining bot's own guild view.
    let botGuild = botClient.guilds.cache.get(spec.guildId);
    if (botGuild === undefined) {
      botGuild = await botClient.guilds.fetch(spec.guildId);
    }
    const botUserId = botClient.user?.id;
    if (botUserId === undefined) throw new Error(`bot ${spec.botNato} has no user id yet`);

    const connection = joinVoiceChannel({
      channelId: spec.channelId,
      guildId: spec.guildId,
      adapterCreator: botGuild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      group: botUserId,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`bot ${spec.botNato} could not reach Ready on ${spec.channelId}: ${errMsg(err)}`);
    }

    const outboundPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: Infinity,
      },
    });

    const leg: HailLeg = {
      role: spec.role,
      channelId: spec.channelId,
      guildId: spec.guildId,
      ownerUserId: spec.ownerUserId,
      botNato: spec.botNato,
      botClient,
      connection,
      outboundPlayer,
      receiveResource: null,
      endMessage: null,
      cueRole: spec.cueRole,
      daveDrops: 0,
      speakingStarts: 0,
    };

    outboundPlayer.on('error', (err) => {
      if (isDaveError(err)) { leg.daveDrops += 1; return; }
      console.error(`hail: outbound player error on ${spec.channelId} [${spec.botNato}]: ${err.message}`);
    });
    outboundPlayer.on('stateChange', (from, to) => {
      if (from.status !== to.status) {
        console.log(
          `hail-diag: player ${spec.botNato}→${spec.channelId} ` +
          `${from.status} → ${to.status}`,
        );
      }
    });
    connection.on('stateChange', (from, to) => {
      if (from.status === to.status) return;
      console.log(
        `hail-diag: connection ${spec.botNato}→${spec.channelId} ` +
        `${from.status} → ${to.status}`,
      );
    });
    connection.subscribe(outboundPlayer);

    return leg;
  }

  /**
   * N-way audio graph — proper PCM mixing (spec §16 pulled forward
   * from "future work" because last-speaker-wins wasn't good enough
   * in practice). Every source is subscribed once for the whole
   * hail and its opus packets are decoded to PCM. The `NwayMixer`
   * runs a 20 ms tick that sums each source's latest PCM frame into
   * every non-self sink, clips, and encodes one opus frame per sink.
   *
   * The `speaking.on('start')` listener stays wired but no longer
   * drives audio routing — only the silence timer (any owner speech
   * re-arms it) and the per-leg speakingStarts counter for
   * diagnostics.
   */
  private wireHailAudio(hail: Hail): void {
    // Permanent output per sink — mixer writes into these.
    for (const sink of hail.legs) {
      const pt = new PassThrough({ highWaterMark: 1 << 16 });
      const resource = createAudioResource(pt, { inputType: StreamType.Opus });
      sink.outboundPlayer.play(resource);
      hail.sinkOutputs.set(sink.channelId, { passthrough: pt, resource });
      sink.receiveResource = resource;
    }

    const mixer = new NwayMixer();
    for (const leg of hail.legs) {
      const sinkOutput = hail.sinkOutputs.get(leg.channelId);
      if (sinkOutput === undefined) continue;
      mixer.attachLeg({
        channelId: leg.channelId,
        ownerUserId: leg.ownerUserId,
        receiverSubscribe: () => subscribeManual(leg.connection, leg.ownerUserId),
        sinkPassthrough: sinkOutput.passthrough,
        onDaveError: () => { leg.daveDrops += 1; },
        // Every incoming opus packet from this leg's owner re-arms
        // the silence timer. Using packet arrival (not the SPEAKING
        // flag) means a target talking continuously without a >100 ms
        // gap still counts as activity — the old speaking-start-only
        // trigger would fire once at the start of a monologue and let
        // the silence timer expire mid-sentence.
        onAudio: () => {
          if (hail.closing || hail.closed) return;
          this.armSilence(hail);
        },
      });
    }
    mixer.start();
    hail.mixer = mixer;

    // Keep the SPEAKING-flag listener for the per-leg speakingStarts
    // counter (diagnostic — shows utterance boundaries in the log)
    // but no longer for silence timing.
    for (const source of hail.legs) {
      source.connection.receiver.speaking.on('start', (userId) => {
        if (userId !== source.ownerUserId) return;
        if (hail.closing || hail.closed) return;
        source.speakingStarts += 1;
      });
    }
  }

  /** 5-second heartbeat — one line per active hail with per-leg counters. */
  private startHeartbeat(hail: Hail): void {
    if (hail.heartbeatTimer !== null) clearInterval(hail.heartbeatTimer);
    hail.heartbeatTimer = setInterval(() => {
      if (hail.closed) return;
      const uptime = Math.round((Date.now() - hail.openedAt) / 1000);
      const mixerStats = hail.mixer?.stats();
      for (const leg of hail.legs) {
        const inbound = leg.receiveResource?.playbackDuration ?? 0;
        const inboundS = (inbound / 1000).toFixed(1);
        const srcStat = mixerStats?.sources.find((s) => s.channelId === leg.channelId);
        const sinkStat = mixerStats?.sinks.find((s) => s.channelId === leg.channelId);
        const mixStr = mixerStats === undefined
          ? ''
          : ` src(in=${srcStat?.in ?? 0} dec=${srcStat?.decoded ?? 0} fail=${srcStat?.failed ?? 0} ` +
            `q=${srcStat?.queued ?? 0} since=${Math.round((srcStat?.sinceLastMs ?? 0) / 1000)}s ` +
            `resub=${srcStat?.resubscribes ?? 0}) sink(wr=${sinkStat?.written ?? 0})`;
        console.log(
          `hail-hb: h${hail.hailId} +${uptime}s ${leg.role}[${leg.botNato}]→${leg.channelId} ` +
          `conn=${leg.connection.state.status} ` +
          `player=${leg.outboundPlayer.state.status} ` +
          `inboundS=${inboundS} ` +
          `speakingStarts=${leg.speakingStarts} ` +
          `daveDrops=${leg.daveDrops}` +
          mixStr,
        );
      }
    }, 5000);
  }

  private stopHeartbeat(hail: Hail): void {
    if (hail.heartbeatTimer !== null) {
      clearInterval(hail.heartbeatTimer);
      hail.heartbeatTimer = null;
    }
  }

  private armSilence(hail: Hail): void {
    if (hail.silenceTimer !== null) clearTimeout(hail.silenceTimer);
    hail.silenceTimer = setTimeout(() => {
      hail.silenceTimer = null;
      logHailEvent(this.cfg.db, hail.hailId, 'close_silence', null, null);
      void this._close(hail, 'silence').catch(() => {});
    }, this.cfg.silenceCloseMs);
  }

  /**
   * Locked-target ring loop. Plays `ring` in the target's outbound
   * player every `ringIntervalMs`, and posts an Accept/Decline button
   * pair through the controller. Resolves on:
   *   • Accept click  → 'accepted'
   *   • Decline click → 'declined'
   *   • `ringMaxMs` elapsed with no click → 'timeout'
   *   • Cancelled from _close via `hail.ringResolver('timeout')`
   *
   * Owner-only enforcement of the Accept/Decline buttons happens in
   * `handleAcceptDecline`, not here.
   */
  private async ringForAccept(hail: Hail, targetLeg: HailLeg): Promise<RingDecision> {
    const controller = this.cfg.fleet.controllerClient();
    const message = await postRingButtons(controller, targetLeg.channelId, hail.hailId, this.strings(targetLeg.guildId))
      .catch((err) => {
        console.error(`hail ${hail.hailId}: ring buttons post failed: ${errMsg(err)}`);
        return null;
      });

    return await new Promise<RingDecision>((resolve) => {
      let ringTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;
      let done = false;

      const finish = (result: RingDecision): void => {
        if (done) return;
        done = true;
        if (ringTimer !== null) clearTimeout(ringTimer);
        if (maxTimer !== null) clearTimeout(maxTimer);
        hail.rings.delete(targetLeg.channelId);
        // Best-effort ring-button removal — the caller (open() or
        // refuseHail) will also try again if a race leaves the message.
        if (message !== null) void message.delete().catch(() => {});
        resolve(result);
      };
      hail.rings.set(targetLeg.channelId, { resolver: finish, message });

      // Play → wait for the cue to finish → gap → play again. Cues
      // may be longer or shorter than the interval and we never want
      // to stack them; chaining on Idle keeps them clean.
      const playRing = async (): Promise<void> => {
        if (done || hail.closing || hail.closed) return;
        try {
          targetLeg.outboundPlayer.play(createCueResource(this.cuesFor(targetLeg.guildId).get('ring')));
          await waitForPlayerIdle(targetLeg.outboundPlayer, 5_000);
        } catch (err) {
          console.error(`hail ${hail.hailId}: ring cue play failed: ${errMsg(err)}`);
        }
        if (done || hail.closing || hail.closed) return;
        ringTimer = setTimeout(() => { void playRing(); }, this.cfg.ringIntervalMs);
      };
      void playRing();

      maxTimer = setTimeout(() => finish('timeout'), this.cfg.ringMaxMs);
    });
  }

  /**
   * Wind-down for a hail where every target refused. Plays `busy` in
   * the initiator's channel (no `end` on the targets — the hail never
   * fully opened), disconnects every bot, writes close_reason
   * 'all_declined'.
   */
  private async refuseHail(
    hail: Hail, initiatorLeg: HailLeg, refusedTargets: HailLeg[],
  ): Promise<void> {
    hail.closing = true;
    this.stopHeartbeat(hail);

    try {
      initiatorLeg.outboundPlayer.play(createCueResource(this.cuesFor(initiatorLeg.guildId).get('busy')));
      await waitForPlayerIdle(initiatorLeg.outboundPlayer);
    } catch (err) {
      console.error(`hail ${hail.hailId}: busy cue play failed: ${errMsg(err)}`);
    }

    for (const leg of [initiatorLeg, ...refusedTargets]) {
      try { leg.outboundPlayer.stop(true); } catch { /* ok */ }
      try { leg.connection.destroy(); } catch { /* ok */ }
      this.busyNatos.delete(leg.botNato);
      this.busyChannels.delete(this.chanKey(hail.guildId, leg.channelId));
    }

    const now = Date.now();
    this.cfg.db.prepare(
      `UPDATE active_hails SET closed_at = ?, close_reason = ? WHERE id = ?`,
    ).run(now, 'all_declined', hail.hailId);
    logHailEvent(this.cfg.db, hail.hailId, 'ended_all', null, null, 'all_declined');

    hail.closed = true;
    this.hails.delete(hail.hailId);
  }

  private async _close(hail: Hail, reason: HailCloseReason): Promise<void> {
    if (hail.closing || hail.closed) return;
    hail.closing = true;
    this.stopHeartbeat(hail);
    const uptime = Math.round((Date.now() - hail.openedAt) / 1000);
    for (const leg of hail.legs) {
      const inbound = leg.receiveResource?.playbackDuration ?? 0;
      console.log(
        `hail-diag: h${hail.hailId} close reason=${reason} +${uptime}s ` +
        `${leg.role}[${leg.botNato}]→${leg.channelId} ` +
        `inboundMs=${inbound} ` +
        `speakingStarts=${leg.speakingStarts} ` +
        `daveDrops=${leg.daveDrops}`,
      );
    }
    if (hail.silenceTimer !== null) { clearTimeout(hail.silenceTimer); hail.silenceTimer = null; }
    if (hail.maxHoldTimer !== null) { clearTimeout(hail.maxHoldTimer); hail.maxHoldTimer = null; }
    // Cancel every in-flight ring (initiator left before every target
    // resolved). Each resolver deletes its own message and drops
    // itself from `hail.rings`.
    for (const ring of [...hail.rings.values()]) {
      ring.resolver('timeout');
    }

    // Stop the mixer (destroys its receive subscriptions internally),
    // then end the sink PassThroughs so the cue path (below) doesn't
    // fight remote audio.
    if (hail.mixer !== null) {
      hail.mixer.stop();
      hail.mixer = null;
    }
    for (const out of hail.sinkOutputs.values()) {
      try { out.passthrough.end(); } catch { /* ok */ }
    }
    hail.sinkOutputs.clear();

    // Play `end` on every remaining leg, wait for all to finish.
    const endPlays = hail.legs.map((leg) => {
      leg.outboundPlayer.play(createCueResource(this.cuesFor(leg.guildId).get('end')));
      return waitForPlayerIdle(leg.outboundPlayer);
    });
    await Promise.all(endPlays);

    // Stop players, disconnect both bots.
    for (const leg of hail.legs) {
      try { leg.outboundPlayer.stop(true); } catch { /* ok */ }
      try { leg.connection.destroy(); } catch { /* ok */ }
    }

    // Delete the End-hail messages.
    for (const leg of hail.legs) {
      if (leg.endMessage !== null) {
        await leg.endMessage.delete().catch(() => {});
      }
    }

    // Persist close + release bots.
    const now = Date.now();
    this.cfg.db.prepare(
      `UPDATE active_hails SET closed_at = ?, close_reason = ? WHERE id = ?`,
    ).run(now, reason, hail.hailId);
    for (const leg of hail.legs) {
      this.cfg.db.prepare(
        `UPDATE hail_participants SET left_at = ? WHERE hail_id = ? AND channel_id = ?`,
      ).run(now, hail.hailId, leg.channelId);
      this.busyNatos.delete(leg.botNato);
      this.busyChannels.delete(this.chanKey(hail.guildId, leg.channelId));
    }
    logHailEvent(this.cfg.db, hail.hailId, 'ended_all', null, null, reason);

    hail.closed = true;
    this.hails.delete(hail.hailId);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function postEndButton(
  controller: Client, channelId: string, hailId: number, s: Strings,
): Promise<Message | null> {
  const channel = await controller.channels.fetch(channelId).catch(() => null);
  if (channel === null) return null;
  if (channel.type !== ChannelType.GuildVoice) return null;
  const voice = channel as VoiceBasedChannel;
  const button = new ButtonBuilder()
    .setCustomId(`${HAIL_END_PREFIX}${hailId}`)
    .setLabel(s.hail.btnEnd)
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  return voice.send({ content: s.hail.active, components: [row] });
}

async function postRingButtons(
  controller: Client, channelId: string, hailId: number, s: Strings,
): Promise<Message | null> {
  const channel = await controller.channels.fetch(channelId).catch(() => null);
  if (channel === null) return null;
  if (channel.type !== ChannelType.GuildVoice) return null;
  const voice = channel as VoiceBasedChannel;
  const accept = new ButtonBuilder()
    .setCustomId(`${HAIL_ACCEPT_PREFIX}${hailId}`)
    .setLabel(s.hail.btnAccept)
    .setStyle(ButtonStyle.Success);
  const decline = new ButtonBuilder()
    .setCustomId(`${HAIL_DECLINE_PREFIX}${hailId}`)
    .setLabel(s.hail.btnDecline)
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(accept, decline);
  return voice.send({
    content: s.hail.incoming,
    components: [row],
  });
}

function isChannelLocked(db: DB, channelId: string): boolean {
  const row = db.prepare(
    `SELECT locked FROM vessels WHERE channel_id = ? AND deleted_at IS NULL`,
  ).get(channelId) as { locked: number } | undefined;
  return row?.locked === 1;
}

function logHailEvent(
  db: DB, hailId: number, kind: string,
  actorUserId: string | null, targetChannelId: string | null,
  note: string | null = null,
): void {
  db.prepare(`
    INSERT INTO hail_events (hail_id, ts, kind, actor_user_id, target_channel_id, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hailId, Date.now(), kind, actorUserId, targetChannelId, note);
}

function isDaveError(err: Error): boolean {
  return /DecryptionFailed|Unencrypted/i.test(err.message);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wait for an AudioPlayer to reach Idle (resource finished / stopped).
 * Used at every cue-play boundary so we proceed only after the cue is
 * actually heard — replaces the old fixed-duration `sleep(D_c)` sync.
 * The timeout is a safety cap in case the player never idles (e.g.,
 * connection died mid-cue).
 */
async function waitForPlayerIdle(player: AudioPlayer, timeoutMs = 15_000): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) return;
  try {
    await entersState(player, AudioPlayerStatus.Idle, timeoutMs);
  } catch { /* timeout — proceed anyway */ }
}
