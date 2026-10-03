// ═══════════════════════════════════════════════════
// What the Model Performance page may show:
// - model architecture / checkpoint names never reach the UI (redactModelNames)
// - the high-confidence read rate on the Mumbai clips, computed from the real
//   per-vehicle event files (readRateStats)
// ═══════════════════════════════════════════════════

import type { CameraEvents } from '@/features/detections/api';

export const GENERIC_MODEL_NAME = 'Trained Indian-plate ANPR model';
export const GENERIC_ENGINE_NAME = 'AI ANPR engine';

/** Architecture / checkpoint / engine identifiers that must not be shown. */
const MODEL_NAME_RE = /\b(?:deim\w*|parseq\w*|raw\d+\w*|yolo\w*|ocr_v\d+\w*|lpu_on_gpu)\b(?:\s*\([^)]*\))?/gi;

/** Replace model architecture / version names in free text with generic wording. */
export function redactModelNames(text: string): string {
  if (!text) return text;
  return text
    .replace(/\b(?:deim\w*|lpu_on_gpu)\s*\+\s*(?:raw\d+\w*|parseq\w*|ocr_v\d+\w*)\b/gi, GENERIC_ENGINE_NAME)
    .replace(MODEL_NAME_RE, GENERIC_ENGINE_NAME)
    .replace(new RegExp(`${GENERIC_ENGINE_NAME}(?:\\s*[+,/]\\s*${GENERIC_ENGINE_NAME})+`, 'g'), GENERIC_ENGINE_NAME)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when text still contains a model name (used by tests). */
export function containsModelName(text: string): boolean {
  MODEL_NAME_RE.lastIndex = 0;
  const hit = MODEL_NAME_RE.test(text);
  MODEL_NAME_RE.lastIndex = 0;
  return hit;
}

export const HIGH_CONFIDENCE = 0.8;
/** App-wide "good read" rule: OCR confidence ≥ 0.75 and a valid Indian plate format. */
export const GOOD_READ_CONFIDENCE = 0.75;

export interface ReadRateRow {
  camera_code: string;
  vehicles: number;
  /** Events with an OCR read (plate_confidence not null). */
  plate_reads: number;
  /** Of those, reads with plate_confidence ≥ 0.8. */
  high_confidence: number;
  rate: number | null;
  /** Reads that pass the Indian plate-format check. */
  valid_format: number;
  /** Of those, reads with plate_confidence ≥ 0.8. */
  valid_high: number;
  /** Good reads: plate_confidence ≥ 0.75 and a valid plate format. */
  good_reads: number;
  /** good_reads ÷ vehicles. */
  good_rate: number | null;
}

export interface ReadRateStats {
  per_camera: ReadRateRow[];
  overall: ReadRateRow;
}

/** High-confidence read rate = reads with OCR confidence ≥ 80 % ÷ vehicles whose plate was read at all. */
export function readRateStats(cameras: CameraEvents[]): ReadRateStats {
  const per_camera = cameras
    .map((c) => {
      const reads = c.events.filter((e) => e.plate_confidence != null);
      const high = reads.filter((e) => (e.plate_confidence ?? 0) >= HIGH_CONFIDENCE).length;
      const valid = reads.filter((e) => e.grammar_valid);
      return {
        valid_format: valid.length,
        valid_high: valid.filter((e) => (e.plate_confidence ?? 0) >= HIGH_CONFIDENCE).length,
        good_reads: valid.filter((e) => (e.plate_confidence ?? 0) >= GOOD_READ_CONFIDENCE).length,
        good_rate: c.events.length ? valid.filter((e) => (e.plate_confidence ?? 0) >= GOOD_READ_CONFIDENCE).length / c.events.length : null,
        camera_code: c.camera_code,
        vehicles: c.events.length,
        plate_reads: reads.length,
        high_confidence: high,
        rate: reads.length ? high / reads.length : null,
      };
    })
    .sort((a, b) => a.camera_code.localeCompare(b.camera_code));
  const sum = (k: 'vehicles' | 'plate_reads' | 'high_confidence' | 'valid_format' | 'valid_high' | 'good_reads') => per_camera.reduce((s, r) => s + r[k], 0);
  const plate_reads = sum('plate_reads');
  const high_confidence = sum('high_confidence');
  return {
    per_camera,
    overall: {
      camera_code: 'All clips',
      vehicles: sum('vehicles'),
      plate_reads,
      high_confidence,
      rate: plate_reads ? high_confidence / plate_reads : null,
      valid_format: sum('valid_format'),
      valid_high: sum('valid_high'),
      good_reads: sum('good_reads'),
      good_rate: sum('vehicles') ? sum('good_reads') / sum('vehicles') : null,
    },
  };
}
