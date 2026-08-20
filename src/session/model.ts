/**
 * Session model — the shape of a live operation.
 *
 * Two modes per §3, resolved 20 Aug 2026 in §17 #2 with named callsigns:
 *
 *   command mode: Command  + Alpha    + Bravo    + Charlie
 *   joint mode:   Head Ops + Alpha Ops + Bravo Ops + Charlie Ops
 *
 * v1 fleet is fixed at 4 applications (main + alfa/bravo/charlie). The
 * "main" application does double duty per §17 #4: it registers slash
 * commands AND occupies the primary net's voice channel — Command in
 * command mode, Head Ops in joint mode. Squad members join the squad
 * nets in fleet order (alfa → Alpha / Alpha Ops, and so on).
 *
 * `squads` is the number of *secondary* nets the operator wants (1..3);
 * the primary is always present. So `command mode, squads=2` opens three
 * nets: Command, Alpha, Bravo. And `command mode, squads=3` opens four:
 * Command, Alpha, Bravo, Charlie — the full v1 fleet.
 */

export type SessionMode = 'command' | 'joint';
export type NetRole = 'command' | 'squad' | 'ops';

/** botKey is the fleet-side identity — 'main' for the controller, else nato. */
export interface NetSpec {
  callsign: string;
  role: NetRole;
  botKey: 'main' | 'alfa' | 'bravo' | 'charlie';
}

export interface SessionNet extends NetSpec {
  channelId: string;
}

export interface SessionRecord {
  id: number;
  guildId: string;
  mode: SessionMode;
  leadUserId: string;
  startedAt: number;
  endedAt: number | null;
  teardownAt: number | null;
  muteOthers: boolean;
  nets: SessionNet[];
}

export const MAX_SQUADS = 3;

const SQUAD_ORDER = ['alfa', 'bravo', 'charlie'] as const;
const SQUAD_CALLSIGNS = ['Alpha', 'Bravo', 'Charlie'] as const;

export function netsFor(mode: SessionMode, squads: number): NetSpec[] {
  const s = Math.max(1, Math.min(MAX_SQUADS, squads));
  if (mode === 'command') {
    const nets: NetSpec[] = [
      { callsign: 'Command', role: 'command', botKey: 'main' },
    ];
    for (let i = 0; i < s; i++) {
      nets.push({
        callsign: SQUAD_CALLSIGNS[i] as string,
        role: 'squad',
        botKey: SQUAD_ORDER[i] as 'alfa' | 'bravo' | 'charlie',
      });
    }
    return nets;
  }
  const nets: NetSpec[] = [
    { callsign: 'Head Ops', role: 'ops', botKey: 'main' },
  ];
  for (let i = 0; i < s; i++) {
    nets.push({
      callsign: `${SQUAD_CALLSIGNS[i] as string} Ops`,
      role: 'ops',
      botKey: SQUAD_ORDER[i] as 'alfa' | 'bravo' | 'charlie',
    });
  }
  return nets;
}
