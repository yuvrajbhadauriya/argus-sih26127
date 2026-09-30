import { describe, it, expect } from 'vitest';
import { containsModelName, readRateStats, redactModelNames, TEAM_BENCHMARKS } from './publicCopy';
import type { CameraEvents, PlateEvent } from '@/features/detections/api';

const ev = (plate_confidence: number | null, grammar_valid = false): PlateEvent => ({
  camera_code: 'X', tracked_vehicle_id: 't', plate_text: null, plate_read: null, plate_confidence, grammar_valid,
  vehicle_type: 'car', vehicle_class: 'Car', time_sec: 0, bbox: { x: 0, y: 0, width: 1, height: 1 },
});

describe('redactModelNames', () => {
  it.each([
    'DEIM (deim50k) — vehicle + plate detection',
    'PARSeq (raw35) — plate text recognition',
    'End-to-end, deim50k + ocr_v9 (previous OCR)',
    'deim50k+raw35 end-to-end accuracy',
    'yolov7-tiny-anpr',
    'engine lpu_on_gpu',
  ])('removes names from %j', (s) => {
    const out = redactModelNames(s);
    expect(containsModelName(out)).toBe(false);
    expect(out).not.toMatch(/deim|parseq|raw35|yolo|ocr_v9/i);
  });
  it('leaves ordinary text alone', () => {
    expect(redactModelNames('OCR latency per crop')).toBe('OCR latency per crop');
  });
});

describe('TEAM_BENCHMARKS', () => {
  it('uses the golden set as the headline', () => {
    expect(TEAM_BENCHMARKS.find((b) => b.headline)).toMatchObject({ plates: 1419, correct: 1403 });
    expect(TEAM_BENCHMARKS[0].accuracy).toBeCloseTo(0.9887, 4);
    expect(TEAM_BENCHMARKS.slice(1).map((b) => b.accuracy)).toEqual([0.964, 0.925]);
  });
});

describe('readRateStats', () => {
  it('counts reads ≥ 0.8 among events with a plate read, per camera and overall', () => {
    const cams: CameraEvents[] = [
      { camera_code: 'B', duration_sec: 10, events: [ev(0.9, true), ev(0.5, true), ev(null), ev(0.8)] },
      { camera_code: 'A', duration_sec: 10, events: [ev(0.1)] },
    ];
    const s = readRateStats(cams);
    expect(s.per_camera.map((r) => r.camera_code)).toEqual(['A', 'B']);
    expect(s.per_camera[1]).toMatchObject({ vehicles: 4, plate_reads: 3, high_confidence: 2, valid_format: 2, valid_high: 1, good_reads: 1, good_rate: 0.25 });
    expect(s.per_camera[1].rate).toBeCloseTo(2 / 3);
    expect(s.overall).toMatchObject({ vehicles: 5, plate_reads: 4, high_confidence: 2, rate: 0.5 });
  });
  it('rate is null without reads', () => {
    expect(readRateStats([{ camera_code: 'A', duration_sec: null, events: [ev(null)] }]).overall.rate).toBeNull();
  });
});
