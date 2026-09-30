// ═══════════════════════════════════════════════════
// Detections Data Access
// Loads pipeline detection data (bboxes + plates) for a camera.
// Priority: 1. Supabase `detections` table  2. Static JSON in /public/detections
//
// Static JSON only exists for clips the ANPR pipeline has actually been run
// on: /detections/manifest.json lists those camera codes. Every other camera
// has no detections (the UI shows "No detections yet — run the AI pipeline")
// rather than borrowing boxes recorded on a different clip.
// ═══════════════════════════════════════════════════

import type { Detection } from '@/types';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { reportLiveError } from '@/lib/dataSource';
import { mockCameras } from '@/mocks/fixtures/mockCameras';

/**
 * Legacy CAM-X codes → camera codes, in registry order (CAM-A = first camera
 * of mockCameras, CAM-B = second, …). Only old pipeline outputs named
 * detections_CAM-A.json etc. use these; current files are keyed by the real
 * camera code (VP-01, SC-01, …) and pass through unchanged.
 */
export const CODE_ALIAS_MAP: Record<string, string> = Object.fromEntries(
  mockCameras.map((c, i) => [`CAM-${String.fromCharCode(65 + i)}`, c.code]),
);

export const DETECTIONS_MANIFEST_URL = '/detections/manifest.json';

/** Rows per Supabase request (PostgREST max_rows) and the per-camera ceiling. */
export const DETECTIONS_PAGE_SIZE = 1000;
export const DETECTIONS_MAX_ROWS = 20_000;

/** Shape of /detections/manifest.json (written when pipeline output is published). */
export interface DetectionsManifest {
  /** Camera codes with a detections_<code>.json file for their current clip. */
  cameras: string[];
}

let manifestPromise: Promise<Set<string>> | null = null;

/** Camera codes that have static detections (memoised; empty when the manifest is missing). */
export function loadDetectionsManifest(): Promise<Set<string>> {
  if (!manifestPromise) {
    manifestPromise = fetch(DETECTIONS_MANIFEST_URL)
      .then(async (res) => {
        if (!res.ok) return new Set<string>();
        const doc = (await res.json()) as Partial<DetectionsManifest>;
        return new Set(Array.isArray(doc.cameras) ? doc.cameras : []);
      })
      .catch(() => new Set<string>());
  }
  return manifestPromise;
}

/** Test hook: forget the memoised manifest. */
export function resetDetectionsManifest() {
  manifestPromise = null;
}

/** Options shared by the detection fetchers. */
export interface FetchDetectionsOptions {
  /** Aborts the underlying fetch / Supabase request (e.g. on unmount or camera switch). */
  signal?: AbortSignal;
}

/**
 * Detections for a camera from the Supabase `detections` table.
 * Returns null when the query errors or yields no rows (caller should fall back).
 * Throws if a row cannot be mapped (e.g. malformed bbox JSON).
 */
export async function fetchDetectionsFromSupabase(
  cameraId: string,
  options: FetchDetectionsOptions = {},
): Promise<Detection[] | null> {
  const supabase = await getSupabase();
  // PostgREST caps a response at 1000 rows (supabase/config.toml max_rows), and
  // one clip holds thousands of reads: page through in frame order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[] = [];
  for (let from = 0; from < DETECTIONS_MAX_ROWS; from += DETECTIONS_PAGE_SIZE) {
    let query = supabase
      .from('detections')
      .select('*')
      .eq('camera_id', cameraId)
      .order('frame_timestamp_sec', { ascending: true })
      .order('event_id', { ascending: true })
      .range(from, from + DETECTIONS_PAGE_SIZE - 1);
    if (options.signal) query = query.abortSignal(options.signal);
    const { data: page, error } = await query;
    if (error) {
      if (from === 0) return null;
      break;
    }
    data.push(...(page ?? []));
    if (!page || page.length < DETECTIONS_PAGE_SIZE) break;
  }

  if (data.length === 0) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.map((item: any) => ({
    event_id: item.event_id || `det-${item.id}`,
    camera_id: item.camera_id,
    tracked_vehicle_id: item.tracked_vehicle_id,
    plate_text_raw: item.plate_text_raw || 'UNKNOWN',
    plate_text_normalized: item.plate_text_normalized || '',
    confidence_score: item.confidence_score ?? 0.85,
    ...(typeof item.plate_confidence === 'number' ? { plate_confidence: item.plate_confidence } : {}),
    vehicle_type: item.vehicle_type || 'car',
    timestamp: item.frame_timestamp_sec ?? 0,
    frame_timestamp_sec: item.frame_timestamp_sec ?? 0,
    bbox: typeof item.bbox === 'string' ? JSON.parse(item.bbox) : (item.bbox || { x: 0, y: 0, width: 0, height: 0 }),
  }));
}

