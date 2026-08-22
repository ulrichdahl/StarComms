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
  type AudioPlayer, type AudioReceiveStream, type VoiceConnection,
} from '@discordjs/voice';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  type Client, type Message, type VoiceBasedChannel,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import type { CueSet } from '../lib/cues.js';
import { createCueResource } from '../lib/cues.js';

export type HailCloseReason =
  | 'silence' | 'button' | 'initiator_left' | 'max_hold'
  | 'drain' | 'error' | 'all_declined';

export type RingDecision = 'accepted' | 'declined' | 'timeout';

export interface HailServiceConfig {
  db: DB;
  fleet: Fleet;
  cues: CueSet;
  silenceCloseMs: number;
  maxHoldMs: number;
  ringIntervalMs: number;
  ringMaxMs: number;
}

export interface OpenHailInput {
  guildId: string;
  initiator: HailChannelSpec;
  target: HailChannelSpec;
}

export interface HailChannelSpec {
  channelId: string;
  ownerUserId: string;
}

export type OpenHailResult =
  | { ok: true; hailId: number }
  | { ok: false; reason: 'no_relays' | 'not_in_guild' | 'target_gone' | 'already_hailing' | string };

interface HailLeg {
  role: 'initiator' | 'target';
  channelId: string;
  guildId: string;
  ownerUserId: string;
  botNato: string;
  botClient: Client;
  connection: VoiceConnection;
  outboundPlayer: AudioPlayer;
  receiveStream: AudioReceiveStream | null;
  receiveResource: import('@discordjs/voice').AudioResource | null;
  endMessage: Message | null;
  cueRole: 'ready' | 'attention';
  /** DAVE decryption failures swallowed on this leg since the hail opened. */
  daveDrops: number;
  /** Speaking-start events observed for the leg's owner. */
  speakingStarts: number;
}

interface Hail {
  hailId: number;
  guildId: string;
  legs: [HailLeg, HailLeg];
  silenceTimer: NodeJS.Timeout | null;
  maxHoldTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  openedAt: number;
  ringResolver: ((d: RingDecision) => void) | null;
  ringMessage: Message | null;
  closing: boolean;
  closed: boolean;
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
 * Pure allocator: pick the first two available relay natos, skipping
 * those that are busy or whose Client is not reachable. Returns null if
 * fewer than two are free. Extracted from HailManager so the picking
 * logic can be tested without touching Discord or the DB.
 */
export function pickTwo(
  natos: readonly string[],
  isBusy: (nato: string) => boolean,
  isReachable: (nato: string) => boolean,
): [string, string] | null {
  const free = natos.filter((n) => !isBusy(n) && isReachable(n));
  if (free.length < 2) return null;
  return [free[0]!, free[1]!];
}

export class HailManager {
  private readonly hails = new Map<number, Hail>();
  private readonly busyNatos = new Set<string>();

  constructor(private readonly cfg: HailServiceConfig) {}

  activeCount(): number { return this.hails.size; }

  silenceCloseMs(): number { return this.cfg.silenceCloseMs; }

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
    if (hail.ringResolver === null) return 'not_ringing';
    const targetLeg = hail.legs.find((l) => l.role === 'target');
    if (targetLeg === undefined) return 'not_ringing';
    if (targetLeg.ownerUserId !== actorUserId) return 'not_owner';
    hail.ringResolver(decision);
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
    // Reject a duplicate initiator: 2-way hail only in this step.
    for (const h of this.hails.values()) {
      if (h.guildId !== input.guildId) continue;
      const initiator = h.legs.find((l) => l.role === 'initiator');
      if (initiator !== undefined && initiator.channelId === input.initiator.channelId) {
        return { ok: false, reason: 'already_hailing' };
      }
    }

    const pick = pickTwo(
      SQUAD_NATOS,
      (n) => this.busyNatos.has(n),
      (n) => {
        const client = this.tryClient(n);
        return client !== null && client.guilds.cache.has(input.guildId);
      },
    );
    if (pick === null) {
      // Distinguish "no bots in this guild at all" from "all busy" so
      // the operator gets an actionable message.
      const reachable = [...SQUAD_NATOS].filter((n) => {
        const c = this.tryClient(n);
        return c !== null && c.guilds.cache.has(input.guildId);
      });
      if (reachable.length < 2) {
        return { ok: false, reason: 'not_in_guild' };
      }
      return { ok: false, reason: 'no_relays' };
    }
    const [initiatorNato, targetNato] = pick;

