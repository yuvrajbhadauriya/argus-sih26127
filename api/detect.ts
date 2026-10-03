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
// The model API is LAN/Tailscale-only, so there are two ways in:
//   - DIRECT (DETECTION_API_URL + DETECTION_API_KEY set, i.e. `npm run dev` on the
//     team network via the dev bridge in api/_lib/viteDevBridge.ts): the frame is
//     forwarded to the model API.
//   - QUEUED (no DETECTION_API_* but SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, i.e.
//     Vercel): the frame goes through the private detect_jobs table to the worker
//     on the GPU box, which dials out to Supabase (api/_lib/detectQueue.ts).
// With neither, this answers 503 and the Live-detect panel falls back to the
// recorded reads.
// Errors are JSON `{ error }` with status 400/405/413/415/429/502/503/504.
// The key and the upstream URL are never included in any response.
// Contract mapping lives in ./_lib/modelAdapter.ts (the ONE place to change).
// ═══════════════════════════════════════════════════════════════════════

import {
  buildUpstreamRequest,
  buildUpstreamUrl,
  normaliseUpstreamResponse,
  parseTiles,
  readFrameQuery,
  readModelApiConfig,
  UpstreamShapeError,
  type FrameInput,
  type NormalisedDetectResponse,
} from './_lib/modelAdapter.js';
import { errorResponse, HttpError, json, readFrameFromRequest } from './_lib/http.js';
import { detectViaQueue, MAX_QUEUE_IMAGE_BYTES, QueueError, type QueueDeps } from './_lib/detectQueue.js';
import { clientIp, createRateLimiter, type RateLimiter } from './_lib/rateLimit.js';
import { readAdminConfig, SupabaseAdmin, type AdminConfig } from './_lib/supabaseAdmin.js';

type Env = Record<string, string | undefined>;

export interface DetectDeps {
  env?: Env;
  /** Direct mode: the model API call. Queued mode: the Supabase calls. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Queued mode only: per-IP limit and timing (injected by tests). */
  limiter?: RateLimiter;
  queue?: QueueDeps;
}

/** ~1 frame/s per viewer: 60 per 10 s leaves room for several viewers behind one address. */
const queueLimiter = createRateLimiter({ windowMs: 10_000, max: 60 });

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
    const admin = readAdminConfig(env);
    if (admin) return handleQueuedDetect(request, admin, env, deps, now);
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

/** Hosted site: the frame goes through the Supabase queue to the worker on the GPU box. */
async function handleQueuedDetect(
  request: Request,
  adminCfg: AdminConfig,
  env: Env,
  deps: DetectDeps,
  now: () => number,
): Promise<Response> {
  if ((deps.limiter ?? queueLimiter).hit(clientIp(request))) {
    return errorResponse(429, 'Too many frames from this address — slow down.', { 'Retry-After': '5' });
  }

  let frame: FrameInput;
  try {
    frame = await readFrameFromRequest(request);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    return errorResponse(400, 'Could not read the request body');
  }
  if (frame.mimeType !== 'image/jpeg') return errorResponse(415, 'Live detection takes JPEG frames.');
  if (frame.bytes.length > MAX_QUEUE_IMAGE_BYTES) {
    return errorResponse(413, `Frame too large for live detection (max ${MAX_QUEUE_IMAGE_BYTES / (1024 * 1024)} MB)`);
  }

  const query = readFrameQuery(env);
  const started = now();
  let raw: unknown;
  try {
    raw = await detectViaQueue(new SupabaseAdmin(adminCfg, deps.fetch), frame, query, deps.queue);
  } catch (err) {
    if (err instanceof QueueError) {
      return errorResponse(err.status, err.message, err.retryAfterS ? { 'Retry-After': String(err.retryAfterS) } : {});
    }
    return errorResponse(502, 'The detection queue failed.');
  }
  const latency = Math.round(now() - started);

  try {
    const image = frame.width && frame.height ? { width: frame.width, height: frame.height } : null;
    const normalised = normaliseUpstreamResponse(raw, image, parseTiles(query));
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
