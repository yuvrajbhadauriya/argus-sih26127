// ═══════════════════════════════════════════════════
// useDetectionOverlay Hook
// Reusable hook syncing video playback time with canvas bounding boxes
// Strictly mandated by .cursorrules
//
// Performance notes:
// - Detections are filtered + indexed into time buckets ONCE per data set
//   (useMemo), so each frame only looks at ~3 small buckets instead of
//   scanning every detection.
// - Frames are driven by requestVideoFrameCallback when available (fires only
//   when a new video frame is presented; idle while paused), falling back to
//   requestAnimationFrame.
// - The canvas is sized via ResizeObserver (no layout read per frame) and is
//   devicePixelRatio-aware so boxes stay crisp on HiDPI screens.
// - React state is only updated when the visible set actually changes, and the
//   canvas is only redrawn when the set or the canvas size changes.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Detection } from '@/types';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';

/** Detections within ±this many seconds of the playhead are drawn. */
export const OVERLAY_WINDOW_SEC = 0.2;
/** Cap on boxes drawn at once (most confident first). */
export const MAX_OVERLAY_BOXES = 20;
/** Bbox coordinates in the data are relative to this base resolution. */
const BASE_WIDTH = 640;
const BASE_HEIGHT = 360;
const BUCKET_SEC = OVERLAY_WINDOW_SEC;

/** Helper to parse timestamp format "MM:SS.mmm" or seconds number */
export function parseTimestampToSeconds(ts: unknown, frameTsSec?: number): number {
  if (typeof frameTsSec === 'number' && !isNaN(frameTsSec)) return frameTsSec;
  if (typeof ts === 'number') return ts;
  if (!ts || typeof ts !== 'string') return 0;
  if (!ts.includes(':')) {
    const val = parseFloat(ts);
    return isNaN(val) ? 0 : val;
  }
  const parts = ts.split(':');
  const minutes = parseFloat(parts[0]) || 0;
  const seconds = parseFloat(parts[1]) || 0;
  return minutes * 60 + seconds;
}

/** Plate reads are only shown as text at or above this OCR confidence (the pipeline good-read rule). */
export const PLATE_READ_MIN_CONFIDENCE = 0.75;

export type PlateReadState = 'read' | 'reading' | 'none';

/**
 * 'read'    the tracked vehicle's plate was read with OCR ≥ 75 % (pipeline
 *           output only carries text for grammar-valid reads)
 * 'reading' a plate was found but the read is below 75 % → shown as "reading…"
 * 'none'    no plate read for this vehicle (box only)
 */
export function plateReadState(d: Pick<Detection, 'plate_text_raw' | 'plate_confidence' | 'confidence_score'>): PlateReadState {
  const text = (d.plate_text_raw || '').trim();
  if (!text || text.toUpperCase() === 'UNKNOWN') return 'none';
  const conf = typeof d.plate_confidence === 'number' ? d.plate_confidence : d.confidence_score;
  return conf >= PLATE_READ_MIN_CONFIDENCE ? 'read' : 'reading';
}

/** Minimum detector confidence for a vehicle box without a plate read. */
export const MIN_VEHICLE_CONFIDENCE = 0.6;
/** Minimum box side (640×360 space) for a vehicle box without a plate read. */
export const MIN_VEHICLE_BOX = 14;

/**
 * Whether the overlay can ever draw this detection (independent of time).
 * scripts/perf/compact_detections.mjs pre-applies this exact filter to the
 * static JSON files — keep the two in sync.
 */
export function isDrawableDetection(d: Detection): boolean {
  const vType = (d.vehicle_type || '').toLowerCase();
  const { x, y, width, height } = d.bbox;

  // Pedestrians are never boxed.
  if (vType === 'person' || vType === 'pedestrian') return false;
  // Full-frame / screen-spanning boxes (e.g. 0,0 640x360 covering the video).
  if (width >= 520 || height >= 290) return false;
  if ((x <= 3 && width >= 630) || (y <= 3 && height >= 350)) return false;
  // A vehicle whose plate was found is always shown (unless degenerate).
  if (plateReadState(d) !== 'none') return width >= 8 && height >= 8;
  // Otherwise: a confidently detected, known vehicle class of useful size.
  if (vType === 'unknown') return false;
  if (d.confidence_score < MIN_VEHICLE_CONFIDENCE) return false;
  if (width < MIN_VEHICLE_BOX || height < MIN_VEHICLE_BOX) return false;
  return true;
}

