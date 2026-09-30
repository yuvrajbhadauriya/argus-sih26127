// ═══════════════════════════════════════════════════
// dataApi — the browser's only path to the (private) database.
//
// The anon key can't read any table (supabase/migrations/
// 20261001000700_private_database.sql). Every live read and write goes to the
// same-origin serverless routes /api/data/<route> (api/_lib/dataRoutes.ts),
// which query Supabase with the service-role key on the server.
//
//   apiGet('alerts')                         → { rows } / { row } body
//   apiSend('alerts/acknowledge', 'POST', …) → adds the signed-in operator's
//                                              Supabase access token
//
// The Supabase JS client in the browser is only used for Auth (lazily), and
// only to read that access token for writes.
// ═══════════════════════════════════════════════════

import { getAccessToken } from '@/lib/supabase/client';

export const DATA_API_BASE = '/api/data/';

/** A /api/data request failed; `status` is the HTTP status (0 = network). */
export class DataApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DataApiError';
    this.status = status;
  }
}

type Params = Record<string, string | number | undefined | null>;

function buildUrl(route: string, params?: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  return `${DATA_API_BASE}${route}${q ? `?${q}` : ''}`;
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new DataApiError(res.status, msg);
  }
  return body as T;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new DataApiError(0, 'Data API is unreachable');
  }
}

/** Identical public GETs in flight at the same time share one request. */
const inFlight = new Map<string, Promise<unknown>>();

/** GET /api/data/<route>?<params>. */
export async function apiGet<T>(route: string, params?: Params, opts: { signal?: AbortSignal; auth?: boolean } = {}): Promise<T> {
  const url = buildUrl(route, params);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (opts.signal || opts.auth) return parse<T>(await send(url, { headers, signal: opts.signal }));
  let p = inFlight.get(url) as Promise<T> | undefined;
  if (!p) {
    p = send(url, { headers }).then((res) => parse<T>(res));
    inFlight.set(url, p);
    const done = () => inFlight.delete(url);
    p.then(done, done);
  }
  return p;
}

/** GET a list route: the `rows` array (never null). */
export async function apiRows<T = Record<string, unknown>>(route: string, params?: Params, opts?: { signal?: AbortSignal; auth?: boolean }): Promise<T[]> {
  const body = await apiGet<{ rows?: T[] }>(route, params, opts);
  return Array.isArray(body?.rows) ? body.rows : [];
}

/** GET a single-row route: the `row` (null when missing). */
export async function apiRow<T = Record<string, unknown>>(route: string, params?: Params, opts?: { signal?: AbortSignal }): Promise<T | null> {
  const body = await apiGet<{ row?: T | null }>(route, params, opts);
  return body?.row ?? null;
}

/** POST/PATCH /api/data/<route> as the signed-in operator. */
export async function apiSend<T = { row?: Record<string, unknown> }>(
  route: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  params?: Params,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new DataApiError(401, 'Sign in as an operator to do this');
  return parse<T>(
    await send(buildUrl(route, params), {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}
