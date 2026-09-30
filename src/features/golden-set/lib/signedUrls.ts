// ═══════════════════════════════════════════════════
// Signed URLs for objects in the private Storage buckets, via
// GET /api/media/sign (api/media/sign.ts). Requests made in the same tick
// are batched (≤ 60 paths per call), URLs are cached in memory until
// REFRESH_MARGIN_MS before they expire, and failures are remembered briefly
// so the UI can show a neutral placeholder instead of retrying in a loop.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useSyncExternalStore } from 'react';

export const SIGN_ENDPOINT = '/api/media/sign';
export const MAX_PATHS_PER_CALL = 60;
export const REFRESH_MARGIN_MS = 5 * 60_000;
export const FAILURE_RETRY_MS = 30_000;

type Entry = { url: string; expiresAt: number } | { failedAt: number };

export class SignedUrlCache {
  private entries = new Map<string, Entry>();
  private inFlight = new Set<string>();
  private queue = new Set<string>();
  private scheduled = false;
  private listeners = new Set<() => void>();
  private version = 0;
  readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly endpoint: string;

  constructor(bucket: string, opts: { fetch?: typeof fetch; now?: () => number; endpoint?: string } = {}) {
    this.bucket = bucket;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
    this.endpoint = opts.endpoint ?? SIGN_ENDPOINT;
  }

  /** Fresh URL → string; recent failure → null; unknown / loading / stale → undefined. */
  peek(path: string): string | null | undefined {
    const e = this.entries.get(path);
    if (!e) return undefined;
    const now = this.now();
    if ('url' in e) return e.expiresAt - REFRESH_MARGIN_MS > now ? e.url : undefined;
    return now - e.failedAt < FAILURE_RETRY_MS ? null : undefined;
  }

  /** Queue paths that need a (new) URL; resolved in batches on the next microtask. */
  request(paths: string[]): void {
    let added = false;
    for (const p of paths) {
      if (!p || this.inFlight.has(p) || this.peek(p) !== undefined) continue;
      this.queue.add(p);
      added = true;
    }
    if (added && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  /** Sends everything queued; resolves when all batches have settled. */
  async flush(): Promise<void> {
    this.scheduled = false;
    const paths = [...this.queue];
    this.queue.clear();
    if (!paths.length) return;
    for (const p of paths) this.inFlight.add(p);
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += MAX_PATHS_PER_CALL) batches.push(paths.slice(i, i + MAX_PATHS_PER_CALL));
    await Promise.all(batches.map((b) => this.load(b)));
  }

  private async load(paths: string[]): Promise<void> {
    const qs = new URLSearchParams({ bucket: this.bucket, paths: paths.join(',') });
    let urls: Record<string, unknown> = {};
    let expiresIn = 0;
    try {
      const res = await this.fetchImpl(`${this.endpoint}?${qs.toString()}`);
      if (res.ok) {
        const body = (await res.json()) as { urls?: Record<string, unknown>; expires_in?: unknown };
        urls = body && typeof body.urls === 'object' && body.urls ? body.urls : {};
        expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 0;
      }
    } catch {
      urls = {};
    }
    const now = this.now();
    for (const p of paths) {
      this.inFlight.delete(p);
      const u = urls[p];
      this.entries.set(p, typeof u === 'string' && expiresIn > 0 ? { url: u, expiresAt: now + expiresIn * 1000 } : { failedAt: now });
    }
    this.version++;
    for (const l of this.listeners) l();
  }

  /**
   * The URL failed to load (e.g. expired or missing object): show the
   * placeholder now and re-sign after FAILURE_RETRY_MS — never in a tight loop.
   */
  markBroken(path: string): void {
    const e = this.entries.get(path);
    if (!e || !('url' in e)) return;
    this.entries.set(path, { failedAt: this.now() });
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = (): number => this.version;
}

const caches = new Map<string, SignedUrlCache>();

/** Shared per-bucket cache for the app. */
export function signedUrlCache(bucket: string): SignedUrlCache {
  let c = caches.get(bucket);
  if (!c) caches.set(bucket, (c = new SignedUrlCache(bucket)));
  return c;
}

/**
 * Signed URLs for `paths` (requested in one batch); re-renders when they arrive.
 * Returns a lookup: string = URL, null = unavailable, undefined = loading.
 */
export function useSignedUrls(cache: SignedUrlCache, paths: string[]): (path: string) => string | null | undefined {
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);
  const key = paths.join('|');
  useEffect(() => {
    cache.request(key ? key.split('|') : []);
  }, [cache, key, version]);
  // A new lookup per cache version, so memoised consumers re-render when URLs arrive.
  return useMemo(() => {
    const v = version;
    return (p: string) => (v >= 0 ? cache.peek(p) : undefined);
  }, [cache, version]);
}
