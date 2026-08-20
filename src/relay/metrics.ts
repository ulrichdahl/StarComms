/**
 * Blind relay stats — spec §16.3.
 *
 * Pulled out of the BlindRelay class so it can be unit-tested without a
 * Discord connection. The metric that matters most is the *first-packet
 * latency* — how long between a speaker's `speaking.on('start')` firing on
 * the source and the AudioPlayer transitioning to Playing on the target.
 * That is the additive latency the relay imposes, and step 3's stated
 * purpose is to measure it (spec §16.3).
 *
 * The other counter, `fleetAudioDropped`, is the §5 hard constraint made
 * observable: any non-zero value while the fleet has quiesced means the
 * suppression is doing real work.
 */

export interface CueStats {
  loaded: boolean;
  count: number;
  /** Absolute delta between source and target Playing state transitions. */
  lastSyncErrorMs: number | null;
  peakSyncErrorMs: number | null;
  lastPair: { source: string; target: string } | null;
  lastPlayedAt: string | null;
}

export interface RelayStatsSnapshot {
  configured: boolean;
  sourceChannelId: string;
  targetChannelId: string;
  sourceReady: boolean;
  targetReady: boolean;
  currentSpeaker: string | null;
  transmissions: number;
  fleetAudioDropped: number;
  lastLatencyMs: number | null;
  peakLatencyMs: number | null;
  cues: CueStats;
  errors: string[];
}

export class RelayMetrics {
  private currentSpeaker: string | null = null;
  private speakerStartAt: number | null = null;
  private transmissions = 0;
  private fleetAudioDropped = 0;
  private lastLatencyMs: number | null = null;
  private peakLatencyMs: number | null = null;
  private readonly errors: string[] = [];
  public sourceReady = false;
  public targetReady = false;

  private cuesLoaded = false;
  private cueCount = 0;
  private lastSyncErrorMs: number | null = null;
  private peakSyncErrorMs: number | null = null;
  private lastPair: { source: string; target: string } | null = null;
  private lastPlayedAt: string | null = null;

  constructor(
    private readonly sourceChannelId: string,
    private readonly targetChannelId: string,
  ) {}

  markCuesLoaded(): void { this.cuesLoaded = true; }

  onCuePairFired(source: string, target: string): void {
    this.cueCount++;
    this.lastPair = { source, target };
    this.lastPlayedAt = new Date().toISOString();
  }

  onCueSyncError(deltaMs: number): void {
    this.lastSyncErrorMs = deltaMs;
    if (this.peakSyncErrorMs === null || deltaMs > this.peakSyncErrorMs) {
      this.peakSyncErrorMs = deltaMs;
    }
  }

  onFleetDrop(): void { this.fleetAudioDropped++; }

  /** Called when we accept a speaker's opus stream on the source. */
  onSpeakerStart(userId: string, now: number = Date.now()): void {
    this.currentSpeaker = userId;
    this.speakerStartAt = now;
  }

  /** Called when the target AudioPlayer transitions Idle/Buffering → Playing. */
  onPlayingBegan(now: number = Date.now()): void {
    this.transmissions++;
    if (this.speakerStartAt !== null) {
      const latency = now - this.speakerStartAt;
      this.lastLatencyMs = latency;
      if (this.peakLatencyMs === null || latency > this.peakLatencyMs) {
        this.peakLatencyMs = latency;
      }
      this.speakerStartAt = null;
    }
  }

  onPlaybackEnded(): void {
    this.currentSpeaker = null;
    this.speakerStartAt = null;
  }

  onError(message: string): void {
    this.errors.push(message);
    while (this.errors.length > 20) this.errors.shift();
  }

  snapshot(configured: boolean): RelayStatsSnapshot {
    return {
      configured,
      sourceChannelId: this.sourceChannelId,
      targetChannelId: this.targetChannelId,
      sourceReady: this.sourceReady,
      targetReady: this.targetReady,
      currentSpeaker: this.currentSpeaker,
      transmissions: this.transmissions,
      fleetAudioDropped: this.fleetAudioDropped,
      lastLatencyMs: this.lastLatencyMs,
      peakLatencyMs: this.peakLatencyMs,
      cues: {
        loaded: this.cuesLoaded,
        count: this.cueCount,
        lastSyncErrorMs: this.lastSyncErrorMs,
        peakSyncErrorMs: this.peakSyncErrorMs,
        lastPair: this.lastPair,
        lastPlayedAt: this.lastPlayedAt,
      },
      errors: [...this.errors],
    };
  }
}

export function emptyRelayStats(): RelayStatsSnapshot {
  return {
    configured: false,
    sourceChannelId: '',
    targetChannelId: '',
    sourceReady: false,
    targetReady: false,
    currentSpeaker: null,
    transmissions: 0,
    fleetAudioDropped: 0,
    lastLatencyMs: null,
    peakLatencyMs: null,
    cues: {
      loaded: false, count: 0,
      lastSyncErrorMs: null, peakSyncErrorMs: null,
      lastPair: null, lastPlayedAt: null,
    },
    errors: [],
  };
}

/**
 * §5 fleet suppression check — dropped audio never reaches detection.
 * A one-line function so the call sites do not open-code it and drift.
 */
export function isFleetAudio(userId: string, fleetUserIds: Set<string>): boolean {
  return fleetUserIds.has(userId);
}
