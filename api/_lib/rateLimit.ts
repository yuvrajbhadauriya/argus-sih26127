// ═══════════════════════════════════════════════════════════════════════
// Basic fixed-window, per-IP rate limiter for the /api functions.
//
// State lives in the memory of one warm serverless instance, so this is a
// speed bump against a single client hammering the API (and, through it, the
// database), not a distributed quota. Responses served from the Vercel CDN
// cache (s-maxage) never reach the function and are not counted.
// ═══════════════════════════════════════════════════════════════════════

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  /** Counts one hit for `key`; true when the key is over the limit in this window. */
  hit(key: string, now?: number): boolean;
  reset(): void;
}

const MAX_KEYS = 10_000;

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const hits = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now = Date.now()) {
      const h = hits.get(key);
      if (!h || now - h.start >= opts.windowMs) {
        hits.set(key, { start: now, count: 1 });
        if (hits.size > MAX_KEYS) {
          for (const [k, v] of hits) if (now - v.start >= opts.windowMs) hits.delete(k);
        }
        return false;
      }
      h.count += 1;
      return h.count > opts.max;
    },
    reset() {
      hits.clear();
    },
  };
}

/** Client IP as seen by Vercel's edge (first X-Forwarded-For hop). */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0] : request.headers.get('x-real-ip') || 'unknown').trim() || 'unknown';
}
