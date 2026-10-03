import { describe, it, expect } from 'vitest';
import type { CameraEvents, PlateEvent } from '@/features/detections/api';
import { GOLDEN_SHARE, REEL_INTERVAL_MS, reelRows, seeded, shuffled, isGoldenSlot, type ReelRow } from './reel';

const camera_cc = (cam: string) => cam.slice(0, 2);
const ev = (cam: string, i: number): PlateEvent => ({
  camera_code: cam, tracked_vehicle_id: `trk_${i}`, plate_text: `MH 01 ${camera_cc(cam)} ${1000 + i}`, plate_read: null, plate_confidence: 0.9, grammar_valid: true,
  vehicle_type: 'unknown', vehicle_class: 'Vehicle', time_sec: i, bbox: { x: 0, y: 0, width: 10, height: 10 },
});
const CODES = ['AN-01', 'BH-01', 'DD-01', 'JG-01', 'KR-01', 'SC-01', 'SN-01', 'VP-01'];
const counts = [3, 12, 9, 6, 4, 26, 10, 16];
const docs = (): CameraEvents[] => CODES.map((c, k) => ({ camera_code: c, duration_sec: 30, events: Array.from({ length: counts[k] }, (_, i) => ev(c, i)) }));
const T = 1_800_000_000_000;
const cam = (rows: ReelRow[]) => rows.filter((r): r is Extract<ReelRow, { kind: 'camera' }> => r.kind === 'camera');

