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
      plate_text_normalized: item.plate_text ? item.plate_text.replace(/\s+/g, '') : '',
      confidence_score: item.confidence ?? 0.85,
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
