// ═══════════════════════════════════════════════════
// Crops of the recorded plate reads (public/detections/crops/, written locally by
// pipeline/detect/make_read_crops.py): real vehicle + plate crops cut from the
// clip frame at the read's time. A read without a manifest entry has no crops.
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { DETECTION_FILE_FETCH } from '../api';

export const READ_CROPS_BASE = '/detections/crops/';
export const READ_CROPS_MANIFEST_URL = `${READ_CROPS_BASE}manifest.json`;

export interface ReadCrop {
  /** Vehicle thumbnail URL (null when the model gave no vehicle box). */
  vehicle: string | null;
  plate: string;
}

export type ReadCropIndex = ReadonlyMap<string, ReadCrop>;

const EMPTY: ReadCropIndex = new Map();

/**
 * Key of one recorded read: `<CAM>_<tracked_vehicle_id>_<round(time_sec * 1000)>`, characters outside
 * [A-Za-z0-9_-] replaced by "-". Must stay identical to event_key() in pipeline/detect/make_read_crops.py.
 */
export function eventKey(cameraCode: string, trackedVehicleId: string, timeSec: number): string {
  return `${cameraCode}_${trackedVehicleId}_${Math.round(timeSec * 1000)}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

const isRel = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.startsWith('/') && !v.includes('..') && !v.includes('://');

/** Tolerant parser: anything that is not a manifest (an HTML fallback page, another JSON) is an empty index. */
export function parseCropManifest(doc: unknown): ReadCropIndex {
  const crops = (doc as { crops?: unknown } | null)?.crops;
  if (!crops || typeof crops !== 'object') return EMPTY;
  const out = new Map<string, ReadCrop>();
  for (const [key, v] of Object.entries(crops)) {
    const e = v as { vehicle?: unknown; plate?: unknown } | null;
    if (!e || !isRel(e.plate)) continue;
    out.set(key, { plate: READ_CROPS_BASE + e.plate, vehicle: isRel(e.vehicle) ? READ_CROPS_BASE + e.vehicle : null });
  }
  return out;
}

let manifestPromise: Promise<ReadCropIndex> | null = null;

/** The crop manifest (memoised). A missing or unreadable manifest is an empty index, never an error. */
export function loadReadCrops(): Promise<ReadCropIndex> {
  if (!manifestPromise) {
    manifestPromise = fetch(READ_CROPS_MANIFEST_URL, DETECTION_FILE_FETCH)
      .then(async (res) => (res.ok ? parseCropManifest(await res.json()) : EMPTY))
      .catch(() => EMPTY);
  }
  return manifestPromise;
}

/** Test hook. */
export function resetReadCrops() {
  manifestPromise = null;
}

export function useReadCrops(): ReadCropIndex {
  const [index, setIndex] = useState<ReadCropIndex>(EMPTY);
  useEffect(() => {
    let alive = true;
    void loadReadCrops().then((i) => alive && setIndex(i));
    return () => {
      alive = false;
    };
  }, []);
  return index;
}
