import { describe, it, expect } from 'vitest';
import { buildTrafficIndex, countInWindow, heatColors, trafficAt, trafficLevel } from './trafficDensity';
import { LIVE_CLOCK_EPOCH_MS, cameraClockOffset } from '@/features/cameras/lib/liveClock';

const row = (id: string, t: number) => ({ tracked_vehicle_id: id, frame_timestamp_sec: t });
/** 5 fps rows for `ids` between [from, to). */
const track = (id: string, from: number, to: number) => {
  const out = [];
  for (let t = from; t < to - 1e-9; t += 0.2) out.push(row(id, Math.round(t * 10) / 10));
  return out;
};

describe('countInWindow', () => {
  const idx = buildTrafficIndex([...track('a', 0, 4), ...track('b', 3, 8), ...track('c', 9, 10)], 12)!;

  it('counts distinct vehicles (not rows) in the 5 s window ending at the clip time', () => {
    expect(countInWindow(idx, 4)).toBe(2); // (-1, 4]: a and b (many rows each, counted once)
    expect(countInWindow(idx, 8.9)).toBe(1); // (3.9, 8.9]: b only - a's last sample (3.8) is outside
    expect(countInWindow(idx, 9.8)).toBe(2); // (4.8, 9.8]: b and c
    expect(countInWindow(idx, 11)).toBe(2); // (6, 11]: b (until 7.8) and c
    expect(countInWindow(idx, 11.9)).toBe(2); // (6.9, 11.9]
  });

  it('uses a half-open window: a sample exactly windowSec before the end is out', () => {
    const i = buildTrafficIndex([row('a', 1), row('b', 6)], 20)!;
    expect(countInWindow(i, 6)).toBe(1); // (1, 6] -> b only
    expect(countInWindow(i, 5.9)).toBe(1); // (0.9, 5.9] -> a only
  });

  it('wraps around the clip end: the window before time 0 is the tail of the clip', () => {
    // clip 12 s: c sits at 9.0-9.8, so at clip time 1 the window is (-4, 1] = tail (8, 12) + [0, 1]
    expect(countInWindow(idx, 1)).toBe(2); // a (0-1) and c (tail 9.2-9.8), but not b (ends 7.8)
    expect(countInWindow(idx, 12)).toBe(3); // clip time 12 = 0: a at 0, and b, c in the tail (7, 12)
    expect(countInWindow(idx, 1 + 12)).toBe(2); // clip time is taken modulo the length
    expect(countInWindow(idx, -11)).toBe(2); // and negative times wrap too
    expect(countInWindow(idx, 4)).toBe(2); // no wrap needed: unchanged
  });

  it('is 0 for no data / bad durations / zero window', () => {
    expect(countInWindow({ samples: [], duration: 10 }, 3)).toBe(0);
    expect(countInWindow({ samples: idx.samples, duration: 0 }, 3)).toBe(0);
    expect(countInWindow(idx, 3, 0)).toBe(0);
  });
});

describe('buildTrafficIndex', () => {
  it('ignores malformed rows and returns null without usable data', () => {
    expect(buildTrafficIndex(null)).toBeNull();
    expect(buildTrafficIndex({})).toBeNull();
    expect(buildTrafficIndex([])).toBeNull();
    expect(buildTrafficIndex([{ foo: 1 }, { tracked_vehicle_id: 'a' }, { tracked_vehicle_id: 'a', frame_timestamp_sec: -1 }, null, 3])).toBeNull();
    const i = buildTrafficIndex([row('a', 1), { tracked_vehicle_id: 'x' }, row('b', 2)])!;
    expect(i.samples).toHaveLength(2);
  });

  it('takes the clip length from the events file, else just past the last sample', () => {
    expect(buildTrafficIndex([row('a', 3)], 10)!.duration).toBe(10);
    expect(buildTrafficIndex([row('a', 3)], 2)!.duration).toBeCloseTo(3.2); // a too-short length cannot cut off samples
    expect(buildTrafficIndex([row('a', 3)])!.duration).toBeCloseTo(3.2);
  });

  it('records the busiest observed window as the peak', () => {
    const i = buildTrafficIndex([...track('a', 0, 4), ...track('b', 3, 8), ...track('c', 3.5, 4.5)], 12)!;
    expect(i.peak).toBe(3);
  });
});

describe('trafficAt', () => {
  // a quiet camera (peak 1) and a busy one (peak 4)
  const quiet = buildTrafficIndex(track('q1', 0, 20), 20)!;
  const busy = buildTrafficIndex(['b1', 'b2', 'b3', 'b4'].flatMap((id) => track(id, 0, 20)), 20)!;
  const indices = new Map([['QQ-01', quiet], ['BB-01', busy]]);
  // a wall-clock instant at which both cameras sit at clip time 10
  const nowAt = (code: string, clip: number) => LIVE_CLOCK_EPOCH_MS + ((clip - cameraClockOffset(code)) % 20 + 20) % 20 * 1000 + 20 * 1000 * 1000;

  it('reads the camera replay clock (live clock modulo the clip length) and exposes the raw count', () => {
    const r = trafficAt(indices, nowAt('BB-01', 10)).get('BB-01')!;
    expect(r.count).toBe(4);
    expect(r.windowSec).toBe(5);
  });

  it('normalises across cameras: the busiest observed window is the heaviest', () => {
    const now = nowAt('BB-01', 10);
    const out = trafficAt(indices, now);
    expect(out.get('BB-01')!.intensity).toBe(1);
    expect(out.get('BB-01')!.level).toBe('Heavy');
    expect(out.get('QQ-01')!.count).toBe(1);
    expect(out.get('QQ-01')!.intensity).toBeCloseTo(0.25);
    expect(out.get('QQ-01')!.level).toBe('Light');
  });

  it('changes as the clock moves and is empty without data', () => {
    const idx = buildTrafficIndex([...track('a', 0, 3), ...track('b', 0, 3), ...track('c', 10, 13)], 20)!;
    const m = new Map([['XX-01', idx]]);
    const at = (clip: number) => nowAt('XX-01', clip);
    expect(trafficAt(m, at(2)).get('XX-01')!.count).toBe(2);
    expect(trafficAt(m, at(15)).get('XX-01')!.count).toBe(1);
    expect(trafficAt(new Map(), 0).size).toBe(0);
  });
});

describe('levels and colours', () => {
  it('Light / Moderate / Heavy thirds', () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map(trafficLevel)).toEqual(['Light', 'Light', 'Moderate', 'Moderate', 'Heavy', 'Heavy']);
  });
  it('heavier traffic is redder and stronger, lighter fades to green and weak', () => {
    const light = heatColors(0);
    const heavy = heatColors(1);
    expect(light.hue).toBe(120);
    expect(heavy.hue).toBe(0);
    const alpha = (c: string) => Number(c.match(/\/ ([\d.]+)\)/)![1]);
    expect(alpha(heavy.core)).toBeGreaterThan(alpha(light.core));
    expect(heatColors(5).hue).toBe(0);
    expect(heatColors(-1).hue).toBe(120);
  });
});
