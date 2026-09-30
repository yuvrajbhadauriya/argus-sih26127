// ═══════════════════════════════════════════════════
// Detections log — pure helpers (filtering, stats, CSV export).
// ═══════════════════════════════════════════════════

import type { Detection } from '@/types';

export interface DetectionFilters {
  plate: string;
  camera: string; // camera id or ''
  vclass: string; // vehicle type or ''
  conf: '' | '90' | '75';
}

export const EMPTY_FILTERS: DetectionFilters = { plate: '', camera: '', vclass: '', conf: '' };

/** Uppercase alphanumerics only ("dl-01 ab" → "DL01AB"). */
export function plateKey(raw: string): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function filtersFromParams(params: URLSearchParams): DetectionFilters {
  const conf = params.get('conf');
  return {
    plate: params.get('plate') ?? '',
    camera: params.get('camera') ?? '',
    vclass: params.get('class') ?? '',
    conf: conf === '90' || conf === '75' ? conf : '',
  };
}

/** Writes non-empty filters into a copy of `params` (other params are kept). */
export function filtersToParams(f: DetectionFilters, params: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (k: string, v: string) => (v ? next.set(k, v) : next.delete(k));
  set('plate', f.plate.trim());
  set('camera', f.camera);
  set('class', f.vclass);
  set('conf', f.conf);
  return next;
}

export function hasActiveFilters(f: DetectionFilters): boolean {
  return !!(f.plate.trim() || f.camera || f.vclass || f.conf);
}

export function filterDetections(rows: Detection[], f: DetectionFilters): Detection[] {
  const q = plateKey(f.plate);
  const min = f.conf ? Number(f.conf) / 100 : 0;
  return rows.filter((d) => {
    if (q && !plateKey(d.plate_text_normalized || d.plate_text_raw).includes(q) && !plateKey(d.plate_text_raw).includes(q)) return false;
    if (f.camera && d.camera_id !== f.camera) return false;
    if (f.vclass && d.vehicle_type !== f.vclass) return false;
    if (min && d.confidence_score < min) return false;
    return true;
  });
}

export interface DetectionStats {
  events: number;
  uniquePlates: number;
  meanConfidence: number | null;
  lowConfidence: number;
}

export const LOW_CONFIDENCE = 0.75;

export function detectionStats(rows: Detection[]): DetectionStats {
  const plates = new Set(rows.map((d) => plateKey(d.plate_text_raw)));
  const sum = rows.reduce((s, d) => s + d.confidence_score, 0);
  return {
    events: rows.length,
    uniquePlates: plates.size,
    meanConfidence: rows.length ? sum / rows.length : null,
    lowConfidence: rows.filter((d) => d.confidence_score < LOW_CONFIDENCE).length,
  };
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function detectionsToCsv(rows: Detection[], cameraName: (id: string) => string): string {
  const header = ['event_id', 'frame_time', 'plate_raw', 'plate_normalized', 'camera_id', 'camera_name', 'vehicle_type', 'confidence', 'bbox_x', 'bbox_y', 'bbox_w', 'bbox_h'];
  const lines = rows.map((d) =>
    [
      d.event_id, d.timestamp, d.plate_text_raw, d.plate_text_normalized || plateKey(d.plate_text_raw), d.camera_id,
      cameraName(d.camera_id), d.vehicle_type, d.confidence_score.toFixed(3), d.bbox.x, d.bbox.y, d.bbox.width, d.bbox.height,
    ].map(csvCell).join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}

/** Formats a "MM:SS.mmm" / seconds frame offset as "mm:ss.s". */
export function formatFrameTime(ts: string | number): string {
  if (typeof ts === 'string' && ts.includes(':')) return ts;
  const n = typeof ts === 'number' ? ts : parseFloat(ts);
  if (!Number.isFinite(n)) return String(ts);
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/** One row per tracked vehicle (its most confident read that has plate text), newest frame first. */
export function recentPlateReads(detections: Detection[], limit = 50): Detection[] {
  const best = new Map<string, Detection>();
  for (const d of detections) {
    if (!d.plate_text_raw || d.plate_text_raw === 'UNKNOWN') continue;
    const key = d.tracked_vehicle_id != null ? `t${d.tracked_vehicle_id}` : `p${plateKey(d.plate_text_raw)}`;
    const cur = best.get(key);
    if (!cur || d.confidence_score > cur.confidence_score) best.set(key, d);
  }
  const t = (d: Detection) => d.frame_timestamp_sec ?? (typeof d.timestamp === 'number' ? d.timestamp : 0);
  return [...best.values()].sort((a, b) => t(b) - t(a)).slice(0, limit);
}
