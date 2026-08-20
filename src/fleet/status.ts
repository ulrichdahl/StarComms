/**
 * Status endpoint — the step 2 equivalent of the spike's verdict.
 *
 * Serves JSON on /healthz. Green means every fleet member is logged in and its
 * shard is READY. Yellow (200 with `degraded`) means some members are
 * reconnecting; that is the resume path in flight and not a failure. Red (503)
 * means at least one member is stuck disconnected or errored past a threshold.
 */

import { createServer, type Server } from 'node:http';
import type { SweepCounts } from './boot-sweep.js';
import type { BotState, Fleet } from './manager.js';
import { emptyRelayStats, type RelayStatsSnapshot } from '../relay/metrics.js';
import type { BlindRelay } from '../relay/blind.js';

export type Verdict = 'ok' | 'degraded' | 'fail';

export interface HealthReport {
  verdict: Verdict;
  reason: string;
  bots: BotState[];
  sweep: SweepCounts;
  relay: RelayStatsSnapshot;
  startedAt: string;
  uptimeSec: number;
}

function judge(bots: BotState[], relay: RelayStatsSnapshot): { verdict: Verdict; reason: string } {
  if (bots.length === 0) return { verdict: 'fail', reason: 'no fleet members configured' };
  const notLoggedIn = bots.filter((b) => !b.loggedIn);
  if (notLoggedIn.length > 0) {
    return { verdict: 'fail', reason: `${notLoggedIn.length} member(s) not logged in` };
  }
  const notReady = bots.filter((b) => b.status !== 'Ready');
  if (notReady.length > 0) {
    return {
      verdict: 'degraded',
      reason: `${notReady.length} member(s) not ready: ${notReady.map((b) => `${b.nato}=${b.status}`).join(', ')}`,
    };
  }
  if (relay.configured && (!relay.sourceReady || !relay.targetReady)) {
    return { verdict: 'degraded', reason: 'relay legs not both ready' };
  }
  return { verdict: 'ok', reason: 'all members ready' };
}

export function buildReport(
  fleet: Fleet,
  sweep: SweepCounts,
  relay: RelayStatsSnapshot,
  startedAt: Date,
): HealthReport {
  const bots = fleet.states();
  const { verdict, reason } = judge(bots, relay);
  return {
    verdict, reason, bots, sweep, relay,
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
  };
}

export interface StatusServerOptions {
  port: number;
  fleet: Fleet;
  sweep: SweepCounts;
  startedAt: Date;
  /** Absent when RELAY_*_CHANNEL_ID were unset — the endpoint still serves. */
  relay: BlindRelay | null;
}

/**
 * Fire the ready/attention cue pair through the active relay. Not a slash
 * command — those need the controller (alfa) to register per-guild, which
 * arrives with the wizard in step 5. `/trigger` is the step 4 test surface.
 * Verbs recognised: hail, command, broadcast (all fire the same pair for
 * step 4 — grammar-differentiated cues are step 6).
 */
function fireTrigger(relay: BlindRelay | null, verb: string): { status: number; body: object } {
  if (relay === null) {
    return { status: 503, body: { error: 'relay not configured' } };
  }
  if (!relay.hasCues()) {
    return { status: 503, body: { error: 'cue engine not loaded' } };
  }
  const accepted = new Set(['hail', 'command', 'broadcast']);
  if (!accepted.has(verb)) {
    return { status: 400, body: { error: `unknown verb ${verb}; accepted: ${[...accepted].join(', ')}` } };
  }
  try {
    // Every accepted verb opens a net: Ready to the caller, Attention to the receivers.
    // Alert (Horn) is step 6 — until then this endpoint mirrors the hail/command/broadcast
    // trio, which all share the same cue pair per §5.
    relay.playCuePair('ready', 'attention');
    return { status: 202, body: { fired: 'ready+attention', verb } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export function startStatusServer(opts: StatusServerOptions): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      const relayStats = opts.relay === null ? emptyRelayStats() : opts.relay.snapshot();
      const report = buildReport(opts.fleet, opts.sweep, relayStats, opts.startedAt);
      const status = report.verdict === 'fail' ? 503 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report, null, 2));
      return;
    }
    if (url.pathname === '/trigger' && req.method === 'POST') {
      const verb = url.searchParams.get('verb') ?? 'hail';
      const { status, body } = fireTrigger(opts.relay, verb);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(opts.port, '0.0.0.0', () =>
    console.log(`health: http://localhost:${opts.port}/healthz    trigger: POST /trigger?verb=hail`));
  return server;
}
