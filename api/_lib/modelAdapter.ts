// ═══════════════════════════════════════════════════════════════════════
// Model API adapter — THE ONE PLACE that knows the GPU model API contract.
//
// The trained YOLOv7-tiny ANPR model runs on the team's GPU box behind an
// API key. Its exact request/response contract is not final yet, so this
// module is deliberately tolerant. When the real contract is known:
//
//   1. REQUEST  → edit `buildUpstreamRequest()` below (or just set
//                 DETECTION_API_REQUEST_FORMAT / DETECTION_API_IMAGE_FIELD).
//   2. RESPONSE → edit `normaliseUpstreamResponse()` below. Most real APIs
//                 already fit one of the shapes handled by the helpers
//                 (`findDetectionArray`, `readBox`, `readPlate`, ...); if not,
//                 replace the body of `normaliseUpstreamResponse()` with a
//                 direct mapping.
//   3. Mirror the same change in pipeline/detect/adapter.py (Python batch
//      pipeline) and update the shape tests in
//      src/features/detections/remote/modelAdapter.test.ts +
//      pipeline/tests/test_remote_adapter.py.
//
// Nothing outside this file (and its Python twin) should need to change.
// Auth header handling lives in `buildAuthHeaders()` here too.
// ═══════════════════════════════════════════════════════════════════════

/** Vehicle classes the dashboard understands (mirrors src/types VehicleType). */
export type VehicleType = 'car' | 'truck' | 'bus' | 'motorcycle' | 'unknown';

export interface NormalisedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One detection in the normalised contract returned by /api/detect. */
export interface NormalisedDetection {
  plate_text: string | null;
  plate_confidence: number | null;
  vehicle_type: VehicleType;
  confidence: number;
  /** Top-left x/y + width/height in PIXELS of the submitted frame. */
  bbox: NormalisedBox;
}

/** Response body of /api/detect (success). */
export interface NormalisedDetectResponse {
  engine: string;
  model_version: string;
  latency_ms: number;
  /** Inference time reported by the model server, when it reports one. */
  inference_ms?: number | null;
  /** Pixel size of the submitted frame, when it could be determined. */
  image?: { width: number; height: number } | null;
  detections: NormalisedDetection[];
}

export type RequestFormat = 'multipart' | 'json' | 'raw';

export interface ModelApiConfig {
  url: string;
  apiKey: string;
  /** Header that carries the key. `Authorization` → `Bearer <key>`, anything else → raw key. */
  authHeader: string;
  timeoutMs: number;
  requestFormat: RequestFormat;
  /** Field name of the image in multipart/json requests. */
  imageField: string;
}

export interface FrameInput {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  cameraCode?: string | null;
  frameTimestampSec?: number | null;
  width?: number | null;
  height?: number | null;
}

export const DEFAULT_ENGINE = 'yolov7-tiny-anpr';
export const DEFAULT_TIMEOUT_MS = 15000;

// ───────────────────────────────────────────────────────────────────────
// Config (server-side env only — never VITE_ prefixed)
// ───────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/** Reads the model API config from env. Returns null when URL or key is missing. */
export function readModelApiConfig(env: Env = process.env): ModelApiConfig | null {
  const url = env.DETECTION_API_URL?.trim();
  const apiKey = env.DETECTION_API_KEY?.trim();
  if (!url || !apiKey) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  const timeout = Number(env.DETECTION_API_TIMEOUT_MS);
  const fmt = (env.DETECTION_API_REQUEST_FORMAT || 'multipart').trim().toLowerCase();
  return {
    url,
    apiKey,
    authHeader: env.DETECTION_API_AUTH_HEADER?.trim() || 'Authorization',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    requestFormat: fmt === 'json' || fmt === 'raw' ? fmt : 'multipart',
    imageField: env.DETECTION_API_IMAGE_FIELD?.trim() || 'image',
  };
}