    // Reserve immediately so a second concurrent open sees them busy.
    this.busyNatos.add(initiatorNato);
    this.busyNatos.add(targetNato);

    const now = Date.now();
    const insert = this.cfg.db.prepare(`
      INSERT INTO active_hails (guild_id, initiator_channel_id, opened_at)
      VALUES (?, ?, ?)
    `).run(input.guildId, input.initiator.channelId, now);
    const hailId = Number(insert.lastInsertRowid);
    logHailEvent(this.cfg.db, hailId, 'opened', input.initiator.ownerUserId, input.target.channelId);

    try {
      const initiatorLeg = await this.joinLeg({
        role: 'initiator',
        botNato: initiatorNato,
        guildId: input.guildId,
        channelId: input.initiator.channelId,
        ownerUserId: input.initiator.ownerUserId,
        cueRole: 'ready',
      });
      const targetLeg = await this.joinLeg({
        role: 'target',
        botNato: targetNato,
        guildId: input.guildId,
        channelId: input.target.channelId,
        ownerUserId: input.target.ownerUserId,
        cueRole: 'attention',
      });

      const legs: [HailLeg, HailLeg] = [initiatorLeg, targetLeg];
      const hail: Hail = {
        hailId, guildId: input.guildId, legs,
        silenceTimer: null, maxHoldTimer: null, heartbeatTimer: null,
        ringResolver: null, ringMessage: null,
        openedAt: Date.now(),
        closing: false, closed: false,
      };
      this.hails.set(hailId, hail);

      // Ring phase — locked target has to accept before we proceed.
      // Insert hail_participants rows once resolution is known, so the
      // row's `decision` matches the outcome and satisfies NOT NULL.
      const targetLocked = isChannelLocked(this.cfg.db, input.target.channelId);
      let ringOutcome: RingDecision = 'accepted';
      if (targetLocked) {
        logHailEvent(this.cfg.db, hailId, 'ring_started', null, input.target.channelId);
        ringOutcome = await this.ringForAccept(hail, targetLeg);
      }

      const now = Date.now();
      if (ringOutcome !== 'accepted') {
        // Log the outcome per participant, then wind down with Busy.
        logHailEvent(
          this.cfg.db, hailId,
          ringOutcome === 'declined' ? 'declined' : 'timeout',
          null, input.target.channelId,
        );
        this.cfg.db.prepare(`
          INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, left_at, decision)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(hailId, initiatorLeg.channelId, initiatorLeg.botNato, now, now, 'accepted');
        this.cfg.db.prepare(`
          INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, left_at, decision)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          hailId, targetLeg.channelId, targetLeg.botNato, now, now,
          ringOutcome === 'declined' ? 'declined' : 'timed_out',
        );
        await this.refuseHail(hail, initiatorLeg, targetLeg);
        return { ok: false, reason: ringOutcome };
      }

      // Accepted (either auto or after Accept click). Record both
      // participants + log the accept event when a real click happened.
      for (const leg of legs) {
        this.cfg.db.prepare(`
          INSERT INTO hail_participants (hail_id, channel_id, bot_id, joined_at, decision)
          VALUES (?, ?, ?, ?, ?)
        `).run(hailId, leg.channelId, leg.botNato, now, 'accepted');
      }
      if (targetLocked) {
        logHailEvent(
          this.cfg.db, hailId, 'accepted',
          targetLeg.ownerUserId, targetLeg.channelId,
        );
      }

      // Cues concurrent, then wait D_c so relay audio does not step on them.
      for (const leg of legs) {
        leg.outboundPlayer.play(createCueResource(this.cfg.cues.get(leg.cueRole)));
      }
      await sleep(this.cfg.cues.expectedDurationMs);

      // Wire the bidirectional relay AFTER cues finish.
      this.wireLegAudio(hail, initiatorLeg, targetLeg);
      this.wireLegAudio(hail, targetLeg, initiatorLeg);