describe('seeded helpers', () => {
  it('are deterministic and permute', () => {
    expect(seeded('a')()).toBe(seeded('a')());
    expect(seeded('a')()).not.toBe(seeded('b')());
    const s = shuffled([1, 2, 3, 4, 5, 6], 'x');
    expect(s).toEqual(shuffled([1, 2, 3, 4, 5, 6], 'x'));
    expect([...s].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('reelRows', () => {
  it('is deterministic for the same clock and docs, whatever the object identity', () => {
    const a = reelRows(docs(), T, { goldenCount: 100, limit: 30 });
    const b = reelRows(docs(), T, { goldenCount: 100, limit: 30 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
  });

  it('advances one slot per interval, newest first', () => {
    const now = reelRows(docs(), T, { goldenCount: 100, limit: 10 });
    const later = reelRows(docs(), T + REEL_INTERVAL_MS, { goldenCount: 100, limit: 10 });
    expect(later[0].slot).toBe(now[0].slot + 1);
    expect(later.slice(1).map((r) => r.key)).toEqual(now.slice(0, 9).map((r) => r.key));
    expect(now.every((r, i) => i === 0 || r.at < now[i - 1].at)).toBe(true);
  });

  it('interleaves ALL cameras: each takes a turn in every round, none starves', () => {
    const rows = cam(reelRows(docs(), T, { filter: 'cameras', limit: 120 }));
    expect(new Set(rows.map((r) => r.camera_code))).toEqual(new Set(CODES));
    // inside one round every camera appears exactly once (golden slots are skipped by the filter)
    const byRound = new Map<number, string[]>();
    for (const r of rows) byRound.set(Math.floor(r.slot / 8), [...(byRound.get(Math.floor(r.slot / 8)) ?? []), r.camera_code]);
    const full = [...byRound.values()].filter((v) => v.length === 8);
    expect(full.length).toBeGreaterThan(0);
    for (const v of byRound.values()) expect(new Set(v).size).toBe(v.length);
    // not a fixed rotation: the order differs between rounds
    expect(new Set([...byRound.values()].map((v) => v.join()))).not.toHaveProperty('size', 1);
  });

  it('only replays reads that exist in the events, and never runs dry across many hours', () => {
    const d = docs();
    const real = new Set(d.flatMap((c) => c.events.map((e) => `${c.camera_code}|${e.tracked_vehicle_id}`)));
    for (const hours of [0, 1, 7, 100]) {
      const rows = reelRows(d, T + hours * 3_600_000, { filter: 'cameras', limit: 40 });
      expect(rows).toHaveLength(40);
      for (const r of cam(rows)) expect(real.has(`${r.camera_code}|${r.event.tracked_vehicle_id}`)).toBe(true);
    }
  });

  it('walks each camera through all its reads before repeating one', () => {
    const rows = cam(reelRows(docs(), T, { filter: 'cameras', limit: 400 })).filter((r) => r.camera_code === 'AN-01');
    const firstThree = rows.slice(0, 3).map((r) => r.event.tracked_vehicle_id);
    expect(new Set(firstThree).size).toBe(3);
  });

  it('mixes in golden slots at the configured share, drawn from all scored plates', () => {
    const n = 4000;
    let golden = 0;
    for (let s = 0; s < n; s++) if (isGoldenSlot(s)) golden++;
    expect(Math.abs(golden / n - GOLDEN_SHARE)).toBeLessThan(0.03);
    const rows = reelRows(docs(), T, { filter: 'golden', limit: 60, goldenCount: 1419 });
    expect(rows.every((r) => r.kind === 'golden')).toBe(true);
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.kind === 'golden' && r.itemIndex >= 0 && r.itemIndex < 1419)).toBe(true);
  });

  it('keeps the same rows when filtering (a filter hides, it does not reshuffle)', () => {
    const all = reelRows(docs(), T, { goldenCount: 50, limit: 40 });
    const only = reelRows(docs(), T, { filter: 'cameras', goldenCount: 50, limit: 40 });
    const keys = new Set(only.map((r) => r.key));
    for (const r of all.filter((x) => x.kind === 'camera')) expect(keys.has(r.key)).toBe(true);
  });

  it('hits the natural error rate of the golden set (draws are uniform over all plates)', () => {
    const goldenCount = 1419;
    const wrong = new Set(Array.from({ length: 16 }, (_, i) => i * 88)); // 16 wrong of 1419 = 1.13 %
    let w = 0;
    let g = 0;
    for (let slot = 0; slot < 200_000; slot++) {
      if (!isGoldenSlot(slot)) continue;
      g++;
      if (wrong.has(Math.floor(seeded(`argus-live-feed-v1:golden:${slot}`)() * goldenCount))) w++;
    }
    expect(Math.abs(w / g - 16 / 1419)).toBeLessThan(0.002);
  });

  it('degrades: no cameras -> golden only; no golden -> cameras only; nothing -> empty', () => {
    expect(reelRows([], T, { goldenCount: 5, limit: 8 }).every((r) => r.kind === 'golden')).toBe(true);
    expect(reelRows(docs(), T, { limit: 8 }).every((r) => r.kind === 'camera')).toBe(true);
    expect(reelRows([], T, { limit: 8 })).toEqual([]);
    expect(reelRows(docs(), T, { filter: 'golden', limit: 8 })).toEqual([]);
    expect(reelRows([{ camera_code: 'X', duration_sec: 1, events: [] }], T, { limit: 8 })).toEqual([]);
  });
});

describe('no plate directly after itself', () => {
  // Cameras sharing plates and a tiny golden set: plenty of chances for repeats.
  const dup = (): CameraEvents[] =>
    ['A-1', 'B-1', 'C-1'].map((c, k) => ({
      camera_code: c, duration_sec: 10,
      events: Array.from({ length: 3 }, (_, i) => ({ ...ev(c, i), plate_text: `MH 01 AA ${1000 + ((i + k) % 4)}` })),
    }));
  const plate = (r: ReelRow) => (r.kind === 'camera' ? r.event.plate_text!.replace(/ /g, '') : ['MH01AA1000', 'MH01AA1001', 'XX00XX0000'][r.itemIndex]);
  const gp = (i: number) => ['MH01AA1000', 'MH01AA1001', 'XX00XX0000'][i];

  it('holds in All, Cameras and Golden set views over many hours', () => {
    for (const filter of ['all', 'cameras', 'golden'] as const) {
      for (let h = 0; h < 40; h++) {
        const rows = reelRows(dup(), T + h * 977_000, { filter, limit: 40, goldenCount: 3, goldenPlate: gp });
        expect(rows.length).toBe(40);
        for (let i = 1; i < rows.length; i++) expect({ filter, h, i, p: plate(rows[i]) }).not.toEqual({ filter, h, i, p: plate(rows[i - 1]) });
      }
    }
  });

  it('keeps every row stable as time advances (a row never changes once emitted)', () => {
    const opts = { limit: 30, goldenCount: 3, goldenPlate: gp };
    const a = reelRows(dup(), T, opts);
    const b = reelRows(dup(), T + 5 * REEL_INTERVAL_MS, opts);
    expect(b.slice(5, 30).map((r) => r.key)).toEqual(a.slice(0, 25).map((r) => r.key));
  });
});
