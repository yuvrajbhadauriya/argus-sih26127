// ═══════════════════════════════════════════════════════════════════════
// GET /api/health — is the detection model API configured and reachable?
// Never returns the key or the upstream URL.
//
// Probe target: DETECTION_API_HEALTH_URL if set, otherwise `<origin>/health`
// of DETECTION_API_URL. Any HTTP response counts as "reachable"; `model_ok`
// is true only for a 2xx.
// ═══════════════════════════════════════════════════════════════════════

import { buildAuthHeaders, readModelApiConfig } from './_lib/modelAdapter.js';
import { errorResponse, json } from './_lib/http.js';

type Env = Record<string, string | undefined>;
const PROBE_TIMEOUT_MS = 5000;

export interface HealthBody {
  ok: boolean;
  configured: boolean;
  reachable: boolean | null;
  model_ok: boolean | null;
  upstream_status: number | null;
  latency_ms: number | null;
  error?: string;
}

export async function handleHealth(
  request: Request,
  deps: { env?: Env; fetch?: typeof fetch } = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed — use GET', { Allow: 'GET, HEAD' });
  }
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const cfg = readModelApiConfig(env);
  if (!cfg) {
    const body: HealthBody = {
      ok: false, configured: false, reachable: null, model_ok: null, upstream_status: null, latency_ms: null,
      error: 'DETECTION_API_URL / DETECTION_API_KEY not set',
    };
    return json(body, 503);
  }

  const probeUrl = env.DETECTION_API_HEALTH_URL?.trim() || new URL('/health', cfg.url).toString();
  const started = performance.now();
  try {
    const res = await doFetch(probeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', ...buildAuthHeaders(cfg) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body: HealthBody = {
      ok: res.ok, configured: true, reachable: true, model_ok: res.ok, upstream_status: res.status,
      latency_ms: Math.round(performance.now() - started),
    };
    return json(body, res.ok ? 200 : 502);
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const body: HealthBody = {
      ok: false, configured: true, reachable: false, model_ok: null, upstream_status: null, latency_ms: null,
      error: timedOut ? `Model API did not answer within ${PROBE_TIMEOUT_MS} ms` : 'Model API is unreachable',
    };
    return json(body, timedOut ? 504 : 502);
  }
}

export const GET = (request: Request) => handleHealth(request);
export const HEAD = GET;
export const POST = GET;
