import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Detection } from '@/types';
import {
  useDetectionOverlay,
  buildDetectionIndex,
  selectActiveDetections,
  isDrawableDetection,
} from './useDetectionOverlay';

// ── Canvas / rAF harness ──────────────────────────────────────────
function makeCtx() {
  return {
    clearRect: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })),
    strokeStyle: '', fillStyle: '', lineWidth: 0, shadowColor: '', shadowBlur: 0, font: '',
  };
}

let rafQueue: FrameRequestCallback[] = [];
let ctx: ReturnType<typeof makeCtx>;

function stepFrame() {
  const cbs = rafQueue;
  rafQueue = [];
  act(() => cbs.forEach((cb) => cb(performance.now())));
}

function setup(detections: Detection[], currentTime = 0, size = { width: 640, height: 360 }) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', { value: currentTime, writable: true });
  video.getBoundingClientRect = () => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => ({}) }) as DOMRect;
  const canvas = document.createElement('canvas');
  const videoRef = { current: video };
  const canvasRef = { current: canvas };
  const hook = renderHook(({ d }) => useDetectionOverlay(videoRef, canvasRef, d), { initialProps: { d: detections } });
  return { video, canvas, hook };
}

let seq = 0;
function det(over: Partial<Detection> & { tracked_vehicle_id?: string } = {}): Detection {
  seq++;
  return {
    event_id: `e${seq}`,
    camera_id: 'cam-001',
    plate_text_raw: `P${seq}`,
    plate_text_normalized: `P${seq}`,
    confidence_score: 0.9,
    vehicle_type: 'car',
    timestamp: 0,
    frame_timestamp_sec: 0,
    bbox: { x: 100, y: 100, width: 80, height: 60 },
    ...over,
  };
}

