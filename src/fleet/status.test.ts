import { describe, expect, it } from 'vitest';
import { buildReport } from './status.js';
import { emptySweep } from './boot-sweep.js';
import type { BotState, Fleet } from './manager.js';

function fakeFleet(bots: BotState[]): Fleet {
  return { states: () => bots, size: bots.length } as unknown as Fleet;
}

function bot(nato: string, o: Partial<BotState> = {}): BotState {
  return {
    nato,
    applicationId: '1'.repeat(18),
    controller: false,
    loggedIn: true,
    status: 'Ready',
    tag: `${nato}#0001`,
    guildIds: ['g1'],
    resumes: 0, reconnects: 0, disconnects: 0, errors: 0,
    lastEventAt: null, lastEvent: null,
    ...o,
  };
}

describe('buildReport', () => {
  it('is ok when every member is logged in and ready', () => {
    const r = buildReport(fakeFleet([bot('alfa'), bot('bravo')]), emptySweep(), new Date());
    expect(r.verdict).toBe('ok');
  });

  it('is degraded when a member is reconnecting', () => {
    const r = buildReport(
      fakeFleet([bot('alfa'), bot('bravo', { status: 'Connecting' })]),
      emptySweep(), new Date(),
    );
    expect(r.verdict).toBe('degraded');
    expect(r.reason).toMatch(/bravo=Connecting/);
  });

  it('is fail when a member is not logged in', () => {
    const r = buildReport(
      fakeFleet([bot('alfa'), bot('bravo', { loggedIn: false, status: 'Idle' })]),
      emptySweep(), new Date(),
    );
    expect(r.verdict).toBe('fail');
  });

  it('is fail when the fleet is empty', () => {
    const r = buildReport(fakeFleet([]), emptySweep(), new Date());
    expect(r.verdict).toBe('fail');
  });

  it('surfaces sweep counts alongside the verdict', () => {
    const r = buildReport(
      fakeFleet([bot('alfa')]),
      { mutesToRestore: 2, sessionsPastTeardown: 0, poolOverwrites: 1, openRelays: 0 },
      new Date(),
    );
    expect(r.sweep.mutesToRestore).toBe(2);
    expect(r.sweep.poolOverwrites).toBe(1);
  });
});
