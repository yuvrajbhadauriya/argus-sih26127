// ═══════════════════════════════════════════════════
// Camera-feed reads that have a saved crop. The crop manifest
// (public/detections/crops/manifest.json, generated locally, not committed)
// maps "<CAM>_<trackedVehicleId>_<round(time_sec*1000)>" to the crop files;
// the plate text and the model's confidence come from the per-vehicle events
// (public/detections/events_<CAM>.json).
// ═══════════════════════════════════════════════════

import { DETECTION_FILE_FETCH, fetchCameraEvents, type PlateEvent } from '@/features/detections/api';

export const CROP_BASE = '/detections/crops/';
export const CROP_MANIFEST_URL = `${CROP_BASE}manifest.json`;

export interface CropEntry {
  /** "<CAM>/<file>.jpg", relative to CROP_BASE. */
  plate: string;
  vehicle: string | null;
}

export interface CameraRead {
  key: string;
  camera: string;
  plateCrop: string;
  vehicleCrop: string | null;
  /** Formatted plate when it passed the grammar check, else the raw OCR string, else ''. */
  text: string;
  /** True when `text` is the raw OCR string (failed the plate-format check). */
  raw: boolean;
  /** Model confidence 0–1 (not verified), or null. */
  confidence: number | null;
  timeSec: number;
}

export const cropKey = (camera: string, trackedVehicleId: string, timeSec: number) => `${camera}_${trackedVehicleId}_${Math.round(timeSec * 1000)}`;

export const cropUrl = (rel: string) => `${CROP_BASE}${rel}`;

/** Parses the manifest; null when it is not a crop manifest. */
export function parseCropManifest(raw: unknown): Record<string, CropEntry> | null {
  const crops = (raw as { crops?: unknown } | null)?.crops;
  if (!crops || typeof crops !== 'object' || Array.isArray(crops)) return null;
  const out: Record<string, CropEntry> = {};
  for (const [k, v] of Object.entries(crops as Record<string, unknown>)) {
    const o = v as { plate?: unknown; vehicle?: unknown } | null;
    if (!o || typeof o.plate !== 'string' || !o.plate) continue;
    out[k] = { plate: o.plate, vehicle: typeof o.vehicle === 'string' && o.vehicle ? o.vehicle : null };
  }
  return out;
}

/** Crop manifest, or null when missing / invalid. */
export async function fetchCropManifest(): Promise<Record<string, CropEntry> | null> {
  try {
    const res = await fetch(CROP_MANIFEST_URL, DETECTION_FILE_FETCH);
    if (!res.ok) return null;
    return parseCropManifest(await res.json());
  } catch {
    return null;
  }
}

/** Camera code of a crop: the first path segment of its plate file ("SC-01/x.jpg"). */
export const cameraOf = (e: CropEntry) => e.plate.split('/')[0];

/** One row per crop that has a matching event; sorted by camera, then confidence (high first). */
export function buildReadRows(crops: Record<string, CropEntry>, events: PlateEvent[]): { rows: CameraRead[]; unmatched: number } {
  const rows: CameraRead[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const key = cropKey(e.camera_code, e.tracked_vehicle_id, e.time_sec);
    const c = crops[key];
    if (!c || seen.has(key)) continue;
    seen.add(key);
    const text = e.plate_text ?? e.plate_read ?? '';
    rows.push({
      key,
      camera: e.camera_code,
      plateCrop: c.plate,
      vehicleCrop: c.vehicle,
      text,
      raw: !e.plate_text && !!e.plate_read,
      confidence: e.plate_confidence,
      timeSec: e.time_sec,
    });
  }
  rows.sort((a, b) => a.camera.localeCompare(b.camera) || (b.confidence ?? -1) - (a.confidence ?? -1) || a.timeSec - b.timeSec);
  return { rows, unmatched: Object.keys(crops).length - rows.length };
}

export type CameraReadsState = { status: 'missing' } | { status: 'ready'; rows: CameraRead[]; unmatched: number };

/** Manifest + the events of every camera it mentions. Never throws. */
export async function loadCameraReads(): Promise<CameraReadsState> {
  const crops = await fetchCropManifest();
  if (!crops || Object.keys(crops).length === 0) return { status: 'missing' };
  const cams = [...new Set(Object.values(crops).map(cameraOf))];
  const events = (await Promise.all(cams.map((c) => fetchCameraEvents(c)))).flatMap((x) => x?.events ?? []);
  return { status: 'ready', ...buildReadRows(crops, events) };
}

/** 83.2 → "1:23". */
export function fmtClip(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