/** `Authorization: Bearer <key>` by default; custom headers (e.g. x-api-key) get the raw key. */
export function buildAuthHeaders(cfg: Pick<ModelApiConfig, 'authHeader' | 'apiKey'>): Record<string, string> {
  if (cfg.authHeader.toLowerCase() === 'authorization') {
    return { Authorization: `Bearer ${cfg.apiKey}` };
  }
  return { [cfg.authHeader]: cfg.apiKey };
}

// ───────────────────────────────────────────────────────────────────────
// REQUEST  ← change here once the real contract is known
// ───────────────────────────────────────────────────────────────────────

export function buildUpstreamRequest(cfg: ModelApiConfig, frame: FrameInput): RequestInit {
  const headers: Record<string, string> = { Accept: 'application/json', ...buildAuthHeaders(cfg) };
  const ext = frame.mimeType === 'image/png' ? 'png' : 'jpg';

  if (cfg.requestFormat === 'raw') {
    headers['Content-Type'] = frame.mimeType;
    if (frame.cameraCode) headers['X-Camera-Code'] = frame.cameraCode;
    return { method: 'POST', headers, body: frame.bytes as BodyInit };
  }

  if (cfg.requestFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    const body: Record<string, unknown> = { [cfg.imageField]: toBase64(frame.bytes) };
    if (frame.cameraCode) body.camera_code = frame.cameraCode;
    if (frame.frameTimestampSec != null) body.frame_timestamp_sec = frame.frameTimestampSec;
    return { method: 'POST', headers, body: JSON.stringify(body) };
  }

  const form = new FormData();
  form.append(cfg.imageField, new Blob([frame.bytes as BlobPart], { type: frame.mimeType }), `frame.${ext}`);
  if (frame.cameraCode) form.append('camera_code', frame.cameraCode);
  if (frame.frameTimestampSec != null) form.append('frame_timestamp_sec', String(frame.frameTimestampSec));
  // Content-Type (with boundary) is set by fetch for FormData bodies.
  return { method: 'POST', headers, body: form };
}

// ───────────────────────────────────────────────────────────────────────
// RESPONSE  ← change here once the real contract is known
// ───────────────────────────────────────────────────────────────────────

export class UpstreamShapeError extends Error {}

/**
 * Maps whatever the model API returned into the normalised contract.
 * `image` is the pixel size of the frame we sent (used to scale normalised
 * 0..1 boxes). Throws UpstreamShapeError when no detection list can be found.
 */
export function normaliseUpstreamResponse(
  raw: unknown,
  image: { width: number; height: number } | null,
): Omit<NormalisedDetectResponse, 'latency_ms' | 'image'> {
  const items = findDetectionArray(raw);
  if (!items) throw new UpstreamShapeError('Model API response contained no detection list');

  const meta = isObj(raw) ? raw : {};
  const detections: NormalisedDetection[] = [];
  for (const entry of items) {
    // Raw YOLO rows: [x1, y1, x2, y2, conf, cls]
    const item = Array.isArray(entry) && entry.length >= 6 && entry.every((v) => typeof v === 'number')
      ? { xyxy: entry.slice(0, 4), confidence: entry[4], class_id: entry[5] }
      : entry;
    if (!isObj(item)) continue;
    const bbox = readBox(item, image);
    if (!bbox) continue;
    const plate = readPlate(item);
    detections.push({
      plate_text: plate.text,
      plate_confidence: plate.confidence,
      vehicle_type: readVehicleType(item),
      confidence: round(clamp01(num(pick(item, CONFIDENCE_KEYS)) ?? plate.confidence ?? 0), 4),
      bbox,
    });
  }

  return {
    engine: str(pick(meta, ['engine'])) || DEFAULT_ENGINE,
    model_version: str(pick(meta, ['model_version', 'version', 'model', 'model_name'])) || 'unknown',
    inference_ms: readInferenceMs(meta),
    detections,
  };
}

// ── shape helpers ──────────────────────────────────────────────────────

