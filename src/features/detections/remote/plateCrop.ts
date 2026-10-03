// ═══════════════════════════════════════════════════
// Plate / vehicle crops cut from the frame the model analysed.
//
// The model returns boxes in pixels of the submitted frame. The crop is taken
// from that same frame's canvas, so what the panel shows is exactly the region
// the OCR read — never a later frame, never a stock image.
// ═══════════════════════════════════════════════════

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

export interface Crop {
  /** JPEG data URL of the cropped region. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface PadOptions {
  /** Extra width on each side, as a fraction of the box width. */
  padX?: number;
  /** Extra height on each side, as a fraction of the box height. */
  padY?: number;
  /** Never crop smaller than this many source pixels per side (tiny plates stay legible in context). */
  minSide?: number;
}

/** Plates are small and wide: a little context left/right, more above/below so the whole plate is inside. */
export const PLATE_PAD: Required<PadOptions> = { padX: 0.18, padY: 0.45, minSide: 24 };
/** Vehicles keep a small margin. */
export const VEHICLE_PAD: Required<PadOptions> = { padX: 0.04, padY: 0.04, minSide: 24 };

/** Expands `box` by the padding, enforces a minimum size and clamps it inside the frame (integer pixels). */
export function padBox(box: PixelBox, frame: FrameSize, pad: PadOptions = PLATE_PAD): PixelBox | null {
  const { padX = 0, padY = 0, minSide = 0 } = pad;
  if (!(box.width > 0) || !(box.height > 0) || !(frame.width > 0) || !(frame.height > 0)) return null;
  const w = Math.min(frame.width, Math.max(box.width * (1 + 2 * padX), minSide));
  const h = Math.min(frame.height, Math.max(box.height * (1 + 2 * padY), minSide));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = Math.min(Math.max(cx - w / 2, 0), frame.width - w);
  const y = Math.min(Math.max(cy - h / 2, 0), frame.height - h);
  const out = { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(w), height: Math.ceil(h) };
  out.width = Math.min(out.width, frame.width - out.x);
  out.height = Math.min(out.height, frame.height - out.y);
  return out.width > 0 && out.height > 0 ? out : null;
}

/** Scales a box from the model's image space to the canvas it was cut from (identical sizes → unchanged). */
export function scaleBox(box: PixelBox, from: FrameSize, to: FrameSize): PixelBox {
  if (!(from.width > 0) || !(from.height > 0) || (from.width === to.width && from.height === to.height)) return box;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy };
}

/**
 * Cuts `box` (pixels of `canvas`) out of `canvas` as a JPEG. Returns null when
 * the box is degenerate or the canvas cannot be read/encoded.
 */
export function cropFromCanvas(canvas: HTMLCanvasElement, box: PixelBox, pad: PadOptions = PLATE_PAD, quality = 0.92): Crop | null {
  const region = padBox(box, { width: canvas.width, height: canvas.height }, pad);
  if (!region) return null;
  try {
    const out = document.createElement('canvas');
    out.width = region.width;
    out.height = region.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    const dataUrl = out.toDataURL('image/jpeg', quality);
    return dataUrl.startsWith('data:image/jpeg') ? { dataUrl, width: region.width, height: region.height } : null;
  } catch {
    return null;
  }
}