interface IndexedDetection {
  det: Detection;
  time: number;
  key: string;
  order: number;
}

export interface DetectionIndex {
  buckets: Map<number, IndexedDetection[]>;
  size: number;
}

/** Filter + bucket detections by time. O(n), done once per detections array. */
export function buildDetectionIndex(detections: Detection[]): DetectionIndex {
  const buckets = new Map<number, IndexedDetection[]>();
  let size = 0;
  (detections || []).forEach((det, order) => {
    if (!isDrawableDetection(det)) return;
    const time = parseTimestampToSeconds(det.timestamp, det.frame_timestamp_sec);
    const b = Math.floor(time / BUCKET_SEC);
    const entry: IndexedDetection = { det, time, key: String(det.tracked_vehicle_id || det.event_id), order };
    const list = buckets.get(b);
    if (list) list.push(entry);
    else buckets.set(b, [entry]);
    size++;
  });
  return { buckets, size };
}

/**
 * The detections to draw at `currentTime`: within the time window, one per
 * tracked vehicle (closest frame wins), top N by confidence.
 */
export function selectActiveDetections(index: DetectionIndex, currentTime: number): Detection[] {
  if (index.size === 0) return [];
  const from = Math.floor((currentTime - OVERLAY_WINDOW_SEC) / BUCKET_SEC) - 1;
  const to = Math.floor((currentTime + OVERLAY_WINDOW_SEC) / BUCKET_SEC) + 1;
  const candidates: IndexedDetection[] = [];
  for (let b = from; b <= to; b++) {
    const list = index.buckets.get(b);
    if (!list) continue;
    for (const e of list) {
      if (Math.abs(e.time - currentTime) <= OVERLAY_WINDOW_SEC) candidates.push(e);
    }
  }
  if (candidates.length === 0) return [];
  // Original array order, so tie-breaking matches a plain linear scan.
  candidates.sort((a, b) => a.order - b.order);

  const bestByVehicle = new Map<string, { e: IndexedDetection; diff: number }>();
  for (const e of candidates) {
    const diff = Math.abs(e.time - currentTime);
    const existing = bestByVehicle.get(e.key);
    if (!existing || diff < existing.diff) bestByVehicle.set(e.key, { e, diff });
  }

  return Array.from(bestByVehicle.values())
    .map((v) => v.e.det)
    // Plate reads first (they carry the information), then most confident.
    .sort((a, b) => readRank(b) - readRank(a) || b.confidence_score - a.confidence_score)
    .slice(0, MAX_OVERLAY_BOXES);
}

function readRank(d: Detection): number {
  const s = plateReadState(d);
  return s === 'read' ? 2 : s === 'reading' ? 1 : 0;
}

function sameSet(a: Detection[], b: Detection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Overlay style: the primary feed gets full labels, wall tiles only plate labels. */
export type OverlayVariant = 'full' | 'tile';

export interface OverlayOptions {
  variant?: OverlayVariant;
  /** Watchlisted plates as plateKey()s (uppercase alphanumerics) — drawn in red. */
  watchlist?: ReadonlySet<string>;
}

const plateKeyOf = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Below this rendered width only plate labels are drawn (no class / "reading…" tags). */
const MIN_DETAIL_WIDTH = 480;
const FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = '"Inter Variable", Inter, system-ui, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function corners(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, len: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
  ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len);
  ctx.stroke();
}

function chipWidths(ctx: CanvasRenderingContext2D, segments: { text: string; font: string }[], h: number): number[] {
  const pad = Math.round(h * 0.32);
  return segments.map((sg) => {
    ctx.font = sg.font;
    return ctx.measureText(sg.text).width + pad * 2;
  });
}

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Pick a label position near the box that does not cover an already placed
 * label: above the box, below it, then stepping further up / down.
 */
function placeLabel(placed: Rect[], x: number, w: number, h: number, boxTop: number, boxBottom: number, maxW: number, maxH: number): number {
  const cx = Math.max(0, Math.min(x, maxW - w));
  const above = boxTop - h - 2;
  const below = boxBottom + 2;
  const candidates = [above, below];
  for (let k = 1; k <= 3; k++) candidates.push(above - k * (h + 1), below + k * (h + 1));
  for (const y of candidates) {
    if (y < 0 || y + h > maxH) continue;
    const r = { x: cx, y, w, h };
    if (!placed.some((p) => overlaps(p, r))) return y;
  }
  return Math.max(0, Math.min(above, maxH - h));
}

