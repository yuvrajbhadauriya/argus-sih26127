#!/usr/bin/env node
// ═══════════════════════════════════════════════════
// compact_detections.mjs — shrink public/detections/detections_*.json
//
//   node scripts/perf/compact_detections.mjs [dir]   (default: public/detections)
//
// 1. Pre-applies the exact row filter the video overlay applies at runtime
//    (src/features/detections/hooks/useDetectionOverlay.ts → isDrawableDetection):
//    rows the overlay could never draw are dropped, after mapping missing fields
//    to the same defaults features/detections/api.ts uses (confidence 0.85,
//    vehicle_type 'car', bbox fields 0).
// 2. Rounds numbers (bbox 1 dp, confidence 3 dp, timestamps 3 dp). The filter
//    is evaluated on the ORIGINAL values, so rounding can't change membership.
// 3. Writes minified JSON with the same per-row schema
//    ({camera_code, tracked_vehicle_id, plate_text, vehicle_type, confidence,
//    frame_timestamp_sec, bbox:{x,y,width,height}}), preserving row order.
//
// Idempotent: running it again on its own output is a no-op.
// ═══════════════════════════════════════════════════

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = process.argv[2] || join(process.cwd(), 'public', 'detections');

// ── Keep in sync with isDrawableDetection() in useDetectionOverlay.ts ──
const MIN_CONFIDENCE = 0.8;
const EXCLUDED_TYPES = new Set(['person', 'pedestrian', 'unknown']);
function isDrawable(row) {
  const vehicleType = String(row.vehicle_type || 'car').toLowerCase();
  const confidence = row.confidence ?? 0.85;
  const x = row.bbox?.x ?? 0;
  const y = row.bbox?.y ?? 0;
  const width = row.bbox?.width ?? 0;
  const height = row.bbox?.height ?? 0;
  if (EXCLUDED_TYPES.has(vehicleType)) return false;
  if (confidence < MIN_CONFIDENCE) return false;
  if (width >= 520 || height >= 290) return false;
  if ((x <= 3 && width >= 630) || (y <= 3 && height >= 350)) return false;
  if (width < 25 || height < 25) return false;
  return true;
}

const round = (v, dp) => (typeof v === 'number' ? Math.round(v * 10 ** dp) / 10 ** dp : v);

function compactRow(row) {
  const out = {};
  if (row.camera_code !== undefined) out.camera_code = row.camera_code;
  if (row.tracked_vehicle_id !== undefined) out.tracked_vehicle_id = row.tracked_vehicle_id;
  if (row.plate_text !== undefined) out.plate_text = row.plate_text;
  if (row.vehicle_type !== undefined) out.vehicle_type = row.vehicle_type;
  if (row.confidence !== undefined) out.confidence = round(row.confidence, 3);
  if (row.frame_timestamp_sec !== undefined) out.frame_timestamp_sec = round(row.frame_timestamp_sec, 3);
  // carry through any other scalar fields unchanged (future-proofing)
  for (const [k, v] of Object.entries(row)) {
    if (!(k in out) && k !== 'bbox') out[k] = v;
  }
  out.bbox = {
    x: round(row.bbox?.x ?? 0, 1),
    y: round(row.bbox?.y ?? 0, 1),
    width: round(row.bbox?.width ?? 0, 1),
    height: round(row.bbox?.height ?? 0, 1),
  };
  return out;
}

const files = readdirSync(dir).filter((f) => /^detections_.+\.json$/.test(f)).sort();
let totBefore = 0;
let totAfter = 0;
let totGzBefore = 0;
let totGzAfter = 0;
console.log('file                        rows before→after      raw before→after          gzip before→after');
for (const f of files) {
  const p = join(dir, f);
  const raw = readFileSync(p);
  const rows = JSON.parse(raw.toString('utf8'));
  const kept = rows.filter(isDrawable).map(compactRow);
  const next = Buffer.from(JSON.stringify(kept));
  writeFileSync(p, next);
  const gzB = gzipSync(raw, { level: 9 }).length;
  const gzA = gzipSync(next, { level: 9 }).length;
  totBefore += raw.length;
  totAfter += next.length;
  totGzBefore += gzB;
  totGzAfter += gzA;
  console.log(
    `${f.padEnd(26)}  ${String(rows.length).padStart(6)} → ${String(kept.length).padEnd(6)}  ` +
      `${(raw.length / 1024).toFixed(0).padStart(6)} kB → ${(next.length / 1024).toFixed(0).padStart(5)} kB   ` +
      `${(gzB / 1024).toFixed(0).padStart(5)} kB → ${(gzA / 1024).toFixed(0).padStart(4)} kB`,
  );
}
console.log(
  `TOTAL raw ${(totBefore / 1048576).toFixed(2)} MB → ${(totAfter / 1048576).toFixed(2)} MB, ` +
    `gzip ${(totGzBefore / 1024).toFixed(0)} kB → ${(totGzAfter / 1024).toFixed(0)} kB`,
);
