/**
 * SessionRouter — spec §5 & §16.6.
 *
 * Ties the detection pipeline to the session lifecycle: on every detected
 * utterance, run the grammar parser → callsign matcher → session relay.
 *
 * v1 simplification: **one relay at a time per session**. The spec's
 * per-net lock table matters when multiple sources can originate hails
 * (joint ops mode; command mode with squad-lead replies). In v1 only the
 * primary net has detection attached, so there is only ever one caller
 * candidate at a time — a session-scoped lock is behaviourally identical
 * to per-net locks. When step 6c introduces squad-lead reply detection,
 * this collapses upward into a proper Map<netCallsign, RelayHandle>.
 *
 * The detection listener is paused for the duration of an active relay
 * — same pattern as the manual `/star-bridge hail`. That means a
 * spoken terminator (`over`, `slut`, `out`) mid-transmission is NOT
 * recognised in this step; the relay closes on `silence_close_ms`
 * instead. Terminator recognition needs a shared opus-tap so
 * detection can keep running mid-relay; that is a 6c refactor.
 */

import type { Client } from 'discord.js';
import { getVoiceConnection, type VoiceConnection } from '@discordjs/voice';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import type { CueSet } from '../lib/cues.js';
import type { DetectionListener, Detection } from '../detection/listener.js';
import { parseCallup, type Locale } from '../detection/grammar.js';
import { matchCallsign } from '../detection/matcher.js';
import type { SessionNet } from './model.js';
import { runSessionRelay, type SessionRelayResult } from './relay.js';

export interface SessionRouterConfig {
  sessionId: number;
  guildId: string;
  locale: Locale;
  fleet: Fleet;
  nets: SessionNet[];
  cues: CueSet;
  db: DB;
  silenceCloseMs: number;
  maxHoldMs: number;
  detection: DetectionListener;
}

export class SessionRouter {
  private busy = false;
  private stopping = false;

  constructor(private readonly cfg: SessionRouterConfig) {
    this.cfg.detection.on('detection', (d: Detection) => {
      // Fire-and-forget; each call self-guards on this.busy.
      void this.onDetection(d);
    });
  }

  private async onDetection(d: Detection): Promise<void> {
    if (this.stopping) return;

    const parsed = parseCallup(d.transcript.text, this.cfg.locale);
    if (parsed === null) {
      // Not a call-up. Common — most speech at Discord latency is small
      // talk between transmissions.
      console.log(`router: no call-up in "${d.transcript.text}"`);
      return;
    }

    // v1 handles command + hail (both = "open a route to callsign").
    // Terminators are handled by silence-close. Alert/broadcast defer to 6c.
    if (parsed.verb === 'terminator') {
      console.log(`router: terminator heard (spoken close is 6c; silence-close handles this today)`);
      return;
    }
    if (parsed.verb === 'alert' || parsed.verb === 'broadcast') {
      console.log(`router: ${parsed.verb} recognised but not yet routed (step 6c)`);
      return;
    }

    if (parsed.callsignHeard === null) {
      // Shouldn't happen for hail/command per grammar rules, but guard anyway.
      return;
    }

    if (this.busy) {
      console.log(`router: dropping "${parsed.raw}" — a route is already open`);
      // Busy cue on the caller's net is a follow-up.
      return;
    }

    const active = this.squadCallsigns();
    const m = matchCallsign(parsed.callsignHeard, {
      activeCallsigns: active,
      db: this.cfg.db,
      guildId: this.cfg.guildId,
    });

    if (m.callsign === null) {
      console.log(`router: NEGATIVE — heard "${parsed.callsignHeard}", no match against [${active.join(', ')}]`);
      // Negative cue on caller's net is a follow-up.
      return;
    }

    const distanceNote = m.distance !== undefined ? ` (distance=${m.distance})` : '';
    console.log(`router: ${parsed.verb} → ${m.callsign} via ${m.layer}${distanceNote}`);

    await this.openRoute(d.userId, m.callsign);
  }

  private squadCallsigns(): string[] {
    // Primary net is not a hail target (§5: hail routes to a *different*
    // net; command routes to squad). Exclude the primary from the match
    // candidate list so "Command" cannot resolve to itself.
    return this.cfg.nets.filter((n) => n.botKey !== 'main').map((n) => n.callsign);
  }

  private targetNetFor(callsign: string): SessionNet | undefined {
    return this.cfg.nets.find((n) => n.callsign === callsign);
  }

  private clientFor(botKey: SessionNet['botKey']): Client {
    return botKey === 'main' ? this.cfg.fleet.controllerClient() : this.cfg.fleet.clientFor(botKey);
  }

  private connectionForBot(botKey: SessionNet['botKey']): VoiceConnection | null {
    const userId = this.clientFor(botKey).user?.id;
    if (userId === undefined) return null;
    return getVoiceConnection(this.cfg.guildId, userId) ?? null;
  }

  private async openRoute(callerId: string, targetCallsign: string): Promise<void> {
    const target = this.targetNetFor(targetCallsign);
    const primary = this.cfg.nets[0];
    if (target === undefined || primary === undefined) {
      console.error(`router: cannot open — target ${targetCallsign} not resolved or session has no primary`);
      return;
    }

    const sourceConn = this.connectionForBot(primary.botKey);
    const targetConn = this.connectionForBot(target.botKey);
    if (sourceConn === null || targetConn === null) {
      console.error(`router: cannot open — source or target voice connection missing`);
      return;
    }

    this.busy = true;
    this.cfg.detection.pause();

    let result: SessionRelayResult;
    try {
      result = await runSessionRelay({
        sourceConnection: sourceConn,
        targetConnection: targetConn,
        cues: this.cfg.cues,
        commanderUserId: callerId,
        silenceCloseMs: this.cfg.silenceCloseMs,
        maxHoldMs: this.cfg.maxHoldMs,
      });
    } catch (err) {
      console.error(`router: runSessionRelay threw: ${err instanceof Error ? err.message : err}`);
      result = { closedBy: 'error', durationMs: 0, opusPackets: 0, errorMessage: 'threw' };
    } finally {
      this.busy = false;
      if (!this.stopping) this.cfg.detection.resume();
    }

    console.log(
      `router: route ${primary.callsign} → ${target.callsign} closed=${result.closedBy}` +
      ` durationMs=${result.durationMs} playback~=${result.opusPackets * 20}ms`,
    );
  }

  stop(): void {
    this.stopping = true;
  }

  /** For /healthz. */
  snapshot(): { busy: boolean; primary: string | null; squads: string[] } {
    return {
      busy: this.busy,
      primary: this.cfg.nets[0]?.callsign ?? null,
      squads: this.squadCallsigns(),
    };
  }
}
