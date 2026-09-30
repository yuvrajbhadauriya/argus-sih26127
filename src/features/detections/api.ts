// ═══════════════════════════════════════════════════
// Detections Data Access
// Loads pipeline detection data (bboxes + plates) for a camera.
// Priority: 1. Supabase `detections` table  2. Static JSON in /public/detections
// ═══════════════════════════════════════════════════

import type { Detection } from '@/types';
import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';

/** Legacy CAM-X codes → pipeline camera codes (used for the static JSON files). */
export const CODE_ALIAS_MAP: Record<string, string> = {
  'CAM-A': 'IG-01',
  'CAM-B': 'CP-01',
  'CAM-C': 'KB-01',
  'CAM-D': 'DW-01',
  'CAM-E': 'LN-01',
  'CAM-F': 'DK-01',
  'CAM-G': 'AI-01',
  'CAM-H': 'NP-01',
  'CAM-I': 'CC-01',
};

/**
 * Detections for a camera from the Supabase `detections` table.
 * Returns null when the query errors or yields no rows (caller should fall back).
 * Throws if a row cannot be mapped (e.g. malformed bbox JSON).
 */
export async function fetchDetectionsFromSupabase(cameraId: string): Promise<Detection[] | null> {
  const { data, error } = await supabase
    .from('detections')
    .select('*')
    .eq('camera_id', cameraId);

  if (error || !data || data.length === 0) return null;

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

/** Detections for a camera from the precomputed static file /detections/detections_<code>.json. */
export async function fetchDetectionsFromStaticJson(cameraCode?: string): Promise<Detection[]> {
  const effectiveCode = CODE_ALIAS_MAP[cameraCode || ''] || cameraCode || 'IG-01';
  try {
    const res = await fetch(`/detections/detections_${effectiveCode}.json`);
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
    console.warn(`Could not load detections for camera ${effectiveCode}:`, err);
    throw err;
  }
}

/**
 * Detections for a camera: Supabase first (when configured and a camera id is
 * known), falling back to the static JSON file. Throws if the fallback fails.
 */
export async function fetchCameraDetections(cameraCode?: string, cameraId?: string): Promise<Detection[]> {
  if (isSupabaseConfigured() && cameraId) {
    try {
      const rows = await fetchDetectionsFromSupabase(cameraId);
      if (rows) return rows;
    } catch (err) {
      console.warn('Supabase detection fetch failed, falling back to local JSON:', err);
    }
  }
  return fetchDetectionsFromStaticJson(cameraCode);
}