/**
 * Detections for a camera from the precomputed static file /detections/detections_<code>.json.
 * Returns [] (without requesting the file) when the manifest does not list the camera.
 */
export async function fetchDetectionsFromStaticJson(
  cameraCode?: string,
  options: FetchDetectionsOptions = {},
): Promise<Detection[]> {
  const effectiveCode = CODE_ALIAS_MAP[cameraCode || ''] || cameraCode || '';
  if (!effectiveCode || !(await loadDetectionsManifest()).has(effectiveCode)) return [];
  options.signal?.throwIfAborted();
  try {
    const url = `/detections/detections_${effectiveCode}.json`;
    const res = options.signal ? await fetch(url, { signal: options.signal }) : await fetch(url);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await res.json();
    return data.map((item, idx) => ({
      event_id: `det-${effectiveCode}-${idx}`,
      camera_id: cameraCode || effectiveCode,
      tracked_vehicle_id: item.tracked_vehicle_id,
      plate_text_raw: item.plate_text,
      plate_text_normalized: item.plate_text && item.plate_text !== 'UNKNOWN' ? item.plate_text.replace(/\s+/g, '') : '',
      confidence_score: item.confidence ?? 0.85,
      ...(typeof item.plate_confidence === 'number' || item.plate_confidence === null ? { plate_confidence: item.plate_confidence } : {}),
      vehicle_type: item.vehicle_type || 'car',
      timestamp: item.frame_timestamp_sec ?? 0,
      frame_timestamp_sec: item.frame_timestamp_sec ?? 0,
      bbox: {
        x: item.bbox?.x ?? 0,
        y: item.bbox?.y ?? 0,
        width: item.bbox?.width ?? 0,
        height: item.bbox?.height ?? 0,
      },
    }));
  } catch (err) {
    if (!options.signal?.aborted) console.warn(`Could not load detections for camera ${effectiveCode}:`, err);
    throw err;
  }
}

/**
 * Detections for a camera: Supabase first (when configured and a camera id is
 * known), falling back to the static JSON file. Throws if the fallback fails.
 */
export async function fetchCameraDetections(
  cameraCode?: string,
  cameraId?: string,
  options?: FetchDetectionsOptions,
): Promise<Detection[]> {
  if (isSupabaseConfigured() && cameraId) {
    try {
      const rows = await fetchDetectionsFromSupabase(cameraId, options);
      if (rows) return rows;
    } catch (err) {
      // Pipeline output shipped as static JSON is real model output (not a
      // fixture), so it is an acceptable fallback — but the failure is
      // reported to the data-source indicator instead of being swallowed.
      reportLiveError(err);
      console.warn('Supabase detection fetch failed, falling back to published pipeline output:', err);
    }
  }
  options?.signal?.throwIfAborted();
  return fetchDetectionsFromStaticJson(cameraCode, options);
}

// ── Per-vehicle ANPR events (events_<code>.json) ─────────────────────────

