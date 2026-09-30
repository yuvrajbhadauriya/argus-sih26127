// ═══════════════════════════════════════════════════
// Canvas drawing for remote (/api/detect) detection results.
// ═══════════════════════════════════════════════════

import type { RemoteDetection } from './detectFrame';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';

const BOX_COLOR = VIDEO_OVERLAY.box;
const PLATE_BG = VIDEO_OVERLAY.labelBg;
const LABEL_FG = VIDEO_OVERLAY.labelFg;

export function formatPct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

/** Draws boxes + plate labels onto a canvas whose pixel size equals the analysed frame. */
export function drawDetections(canvas: HTMLCanvasElement, frame: { width: number; height: number }, detections: RemoteDetection[]) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, frame.width, frame.height);
  const line = Math.max(2, Math.round(frame.width / 400));
  const fontPx = Math.max(12, Math.round(frame.width / 55));
  ctx.lineWidth = line;
  ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';

  for (const d of detections) {
    const { x, y, width, height } = d.bbox;
    ctx.strokeStyle = BOX_COLOR;
    ctx.strokeRect(x, y, width, height);

    const label = d.plate_text ? `${d.plate_text}  ${formatPct(d.plate_confidence ?? d.confidence)}` : `${d.vehicle_type} ${formatPct(d.confidence)}`;
    const tw = ctx.measureText(label).width + 8;
    const th = fontPx + 6;
    const ly = y - th >= 0 ? y - th : y + height;
    ctx.fillStyle = PLATE_BG;
    ctx.fillRect(x, ly, tw, th);
    ctx.fillStyle = LABEL_FG;
    ctx.fillText(label, x + 4, ly + 3);
  }
}

