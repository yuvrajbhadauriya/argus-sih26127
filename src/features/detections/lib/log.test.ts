import { describe, it, expect } from 'vitest';
import type { Detection } from '@/types';
import {
  EMPTY_FILTERS, detectionStats, detectionsToCsv, filterDetections, filtersFromParams, filtersToParams,
  formatFrameTime, hasActiveFilters, plateKey,
} from './log';

const det = (over: Partial<Detection>): Detection => ({
  event_id: 'e1', camera_id: 'cam-001', plate_text_raw: 'MH-01-AB-1234', plate_text_normalized: 'MH01AB1234',
  confidence_score: 0.95, vehicle_type: 'car', timestamp: '00:02.500', bbox: { x: 1, y: 2, width: 3, height: 4 }, ...over,
});

const rows = [
  det({}),
  det({ event_id: 'e2', camera_id: 'cam-002', plate_text_raw: 'MH-43-BM-3816', plate_text_normalized: '', vehicle_type: 'truck', confidence_score: 0.8 }),
  det({ event_id: 'e3', plate_text_raw: 'MH-01-AB-1234', confidence_score: 0.7 }),
];

describe('detections log helpers', () => {
  it('normalises plates', () => {
    expect(plateKey('mh 01-ab 1234')).toBe('MH01AB1234');
  });

  it('round-trips filters through URL params and keeps other params', () => {
    const f = { plate: 'MH01', camera: 'cam-001', vclass: 'car', conf: '90' as const };
    const p = filtersToParams(f, new URLSearchParams('x=1'));
    expect(p.get('x')).toBe('1');
    expect(p.get('class')).toBe('car');
    expect(filtersFromParams(p)).toEqual(f);
    expect(filtersFromParams(new URLSearchParams('conf=50'))).toEqual(EMPTY_FILTERS);
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(f)).toBe(true);
  });

  it('filters by plate (format-insensitive), camera, class and min confidence', () => {
    expect(filterDetections(rows, { ...EMPTY_FILTERS, plate: 'mh 43' }).map((d) => d.event_id)).toEqual(['e2']);
    expect(filterDetections(rows, { ...EMPTY_FILTERS, camera: 'cam-001' })).toHaveLength(2);
    expect(filterDetections(rows, { ...EMPTY_FILTERS, vclass: 'truck' })).toHaveLength(1);
    expect(filterDetections(rows, { ...EMPTY_FILTERS, conf: '90' }).map((d) => d.event_id)).toEqual(['e1']);
    expect(filterDetections(rows, { ...EMPTY_FILTERS, conf: '75' })).toHaveLength(2);
  });

  it('computes stats', () => {
    const s = detectionStats(rows);
    expect(s).toMatchObject({ events: 3, uniquePlates: 2, lowConfidence: 1 });
    expect(s.meanConfidence).toBeCloseTo(0.8167, 3);
    expect(detectionStats([]).meanConfidence).toBeNull();
  });

  it('exports CSV with escaping', () => {
    const csv = detectionsToCsv([det({ plate_text_raw: 'A,"B"' })], () => 'Gate, North');
    const [head, line] = csv.split('\r\n');
    expect(head.startsWith('event_id,frame_time,plate_raw')).toBe(true);
    expect(line).toContain('"A,""B"""');
    expect(line).toContain('"Gate, North"');
  });

  it('formats frame offsets', () => {
    expect(formatFrameTime('00:02.500')).toBe('00:02.500');
    expect(formatFrameTime(65.5)).toBe('01:05.500');
  });
});

describe('recentPlateReads', () => {
  it('keeps the most confident read per tracked vehicle, newest first, skipping unreadable plates', async () => {
    const { recentPlateReads } = await import('./log');
    const out = recentPlateReads([
      det({ event_id: 'a', tracked_vehicle_id: 1, confidence_score: 0.8, frame_timestamp_sec: 1 }),
      det({ event_id: 'b', tracked_vehicle_id: 1, confidence_score: 0.9, frame_timestamp_sec: 2 }),
      det({ event_id: 'c', tracked_vehicle_id: 2, plate_text_raw: 'UNKNOWN', frame_timestamp_sec: 5 }),
      det({ event_id: 'd', tracked_vehicle_id: 3, plate_text_raw: 'MH43BM3816', frame_timestamp_sec: 9 }),
    ]);
    expect(out.map((d) => d.event_id)).toEqual(['d', 'b']);
  });
});