      // End buttons via the controller Client (only bot with SEND_MESSAGES
      // in the vessel), so both sides see the button in their voice-text.
      const controller = this.cfg.fleet.controllerClient();
      for (const leg of legs) {
        leg.endMessage = await postEndButton(controller, leg.channelId, hailId).catch((err) => {
          console.error(`hail ${hailId}: end-button post failed on ${leg.channelId}: ${errMsg(err)}`);
          return null;
        });
      }

      // Silence + max-hold timers + telemetry heartbeat.
      this.armSilence(hail);
      hail.maxHoldTimer = setTimeout(() => {
        void this._close(hail, 'max_hold').catch(() => {});
      }, this.cfg.maxHoldMs);
      this.startHeartbeat(hail);

      return { ok: true, hailId };
    } catch (err) {
      console.error(`hail ${hailId}: open failed: ${errMsg(err)}`);
      const hail = this.hails.get(hailId);
      if (hail !== undefined) {
        await this._close(hail, 'error');
      } else {
        // Never made it into the map. Free bots + close the row.
        this.busyNatos.delete(initiatorNato);
        this.busyNatos.delete(targetNato);
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
      receiveStream: null,
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

  private wireLegAudio(hail: Hail, source: HailLeg, sink: HailLeg): void {
    const stream = source.connection.receiver.subscribe(source.ownerUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.cfg.silenceCloseMs },
    });
    stream.on('error', (err) => {
      if (isDaveError(err)) { source.daveDrops += 1; return; }
      console.error(`hail ${hail.hailId}: receive stream error on ${source.channelId}: ${err.message}`);
    });
    stream.on('end', () => {
      console.log(`hail-diag: hail ${hail.hailId} receive stream END on ${source.channelId} [${source.botNato}]`);
    });
    stream.on('close', () => {
      console.log(`hail-diag: hail ${hail.hailId} receive stream CLOSE on ${source.channelId} [${source.botNato}]`);
    });
    source.receiveStream = stream;

    const resource = createAudioResource(stream, { inputType: StreamType.Opus });
    source.receiveResource = resource;
    sink.outboundPlayer.play(resource);

    // Any speech by the source owner re-arms the silence timer.
    // `speaking.on('start', userId)` fires on the connection's receiver.
    source.connection.receiver.speaking.on('start', (userId) => {
      if (userId !== source.ownerUserId) return;
      source.speakingStarts += 1;
      if (hail.closing || hail.closed) return;
      this.armSilence(hail);
    });
  }

