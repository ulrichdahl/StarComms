import { describe, expect, it } from 'vitest';
import { RelayMetrics, emptyRelayStats, isFleetAudio } from './metrics.js';

describe('isFleetAudio', () => {
  // §5 constraint. This is the highest-consequence check in the whole product:
  // if it ever returns false for a fleet-owned user id, the fleet talks to
  // itself and the relay loops forever.
  it('flags a user id that is in the fleet set', () => {
    expect(isFleetAudio('bot-a', new Set(['bot-a', 'bot-b']))).toBe(true);
  });

  it('passes a user id that is not in the fleet set', () => {
    expect(isFleetAudio('human', new Set(['bot-a', 'bot-b']))).toBe(false);
  });

  it('handles an empty fleet set', () => {
    expect(isFleetAudio('anyone', new Set())).toBe(false);
  });
});

describe('emptyRelayStats', () => {
  it('reports configured=false so /healthz can distinguish unconfigured from broken', () => {
    const s = emptyRelayStats();
    expect(s.configured).toBe(false);
    expect(s.transmissions).toBe(0);
    expect(s.fleetAudioDropped).toBe(0);
    expect(s.lastLatencyMs).toBeNull();
  });
});

describe('RelayMetrics', () => {
  it('measures first-packet latency as target playing time minus speaker start', () => {
    const m = new RelayMetrics('src', 'tgt');
    m.onSpeakerStart('u1', 1_000);
    m.onPlayingBegan(1_042);
    const s = m.snapshot(true);
    expect(s.lastLatencyMs).toBe(42);
    expect(s.peakLatencyMs).toBe(42);
    expect(s.transmissions).toBe(1);
  });

  it('tracks the peak latency across multiple transmissions', () => {
    const m = new RelayMetrics('src', 'tgt');
    m.onSpeakerStart('u1', 1_000); m.onPlayingBegan(1_020);
    m.onPlaybackEnded();
    m.onSpeakerStart('u2', 2_000); m.onPlayingBegan(2_100);
    m.onPlaybackEnded();
    m.onSpeakerStart('u3', 3_000); m.onPlayingBegan(3_040);
    const s = m.snapshot(true);
    expect(s.lastLatencyMs).toBe(40);
    expect(s.peakLatencyMs).toBe(100);
    expect(s.transmissions).toBe(3);
  });

  it('does not compute latency if Playing arrives without a preceding SpeakerStart', () => {
    const m = new RelayMetrics('src', 'tgt');
    m.onPlayingBegan(1_000);
    const s = m.snapshot(true);
    expect(s.lastLatencyMs).toBeNull();
    expect(s.transmissions).toBe(1);
  });

  it('reports the current speaker while playback is in flight', () => {
    const m = new RelayMetrics('src', 'tgt');
    m.onSpeakerStart('alice', 1_000);
    m.onPlayingBegan(1_010);
    expect(m.snapshot(true).currentSpeaker).toBe('alice');
    m.onPlaybackEnded();
    expect(m.snapshot(true).currentSpeaker).toBeNull();
  });

  it('counts fleet drops independently of transmissions', () => {
    const m = new RelayMetrics('src', 'tgt');
    m.onFleetDrop(); m.onFleetDrop(); m.onFleetDrop();
    const s = m.snapshot(true);
    expect(s.fleetAudioDropped).toBe(3);
    expect(s.transmissions).toBe(0);
  });

  it('exposes source/target readiness so /healthz can degrade before the pipe is up', () => {
    const m = new RelayMetrics('src', 'tgt');
    expect(m.snapshot(true).sourceReady).toBe(false);
    m.sourceReady = true;
    m.targetReady = true;
    const s = m.snapshot(true);
    expect(s.sourceReady).toBe(true);
    expect(s.targetReady).toBe(true);
  });

  it('caps stored errors to bound the /healthz payload', () => {
    const m = new RelayMetrics('src', 'tgt');
    for (let i = 0; i < 50; i++) m.onError(`err ${i}`);
    expect(m.snapshot(true).errors.length).toBeLessThanOrEqual(20);
  });
});
