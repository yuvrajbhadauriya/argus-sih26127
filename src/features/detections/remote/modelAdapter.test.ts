// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAuthHeaders,
  buildUpstreamRequest,
  findDetectionArray,
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

const IMG = { width: 640, height: 360 };

describe('readModelApiConfig', () => {
  it('returns null without URL or key', () => {
    expect(readModelApiConfig({})).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_URL: 'http://gpu:8000/detect' })).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_KEY: 'k' })).toBeNull();
    expect(readModelApiConfig({ DETECTION_API_URL: 'not a url', DETECTION_API_KEY: 'k' })).toBeNull();
  });

  it('applies defaults and overrides', () => {
    const cfg = readModelApiConfig({ DETECTION_API_URL: 'http://gpu:8000/detect', DETECTION_API_KEY: ' k ' });
    expect(cfg).toMatchObject({ apiKey: 'k', authHeader: 'Authorization', timeoutMs: 15000, requestFormat: 'multipart', imageField: 'image' });
    const cfg2 = readModelApiConfig({
      DETECTION_API_URL: 'http://gpu:8000/detect', DETECTION_API_KEY: 'k', DETECTION_API_AUTH_HEADER: 'x-api-key',
      DETECTION_API_TIMEOUT_MS: '2500', DETECTION_API_REQUEST_FORMAT: 'JSON', DETECTION_API_IMAGE_FIELD: 'file',
    });
    expect(cfg2).toMatchObject({ authHeader: 'x-api-key', timeoutMs: 2500, requestFormat: 'json', imageField: 'file' });
  });
});

describe('buildAuthHeaders / buildUpstreamRequest', () => {
  const base: ModelApiConfig = {
    url: 'http://gpu/detect', apiKey: 'sekret', authHeader: 'Authorization', timeoutMs: 1000, requestFormat: 'multipart', imageField: 'image',
  };
  const frame = { bytes: fakeJpeg(), mimeType: 'image/jpeg' as const, cameraCode: 'IG-01', frameTimestampSec: 1.5 };

  it('uses Bearer for Authorization and the raw key otherwise', () => {
    expect(buildAuthHeaders(base)).toEqual({ Authorization: 'Bearer sekret' });
    expect(buildAuthHeaders({ ...base, authHeader: 'x-api-key' })).toEqual({ 'x-api-key': 'sekret' });
  });

  it('builds multipart by default', async () => {
    const init = buildUpstreamRequest(base, frame);
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect((form.get('image') as File).size).toBe(frame.bytes.length);
    expect(form.get('camera_code')).toBe('IG-01');
    expect(form.get('frame_timestamp_sec')).toBe('1.5');
  });

  it('builds json and raw bodies', () => {
    const j = buildUpstreamRequest({ ...base, requestFormat: 'json', imageField: 'img' }, frame);
    const body = JSON.parse(j.body as string);
    expect(body.img).toBe(Buffer.from(frame.bytes).toString('base64'));
    expect(body.camera_code).toBe('IG-01');
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
    expect(readPlate({ plate: 'dl 01-ab 1234', plate_confidence: 0.97 })).toEqual({ text: 'DL 01 AB 1234', confidence: 0.97 });
    expect(readPlate({ ocr: { text: 'MH12DE1433', conf: 0.99 } })).toEqual({ text: 'MH12DE1433', confidence: 0.99 });
    expect(readPlate({ text: 'KA 05 MN 7777', text_score: 91 })).toEqual({ text: 'KA 05 MN 7777', confidence: 0.91 });
    expect(readPlate({ label: 'car' })).toEqual({ text: null, confidence: null });
  });
  it('normalises plate text', () => {
    expect(normalisePlateText('  hr26-dk.8337 ')).toBe('HR26 DK 8337');
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

describe('normaliseUpstreamResponse', () => {
  it('maps a plausible YOLOv7 ANPR response', () => {
    const out = normaliseUpstreamResponse(
      {
        model: 'yolov7-tiny-anpr', version: '1.2.0', inference_ms: 12.34,
        predictions: [
          { class: 'car', confidence: 0.93, bbox: [10, 20, 110, 70], plate: { text: 'DL 3C AB 1234', confidence: 0.985 } },
          { class: 'number_plate', score: 0.9, xywhn: [0.5, 0.5, 0.1, 0.05], ocr: 'UP16BT5678' },
          { class: 'car', confidence: 0.5 }, // no box → dropped
        ],
      },
      IMG,
    );
    expect(out.engine).toBe('yolov7-tiny-anpr');
    expect(out.model_version).toBe('1.2.0');
    expect(out.inference_ms).toBe(12.3);
    expect(out.detections).toHaveLength(2);
    expect(out.detections[0]).toEqual({
      plate_text: 'DL 3C AB 1234', plate_confidence: 0.985, vehicle_type: 'car', confidence: 0.93,
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