  /** 5-second heartbeat — one line per active hail with per-leg counters. */
  private startHeartbeat(hail: Hail): void {
    if (hail.heartbeatTimer !== null) clearInterval(hail.heartbeatTimer);
    hail.heartbeatTimer = setInterval(() => {
      if (hail.closed) return;
      const uptime = Math.round((Date.now() - hail.openedAt) / 1000);
      for (const leg of hail.legs) {
        const inbound = leg.receiveResource?.playbackDuration ?? 0;
        const inboundS = (inbound / 1000).toFixed(1);
        console.log(
          `hail-hb: h${hail.hailId} +${uptime}s ${leg.role}[${leg.botNato}]→${leg.channelId} ` +
          `conn=${leg.connection.state.status} ` +
          `player=${leg.outboundPlayer.state.status} ` +
          `inboundS=${inboundS} ` +
          `speakingStarts=${leg.speakingStarts} ` +
          `daveDrops=${leg.daveDrops}`,
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
    hail.ringMessage = await postRingButtons(controller, targetLeg.channelId, hail.hailId)
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
        hail.ringResolver = null;
        resolve(result);
      };
      hail.ringResolver = finish;

      const playRing = (): void => {
        if (done || hail.closing || hail.closed) return;
        try {
          targetLeg.outboundPlayer.play(createCueResource(this.cfg.cues.get('ring')));
        } catch (err) {
          console.error(`hail ${hail.hailId}: ring cue play failed: ${errMsg(err)}`);
        }
        ringTimer = setTimeout(playRing, this.cfg.ringIntervalMs);
      };
      playRing();

      maxTimer = setTimeout(() => finish('timeout'), this.cfg.ringMaxMs);
    });
  }

  /**
   * Wind-down for a hail that was refused (declined or timed out).
   * Plays `busy` in the initiator's channel — no `end` on the target
   * because the hail never fully opened — disconnects both bots, and
   * writes the close row with reason 'all_declined'.
   */
  private async refuseHail(
    hail: Hail, initiatorLeg: HailLeg, _targetLeg: HailLeg,
  ): Promise<void> {
    hail.closing = true;
    this.stopHeartbeat(hail);

    // Delete ring buttons before Busy plays so the target does not see
    // stale controls while the initiator hears the refuse cue.
    if (hail.ringMessage !== null) {
      await hail.ringMessage.delete().catch(() => {});
      hail.ringMessage = null;
    }

    try {
      initiatorLeg.outboundPlayer.play(createCueResource(this.cfg.cues.get('busy')));
    } catch (err) {
      console.error(`hail ${hail.hailId}: busy cue play failed: ${errMsg(err)}`);
    }
    await sleep(this.cfg.cues.expectedDurationMs);

    for (const leg of hail.legs) {
      try { leg.outboundPlayer.stop(true); } catch { /* ok */ }
      try { leg.connection.destroy(); } catch { /* ok */ }
    }

    const now = Date.now();
    this.cfg.db.prepare(
      `UPDATE active_hails SET closed_at = ?, close_reason = ? WHERE id = ?`,
    ).run(now, 'all_declined', hail.hailId);
    for (const leg of hail.legs) this.busyNatos.delete(leg.botNato);
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
    // If a ring is still in flight (initiator left before the target
    // resolved), collapse it as 'timeout' so open() unblocks and the
    // refuseHail path takes over. The DB row will already have been
    // marked closed by the caller of _close, but the ring buttons must
    // be removed either way.
    if (hail.ringResolver !== null) {
      hail.ringResolver('timeout');
      hail.ringResolver = null;
    }
    if (hail.ringMessage !== null) {
      await hail.ringMessage.delete().catch(() => {});
      hail.ringMessage = null;
    }

    // Tear down inbound audio first so cues do not fight remote audio.
    for (const leg of hail.legs) {
      if (leg.receiveStream !== null) {
        try { leg.receiveStream.destroy(); } catch { /* already dead */ }
      }
    }

    // Play `end` cue on both, wait D_c.
    for (const leg of hail.legs) {
      leg.outboundPlayer.play(createCueResource(this.cfg.cues.get('end')));
    }
    await sleep(this.cfg.cues.expectedDurationMs);

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
  controller: Client, channelId: string, hailId: number,
): Promise<Message | null> {
  const channel = await controller.channels.fetch(channelId).catch(() => null);
  if (channel === null) return null;
  if (channel.type !== ChannelType.GuildVoice) return null;
  const voice = channel as VoiceBasedChannel;
  const button = new ButtonBuilder()
    .setCustomId(`${HAIL_END_PREFIX}${hailId}`)
    .setLabel('End hail')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  return voice.send({ content: '🛰️ **Hail active.**', components: [row] });
}

async function postRingButtons(
  controller: Client, channelId: string, hailId: number,
): Promise<Message | null> {
  const channel = await controller.channels.fetch(channelId).catch(() => null);
  if (channel === null) return null;
  if (channel.type !== ChannelType.GuildVoice) return null;
  const voice = channel as VoiceBasedChannel;
  const accept = new ButtonBuilder()
    .setCustomId(`${HAIL_ACCEPT_PREFIX}${hailId}`)
    .setLabel('Accept')
    .setStyle(ButtonStyle.Success);
  const decline = new ButtonBuilder()
    .setCustomId(`${HAIL_DECLINE_PREFIX}${hailId}`)
    .setLabel('Decline')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(accept, decline);
  return voice.send({
    content: '🛰️ **Incoming hail.** Only the vessel owner can respond.',
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ensure a player has settled to Idle before we drop references. Used in tests. */
export async function _waitIdle(player: AudioPlayer, timeoutMs = 200): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    player.once(AudioPlayerStatus.Idle, () => { clearTimeout(timer); resolve(); });
  });
}
