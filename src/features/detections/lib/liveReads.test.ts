import { describe, it, expect } from 'vitest';
import { LIVE_CLOCK_EPOCH_MS, liveClockSeconds, livePosition } from '@/features/cameras/lib/liveClock';
import type { CameraEvents, PlateEvent } from '../api';
import { clockDuration, goodReads, recentCameraReads, recentNetworkReads } from './liveReads';

function ev(time_sec: number, over: Partial<PlateEvent> = {}): PlateEvent {
  return {
    camera_code: 'VP-01', tracked_vehicle_id: `trk_${time_sec}`, plate_text: `MH 02 AB ${String(Math.round(time_sec * 10)).padStart(4, '0')}`,
    plate_read: null, plate_confidence: 0.9, grammar_valid: true, vehicle_type: 'car', vehicle_class: 'Car', time_sec,
    bbox: { x: 0, y: 0, width: 10, height: 10 }, ...over,
  };
}
function cam(code: string, events: PlateEvent[], duration = 60): CameraEvents {
  return { camera_code: code, duration_sec: duration, events: events.map((e) => ({ ...e, camera_code: code })) };
}

/** A wall time at which camera `code` is exactly at clip position `pos` (loop ≥ 1). */
function nowAt(code: string, pos: number, dur: number): number {
  const base = LIVE_CLOCK_EPOCH_MS + 7 * 86_400_000;
  const cur = livePosition(code, dur, base);
  let delta = pos - cur;
  if (delta < 0) delta += dur;
  return base + delta * 1000;
}

describe('live reads', () => {
  it('keeps only good reads (≥ 75 % and valid grammar)', () => {
    const c = cam('VP-01', [ev(1), ev(2, { plate_confidence: 0.74 }), ev(3, { grammar_valid: false }), ev(4, { plate_text: null })]);
    expect(goodReads(c).map((e) => e.time_sec)).toEqual([1]);
  });

  it('a read appears exactly when the live clock passes its time_sec', () => {
    const c = cam('VP-01', [ev(10), ev(20)], 60);
    const before = recentCameraReads(c, nowAt('VP-01', 19.9, 60));
    const after = recentCameraReads(c, nowAt('VP-01', 20.1, 60));
    expect(before[0].event.time_sec).toBe(10);
    expect(after[0].event.time_sec).toBe(20);
    // stamped with the wall time it happened (0.1 s ago)
    const now = nowAt('VP-01', 20.1, 60);
    expect(now - recentCameraReads(c, now)[0].at).toBeCloseTo(100, 0);
  });

  it('continues across the loop point (previous loop reads follow, newest first)', () => {
    const c = cam('VP-01', [ev(10), ev(50)], 60);
    const reads = recentCameraReads(c, nowAt('VP-01', 5, 60), { limit: 4 });
    expect(reads.map((r) => r.event.time_sec)).toEqual([50, 10, 50, 10]);
    // occurrences in different loops have distinct keys
    expect(new Set(reads.map((r) => r.key)).size).toBe(4);
    for (let i = 1; i < reads.length; i++) expect(reads[i - 1].at).toBeGreaterThan(reads[i].at);
  });

  it('respects maxAgeSec', () => {
    const c = cam('VP-01', [ev(10), ev(50)], 60);
    const reads = recentCameraReads(c, nowAt('VP-01', 55, 60), { maxAgeSec: 30 });
    expect(reads.map((r) => r.event.time_sec)).toEqual([50]);
  });

  it('merges cameras newest first and skips cameras without good reads', () => {
    const a = cam('VP-01', [ev(10)], 60);
    const b = cam('AN-01', [ev(5)], 40);
    const none = cam('BH-01', [ev(3, { plate_text: null })], 20);
    const now = LIVE_CLOCK_EPOCH_MS + 3 * 86_400_000;
    const reads = recentNetworkReads([a, b, none], now, { limit: 10 });
    expect(reads.every((r) => r.camera_code !== 'BH-01')).toBe(true);
    expect(reads.length).toBe(10);
    for (let i = 1; i < reads.length; i++) expect(reads[i - 1].at).toBeGreaterThanOrEqual(reads[i].at);
    // every occurrence lies on its own camera's clock
    for (const r of reads) {
      const doc = r.camera_code === 'VP-01' ? a : b;
      const T = liveClockSeconds(r.camera_code, r.at);
      const pos = T - Math.floor(T / clockDuration(doc)) * clockDuration(doc);
      expect(pos).toBeCloseTo(r.event.time_sec, 3);
    }
  });
});