/** One vehicle's final read on a clip, from /detections/events_<code>.json. */
export interface PlateEvent {
  camera_code: string;
  tracked_vehicle_id: string;
  /** Formatted plate ("MH 02 GB 4920") when the OCR read passed the grammar check, else null. */
  plate_text: string | null;
  /** Raw OCR string (may be garbage for unreadable plates). */
  plate_read: string | null;
  /** OCR confidence 0–1 (null when no plate crop was read). */
  plate_confidence: number | null;
  grammar_valid: boolean;
  vehicle_type: Detection['vehicle_type'];
  /** Human class label from the model (Car, LCV, Bus, …). */
  vehicle_class: string;
  /** Clip time (s) at which the read was made. */
  time_sec: number;
  bbox: Detection['bbox'];
}

export interface CameraEvents {
  camera_code: string;
  /** Clip length in seconds (frames / fps) when the file says so. */
  duration_sec: number | null;
  events: PlateEvent[];
}

/** A plate read shown to operators ("good read"): OCR ≥ 75 % and a valid Indian plate grammar (pipeline rule). */
export const DISPLAY_READ_MIN_CONFIDENCE = 0.75;

export function isDisplayableRead(e: Pick<PlateEvent, 'plate_text' | 'plate_confidence' | 'grammar_valid'>): boolean {
  return !!e.plate_text && e.grammar_valid && (e.plate_confidence ?? 0) >= DISPLAY_READ_MIN_CONFIDENCE;
}

const VEHICLE_TYPES = new Set(['car', 'truck', 'bus', 'motorcycle', 'unknown']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseCameraEvents(code: string, doc: any): CameraEvents {
  const clip = doc?.clip ?? {};
  const duration = Number(clip.frames) > 0 && Number(clip.fps) > 0 ? Number(clip.frames) / Number(clip.fps) : null;
  const raw = Array.isArray(doc?.events) ? doc.events : Array.isArray(doc) ? doc : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: PlateEvent[] = raw.map((e: any, i: number) => ({
    camera_code: code,
    tracked_vehicle_id: String(e.tracked_vehicle_id ?? `ev-${i}`),
    plate_text: typeof e.plate_text === 'string' && e.plate_text && e.plate_text !== 'UNKNOWN' ? e.plate_text : null,
    plate_read: typeof e.plate_read === 'string' ? e.plate_read : null,
    plate_confidence: typeof e.plate_confidence === 'number' ? e.plate_confidence : null,
    grammar_valid: e.grammar_valid === true,
    vehicle_type: VEHICLE_TYPES.has(e.vehicle_type) ? e.vehicle_type : 'unknown',
    vehicle_class: typeof e.vehicle_class === 'string' ? e.vehicle_class : 'Vehicle',
    time_sec: typeof e.time_sec === 'number' ? e.time_sec : 0,
    bbox: { x: e.bbox?.x ?? 0, y: e.bbox?.y ?? 0, width: e.bbox?.width ?? 0, height: e.bbox?.height ?? 0 },
  }));
  events.sort((a, b) => a.time_sec - b.time_sec);
  return { camera_code: code, duration_sec: duration, events };
}

const eventsCache = new Map<string, Promise<CameraEvents | null>>();

/**
 * Per-vehicle events for a camera's clip (memoised). Resolves null when the
 * manifest does not list the camera or the file is missing.
 */
export function fetchCameraEvents(cameraCode: string): Promise<CameraEvents | null> {
  const code = CODE_ALIAS_MAP[cameraCode] || cameraCode;
  let p = eventsCache.get(code);
  if (!p) {
    p = loadDetectionsManifest()
      .then(async (codes) => {
        if (!codes.has(code)) return null;
        const res = await fetch(`/detections/events_${code}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseCameraEvents(code, await res.json());
      })
      .catch((err: unknown) => {
        eventsCache.delete(code);
        console.warn(`Could not load plate events for camera ${code}:`, err);
        return null;
      });
    eventsCache.set(code, p);
  }
  return p;
}

/** Events for every camera in the manifest (cameras without a file are skipped). */
export async function fetchAllCameraEvents(): Promise<CameraEvents[]> {
  const codes = [...(await loadDetectionsManifest())];
  const all = await Promise.all(codes.map((c) => fetchCameraEvents(c)));
  return all.filter((x): x is CameraEvents => !!x);
}

/** Test hook. */
export function resetCameraEventsCache() {
  eventsCache.clear();
}