const LIST_KEYS = ['detections', 'predictions', 'results', 'objects', 'plates', 'vehicles', 'boxes', 'output', 'data'];
const CONFIDENCE_KEYS = ['confidence', 'conf', 'score', 'probability', 'prob'];
const CLASS_KEYS = ['vehicle_type', 'vehicle_class', 'class_name', 'label', 'name', 'category', 'class', 'cls', 'class_id'];
const PLATE_KEYS = ['plate_text', 'plate', 'license_plate', 'number_plate', 'plate_number', 'registration', 'text', 'ocr', 'ocr_text'];
const PLATE_CONF_KEYS = ['plate_confidence', 'plate_conf', 'ocr_confidence', 'ocr_conf', 'text_confidence', 'text_score'];

/** COCO ids for vehicles (only used if the API returns bare numeric classes). */
const COCO_VEHICLE_IDS: Record<number, VehicleType> = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' };

const VEHICLE_ALIASES: Record<string, VehicleType> = {
  car: 'car', suv: 'car', van: 'car', jeep: 'car', taxi: 'car', sedan: 'car', hatchback: 'car',
  truck: 'truck', lorry: 'truck', tempo: 'truck', pickup: 'truck',
  bus: 'bus', minibus: 'bus',
  motorcycle: 'motorcycle', motorbike: 'motorcycle', bike: 'motorcycle', scooter: 'motorcycle',
  two_wheeler: 'motorcycle', twowheeler: 'motorcycle', moped: 'motorcycle',
};

