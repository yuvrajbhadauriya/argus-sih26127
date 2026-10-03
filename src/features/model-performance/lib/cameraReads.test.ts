import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCameraEventsCache, resetDetectionsManifest, type PlateEvent } from '@/features/detections/api';
import { buildReadRows, cropKey, fetchCropManifest, fmtClip, loadCameraReads, parseCropManifest } from './cameraReads';

const ev = (cam: string, id: string, t: number, conf: number | null, text: string | null = 'MH12AB1234'): PlateEvent => ({
  camera_code: cam, tracked_vehicle_id: id, plate_text: text, plate_read: text ?? 'XX', plate_confidence: conf, grammar_valid: !!text,
  vehicle_type: 'car', vehicle_class: 'Car', time_sec: t, bbox: { x: 0, y: 0, width: 1, height: 1 },
});

beforeEach(() => {
  resetDetectionsManifest();
  resetCameraEventsCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('cropKey', () => {
  it('is <CAM>_<id>_<round(time_sec*1000)>', () => {
    expect(cropKey('SC-01', 'v7', 12.3456)).toBe('SC-01_v7_12346');
  });
});

describe('parseCropManifest', () => {
  it('keeps entries with a plate crop and nulls a missing vehicle crop', () => {
    expect(parseCropManifest({ crops: { a: { plate: 'SC-01/a.jpg', vehicle: null }, b: { plate: 'SC-01/b.jpg', vehicle: 'SC-01/bv.jpg' }, c: { vehicle: 'x' } } })).toEqual({
      a: { plate: 'SC-01/a.jpg', vehicle: null },
      b: { plate: 'SC-01/b.jpg', vehicle: 'SC-01/bv.jpg' },
    });
  });
  it('is null for anything else', () => {
    expect(parseCropManifest(null)).toBeNull();
    expect(parseCropManifest({})).toBeNull();
    expect(parseCropManifest({ crops: [] })).toBeNull();
  });
});

describe('buildReadRows', () => {
  const crops = {
    [cropKey('SC-01', 'a', 5)]: { plate: 'SC-01/a.jpg', vehicle: 'SC-01/av.jpg' },
    [cropKey('SC-01', 'b', 9)]: { plate: 'SC-01/b.jpg', vehicle: null },
    [cropKey('AN-01', 'c', 1)]: { plate: 'AN-01/c.jpg', vehicle: null },
    [cropKey('AN-01', 'orphan', 2)]: { plate: 'AN-01/o.jpg', vehicle: null },
  };
  it('sorts by camera, then confidence (high first); counts crops without an event', () => {
    const { rows, unmatched } = buildReadRows(crops, [ev('SC-01', 'a', 5, 0.6), ev('SC-01', 'b', 9, 0.9), ev('AN-01', 'c', 1, 0.5), ev('SC-01', 'zz', 3, 0.99)]);
    expect(rows.map((r) => `${r.camera}:${r.confidence}`)).toEqual(['AN-01:0.5', 'SC-01:0.9', 'SC-01:0.6']);
    expect(unmatched).toBe(1);
    expect(rows[2]).toMatchObject({ plateCrop: 'SC-01/a.jpg', vehicleCrop: 'SC-01/av.jpg', timeSec: 5, text: 'MH12AB1234', raw: false });
  });
  it('falls back to the raw OCR string, flagged as raw', () => {
    const { rows } = buildReadRows({ [cropKey('SC-01', 'a', 5)]: { plate: 'SC-01/a.jpg', vehicle: null } }, [ev('SC-01', 'a', 5, 0.4, null)]);
    expect(rows[0]).toMatchObject({ text: 'XX', raw: true });
  });
});

describe('loading', () => {
  it('a missing manifest (404, network error, or HTML) yields null / status "missing"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await fetchCropManifest()).toBeNull();
    expect(await loadCameraReads()).toEqual({ status: 'missing' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await loadCameraReads()).toEqual({ status: 'missing' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('<html>'); } })));
    expect(await loadCameraReads()).toEqual({ status: 'missing' });
  });
  it('joins the manifest with the per-camera events, using the no-cache fetch options', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const files: Record<string, unknown> = {
        '/detections/crops/manifest.json': { crops: { [cropKey('SC-01', 'a', 5)]: { plate: 'SC-01/a.jpg', vehicle: null } } },
        '/detections/manifest.json': { cameras: ['SC-01'] },
        '/detections/events_SC-01.json': { events: [{ tracked_vehicle_id: 'a', plate_text: 'MH12AB1234', plate_confidence: 0.91, grammar_valid: true, time_sec: 5 }] },
      };
      return files[url] ? { ok: true, status: 200, json: async () => files[url] } : { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const s = await loadCameraReads();
    expect(s).toMatchObject({ status: 'ready', unmatched: 0 });
    if (s.status === 'ready') expect(s.rows[0]).toMatchObject({ camera: 'SC-01', text: 'MH12AB1234', confidence: 0.91 });
    expect(fetchMock).toHaveBeenCalledWith('/detections/crops/manifest.json', { cache: 'no-cache' });
  });
});

describe('fmtClip', () => {
  it('formats m:ss', () => {
    expect(fmtClip(83.2)).toBe('1:23');
    expect(fmtClip(5)).toBe('0:05');
  });
});
