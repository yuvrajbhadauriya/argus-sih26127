// ═══════════════════════════════════════════════════════════════════════
// GET /api/health — is the detection model API configured and reachable?
// Never returns the key or the upstream URL.
//
// Probe target: DETECTION_API_HEALTH_URL if set, otherwise `<origin>/health`
// of DETECTION_API_URL (the LPU server's GET /health needs no key, so none is
// sent). Any HTTP response counts as "reachable"; `model_ok` is true only for
// a 2xx whose body does not say ok:false / model_loaded:false. engine,
// model_version, model_loaded and gpu_busy are passed through when reported.
//
// Without DETECTION_API_* but with Supabase (the hosted site), `via: "queue"`:
// healthy means the worker on the GPU box has checked in within 30 s.
// ═══════════════════════════════════════════════════════════════════════

import { buildHealthUrl, readModelApiConfig } from './_lib/modelAdapter.js';
import { errorResponse, json } from './_lib/http.js';
import { QueueError, readWorkerStatus } from './_lib/detectQueue.js';
import { readAdminConfig, SupabaseAdmin } from './_lib/supabaseAdmin.js';

type Env = Record<string, string | undefined>;
const PROBE_TIMEOUT_MS = 5000;

export interface HealthBody {
  ok: boolean;
  configured: boolean;
  reachable: boolean | null;
  model_ok: boolean | null;
  upstream_status: number | null;
  latency_ms: number | null;
  engine?: string | null;
  model_version?: string | null;
  model_loaded?: boolean | null;
  gpu_busy?: boolean | null;
  /** 'queue' when the check is about the GPU worker behind the Supabase queue. */
  via?: 'queue';
  worker_version?: string | null;
  worker_seen_seconds_ago?: number | null;
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
    const adminCfg = readAdminConfig(env);
    if (adminCfg) return queueHealth(new SupabaseAdmin(adminCfg, doFetch));
    const body: HealthBody = {
      ok: false, configured: false, reachable: null, model_ok: null, upstream_status: null, latency_ms: null,
      error: 'Model API not configured here (DETECTION_API_URL / DETECTION_API_KEY unset) — it is LAN/VPN-only',
    };
    return json(body, 503);
  }

  const probeUrl = buildHealthUrl(cfg, env);
  const started = performance.now();
  try {
    const res = await doFetch(probeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let info: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
    } catch {
      info = {};
    }
    const modelOk = res.ok && info.ok !== false && info.model_loaded !== false;
    const body: HealthBody = {
      ok: modelOk, configured: true, reachable: true, model_ok: modelOk, upstream_status: res.status,
      latency_ms: Math.round(performance.now() - started),
      engine: typeof info.engine === 'string' ? info.engine : null,
      model_version: typeof info.model_version === 'string' ? info.model_version : null,
      model_loaded: typeof info.model_loaded === 'boolean' ? info.model_loaded : null,
      gpu_busy: typeof info.gpu_busy === 'boolean' ? info.gpu_busy : null,
    };
    return json(body, modelOk ? 200 : 502);
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const body: HealthBody = {
      ok: false, configured: true, reachable: false, model_ok: null, upstream_status: null, latency_ms: null,
      error: timedOut ? `Model API did not answer within ${PROBE_TIMEOUT_MS} ms` : 'Model API is unreachable',
    };
    return json(body, timedOut ? 504 : 502);
  }
}

/** Hosted site: is the GPU worker behind the queue alive? */
async function queueHealth(admin: SupabaseAdmin): Promise<Response> {
  const started = performance.now();
  try {
    const w = await readWorkerStatus(admin);
    const body: HealthBody = {
      ok: w.online, configured: true, reachable: w.online, model_ok: w.online, upstream_status: null,
      latency_ms: Math.round(performance.now() - started),
      via: 'queue', worker_version: w.version, worker_seen_seconds_ago: w.seenSecondsAgo,
      ...(w.online ? {} : { error: 'The GPU worker has not checked in for 30 s' }),
    };
    return json(body, w.online ? 200 : 503);
  } catch (err) {
    const body: HealthBody = {
      ok: false, configured: true, reachable: null, model_ok: null, upstream_status: null, latency_ms: null, via: 'queue',
      error: err instanceof QueueError ? err.message : 'The detection queue is unreachable.',
    };
    return json(body, err instanceof QueueError && err.status === 503 ? 503 : 502);
  }
}

export const GET = (request: Request) => handleHealth(request);
export const HEAD = GET;
export const POST = GET;