export function findDetectionArray(raw: unknown, depth = 0): unknown[] | null {
  if (depth > 3) return null;
  if (Array.isArray(raw)) {
    // Batched shape: [[det, det], ...] or [{detections: [...]}] (one image) → first image.
    if (raw.length > 0 && Array.isArray(raw[0]) && raw.every((r) => Array.isArray(r))) {
      // Rows of numbers ([x1,y1,x2,y2,conf,cls]) are detections themselves.
      return (raw[0] as unknown[]).every((v) => typeof v === 'number') ? raw : (raw[0] as unknown[]);
    }
    if (raw.length === 1 && isObj(raw[0]) && !looksLikeDetection(raw[0])) {
      return findDetectionArray(raw[0], depth + 1) ?? raw;
    }
    return raw;
  }
  if (!isObj(raw)) return null;
  for (const key of LIST_KEYS) {
    if (key in raw) {
      const found = findDetectionArray(raw[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function looksLikeDetection(o: Record<string, unknown>): boolean {
  return ['bbox', 'box', 'xyxy', 'xywh', 'x1', 'xmin', 'bounding_box', 'x'].some((k) => k in o);
}

/**
 * Reads a box from common YOLO-API shapes and returns top-left x/y + w/h in pixels.
 *   - arrays under `xyxy`/`xyxyn` (corners), `xywh`/`xywhn` (YOLO centre format),
 *     `tlwh`/`ltwh` (top-left + size), generic `bbox`/`box` (treated as corners
 *     when x2>x1 && y2>y1, otherwise top-left + size)
 *   - objects {x1,y1,x2,y2} | {xmin,ymin,xmax,ymax} | {left,top,right,bottom} |
 *     {x,y,width,height} | {x,y,w,h}
 *   - the same flat keys directly on the detection (YOLOv5 pandas records).
 * Values that are all within 0..1 are treated as normalised and scaled by `image`.
 */
export function readBox(item: Record<string, unknown>, image: { width: number; height: number } | null): NormalisedBox | null {
  let x1: number, y1: number, x2: number, y2: number;
  let normalisedHint = false;

  const arrayKey = ['xyxy', 'xyxyn', 'xywh', 'xywhn', 'tlwh', 'ltwh', 'bbox', 'box', 'bounding_box', 'rect']
    .find((k) => Array.isArray(item[k]) && (item[k] as unknown[]).length >= 4);
  const objKey = ['bbox', 'box', 'bounding_box', 'rect'].find((k) => isObj(item[k]));

  if (arrayKey) {
    const [a, b, c, d] = (item[arrayKey] as unknown[]).slice(0, 4).map(num);
    if ([a, b, c, d].some((v) => v == null)) return null;
    normalisedHint = arrayKey.endsWith('n');
    if (arrayKey.startsWith('xywh')) {
      [x1, y1, x2, y2] = [a! - c! / 2, b! - d! / 2, a! + c! / 2, b! + d! / 2];
    } else if (arrayKey === 'tlwh' || arrayKey === 'ltwh') {
      [x1, y1, x2, y2] = [a!, b!, a! + c!, b! + d!];
    } else if (arrayKey.startsWith('xyxy') || (c! > a! && d! > b!)) {
      [x1, y1, x2, y2] = [a!, b!, c!, d!];
    } else {
      [x1, y1, x2, y2] = [a!, b!, a! + c!, b! + d!];
    }
  } else {
    const src = objKey ? (item[objKey] as Record<string, unknown>) : item;
    const corners = readCorners(src);
    if (!corners) return null;
    [x1, y1, x2, y2] = corners;
  }

  const allUnit = [x1, y1, x2, y2].every((v) => v >= 0 && v <= 1.0001);
  if ((normalisedHint || allUnit) && image && image.width > 0 && image.height > 0) {
    x1 *= image.width; x2 *= image.width;
    y1 *= image.height; y2 *= image.height;
  }
  const width = x2 - x1;
  const height = y2 - y1;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: round(x1, 1), y: round(y1, 1), width: round(width, 1), height: round(height, 1) };
}

function readCorners(o: Record<string, unknown>): [number, number, number, number] | null {
  const q = (...keys: string[]) => keys.map((k) => num(o[k]));
  for (const keys of [['x1', 'y1', 'x2', 'y2'], ['xmin', 'ymin', 'xmax', 'ymax'], ['left', 'top', 'right', 'bottom']]) {
    const v = q(...keys);
    if (v.every((n) => n != null)) return v as [number, number, number, number];
  }
  for (const keys of [['x', 'y', 'width', 'height'], ['x', 'y', 'w', 'h'], ['left', 'top', 'width', 'height']]) {
    const [x, y, w, h] = q(...keys);
    if (x != null && y != null && w != null && h != null) return [x, y, x + w, y + h];
  }
  return null;
}

export function readPlate(item: Record<string, unknown>): { text: string | null; confidence: number | null } {
  let text: string | null = null;
  let confidence = num(pick(item, PLATE_CONF_KEYS));
  for (const key of PLATE_KEYS) {
    const v = item[key];
    if (typeof v === 'string' && v.trim()) { text = v; break; }
    if (isObj(v)) {
      const inner = pick(v, ['text', 'plate_text', 'value', 'number', 'ocr']);
      if (typeof inner === 'string' && inner.trim()) {
        text = inner;
        confidence = confidence ?? num(pick(v, ['confidence', 'conf', 'score', ...PLATE_CONF_KEYS]));
        break;
      }
    }
  }
  return {
    text: text ? normalisePlateText(text) : null,
    confidence: confidence == null ? null : round(clamp01(confidence), 4),
  };
}

/** Upper-cases and collapses whitespace; keeps the model's own spacing (e.g. "DL 01 AB 1234"). */
export function normalisePlateText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readVehicleType(item: Record<string, unknown>): VehicleType {
  for (const key of CLASS_KEYS) {
    const v = item[key];
    if (typeof v === 'number' && key !== 'vehicle_type') {
      if (COCO_VEHICLE_IDS[v]) return COCO_VEHICLE_IDS[v];
      continue;
    }
    if (typeof v === 'string' && v.trim()) {
      const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (VEHICLE_ALIASES[k]) return VEHICLE_ALIASES[k];
    }
  }
  return 'unknown';
}

function readInferenceMs(meta: Record<string, unknown>): number | null {
  const direct = num(pick(meta, ['inference_ms', 'inference_time_ms', 'latency_ms', 'time_ms']));
  if (direct != null) return round(direct, 1);
  const speed = meta.speed;
  if (isObj(speed)) {
    const v = num(speed.inference);
    if (v != null) return round(v, 1);
  }
  const secs = num(pick(meta, ['inference_time', 'inference_s']));
  return secs == null ? null : round(secs * 1000, 1);
}

// ── tiny utils ─────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}
function clamp01(n: number): number {
  // Some APIs report percentages (0..100).
  const v = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, v));
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
