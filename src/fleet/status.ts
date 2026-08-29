/**
 * Status endpoint.
 *
 * Serves JSON on /healthz. Green means every fleet member is logged in
 * and its shard is READY. Yellow (200 with `degraded`) means some
 * members are reconnecting — the resume path in flight, not a failure.
 * Red (503) means at least one member is stuck disconnected or errored
 * past a threshold.
 */

import { createServer, type Server } from 'node:http';
import { ownVersion } from '../lib/pkg.js';
import type { SweepCounts } from './boot-sweep.js';
import type { BotState, Fleet } from './manager.js';

export type Verdict = 'ok' | 'degraded' | 'fail';

export interface HealthReport {
  verdict: Verdict;
  reason: string;
  bots: BotState[];
  sweep: SweepCounts;
  version: string;
  startedAt: string;
  uptimeSec: number;
}

function judge(bots: BotState[]): { verdict: Verdict; reason: string } {
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
  return { verdict: 'ok', reason: 'all members ready' };
}

export function buildReport(
  fleet: Fleet,
  sweep: SweepCounts,
  startedAt: Date,
): HealthReport {
  const bots = fleet.states();
  const { verdict, reason } = judge(bots);
  return {
    verdict, reason, bots, sweep,
    version: ownVersion(),
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
  };
}

export interface StatusServerOptions {
  port: number;
  fleet: Fleet;
  sweep: SweepCounts;
  startedAt: Date;
}

export function startStatusServer(opts: StatusServerOptions): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      const report = buildReport(opts.fleet, opts.sweep, opts.startedAt);
      const status = report.verdict === 'fail' ? 503 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report, null, 2));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(opts.port, '0.0.0.0', () =>
    console.log(`health: http://localhost:${opts.port}/healthz`));
  return server;
}
