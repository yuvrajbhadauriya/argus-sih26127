import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropFromCanvas, padBox, PLATE_PAD, scaleBox } from './plateCrop';

const FRAME = { width: 1280, height: 720 };

afterEach(() => vi.restoreAllMocks());

describe('padBox', () => {
  it('adds the plate padding around the box and keeps it centred', () => {
    // 100×30 plate: +18 % per side horizontally, +45 % per side vertically
    expect(padBox({ x: 500, y: 400, width: 100, height: 30 }, FRAME, PLATE_PAD)).toEqual({ x: 482, y: 386, width: 136, height: 57 });
  });

  it('enforces the minimum side so a tiny plate keeps some context', () => {
    const r = padBox({ x: 600, y: 300, width: 10, height: 4 }, FRAME, PLATE_PAD)!;
    expect(r.width).toBe(24);
    expect(r.height).toBe(24);
    // still centred on the plate (605, 302)
    expect(r.x + r.width / 2).toBeCloseTo(605, 0);
    expect(r.y + r.height / 2).toBeCloseTo(302, 0);
  });

  it('slides the crop back inside the frame at the edges instead of shrinking it', () => {
    const left = padBox({ x: 0, y: 0, width: 100, height: 30 }, FRAME, PLATE_PAD)!;
    expect(left.x).toBe(0);
    expect(left.y).toBe(0);
    expect(left.width).toBe(136);
    const right = padBox({ x: 1270, y: 715, width: 10, height: 5 }, FRAME, PLATE_PAD)!;
    expect(right.x + right.width).toBeLessThanOrEqual(FRAME.width);
    expect(right.y + right.height).toBeLessThanOrEqual(FRAME.height);
  });

  it('never exceeds the frame and rejects degenerate input', () => {
    const huge = padBox({ x: 0, y: 0, width: 5000, height: 5000 }, FRAME, PLATE_PAD)!;
    expect(huge).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(padBox({ x: 0, y: 0, width: 0, height: 10 }, FRAME)).toBeNull();
    expect(padBox({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('scaleBox', () => {
  it('maps model-space boxes onto the canvas and leaves identical sizes alone', () => {
    const b = { x: 10, y: 20, width: 30, height: 40 };
    expect(scaleBox(b, { width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({ x: 5, y: 10, width: 15, height: 20 });
    expect(scaleBox(b, FRAME, FRAME)).toBe(b);
  });
});

describe('cropFromCanvas', () => {
  function stub(dataUrl = 'data:image/jpeg;base64,CROP') {
    const ctx = { drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
    const src = document.createElement('canvas');
    src.width = FRAME.width;
    src.height = FRAME.height;
    return { ctx, src };
  }

  it('draws exactly the padded region of the source canvas', () => {
    const { ctx, src } = stub();
    const crop = cropFromCanvas(src, { x: 500, y: 400, width: 100, height: 30 }, PLATE_PAD);
    expect(crop).toEqual({ dataUrl: 'data:image/jpeg;base64,CROP', width: 136, height: 57 });
    expect(ctx.drawImage).toHaveBeenCalledWith(src, 482, 386, 136, 57, 0, 0, 136, 57);
  });

  it('returns null for a degenerate box, a missing 2d context or an unreadable canvas', () => {
    const { src } = stub();
    expect(cropFromCanvas(src, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(cropFromCanvas(src, { x: 1, y: 1, width: 50, height: 20 })).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(cropFromCanvas(src, { x: 1, y: 1, width: 50, height: 20 })).toBeNull();
  });

  it('rejects an encoder that did not produce a JPEG', () => {
    const { src } = stub('data:,');
    expect(cropFromCanvas(src, { x: 1, y: 1, width: 50, height: 20 })).toBeNull();
  });
});
