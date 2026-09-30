// ═══════════════════════════════════════════════════════════════════════
// POST /api/detect — server-side proxy to the GPU ANPR model API.
//
// The browser sends one video frame here; this function adds the secret API
// key (DETECTION_API_KEY, server env only) and forwards it to
// DETECTION_API_URL, then returns a normalised response:
//
//   { engine, model_version, latency_ms, inference_ms?, image?,
//     detections: [{ plate_text, plate_confidence, vehicle_type, confidence,
//                    bbox: { x, y, width, height } }] }      // bbox in frame pixels
//
// Errors are JSON `{ error }` with status 400/405/413/415/502/503/504.
// The key and the upstream URL are never included in any response.
// Contract mapping lives in ./_lib/modelAdapter.ts (the ONE place to change).
// ═══════════════════════════════════════════════════════════════════════

import {
  buildUpstreamRequest,
  normaliseUpstreamResponse,
  readModelApiConfig,
  UpstreamShapeError,
  type NormalisedDetectResponse,
} from './_lib/modelAdapter.js';
import { errorResponse, HttpError, json, readFrameFromRequest } from './_lib/http.js';

type Env = Record<string, string | undefined>;

export interface DetectDeps {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function handleDetect(request: Request, deps: DetectDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'Method not allowed — use POST', { Allow: 'POST, OPTIONS' });
  }

  const cfg = readModelApiConfig(env);
  if (!cfg) {
    return errorResponse(503, 'Detection model API is not configured on the server (set DETECTION_API_URL and DETECTION_API_KEY)');
  }

  let frame;
  try {
    frame = await readFrameFromRequest(request);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    return errorResponse(400, 'Could not read the request body');
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let upstream: Response;
  try {
    upstream = await doFetch(cfg.url, { ...buildUpstreamRequest(cfg, frame), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
      return errorResponse(504, `Detection model API timed out after ${cfg.timeoutMs} ms`);
    }
    return errorResponse(502, 'Detection model API is unreachable');
  }

  let raw: unknown;
  try {
    if (!upstream.ok) {
      clearTimeout(timer);
      const hint = upstream.status === 401 || upstream.status === 403
        ? ' (API key rejected — check DETECTION_API_KEY / DETECTION_API_AUTH_HEADER)'
        : '';
      return errorResponse(502, `Detection model API returned HTTP ${upstream.status}${hint}`);
    }
    raw = await upstream.json();
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) return errorResponse(504, `Detection model API timed out after ${cfg.timeoutMs} ms`);
    return errorResponse(502, 'Detection model API returned a non-JSON response');
  }
  clearTimeout(timer);
  const latency = Math.round(now() - started);

  try {
    const image = frame.width && frame.height ? { width: frame.width, height: frame.height } : null;
    const normalised = normaliseUpstreamResponse(raw, image);
    const body: NormalisedDetectResponse = { ...normalised, latency_ms: latency, image };
    return json(body);
  } catch (err) {
    if (err instanceof UpstreamShapeError) return errorResponse(502, err.message);
    return errorResponse(502, 'Could not interpret the detection model API response');
  }
}

// Vercel Node.js runtime: Web-standard named method exports.
export const POST = (request: Request) => handleDetect(request);
export const GET = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