beforeEach(() => {
  rafQueue = [];
  ctx = makeCtx();
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.unstubAllGlobals());

describe('useDetectionOverlay', () => {
  it('does nothing (no rAF) when refs are empty', () => {
    renderHook(() => useDetectionOverlay({ current: null }, { current: null }, []));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('draws detections inside the ±0.20s window and exposes them', () => {
    const a = det({ frame_timestamp_sec: 5.1 });
    const b = det({ frame_timestamp_sec: 5.5 }); // outside window
    const { hook } = setup([a, b], 5.0);
    stepFrame();
    expect(hook.result.current.activeDetections.map((d) => d.event_id)).toEqual([a.event_id]);
    expect(ctx.strokeRect).toHaveBeenCalledWith(100, 100, 80, 60);
  });

  it('filters people/unknown, low confidence, full-frame and tiny boxes', () => {
    const keep = det();
    const dets = [
      keep,
      det({ vehicle_type: 'unknown' }),
      det({ confidence_score: 0.79 }),
      det({ bbox: { x: 0, y: 0, width: 640, height: 360 } }),
      det({ bbox: { x: 10, y: 10, width: 24, height: 40 } }),
    ];
    const { hook } = setup(dets, 0);
    stepFrame();
    expect(hook.result.current.activeDetections.map((d) => d.event_id)).toEqual([keep.event_id]);
  });

  it('parses "MM:SS.mmm" string timestamps when frame_timestamp_sec is absent', () => {
    const d = det({ timestamp: '01:02.500', frame_timestamp_sec: undefined });
    const { hook } = setup([d], 62.5);
    stepFrame();
    expect(hook.result.current.activeDetections).toHaveLength(1);
  });

  it('parses plain numeric-string timestamps and treats garbage as 0', () => {
    const d1 = det({ timestamp: '3.1', frame_timestamp_sec: undefined });
    const d2 = det({ timestamp: 'abc', frame_timestamp_sec: undefined });
    const { hook } = setup([d1, d2], 3.0);
    stepFrame();
    expect(hook.result.current.activeDetections.map((d) => d.event_id)).toEqual([d1.event_id]);
  });

  it('de-duplicates by tracked_vehicle_id keeping the closest-in-time frame', () => {
    const far = det({ tracked_vehicle_id: 'trk_1', frame_timestamp_sec: 1.15 });
    const near = det({ tracked_vehicle_id: 'trk_1', frame_timestamp_sec: 1.02 });
    const other = det({ tracked_vehicle_id: 'trk_2', frame_timestamp_sec: 1.0 });
    const { hook } = setup([far, near, other], 1.0);
    stepFrame();
    const ids = hook.result.current.activeDetections.map((d) => d.event_id).sort();
    expect(ids).toEqual([near.event_id, other.event_id].sort());
  });

  it('caps the overlay at the 15 most confident vehicles', () => {
    const dets = Array.from({ length: 20 }, (_, i) => det({ confidence_score: 0.8 + i * 0.005 }));
    const { hook } = setup(dets, 0);
    stepFrame();
    const active = hook.result.current.activeDetections;
    expect(active).toHaveLength(15);
    expect(active[0].confidence_score).toBeCloseTo(0.8 + 19 * 0.005);
    expect(active.every((d, i) => i === 0 || active[i - 1].confidence_score >= d.confidence_score)).toBe(true);
  });

  it('scales 640x360 coordinates to the rendered canvas size', () => {
    const { canvas } = setup([det({ bbox: { x: 64, y: 36, width: 64, height: 36 } })], 0, { width: 1280, height: 720 });
    stepFrame();
    expect(canvas.width).toBe(1280);
    expect(ctx.strokeRect).toHaveBeenCalledWith(128, 72, 128, 72);
  });

  it('cancels the animation frame on unmount', () => {
    const { hook } = setup([det()], 0);
    hook.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  // Regression: setActiveDetections() used to run with a new array on every
  // animation frame, re-rendering the host component ~60x/second.
  it('does not re-render when the active set is unchanged between frames', () => {
    let renders = 0;
    const video = document.createElement('video');
    video.getBoundingClientRect = () => ({ width: 640, height: 360 }) as DOMRect;
    const canvas = document.createElement('canvas');
    const d = [det()];
    renderHook(() => {
      renders++;
      return useDetectionOverlay({ current: video }, { current: canvas }, d);
    });
    stepFrame();
    const after1 = renders;
    stepFrame();
    stepFrame();
    stepFrame();
    expect(renders).toBe(after1);
  });

  it('does not redraw the canvas when the active set is unchanged', () => {
    setup([det()], 0);
    stepFrame();
    expect(ctx.strokeRect).toHaveBeenCalled();
    ctx.strokeRect.mockClear();
    ctx.clearRect.mockClear();
    stepFrame();
    stepFrame();
    expect(ctx.clearRect).not.toHaveBeenCalled();
    expect(ctx.strokeRect).not.toHaveBeenCalled();
  });

  it('re-renders and redraws when the playhead moves to a different set', () => {
    const a = det({ frame_timestamp_sec: 0 });
    const b = det({ frame_timestamp_sec: 2 });
    const { video, hook } = setup([a, b], 0);
    stepFrame();
    expect(hook.result.current.activeDetections).toEqual([a]);
    (video as unknown as { currentTime: number }).currentTime = 2;
    stepFrame();
    expect(hook.result.current.activeDetections).toEqual([b]);
  });

  it('reads the element size once, not on every frame', () => {
    const { video } = setup([det()], 0);
    const spy = vi.spyOn(video, 'getBoundingClientRect');
    stepFrame();
    stepFrame();
    stepFrame();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sizes the backing store by devicePixelRatio and draws in CSS pixels', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const setTransform = vi.fn();
    (ctx as unknown as { setTransform: typeof setTransform }).setTransform = setTransform;
    const { canvas } = setup([det({ bbox: { x: 64, y: 36, width: 64, height: 36 } })], 0, { width: 1280, height: 720 });
    stepFrame();
    expect(canvas.width).toBe(2560);
    expect(canvas.height).toBe(1440);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(ctx.strokeRect).toHaveBeenCalledWith(128, 72, 128, 72);
  });

  it('uses requestVideoFrameCallback when the browser supports it', () => {
    const rvfc: ((now: number, meta: { mediaTime: number }) => void)[] = [];
    const request = vi.fn((cb: (now: number, meta: { mediaTime: number }) => void) => { rvfc.push(cb); return rvfc.length; });
    const cancel = vi.fn();
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    proto.requestVideoFrameCallback = request;
    proto.cancelVideoFrameCallback = cancel;
    try {
      const a = det({ frame_timestamp_sec: 3 });
      const { hook } = setup([a], 0);
      // painted synchronously for the current frame, then waits for the next video frame
      expect(requestAnimationFrame).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      act(() => rvfc[0](0, { mediaTime: 3.05 }));
      expect(hook.result.current.activeDetections).toEqual([a]);
      hook.unmount();
      expect(cancel).toHaveBeenCalled();
    } finally {
      delete proto.requestVideoFrameCallback;
      delete proto.cancelVideoFrameCallback;
    }
  });
});

describe('detection index', () => {
  it('drops undrawable rows up front', () => {
    const idx = buildDetectionIndex([det(), det({ confidence_score: 0.5 }), det({ vehicle_type: 'person' as Detection['vehicle_type'] })]);
    expect(idx.size).toBe(1);
    expect(isDrawableDetection(det({ bbox: { x: 0, y: 0, width: 25, height: 25 } }))).toBe(true);
    expect(isDrawableDetection(det({ bbox: { x: 0, y: 0, width: 24.9, height: 25 } }))).toBe(false);
  });

  it('matches a brute-force linear scan at every playhead position', () => {
    const rows: Detection[] = [];
    for (let i = 0; i < 600; i++) {
      rows.push(det({
        tracked_vehicle_id: `trk_${i % 37}`,
        frame_timestamp_sec: Math.round(((i * 7919) % 2000) / 10) / 10, // 0..20s, unsorted
        confidence_score: 0.8 + ((i * 13) % 20) / 100,
      }));
    }
    const brute = (t: number) => {
      const best = new Map<string, { d: Detection; diff: number }>();
      for (const d of rows) {
        if (!isDrawableDetection(d)) continue;
        const diff = Math.abs((d.frame_timestamp_sec ?? 0) - t);
        if (diff > 0.2) continue;
        const k = String(d.tracked_vehicle_id);
        const e = best.get(k);
        if (!e || diff < e.diff) best.set(k, { d, diff });
      }
      return [...best.values()].map((v) => v.d).sort((a, b) => b.confidence_score - a.confidence_score).slice(0, 15);
    };
    const idx = buildDetectionIndex(rows);
    for (let t = -0.5; t <= 20.5; t += 0.033) {
      expect(selectActiveDetections(idx, t)).toEqual(brute(t));
    }
  });
});
