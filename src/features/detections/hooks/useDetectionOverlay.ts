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
export const MAX_OVERLAY_BOXES = 15;
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

/**
 * Whether the overlay can ever draw this detection (independent of time).
 * scripts/perf/compact_detections.mjs pre-applies this exact filter to the
 * static JSON files — keep the two in sync.
 */
export function isDrawableDetection(d: Detection): boolean {
  const vType = (d.vehicle_type || '').toLowerCase();
  const { x, y, width, height } = d.bbox;

  // Filter out pedestrians / non-vehicles
  if (vType === 'person' || vType === 'pedestrian' || vType === 'unknown') return false;
  // Require at least 80% detection confidence to eliminate false edge detections
  if (d.confidence_score < 0.8) return false;
  // Filter out full-frame / screen-spanning boundary boxes (e.g. 0,0 640x360 covering video)
  if (width >= 520 || height >= 290) return false;
  // Filter out edge boundary artifacts clipped at outer frame margins
  if ((x <= 3 && width >= 630) || (y <= 3 && height >= 350)) return false;
  // Filter out tiny background noise boxes (< 25px)
  if (width < 25 || height < 25) return false;
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
    .sort((a, b) => b.confidence_score - a.confidence_score)
    .slice(0, MAX_OVERLAY_BOXES);
}

function sameSet(a: Detection[], b: Detection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Below this rendered width the text labels would bury the frame, so only boxes are drawn. */
const MIN_LABEL_WIDTH = 480;

function drawDetections(ctx: CanvasRenderingContext2D, dets: Detection[], cssW: number, cssH: number) {
  // Scale coordinates from 640x360 base video resolution to canvas rendered dimensions
  const scaleX = cssW / BASE_WIDTH;
  const scaleY = cssH / BASE_HEIGHT;

  for (const det of dets) {
    const { x, y, width, height } = det.bbox;
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
    const scaledW = width * scaleX;
    const scaledH = height * scaleY;

    // Bounding box (fixed video-overlay palette: video is always dark)
    ctx.strokeStyle = VIDEO_OVERLAY.box;
    ctx.lineWidth = 2;
    ctx.shadowColor = VIDEO_OVERLAY.boxGlow;
    ctx.shadowBlur = 6;
    ctx.strokeRect(scaledX, scaledY, scaledW, scaledH);
    ctx.shadowBlur = 0;

    // Corner ticks make small boxes easier to pick out on busy footage
    const cornerLen = Math.min(10, scaledW / 3, scaledH / 3);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(scaledX, scaledY + cornerLen);
    ctx.lineTo(scaledX, scaledY);
    ctx.lineTo(scaledX + cornerLen, scaledY);
    ctx.moveTo(scaledX + scaledW - cornerLen, scaledY);
    ctx.lineTo(scaledX + scaledW, scaledY);
    ctx.lineTo(scaledX + scaledW, scaledY + cornerLen);
    ctx.moveTo(scaledX, scaledY + scaledH - cornerLen);
    ctx.lineTo(scaledX, scaledY + scaledH);
    ctx.lineTo(scaledX + cornerLen, scaledY + scaledH);
    ctx.moveTo(scaledX + scaledW - cornerLen, scaledY + scaledH);
    ctx.lineTo(scaledX + scaledW, scaledY + scaledH);
    ctx.lineTo(scaledX + scaledW, scaledY + scaledH - cornerLen);
    ctx.stroke();

    if (cssW < MIN_LABEL_WIDTH) continue;

    // Label: plate · class · confidence on a dark chip above the box
    const trackedIdStr = det.tracked_vehicle_id ? `#${det.tracked_vehicle_id} ` : '';
    const labelText = `${trackedIdStr}${det.plate_text_raw} · ${String(det.vehicle_type).toUpperCase()} · ${Math.round(det.confidence_score * 100)}%`;
    ctx.font = '600 11px "Inter Variable", Inter, sans-serif';
    const tagHeight = 18;
    const tagWidth = ctx.measureText(labelText).width + 10;
    const tagY = Math.max(0, scaledY - tagHeight - 2);

    ctx.fillStyle = VIDEO_OVERLAY.labelBg;
    ctx.fillRect(scaledX, tagY, tagWidth, tagHeight);
    ctx.fillStyle = VIDEO_OVERLAY.box;
    ctx.fillRect(scaledX, tagY, 2, tagHeight);
    ctx.fillStyle = VIDEO_OVERLAY.labelFg;
    ctx.fillText(labelText, scaledX + 6, tagY + 13);
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
) {
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
        drawDetections(ctx, current, cssW, cssH);
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
      ro?.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [videoRef, canvasRef, index]);

  return { activeDetections };
}
