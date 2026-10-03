// ═══════════════════════════════════════════════════════════════════════
// GET /api/media/sign?bucket=<bucket>&paths=<p1>,<p2>… — short-lived signed
// URLs for objects in the PRIVATE Supabase Storage buckets, so the public
// dashboard can show media without the buckets being public.
//
// - Only allowlisted bucket/prefix pairs are signed (anything else → 400).
// - At most MAX_PATHS paths per call (comma-separated and/or repeated `paths`).
// - 1-hour URLs via Storage's batch sign endpoint (what supabase-js
//   `createSignedUrls` calls). The service-role key is read from
//   process.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — server-only) and is
//   never returned.
// - Simple in-memory per-IP rate limit (per warm instance).
// ═══════════════════════════════════════════════════════════════════════

import { errorResponse, json } from '../_lib/http.js';

type Env = Record<string, string | undefined>;

export const EXPIRES_IN = 3600;
export const MAX_PATHS = 60;
export const RATE_LIMIT = { windowMs: 60_000, max: 120 };

/** bucket → allowed object-path prefixes (videos: the 720p wall renditions and the 1080p HD ones). */
export const ALLOWLIST: Record<string, string[]> = {
  golden: ['ocr_golden_v1/'],
  videos: ['mumbai/720p/', 'mumbai/1080p/'],
};

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export interface SignBody {
  urls: Record<string, string>;
  expires_in: number;
}

/** Validates bucket + paths; returns an error message or the de-duplicated paths. */
export function validateSignRequest(bucket: string | null, rawPaths: string[]): { error: string } | { bucket: string; paths: string[] } {
  if (!bucket || !Object.hasOwn(ALLOWLIST, bucket)) return { error: 'bucket not allowed' };
  const prefixes = ALLOWLIST[bucket];
  const paths = [...new Set(rawPaths.flatMap((p) => p.split(',')).map((p) => p.trim()).filter(Boolean))];
  if (!paths.length) return { error: 'paths is required' };
  if (paths.length > MAX_PATHS) return { error: `too many paths (max ${MAX_PATHS})` };
  for (const p of paths) {
    if (!prefixes.some((prefix) => p.startsWith(prefix) && p.length > prefix.length) || !SAFE_PATH.test(p) || p.includes('..') || p.includes('//')) {
      return { error: 'path not allowed' };
    }
  }
  return { bucket, paths };
}

// ── rate limit ──────────────────────────────────────
const hits = new Map<string, { start: number; count: number }>();

export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0] : request.headers.get('x-real-ip') || 'unknown').trim();
}

/** True when this IP is over the limit for the current window. */
export function rateLimited(ip: string, now = Date.now()): boolean {
  const h = hits.get(ip);
  if (!h || now - h.start >= RATE_LIMIT.windowMs) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now - v.start >= RATE_LIMIT.windowMs) hits.delete(k);
    }
    return false;
  }
  h.count += 1;
  return h.count > RATE_LIMIT.max;
}

export function resetRateLimit(): void {
  hits.clear();
}

// ── handler ─────────────────────────────────────────
export async function handleSign(request: Request, deps: { env?: Env; fetch?: typeof fetch; now?: number } = {}): Promise<Response> {
  if (request.method !== 'GET') return errorResponse(405, 'Method not allowed — use GET', { Allow: 'GET' });
  if (rateLimited(clientIp(request), deps.now)) return errorResponse(429, 'Too many requests', { 'Retry-After': '60' });

  const url = new URL(request.url);
  const v = validateSignRequest(url.searchParams.get('bucket'), url.searchParams.getAll('paths'));
  if ('error' in v) return errorResponse(400, v.error);

  const env = deps.env ?? process.env;
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return errorResponse(503, 'Media signing is not configured');

  const doFetch = deps.fetch ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(`${base}/storage/v1/object/sign/${encodeURIComponent(v.bucket)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: EXPIRES_IN, paths: v.paths }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return errorResponse(502, 'Storage is unreachable');
  }
  if (!upstream.ok) return errorResponse(502, `Storage refused to sign (HTTP ${upstream.status})`);

  let rows: unknown;
  try {
    rows = await upstream.json();
  } catch {
    return errorResponse(502, 'Storage returned an invalid answer');
  }
  const urls: Record<string, string> = {};
  if (Array.isArray(rows)) {
    for (const r of rows as { path?: unknown; signedURL?: unknown; signedUrl?: unknown; error?: unknown }[]) {
      const signed = typeof r.signedURL === 'string' ? r.signedURL : typeof r.signedUrl === 'string' ? r.signedUrl : null;
      if (typeof r.path !== 'string' || !signed || r.error) continue;
      if (!v.paths.includes(r.path)) continue;
      urls[r.path] = signed.startsWith('http') ? signed : `${base}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    }
  }
  const body: SignBody = { urls, expires_in: EXPIRES_IN };
  return json(body, 200, { 'Cache-Control': 'private, max-age=300' });
}

export const GET = (request: Request) => handleSign(request);
