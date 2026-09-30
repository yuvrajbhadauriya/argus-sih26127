// ═══════════════════════════════════════════════════
// useCameras Hook — single source of truth for camera data
// Both Camera Grid and Leaflet Map consume this hook.
//
// Results are kept in a small module-level cache (stale-while-revalidate) and
// concurrent requests are de-duplicated, so navigating Map ⇄ Cameras renders
// instantly instead of refetching and flashing a spinner every time.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import type { Camera } from '@/types/camera';
import { getCameras } from '@/features/cameras/api';

/** Cached data younger than this is used without a background refresh. */
export const CAMERAS_CACHE_TTL_MS = 60_000;

let cache: { data: Camera[]; at: number } | null = null;
let inflight: Promise<Camera[]> | null = null;

/** Fetch cameras, sharing one in-flight request between all callers. */
function loadCameras(force = false): Promise<Camera[]> {
  if (inflight && !force) return inflight;
  const p = getCameras()
    .then((data) => {
      cache = { data, at: Date.now() };
      return data;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Drop cached cameras (tests, or after an admin edit). */
export function clearCamerasCache(): void {
  cache = null;
  inflight = null;
}

/** Warm the cache ahead of navigation (e.g. on nav-link hover). Never throws. */
export function prefetchCameras(): void {
  if (cache && Date.now() - cache.at < CAMERAS_CACHE_TTL_MS) return;
  loadCameras().catch(() => {});
}

interface UseCamerasReturn {
  cameras: Camera[];
  loading: boolean;
  error: string | null;
  /** Manually re-fetch cameras (e.g. after a retry); bypasses the cache */
  refetch: () => Promise<void>;
}

/**
 * Fetches cameras from Supabase on mount and exposes loading / error states.
 * This must be the **only** place cameras are fetched — components should
 * never call `getCameras()` directly.
 */
export function useCameras(): UseCamerasReturn {
  const [cameras, setCameras] = useState<Camera[]>(() => cache?.data ?? []);
  const [loading, setLoading] = useState(() => !cache);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (force: boolean, isActive: () => boolean = () => true) => {
    try {
      const data = await loadCameras(force);
      if (isActive()) {
        setCameras(data);
        setError(null);
      }
    } catch (err) {
      if (isActive()) setError(err instanceof Error ? err.message : 'Failed to load cameras');
    } finally {
      if (isActive()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fresh cache → nothing to do. Stale cache → show it, refresh in background.
    if (cache && Date.now() - cache.at < CAMERAS_CACHE_TTL_MS) return;
    let active = true;
    run(false, () => active);
    return () => {
      active = false;
    };
  }, [run]);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return run(true);
  }, [run]);

  return { cameras, loading, error, refetch };
}