/**
 * Draw one chip made of segments ({text, bg, fg, font}) at (x, y) — clamped
 * inside the canvas. Returns the chip width.
 */
function chip(
  ctx: CanvasRenderingContext2D,
  segments: { text: string; bg: string; fg: string; font: string }[],
  x: number,
  y: number,
  h: number,
  maxW: number,
): number {
  const widths = chipWidths(ctx, segments, h);
  const total = widths.reduce((a, b) => a + b, 0);
  const pad = Math.round(h * 0.32);
  let cx = Math.max(0, Math.min(x, maxW - total));
  segments.forEach((sg, i) => {
    ctx.fillStyle = sg.bg;
    roundRect(ctx, cx, y, widths[i], h, i === 0 || i === segments.length - 1 ? 2 : 0);
    ctx.fill();
    ctx.font = sg.font;
    ctx.fillStyle = sg.fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(sg.text, cx + pad, y + h / 2 + 0.5);
    cx += widths[i];
  });
  return total;
}

export function drawDetections(
  ctx: CanvasRenderingContext2D,
  dets: Detection[],
  cssW: number,
  cssH: number,
  options: OverlayOptions = {},
) {
  // Scale coordinates from the 640x360 base resolution to the rendered size.
  const scaleX = cssW / BASE_WIDTH;
  const scaleY = cssH / BASE_HEIGHT;
  const tile = options.variant === 'tile' || cssW < MIN_DETAIL_WIDTH;
  // Label size follows the rendered frame: ~11 px on a 720p-wide feed, 9 px on phones / tiles.
  const fontPx = Math.max(9, Math.min(13, Math.round(cssW / 68)));
  const chipH = Math.round(fontPx * 1.6);

  const mono = `700 ${fontPx}px ${FONT}`;
  const sans = `600 ${Math.max(8, fontPx - 1)}px ${SANS}`;
  const boxOf = (det: Detection) => ({ bx: det.bbox.x * scaleX, by: det.bbox.y * scaleY, bw: det.bbox.width * scaleX, bh: det.bbox.height * scaleY });
  const isWatch = (det: Detection) => plateReadState(det) === 'read' && !!options.watchlist?.has(plateKeyOf(det.plate_text_raw));

  // Pass 1 — boxes: plain vehicles first so plate reads end up on top.
  const byRankAsc = [...dets].sort((a, b) => readRank(a) - readRank(b));
  for (const det of byRankAsc) {
    const { bx, by, bw, bh } = boxOf(det);
    const state = plateReadState(det);
    const watch = isWatch(det);
    const color = watch ? VIDEO_OVERLAY.watchlistBox : state === 'read' ? VIDEO_OVERLAY.readBox : VIDEO_OVERLAY.box;
    // Thin box for tracked vehicles, highlighted box for a plate read.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = state === 'none' ? VIDEO_OVERLAY.boxMuted : color;
    ctx.lineWidth = state === 'read' ? 2 : 1;
    if (state === 'read') {
      ctx.shadowColor = watch ? VIDEO_OVERLAY.watchlistGlow : VIDEO_OVERLAY.readGlow;
      ctx.shadowBlur = 6;
    }
    ctx.strokeRect(bx, by, bw, bh);
    ctx.shadowBlur = 0;
    if (state !== 'none') {
      ctx.lineWidth = state === 'read' ? 3 : 2;
      ctx.strokeStyle = color;
      corners(ctx, bx, by, bw, bh, Math.min(10, bw / 3, bh / 3));
    }
  }

  // Pass 2 — labels: plate reads claim their spot first; later labels avoid them.
  // Labels never name the vehicle class: the model's class output is unreliable
  // on these clips (cars come out as TRUCK / BUS), so a vehicle without a plate
  // read keeps its box only.
  const placed: Rect[] = [];
  for (const det of [...byRankAsc].reverse()) {
    const { bx, by, bh } = boxOf(det);
    const state = plateReadState(det);
    const watch = isWatch(det);
    let segments: { text: string; bg: string; fg: string; font: string }[];
    let h = chipH;
    if (state === 'read') {
      const conf = typeof det.plate_confidence === 'number' ? det.plate_confidence : det.confidence_score;
      segments = [{ text: det.plate_text_raw, bg: watch ? VIDEO_OVERLAY.watchlistBox : VIDEO_OVERLAY.plateBg, fg: watch ? '#FFFFFF' : VIDEO_OVERLAY.plateFg, font: mono }];
      if (!tile) {
        segments.push({ text: `${Math.round(conf * 100)}%`, bg: VIDEO_OVERLAY.labelBg, fg: VIDEO_OVERLAY.labelFg, font: sans });
        if (watch) segments.push({ text: 'WATCHLIST', bg: VIDEO_OVERLAY.watchlistBox, fg: '#FFFFFF', font: sans });
      }
    } else if (state === 'reading' && !tile) {
      h = Math.round(chipH * 0.85);
      segments = [{ text: 'reading…', bg: VIDEO_OVERLAY.labelBg, fg: VIDEO_OVERLAY.labelFg, font: sans }];
    } else {
      continue;
    }
    const w = chipWidths(ctx, segments, h).reduce((a, b) => a + b, 0);
    const y = placeLabel(placed, bx, w, h, by, by + bh, cssW, cssH);
    chip(ctx, segments, bx, y, h, cssW);
    placed.push({ x: Math.max(0, Math.min(bx, cssW - w)), y, w, h });
  }
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function useDetectionOverlay(
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  detections: Detection[],
  options: OverlayOptions = {},
) {
  const { variant = 'full', watchlist } = options;
  const [activeDetections, setActiveDetections] = useState<Detection[]>([]);
  const index = useMemo(() => buildDetectionIndex(detections), [detections]);
  const animFrameRef = useRef<number | null>(null);
  const publishedRef = useRef<Detection[]>([]);

  useEffect(() => {
    const video = videoRef.current as VideoWithRvfc | null;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cssW = 0;
    let cssH = 0;
    let sizeDirty = true;
    let lastDrawn: Detection[] | null = null;
    let disposed = false;

    const measure = () => {
      const rect = video.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      sizeDirty = true;
    };
    measure();

    let ro: ResizeObserver | null = null;
    const onWindowResize = () => measure();
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(video);
    } else {
      window.addEventListener('resize', onWindowResize);
    }

    const useRvfc = typeof video.requestVideoFrameCallback === 'function';
    let rvfcHandle: number | null = null;

    const paint = (mediaTime?: number) => {
      if (disposed) return;
      if (sizeDirty) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sizeDirty = false;
        lastDrawn = null; // resizing clears the canvas → force a redraw
      }

      const currentTime = typeof mediaTime === 'number' ? mediaTime : video.currentTime;
      const current = selectActiveDetections(index, currentTime);

      if (lastDrawn === null || !sameSet(current, lastDrawn)) {
        ctx.clearRect(0, 0, cssW, cssH);
        // The video is object-contain: draw into the letterboxed picture area.
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        let ox = 0, oy = 0, cw = cssW, ch = cssH;
        if (vw > 0 && vh > 0 && cssW > 0 && cssH > 0) {
          const k = Math.min(cssW / vw, cssH / vh);
          cw = vw * k;
          ch = vh * k;
          ox = (cssW - cw) / 2;
          oy = (cssH - ch) / 2;
        }
        const shifted = ox !== 0 || oy !== 0;
        if (shifted && typeof ctx.translate === 'function') {
          ctx.save();
          ctx.translate(ox, oy);
        }
        drawDetections(ctx, current, cw, ch, { variant, watchlist });
        if (shifted && typeof ctx.restore === 'function') ctx.restore();
        lastDrawn = current;
      }
      // Only touch React state when the visible set changes. The ref outlives
      // effect restarts (e.g. callers passing fresh ref objects each render).
      if (!sameSet(current, publishedRef.current)) {
        publishedRef.current = current;
        setActiveDetections(current);
      }
    };

    const tick = (mediaTime?: number) => {
      if (disposed) return;
      paint(mediaTime);
      if (useRvfc) {
        rvfcHandle = video.requestVideoFrameCallback!((_now, meta) => tick(meta?.mediaTime));
      } else {
        animFrameRef.current = requestAnimationFrame(() => tick());
      }
    };

    // rVFC does not fire while paused → repaint on seek so scrubbing stays in sync.
    const onSeeked = () => paint();
    // Picture size (letterboxing) is only known once metadata has loaded.
    const onMeta = () => {
      sizeDirty = true;
      paint();
    };
    video.addEventListener('loadedmetadata', onMeta);
    if (useRvfc) {
      video.addEventListener('seeked', onSeeked);
      tick(); // paint the current frame immediately, then follow presented frames
    } else {
      animFrameRef.current = requestAnimationFrame(() => tick());
    }

    return () => {
      disposed = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', onMeta);
      ro?.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [videoRef, canvasRef, index, variant, watchlist]);

  return { activeDetections };
}
