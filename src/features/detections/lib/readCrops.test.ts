import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventKey, loadReadCrops, parseCropManifest, resetReadCrops, READ_CROPS_MANIFEST_URL } from './readCrops';

describe('eventKey (same cases as pipeline/tests/test_make_read_crops.py)', () => {
  it('builds <CAM>_<track>_<ms>', () => {
    expect(eventKey('VP-01', 'trk_0008', 0.4)).toBe('VP-01_trk_0008_400');
    expect(eventKey('SC-01', 'trk_0005', 12.67)).toBe('SC-01_trk_0005_12670');
    expect(eventKey('AN-01', 'a/b c', 0.07)).toBe('AN-01_a-b-c_70');
  });
});

describe('parseCropManifest', () => {
  it('maps keys to URLs under /detections/crops/', () => {
    const idx = parseCropManifest({ crops: { K: { plate: 'VP-01/K_plate.jpg', vehicle: 'VP-01/K_vehicle.jpg' }, P: { plate: 'VP-01/P_plate.jpg', vehicle: null } } });
    expect(idx.get('K')).toEqual({ plate: '/detections/crops/VP-01/K_plate.jpg', vehicle: '/detections/crops/VP-01/K_vehicle.jpg' });
    expect(idx.get('P')).toEqual({ plate: '/detections/crops/VP-01/P_plate.jpg', vehicle: null });
  });
  it('ignores anything that is not a manifest or points outside the crops folder', () => {
    expect(parseCropManifest(null).size).toBe(0);
    expect(parseCropManifest({ simulated: true }).size).toBe(0);
    expect(parseCropManifest({ crops: { A: { plate: '../x.jpg' }, B: { plate: 'https://x/y.jpg' }, C: {}, D: null } }).size).toBe(0);
  });
});

describe('loadReadCrops', () => {
  beforeEach(resetReadCrops);
  afterEach(() => vi.unstubAllGlobals());

  it('fetches with revalidation and memoises', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ crops: { K: { plate: 'a/K_plate.jpg' } } }))));
    vi.stubGlobal('fetch', f);
    expect((await loadReadCrops()).has('K')).toBe(true);
    await loadReadCrops();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(READ_CROPS_MANIFEST_URL, { cache: 'no-cache' });
  });
  it('treats a missing manifest (404, HTML fallback, network error) as empty', async () => {
    for (const f of [
      () => Promise.resolve(new Response('', { status: 404 })),
      () => Promise.resolve(new Response('<!doctype html>')),
      () => Promise.reject(new Error('offline')),
    ]) {
      resetReadCrops();
      vi.stubGlobal('fetch', vi.fn(f));
      expect((await loadReadCrops()).size).toBe(0);
    }
  });
});
