// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAuthHeaders,
  buildHealthUrl,
  buildUpstreamRequest,
  buildUpstreamUrl,
  DEFAULT_QUERY,
  findDetectionArray,
  isLpuResponse,
  isTileArtifact,
  parseTiles,
  vehicleTypeFromClass,
  normalisePlateText,
  normaliseUpstreamResponse,
  readBox,
  readModelApiConfig,
  readPlate,
  readVehicleType,
  UpstreamShapeError,
  type ModelApiConfig,
} from '../../../../api/_lib/modelAdapter';
import { readImageSize, sniffImageType } from '../../../../api/_lib/http';
import { fakeJpeg, fakePng } from './testFrames';
// REAL responses of the team's LPU model API (Mumbai stock clips VP-01 / JG-01).
import lpuFrame from './fixtures/lpu_frame_vp01.json';
import lpuVideo from './fixtures/lpu_video_jg01.json';

const IMG = { width: 640, height: 360 };

describe('readModelApiConfig', () => {
  it('returns null without URL or key', () => {
    expect(readModelApiConfig({})).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_URL: 'http://gpu:8000/detect' })).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_KEY: 'k' })).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_URL: 'not a url', DETECTION_API_KEY: 'k' })).toBeNull();
  });

  it('applies the real-API defaults and overrides', () => {
    const cfg = readModelApiConfig({ DETECTION_API_URL: 'http://gpu:8765/v1/frame', DETECTION_API_KEY: ' k ' });
    expect(cfg).toMatchObject({
      apiKey: 'k', authHeader: 'X-API-Key', timeoutMs: 15000, requestFormat: 'raw', imageField: 'image', query: DEFAULT_QUERY,
    });
    expect(DEFAULT_QUERY).toBe('tiles=2x3&roi_top=0.33&min_conf=60');
    const cfg2 = readModelApiConfig({
      DETECTION_API_URL: 'http://gpu:8000/detect', DETECTION_API_KEY: 'k', DETECTION_API_AUTH_HEADER: 'Authorization',
      DETECTION_API_TIMEOUT_MS: '2500', DETECTION_API_REQUEST_FORMAT: 'JSON', DETECTION_API_IMAGE_FIELD: 'file',
      DETECTION_API_QUERY: '?tiles=1x1',
    });
    expect(cfg2).toMatchObject({ authHeader: 'Authorization', timeoutMs: 2500, requestFormat: 'json', imageField: 'file', query: 'tiles=1x1' });
  });

  it('falls back to ANPR_API_BASE/v1/frame', () => {
    expect(readModelApiConfig({ ANPR_API_BASE: 'http://gpu:8765/', DETECTION_API_KEY: 'k' })?.url).toBe('http://gpu:8765/v1/frame');
  });

  it('builds the upstream and health URLs', () => {
    const cfg = readModelApiConfig({ DETECTION_API_URL: 'http://gpu:8765/v1/frame', DETECTION_API_KEY: 'k' })!;
    expect(buildUpstreamUrl(cfg)).toBe('http://gpu:8765/v1/frame?tiles=2x3&roi_top=0.33&min_conf=60');
    // params already on the URL win
    expect(buildUpstreamUrl({ url: 'http://gpu/v1/frame?tiles=1x1', query: 'tiles=2x3&min_conf=75' })).toBe(
      'http://gpu/v1/frame?tiles=1x1&min_conf=75',
    );
    expect(buildHealthUrl(cfg, {})).toBe('http://gpu:8765/health');
    expect(buildHealthUrl(cfg, { DETECTION_API_HEALTH_URL: 'http://gpu:1/h' })).toBe('http://gpu:1/h');
  });
});

