// ═══════════════════════════════════════════════════════════════════════
// POST /api/detect — server-side proxy to the GPU ANPR model API.
//
// The browser sends one video frame here; this function adds the secret API
// key (DETECTION_API_KEY, server env only, sent as X-API-Key) and forwards the
// raw JPEG to DETECTION_API_URL (the LPU model's /v1/frame) with the query in
// DETECTION_API_QUERY (default tiles=2x3&roi_top=0.33&min_conf=60), then
// returns a normalised response:
//
//   { engine, model_version, latency_ms, inference_ms?, image?,
//     detections: [{ plate_text, plate_confidence (0..1), vehicle_type, confidence,
//                    bbox: { x, y, width, height },          // frame pixels
//                    vehicle_class, grammar_valid, raw_ocr, plate_bbox, bbox_source }] }
//
// The model API is LAN/Tailscale-only: on Vercel (no DETECTION_API_* env) this
// answers 503 and the Live-detect panel says so. Locally, `npm run dev` mounts
// this handler through the dev bridge in api/_lib/viteDevBridge.ts.
// Errors are JSON `{ error }` with status 400/405/413/415/502/503/504.
// The key and the upstream URL are never included in any response.
// Contract mapping lives in ./_lib/modelAdapter.ts (the ONE place to change).
// ═══════════════════════════════════════════════════════════════════════

import {
  buildUpstreamRequest,
  buildUpstreamUrl,
  normaliseUpstreamResponse,
  parseTiles,
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
    return errorResponse(
      503,
      'Detection model API is not configured on this server — the ANPR model API is LAN/VPN-only ' +
        '(run the dashboard locally on the team network, or set DETECTION_API_URL and DETECTION_API_KEY).',
    );
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
    upstream = await doFetch(buildUpstreamUrl(cfg), { ...buildUpstreamRequest(cfg, frame), signal: controller.signal });
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
    const normalised = normaliseUpstreamResponse(raw, image, parseTiles(cfg.query));
    const body: NormalisedDetectResponse = { ...normalised, image: normalised.image ?? image, latency_ms: latency };
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
