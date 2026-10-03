import { describe, expect, it, vi } from 'vitest';
import { captureVideoFrame, captureVideoFrameWithCanvas, detectCapturedFrame, DetectFrameError } from './detectFrame';

function fakeVideo(opts: { width?: number; height?: number; readyState?: number; currentTime?: number } = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { value: opts.width ?? 1920 });
  Object.defineProperty(video, 'videoHeight', { value: opts.height ?? 1080 });
  Object.defineProperty(video, 'readyState', { value: opts.readyState ?? 4 });
  Object.defineProperty(video, 'currentTime', { value: opts.currentTime ?? 2.5, writable: true });
  return video;
}

function stubCanvas(toDataURL: () => string) {
  const ctx = {
    drawImage: vi.fn(), clearRect: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL);
  return ctx;
}

const RESULT = {
  engine: 'yolov7-tiny-anpr',
  model_version: '1.0',
  latency_ms: 87,
  detections: [{ plate_text: 'MH 01 AB 1234', plate_confidence: 0.987, vehicle_type: 'car', confidence: 0.9, bbox: { x: 1, y: 2, width: 3, height: 4 } }],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('captureVideoFrame', () => {
  it('downscales to maxWidth and encodes JPEG', () => {
    const ctx = stubCanvas(() => 'data:image/jpeg;base64,AAAA');
    const frame = captureVideoFrame(fakeVideo(), { maxWidth: 1280 });
    expect(frame).toEqual({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, timestampSec: 2.5 });
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('can also hand back the canvas of the frame that was encoded (for plate crops)', () => {
    stubCanvas(() => 'data:image/jpeg;base64,AAAA');
    const frame = captureVideoFrameWithCanvas(fakeVideo(), { maxWidth: 1280 });
    expect(frame.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect([frame.canvas.width, frame.canvas.height]).toEqual([1280, 720]);
    expect(frame).toMatchObject({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, timestampSec: 2.5 });
    // the plain capture stays canvas-free
    expect(captureVideoFrame(fakeVideo())).not.toHaveProperty('canvas');
  });

  it('rejects videos that are not ready', () => {
    stubCanvas(() => 'data:image/jpeg;base64,AAAA');
    expect(() => captureVideoFrame(fakeVideo({ readyState: 1 }))).toThrow(DetectFrameError);
  });

  it('explains tainted (cross-origin) canvases', () => {
    stubCanvas(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    try {
      captureVideoFrame(fakeVideo());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DetectFrameError);
      expect((err as DetectFrameError).code).toBe('tainted');
      expect((err as Error).message).toMatch(/CORS/);
    }
  });
});

describe('detectCapturedFrame', () => {
  const frame = { dataUrl: 'data:image/jpeg;base64,QUJD', width: 640, height: 360, timestampSec: 1 };

  it('POSTs base64 JSON to the relative /api/detect endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESULT));
    const out = await detectCapturedFrame(frame, { cameraCode: 'JG-01' });
    expect(out.detections[0].plate_text).toBe('MH 01 AB 1234');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/detect');
    expect(JSON.parse(init!.body as string)).toEqual({ image_base64: 'QUJD', camera_code: 'JG-01', frame_timestamp_sec: 1 });
  });

  it('surfaces server error messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'Detection model API timed out after 15000 ms' }, 504));
    await expect(detectCapturedFrame(frame)).rejects.toMatchObject({ code: 'http', status: 504, message: expect.stringMatching(/timed out/) });
  });

  it('hints at vercel dev when the route is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(detectCapturedFrame(frame)).rejects.toThrow(/vercel dev/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(detectCapturedFrame(frame)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('maps network failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(detectCapturedFrame(frame)).rejects.toMatchObject({ code: 'network' });
  });
});
