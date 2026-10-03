// ═══════════════════════════════════════════════════
// Live ANPR reads — what the GPU model returns for frames of the playing feed,
// turned into rows with the real plate / vehicle crops.
//
// Only good reads count (OCR ≥ 75 % and valid plate grammar — the same rule as
// the batch pipeline). A vehicle stays in view for several frames, so the same
// plate comes back again and again: reads of one plate (allowing one character
// of OCR jitter) inside DEDUPE_WINDOW_MS are one row, which keeps the crop of
// the highest-confidence sighting.
// ═══════════════════════════════════════════════════

import { formatPlate, normalizePlate } from '@/shared/lib/plate';
import { isGoodRead, type RemoteDetectResponse, type RemoteDetection } from './detectFrame';
import { cropFromCanvas, PLATE_PAD, scaleBox, VEHICLE_PAD, type Crop, type FrameSize } from './plateCrop';

/** Reads of the same plate closer together than this are one vehicle. */
export const DEDUPE_WINDOW_MS = 20_000;
/** Rows kept (newest first). */
export const MAX_LIVE_READS = 25;

export interface LivePlateRead {
  /** Unique per row. */
  id: string;
  camera_code: string;
  /** Display form, e.g. "MH 02 DJ 8770". */
  plate: string;
  /** Uppercase alphanumerics, the dedupe / watchlist key. */
  key: string;
  /** OCR confidence 0..1 of the best sighting. */
  confidence: number;
  /** The plate as cut from the analysed frame (null when the model gave no plate box). */
  plateCrop: Crop | null;
  /** The vehicle as cut from the analysed frame (null when the model gave no vehicle box). */
  vehicleCrop: Crop | null;
  /** Wall-clock ms of the first sighting. */
  at: number;
  lastSeenAt: number;
  /** Video time (s) of the best sighting. */
  frameTimeSec: number;
  sightings: number;
}

/** A good read in a response, with its crops made on demand (only rows that are kept pay for them). */
export interface ReadCandidate {
  plate: string;
  key: string;
  confidence: number;
  frameTimeSec: number;
  makeCrops: () => { plateCrop: Crop | null; vehicleCrop: Crop | null };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Same vehicle: identical plate, or (for full-length plates) one character of OCR jitter. */
export function samePlate(a: string, b: string): boolean {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 8 && levenshtein(a, b) <= 1;
}

/** The good reads of one /api/detect response, ready to merge. `canvas` is the frame that was sent. */
export function candidatesFromResponse(
  res: RemoteDetectResponse,
  canvas: HTMLCanvasElement,
  frameTimeSec: number,
): ReadCandidate[] {
  const frame: FrameSize = { width: canvas.width, height: canvas.height };
  const model: FrameSize = res.image && res.image.width > 0 && res.image.height > 0 ? res.image : frame;
  const out: ReadCandidate[] = [];
  for (const d of res.detections) {
    if (!isGoodRead(d) || !d.plate_text) continue;
    const key = normalizePlate(d.plate_text);
    if (!key) continue;
    out.push({
      plate: formatPlate(d.plate_text),
      key,
      confidence: d.plate_confidence ?? 0,
      frameTimeSec,
      makeCrops: () => cropsOf(d, canvas, model, frame),
    });
  }
  // Best read first: if one response holds the same plate twice, the better one is kept.
  return out.sort((a, b) => b.confidence - a.confidence);
}

function cropsOf(d: RemoteDetection, canvas: HTMLCanvasElement, model: FrameSize, frame: FrameSize) {
  const plateCrop = d.plate_bbox ? cropFromCanvas(canvas, scaleBox(d.plate_bbox, model, frame), PLATE_PAD) : null;
  // A vehicle box that is really "the whole frame" says nothing about this vehicle.
  const v = d.bbox_source === 'vehicle' ? scaleBox(d.bbox, model, frame) : null;
  const vehicleCrop =
    v && v.width < frame.width * 0.8 && v.height < frame.height * 0.8 ? cropFromCanvas(canvas, v, VEHICLE_PAD, 0.88) : null;
  return { plateCrop, vehicleCrop };
}

/**
 * Folds the candidates of one analysed frame into the rows. New plate → new
 * row on top; seen again → same row (last-seen refreshed, crop and text
 * upgraded when this sighting is more confident). Returns a new array.
 */
export function mergeReads(
  prev: readonly LivePlateRead[],
  candidates: readonly ReadCandidate[],
  now: number,
  cameraCode: string,
  { windowMs = DEDUPE_WINDOW_MS, max = MAX_LIVE_READS }: { windowMs?: number; max?: number } = {},
): LivePlateRead[] {
  const rows = [...prev];
  const touched = new Set<number>();
  candidates.forEach((c, n) => {
    const i = rows.findIndex((r, idx) => !touched.has(idx) && now - r.lastSeenAt <= windowMs && samePlate(r.key, c.key));
    if (i >= 0) {
      touched.add(i);
      const r = rows[i];
      if (c.confidence > r.confidence) {
        const crops = c.makeCrops();
        rows[i] = {
          ...r,
          plate: c.plate,
          key: c.key,
          confidence: c.confidence,
          plateCrop: crops.plateCrop ?? r.plateCrop,
          vehicleCrop: crops.vehicleCrop ?? r.vehicleCrop,
          frameTimeSec: c.frameTimeSec,
          lastSeenAt: now,
          sightings: r.sightings + 1,
        };
      } else {
        rows[i] = { ...r, lastSeenAt: now, sightings: r.sightings + 1 };
      }
      return;
    }
    const crops = c.makeCrops();
    rows.push({
      id: `${cameraCode}-${now}-${n}`,
      camera_code: cameraCode,
      plate: c.plate,
      key: c.key,
      confidence: c.confidence,
      plateCrop: crops.plateCrop,
      vehicleCrop: crops.vehicleCrop,
      at: now,
      lastSeenAt: now,
      frameTimeSec: c.frameTimeSec,
      sightings: 1,
    });
    touched.add(rows.length - 1);
  });
  return rows.sort((a, b) => b.at - a.at).slice(0, max);
}