describe('buildAuthHeaders / buildUpstreamRequest', () => {
  const base: ModelApiConfig = {
    url: 'http://gpu/detect', apiKey: 'sekret', authHeader: 'Authorization', timeoutMs: 1000, requestFormat: 'multipart', imageField: 'image',
    query: '',
  };
  const frame = { bytes: fakeJpeg(), mimeType: 'image/jpeg' as const, cameraCode: 'JG-01', frameTimestampSec: 1.5 };

  it('uses Bearer for Authorization and the raw key otherwise', () => {
    expect(buildAuthHeaders(base)).toEqual({ Authorization: 'Bearer sekret' });
    expect(buildAuthHeaders({ ...base, authHeader: 'X-API-Key' })).toEqual({ 'X-API-Key': 'sekret' });
  });

  it('sends the raw JPEG with X-API-Key for the real API', () => {
    const init = buildUpstreamRequest({ ...base, authHeader: 'X-API-Key', requestFormat: 'raw' }, frame);
    expect(init.body).toBe(frame.bytes);
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/jpeg', 'X-API-Key': 'sekret' });
  });

  it('builds multipart by default', async () => {
    const init = buildUpstreamRequest(base, frame);
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect((form.get('image') as File).size).toBe(frame.bytes.length);
    expect(form.get('camera_code')).toBe('JG-01');
    expect(form.get('frame_timestamp_sec')).toBe('1.5');
  });

  it('builds json and raw bodies', () => {
    const j = buildUpstreamRequest({ ...base, requestFormat: 'json', imageField: 'img' }, frame);
    const body = JSON.parse(j.body as string);
    expect(body.img).toBe(Buffer.from(frame.bytes).toString('base64'));
    expect(body.camera_code).toBe('JG-01');
    const r = buildUpstreamRequest({ ...base, requestFormat: 'raw' }, frame);
    expect((r.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(r.body).toBe(frame.bytes);
  });
});

describe('findDetectionArray', () => {
  it.each([
    ['detections', { detections: [{ a: 1 }] }],
    ['predictions', { predictions: [{ a: 1 }] }],
    ['results', { results: [{ a: 1 }] }],
    ['nested data', { data: { objects: [{ a: 1 }] } }],
    ['bare array', [{ a: 1 }]],
    ['batched list-of-lists', [[{ a: 1 }]]],
    ['per-image wrapper', [{ detections: [{ a: 1 }] }]],
  ])('%s', (_name, raw) => {
    expect(findDetectionArray(raw)).toEqual([{ a: 1 }]);
  });

  it('returns null for shapes without a list', () => {
    expect(findDetectionArray({ status: 'ok' })).toBeNull();
    expect(findDetectionArray('nope')).toBeNull();
  });
});

describe('readBox', () => {
  it('xyxy arrays', () => {
    expect(readBox({ xyxy: [10, 20, 110, 70] }, IMG)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
  it('YOLO centre xywh arrays', () => {
    expect(readBox({ xywh: [60, 45, 100, 50] }, IMG)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
  it('normalised xywhn / xyxyn arrays are scaled by image size', () => {
    expect(readBox({ xyxyn: [0.5, 0.5, 1, 1] }, IMG)).toEqual({ x: 320, y: 180, width: 320, height: 180 });
    expect(readBox({ xywhn: [0.5, 0.5, 0.5, 0.5] }, IMG)).toEqual({ x: 160, y: 90, width: 320, height: 180 });
  });
  it('generic bbox arrays: corners vs top-left+size', () => {
    expect(readBox({ bbox: [10, 20, 110, 70] }, IMG)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(readBox({ bbox: [300, 200, 50, 40] }, IMG)).toEqual({ x: 300, y: 200, width: 50, height: 40 });
  });
  it('object boxes', () => {
    expect(readBox({ bbox: { x1: 1, y1: 2, x2: 11, y2: 12 } }, IMG)).toEqual({ x: 1, y: 2, width: 10, height: 10 });
    expect(readBox({ box: { xmin: 1, ymin: 2, xmax: 11, ymax: 12 } }, IMG)).toEqual({ x: 1, y: 2, width: 10, height: 10 });
    expect(readBox({ bbox: { x: 5, y: 6, width: 7, height: 8 } }, IMG)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(readBox({ bounding_box: { left: 5, top: 6, w: 7, h: 8, x: 5, y: 6 } }, IMG)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });
  it('flat keys on the detection (YOLOv5 pandas records)', () => {
    expect(readBox({ xmin: 1, ymin: 2, xmax: 11, ymax: 12, confidence: 0.9 }, IMG)).toEqual({ x: 1, y: 2, width: 10, height: 10 });
    expect(readBox({ x1: '1', y1: '2', x2: '11', y2: '12' }, IMG)).toEqual({ x: 1, y: 2, width: 10, height: 10 });
  });
  it('rejects missing or degenerate boxes', () => {
    expect(readBox({}, IMG)).toBeNull();
    expect(readBox({ xyxy: [10, 10, 5, 5] }, IMG)).toBeNull();
    expect(readBox({ xyxy: [1, 'a', 2, 3] }, IMG)).toBeNull();
  });
});

describe('readPlate / readVehicleType', () => {
  it('reads plate text from strings and nested objects', () => {
    expect(readPlate({ plate: 'mh 01-ab 1234', plate_confidence: 0.97 })).toEqual({ text: 'MH 01 AB 1234', confidence: 0.97 });
    expect(readPlate({ ocr: { text: 'MH12DE1433', conf: 0.99 } })).toEqual({ text: 'MH12DE1433', confidence: 0.99 });
    expect(readPlate({ text: 'KA 05 MN 7777', text_score: 91 })).toEqual({ text: 'KA 05 MN 7777', confidence: 0.91 });
    expect(readPlate({ label: 'car' })).toEqual({ text: null, confidence: null });
  });
  it('normalises plate text', () => {
    expect(normalisePlateText('  mh02-dk.8337 ')).toBe('MH02 DK 8337');
  });
  it('maps class / label / name to vehicle types', () => {
    expect(readVehicleType({ class: 'Car' })).toBe('car');
    expect(readVehicleType({ label: 'lorry' })).toBe('truck');
    expect(readVehicleType({ name: 'two-wheeler' })).toBe('motorcycle');
    expect(readVehicleType({ class: 5 })).toBe('bus');
    expect(readVehicleType({ class: 'number_plate' })).toBe('unknown');
    expect(readVehicleType({})).toBe('unknown');
  });
});

describe('real LPU contract (/v1/frame, /v1/video)', () => {
  const tiles = parseTiles(DEFAULT_QUERY);

  it('parses tiles', () => {
    expect(tiles).toEqual({ rows: 2, cols: 3, roiTop: 0.33 });
    expect(parseTiles('')).toEqual({ rows: 1, cols: 1, roiTop: 0 });
    expect(parseTiles('tiles=3x4')).toEqual({ rows: 3, cols: 4, roiTop: 0.33 });
  });

  it('maps a real /v1/frame response', () => {
    expect(isLpuResponse(lpuFrame)).toBe(true);
    const out = normaliseUpstreamResponse(lpuFrame, null, tiles);
    expect(out).toMatchObject({ engine: 'lpu_on_gpu', model_version: 'deim50k+raw35', inference_ms: 330.2, image: { width: 1920, height: 1080 } });
    // Car with a read: vehicle box, OCR 93.4 → 0.934, raw fields passed through.
    expect(out.detections).toContainEqual({
      plate_text: 'MH02EZ1785', plate_confidence: 0.934, vehicle_type: 'car', confidence: 0.5731,
      bbox: { x: 778, y: 809, width: 186, height: 189 },
      vehicle_class: 'Car', grammar_valid: true, raw_ocr: 'MH02EZ1785',
      plate_bbox: { x: 830, y: 935, width: 46, height: 12 }, bbox_source: 'vehicle',
    });
    // A plate inside a tile-sized "vehicle" box is drawn at its plate box.
    expect(out.detections.find((d) => d.plate_text === 'MH02FX5860')).toMatchObject({
      bbox_source: 'plate', bbox: { x: 155, y: 914, width: 42, height: 11 }, vehicle_type: 'bus',
    });
    // "Not Found" vehicles keep their box without a plate; tile-sized ones are dropped.
    const plateless = out.detections.filter((d) => d.plate_text === null);
    expect(plateless).toHaveLength(1);
    expect(plateless[0]).toMatchObject({ plate_confidence: null, bbox: { x: 114, y: 830, width: 147, height: 137 } });
    expect(out.detections).toHaveLength(4);
  });

  it('maps real /v1/video events', () => {
    expect(isLpuResponse(lpuVideo)).toBe(true);
    const out = normaliseUpstreamResponse(lpuVideo, { width: 1920, height: 1080 }, tiles);
    expect(out.engine).toBe('lpu_on_gpu');
    expect(out.detections.length).toBeGreaterThan(0);
    for (const d of out.detections) {
      expect(d.plate_text).toMatch(/^[A-Z0-9]+$/);
      expect(d.plate_confidence).toBeGreaterThan(0);
      expect(d.plate_confidence).toBeLessThanOrEqual(1);
    }
  });

  it('flags tile-sized boxes and maps model classes', () => {
    const img = { width: 1920, height: 1080 };
    expect(isTileArtifact({ x: 0, y: 313, width: 715, height: 447 }, img, tiles)).toBe(true);
    expect(isTileArtifact({ x: 778, y: 809, width: 186, height: 189 }, img, tiles)).toBe(false);
    expect(isTileArtifact({ x: 4, y: 0, width: 1908, height: 1079 }, img, parseTiles('tiles=1x1'))).toBe(true);
    expect(vehicleTypeFromClass('Bike')).toBe('motorcycle');
    expect(vehicleTypeFromClass('LCV')).toBe('truck');
    expect(vehicleTypeFromClass('Mini-LCV')).toBe('truck');
    expect(vehicleTypeFromClass('Auto')).toBe('car');
    expect(vehicleTypeFromClass('Unknown')).toBe('unknown');
    expect(vehicleTypeFromClass(null)).toBe('unknown');
  });

  it('accepts an empty detection list', () => {
    const out = normaliseUpstreamResponse({ engine: 'lpu_on_gpu', model_version: 'deim50k+raw35', detections: [] }, null, tiles);
    expect(out.detections).toEqual([]);
  });
});

describe('normaliseUpstreamResponse (legacy fallback)', () => {
  it('maps a plausible YOLO-style response', () => {
    const out = normaliseUpstreamResponse(
      {
        model: 'yolov7-tiny-anpr', version: '1.2.0', inference_ms: 12.34,
        predictions: [
          { class: 'car', confidence: 0.93, bbox: [10, 20, 110, 70], plate: { text: 'MH 3C AB 1234', confidence: 0.985 } },
          { class: 'number_plate', score: 0.9, xywhn: [0.5, 0.5, 0.1, 0.05], ocr: 'UP16BT5678' },
          { class: 'car', confidence: 0.5 }, // no box → dropped
        ],
      },
      IMG,
    );
    expect(out.engine).toBe('unknown');
    expect(out.model_version).toBe('1.2.0');
    expect(out.inference_ms).toBe(12.3);
    expect(out.detections).toHaveLength(2);
    expect(out.detections[0]).toEqual({
      plate_text: 'MH 3C AB 1234', plate_confidence: 0.985, vehicle_type: 'car', confidence: 0.93,
      bbox: { x: 10, y: 20, width: 100, height: 50 },
    });
    expect(out.detections[1]).toMatchObject({ plate_text: 'UP16BT5678', vehicle_type: 'unknown', bbox: { x: 288, y: 171, width: 64, height: 18 } });
  });

  it('accepts raw numeric YOLO rows and ultralytics speed', () => {
    const out = normaliseUpstreamResponse({ detections: [[0, 0, 10, 10, 0.8, 7]], speed: { inference: 4.2 } }, IMG);
    expect(out.detections[0]).toMatchObject({ vehicle_type: 'truck', confidence: 0.8, plate_text: null });
    expect(out.inference_ms).toBe(4.2);
    expect(out.model_version).toBe('unknown');
  });

  it('returns empty detections for an empty list', () => {
    expect(normaliseUpstreamResponse({ results: [] }, IMG).detections).toEqual([]);
  });

  it('throws UpstreamShapeError when there is no list', () => {
    expect(() => normaliseUpstreamResponse({ message: 'ok' }, IMG)).toThrow(UpstreamShapeError);
  });
});

describe('image sniffing', () => {
  it('detects JPEG / PNG and reads their size', () => {
    expect(sniffImageType(fakeJpeg())).toBe('image/jpeg');
    expect(readImageSize(fakeJpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(sniffImageType(fakePng())).toBe('image/png');
    expect(readImageSize(fakePng(320, 240))).toEqual({ width: 320, height: 240 });
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
