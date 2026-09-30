// ═══════════════════════════════════════════════════
// Signed media URLs for the private Storage buckets.
//
// Camera clips / posters are addressed by their public-object URL
// (…/storage/v1/object/public/videos/mumbai/720p/<slug>.mp4, see
// cameras/api.ts clipUrls). The buckets are private, so before such a URL is
// handed to a <video> or <img> it is exchanged for a 1-hour signed URL from
// GET /api/media/sign (shared, batched, in-memory cache — the same one the
// /accuracy page uses). Any other URL (local dev copies, CDN overrides) passes
// through unchanged.
//
// Refresh: the cache treats a URL as stale 5 min before it expires; a 60 s
// tick re-requests it then, and the hook keeps returning the previous URL
// until the new one arrives, so the element never loses its src. The video
// player re-syncs to the live clock when the src changes (no restart at 0).
// ═══════════════════════════════════════════════════

import { useEffect, useMemo } from 'react';
import { SUPABASE_PUBLIC_OBJECT_BASE } from '@/config/constants';
import { signedUrlCache, useSignedUrls } from '@/features/golden-set/lib/signedUrls';

/** Buckets (and object prefixes) that /api/media/sign will sign. */
const SIGNABLE: Record<string, string> = { videos: 'mumbai/720p/' };
export const SIGNED_REFRESH_TICK_MS = 60_000;

export interface StorageRef {
  bucket: string;
  path: string;
}

/** Bucket + object path of a public-object URL in a signable bucket, else null. */
export function storageRef(url: string | null | undefined): StorageRef | null {
  if (!url || !url.startsWith(SUPABASE_PUBLIC_OBJECT_BASE)) return null;
  const rest = url.slice(SUPABASE_PUBLIC_OBJECT_BASE.length).split(/[?#]/)[0];
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  const prefix = SIGNABLE[bucket];
  return prefix && path.startsWith(prefix) ? { bucket, path } : null;
}

/**
 * The URL to put on the element: `url` itself when it needs no signing;
 * otherwise the signed URL (undefined while the first one loads, null when
 * signing failed). Keeps the previous signed URL during a refresh.
 */
export function useSignedMediaUrl(url: string | null | undefined): string | null | undefined {
  const ref = storageRef(url);
  const cache = signedUrlCache(ref?.bucket ?? 'videos');
  const paths = useMemo(() => (ref ? [ref.path] : []), [ref?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const lookup = useSignedUrls(cache, paths);

  // Re-request when the URL goes stale (the cache ignores fresh ones).
  useEffect(() => {
    if (!paths.length) return;
    const t = setInterval(() => cache.request(paths), SIGNED_REFRESH_TICK_MS);
    return () => clearInterval(t);
  }, [cache, paths]);

  if (!ref) return url;
  const current = lookup(ref.path);
  if (typeof current === 'string') return current;
  // Refreshing (or a refresh failed): keep the still-valid previous URL.
  return cache.latest(ref.path) ?? current;
}

/** Forget a signed URL that failed on the element so the next render re-signs it. */
export function invalidateSignedMedia(url: string | null | undefined): boolean {
  const ref = storageRef(url);
  if (!ref) return false;
  signedUrlCache(ref.bucket).invalidate(ref.path);
  return true;
}
