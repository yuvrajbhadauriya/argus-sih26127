// ═══════════════════════════════════════════════════
// Remote detection client
// Captures the current frame of a <video> to JPEG and sends it to the
// same-origin serverless proxy (/api/detect). The model API key lives only on
// the server — this module never sees it.
// ═══════════════════════════════════════════════════

import type { VehicleType } from '@/types';

export const DETECT_ENDPOINT = '/api/detect';

/** Mirrors NormalisedDetection in api/_lib/modelAdapter.ts. */
export interface RemoteDetection {
  plate_text: string | null;
  plate_confidence: number | null;
  vehicle_type: VehicleType;
  confidence: number;
  /** Top-left + size in pixels of the submitted frame. */
  bbox: { x: number; y: number; width: number; height: number };
}

/** Mirrors NormalisedDetectResponse in api/_lib/modelAdapter.ts. */
export interface RemoteDetectResponse {
  engine: string;
  model_version: string;
  latency_ms: number;
  inference_ms?: number | null;
  image?: { width: number; height: number } | null;
  detections: RemoteDetection[];
}

export type DetectFrameErrorCode = 'not_ready' | 'tainted' | 'encode' | 'network' | 'http' | 'bad_response' | 'aborted';

export class DetectFrameError extends Error {
  readonly code: DetectFrameErrorCode;
  readonly status?: number;
  constructor(code: DetectFrameErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DetectFrameError';
    this.code = code;
    this.status = status;
  }
}

export interface CapturedFrame {
  /** Data URL (image/jpeg) — handy for showing a still of what was analysed. */
  dataUrl: string;
  width: number;
  height: number;
  timestampSec: number;
}

export interface CaptureOptions {
  /** Downscale wider frames to this width (keeps the upload well under 4 MB). Default 1280. */
  maxWidth?: number;
  /** JPEG quality 0..1. Default 0.85. */
  quality?: number;
}

/** Draws the current video frame onto a canvas and encodes it as JPEG. */
export function captureVideoFrame(video: HTMLVideoElement, options: CaptureOptions = {}): CapturedFrame {
  const { maxWidth = 1280, quality = 0.85 } = options;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) {
    throw new DetectFrameError('not_ready', 'Video frame is not ready yet — wait for playback to start.');
  }
  const scale = vw > maxWidth ? maxWidth / vw : 1;
  const width = Math.round(vw * scale);
  const height = Math.round(vh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new DetectFrameError('encode', 'Canvas 2D context is unavailable in this browser.');
  ctx.drawImage(video, 0, 0, width, height);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new DetectFrameError(
        'tainted',
        'Cannot read pixels from this video: it is served from another origin without CORS headers. ' +
          'Serve it with Access-Control-Allow-Origin and keep crossOrigin="anonymous" on the <video>.',
      );
    }
    throw new DetectFrameError('encode', 'Could not encode the video frame as JPEG.');
  }
  if (!dataUrl.startsWith('data:image/jpeg')) {
    throw new DetectFrameError('encode', 'This browser could not encode the frame as JPEG.');
  }
  return { dataUrl, width, height, timestampSec: Math.round(video.currentTime * 1000) / 1000 };
}

export interface DetectFrameOptions extends CaptureOptions {
  cameraCode?: string;
  signal?: AbortSignal;
  endpoint?: string;
}

/** Sends an already-captured frame to /api/detect. */
export async function detectCapturedFrame(
  frame: CapturedFrame,
  { cameraCode, signal, endpoint = DETECT_ENDPOINT }: Omit<DetectFrameOptions, keyof CaptureOptions> = {},
): Promise<RemoteDetectResponse> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        image_base64: frame.dataUrl.slice(frame.dataUrl.indexOf(',') + 1),
        camera_code: cameraCode,
        frame_timestamp_sec: frame.timestampSec,
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new DetectFrameError('aborted', 'Detection request was cancelled.');
    }
    throw new DetectFrameError('network', 'Could not reach the detection service — check your connection.');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = null;
  if (isJson) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body.error === 'string' && body.error) ||
      (res.status === 404
        ? 'Detection endpoint /api/detect not found — run the app with `vercel dev` (plain `vite` has no API routes).'
        : `Detection service returned HTTP ${res.status}.`);
    throw new DetectFrameError('http', message, res.status);
  }
  if (!body || !Array.isArray(body.detections)) {
    throw new DetectFrameError(
      'bad_response',
      'Detection service returned an unexpected response — is /api/detect deployed (use `vercel dev` locally)?',
      res.status,
    );
  }
  return body as RemoteDetectResponse;
}

/** Captures the current frame of `video` and runs remote detection on it. */
export async function detectVideoFrame(
  video: HTMLVideoElement,
  options: DetectFrameOptions = {},
): Promise<{ frame: CapturedFrame; result: RemoteDetectResponse }> {
  const frame = captureVideoFrame(video, options);
  const result = await detectCapturedFrame(frame, options);
  return { frame, result };
}
