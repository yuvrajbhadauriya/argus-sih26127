import { describe, it, expect } from 'vitest';
import {
  LIVE_CLOCK_EPOCH_MS,
  cameraClockOffset,
  liveClockSeconds,
  livePosition,
  loopDelta,
  syncVideoToLiveClock,
} from './liveClock';

describe('live clock', () => {
  it('gives each camera a stable offset in [0, 3600)', () => {
    const a = cameraClockOffset('VP-01');
    expect(a).toBe(cameraClockOffset('VP-01'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(3600);
    expect(cameraClockOffset('VP-01')).not.toBe(cameraClockOffset('AN-01'));
  });

  it('advances one second per wall-clock second', () => {
    const now = LIVE_CLOCK_EPOCH_MS + 10_000_000;
    expect(liveClockSeconds('JG-01', now + 1000) - liveClockSeconds('JG-01', now)).toBeCloseTo(1, 6);
  });

  it('wraps the position into the clip duration', () => {
    const off = cameraClockOffset('SC-01');
    const now = LIVE_CLOCK_EPOCH_MS + 125_500; // 125.5 s after the epoch
    const expected = (125.5 + off) % 40;
    expect(livePosition('SC-01', 40, now)).toBeCloseTo(expected, 6);
    for (let k = 0; k < 50; k++) {
      const p = livePosition('SC-01', 40, now + k * 7_331);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(40);
    }
  });

  it('is continuous across the loop point', () => {
    // Find the instant the clip wraps, then check just before / after.
    const dur = 30;
    const base = LIVE_CLOCK_EPOCH_MS;
    const toWrap = dur - livePosition('DD-01', dur, base);
    const before = livePosition('DD-01', dur, base + (toWrap - 0.1) * 1000);
    const after = livePosition('DD-01', dur, base + (toWrap + 0.1) * 1000);
    expect(before).toBeGreaterThan(dur - 0.2);
    expect(after).toBeLessThan(0.2);
    expect(loopDelta(before, after, dur)).toBeCloseTo(0.2, 3);
  });

  it('returns 0 for unknown durations', () => {
    expect(livePosition('VP-01', NaN)).toBe(0);
    expect(livePosition('VP-01', 0)).toBe(0);
    expect(livePosition('VP-01', Infinity)).toBe(0);
  });

  it('measures drift the short way round the loop', () => {
    expect(loopDelta(59.5, 0.5, 60)).toBeCloseTo(1);
    expect(loopDelta(0.5, 59.5, 60)).toBeCloseTo(-1);
    expect(loopDelta(10, 40, 60)).toBeCloseTo(30);
  });

  it('seeks only when metadata is known and drift exceeds the tolerance', () => {
    const now = LIVE_CLOCK_EPOCH_MS + 3_600_000;
    const target = livePosition('VP-01', 57, now);
    const v = { duration: 57, currentTime: target + 0.5, readyState: 4 };
    expect(syncVideoToLiveClock(v, 'VP-01', 1.5, now)).toBe(false);
    v.currentTime = (target + 20) % 57;
    expect(syncVideoToLiveClock(v, 'VP-01', 1.5, now)).toBe(true);
    expect(v.currentTime).toBeCloseTo(target, 6);
    const noMeta = { duration: NaN, currentTime: 0, readyState: 0 };
    expect(syncVideoToLiveClock(noMeta, 'VP-01', 1.5, now)).toBe(false);
    expect(noMeta.currentTime).toBe(0);
  });

  it('uses the canonical clip duration and never seeks past the media end', () => {
    const now = LIVE_CLOCK_EPOCH_MS + 42_000_000;
    const target = livePosition('AN-01', 46.6, now);
    const v = { duration: 46.5, currentTime: (target + 10) % 46.5, readyState: 4 };
    expect(syncVideoToLiveClock(v, 'AN-01', 0.25, now, 46.6)).toBe(true);
    expect(v.currentTime).toBeCloseTo(Math.min(target, 46.45), 6);
  });
});
