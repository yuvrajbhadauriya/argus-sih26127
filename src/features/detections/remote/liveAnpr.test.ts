import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDetectResponse, RemoteDetection } from './detectFrame';
import { candidatesFromResponse, mergeReads, samePlate, DEDUPE_WINDOW_MS, type ReadCandidate } from './liveAnpr';

afterEach(() => vi.restoreAllMocks());

function canvas(width = 1280, height = 720) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Every crop gets a distinct data URL so tests can tell which sighting it came from. */
function stubCrops() {
  let n = 0;
  const ctx = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/jpeg;base64,C${++n}`);
  return ctx;
}

const det = (over: Partial<RemoteDetection> = {}): RemoteDetection => ({
  plate_text: 'MH 02 DJ 8770',
  plate_confidence: 0.94,
  vehicle_type: 'car',
  confidence: 0.9,
  bbox: { x: 400, y: 300, width: 200, height: 160 },
  grammar_valid: true,
  plate_bbox: { x: 470, y: 420, width: 60, height: 16 },
  bbox_source: 'vehicle',
  ...over,
});

const response = (detections: RemoteDetection[], image = { width: 1280, height: 720 }): RemoteDetectResponse => ({
  engine: 'lpu_on_gpu', model_version: 'deim50k+raw35', latency_ms: 900, image, detections,
});

describe('candidatesFromResponse', () => {
  it('keeps only good reads (OCR ≥ 75 %, valid grammar, a plate) best first', () => {
    const c = candidatesFromResponse(
      response([
        det({ plate_text: 'MH 01 AA 1111', plate_confidence: 0.8 }),
        det({ plate_text: 'MH 01 BB 2222', plate_confidence: 0.6 }),
        det({ plate_text: 'XX 99', plate_confidence: 0.99, grammar_valid: false }),
        det({ plate_text: null, plate_confidence: null }),
        det({ plate_text: 'MH 01 CC 3333', plate_confidence: 0.97 }),
      ]),
      canvas(),
      4.2,
    );
    expect(c.map((x) => x.key)).toEqual(['MH01CC3333', 'MH01AA1111']);
    expect(c[0]).toMatchObject({ plate: 'MH 01 CC 3333', confidence: 0.97, frameTimeSec: 4.2 });
  });

  it('crops the plate box and the vehicle box from the analysed frame, only when asked', () => {
    const ctx = stubCrops();
    const c = candidatesFromResponse(response([det()]), canvas(), 1);
    expect(ctx.drawImage).not.toHaveBeenCalled(); // lazy: no crops until a row is kept
    const { plateCrop, vehicleCrop } = c[0].makeCrops();
    expect(plateCrop).not.toBeNull();
    expect(vehicleCrop).not.toBeNull();
    // plate crop = padded plate box (470,420,60×16 → 18 % / 45 % padding)
    expect(ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([459, 412, 82, 31]);
  });

  it('scales boxes when the model reports a different image size than the canvas', () => {
    const ctx = stubCrops();
    // model analysed 2560×1440, canvas is 1280×720 → boxes halve
    const c = candidatesFromResponse(response([det({ plate_bbox: { x: 940, y: 840, width: 120, height: 32 } })], { width: 2560, height: 1440 }), canvas(), 1);
    c[0].makeCrops();
    expect(ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([459, 412, 82, 31]);
  });

  it('has no plate crop without a plate box and no vehicle crop for a plate-sourced or whole-frame box', () => {
    stubCrops();
    const [a] = candidatesFromResponse(response([det({ plate_bbox: null })]), canvas(), 1);
    expect(a.makeCrops().plateCrop).toBeNull();
    const [b] = candidatesFromResponse(response([det({ bbox_source: 'plate' })]), canvas(), 1);
    expect(b.makeCrops().vehicleCrop).toBeNull();
    const [c] = candidatesFromResponse(response([det({ bbox: { x: 0, y: 0, width: 1280, height: 720 } })]), canvas(), 1);
    expect(c.makeCrops().vehicleCrop).toBeNull();
  });
});

describe('samePlate', () => {
  it('allows one character of OCR jitter on full-length plates only', () => {
    expect(samePlate('MH02DJ8770', 'MH02DJ8770')).toBe(true);
    expect(samePlate('MH02DJ8770', 'MH02DJ8710')).toBe(true);
    expect(samePlate('MH02DJ8770', 'MH02DJ8999')).toBe(false);
    expect(samePlate('MH021', 'MH022')).toBe(false); // too short to trust a fuzzy match
  });
});

describe('mergeReads', () => {
  const cand = (key: string, confidence: number, tag = key): ReadCandidate => ({
    plate: key,
    key,
    confidence,
    frameTimeSec: 1,
    makeCrops: () => ({
      plateCrop: { dataUrl: `plate-${tag}`, width: 80, height: 30 },
      vehicleCrop: { dataUrl: `veh-${tag}`, width: 200, height: 160 },
    }),
  });

  it('adds a new plate as a row on top', () => {
    const a = mergeReads([], [cand('MH01AA1111', 0.9)], 1000, 'JG-01');
    const b = mergeReads(a, [cand('MH01BB2222', 0.85)], 2000, 'JG-01');
    expect(b.map((r) => r.key)).toEqual(['MH01BB2222', 'MH01AA1111']);
    expect(b[0]).toMatchObject({ camera_code: 'JG-01', at: 2000, sightings: 1, plateCrop: { dataUrl: 'plate-MH01BB2222' } });
    expect(new Set(b.map((r) => r.id)).size).toBe(2);
  });

  it('folds repeat sightings into one row and keeps the most confident crop', () => {
    let rows = mergeReads([], [cand('MH01AA1111', 0.8, 'first')], 1000, 'JG-01');
    rows = mergeReads(rows, [cand('MH01AA1111', 0.95, 'better')], 2000, 'JG-01');
    rows = mergeReads(rows, [cand('MH01AA1111', 0.7, 'worse')], 3000, 'JG-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confidence: 0.95, plateCrop: { dataUrl: 'plate-better' }, vehicleCrop: { dataUrl: 'veh-better' }, at: 1000, lastSeenAt: 3000, sightings: 3 });
  });

  it('only makes crops for sightings that are kept', () => {
    const rows = mergeReads([], [cand('MH01AA1111', 0.9)], 1000, 'JG-01');
    const worse = { ...cand('MH01AA1111', 0.7), makeCrops: vi.fn() };
    mergeReads(rows, [worse], 2000, 'JG-01');
    expect(worse.makeCrops).not.toHaveBeenCalled();
  });

  it('treats a one-character OCR variant as the same vehicle and takes the better text', () => {
    let rows = mergeReads([], [cand('MH02DJ8770', 0.8)], 1000, 'JG-01');
    rows = mergeReads(rows, [cand('MH02DJ8710', 0.9)], 2000, 'JG-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('MH02DJ8710');
  });

  it('starts a new row once the dedupe window has passed (the clip looped)', () => {
    let rows = mergeReads([], [cand('MH01AA1111', 0.9)], 1000, 'JG-01');
    rows = mergeReads(rows, [cand('MH01AA1111', 0.9)], 1000 + DEDUPE_WINDOW_MS + 1, 'JG-01');
    expect(rows).toHaveLength(2);
  });

  it('does not merge two plates of the same frame into one row, and caps the list', () => {
    const two = mergeReads([], [cand('MH02DJ8770', 0.9), cand('MH02DJ8771', 0.9)], 1000, 'JG-01');
    expect(two).toHaveLength(2);
    let rows = two;
    for (let i = 0; i < 40; i++) rows = mergeReads(rows, [cand(`MH01AA${String(1000 + i * 37)}`, 0.9)], 2000 + i * 100, 'JG-01', { max: 25 });
    expect(rows).toHaveLength(25);
    expect(rows[0].at).toBeGreaterThan(rows[24].at);
  });

  it('does not mutate the previous rows', () => {
    const a = mergeReads([], [cand('MH01AA1111', 0.8)], 1000, 'JG-01');
    const snapshot = JSON.stringify(a);
    mergeReads(a, [cand('MH01AA1111', 0.99)], 2000, 'JG-01');
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});
