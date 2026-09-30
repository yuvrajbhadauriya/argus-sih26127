// ═══════════════════════════════════════════════════
// useCameraDetections Hook
// Loads pipeline detection data for a camera (see ../api.ts for sources)
// The request is aborted when the camera changes or the component unmounts,
// and can be deferred with `enabled: false` until a player actually needs it.
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import type { Detection } from '@/types';
import { fetchCameraDetections } from '../api';

interface UseCameraDetectionsOptions {
  /** When false, nothing is fetched (e.g. the player is off-screen). Default true. */
  enabled?: boolean;
}

export function useCameraDetections(
  cameraCode?: string,
  cameraId?: string,
  { enabled = true }: UseCameraDetectionsOptions = {},
) {
  // Results are stored with the request they answer; loading / "no camera"
  // are derived during render, so the effect never sets state synchronously.
  const key = cameraCode || cameraId ? `${cameraCode ?? ''}|${cameraId ?? ''}` : null;
  const [result, setResult] = useState<{ key: string; detections: Detection[]; error: string | null } | null>(null);

  useEffect(() => {
    if (!key || !enabled) return;
    const controller = new AbortController();
    fetchCameraDetections(cameraCode, cameraId, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setResult({ key, detections: rows, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setResult({ key, detections: [], error: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [key, cameraCode, cameraId, enabled]);

  const current = key && result?.key === key ? result : null;
  return {
    detections: current?.detections ?? EMPTY,
    loading: key != null && enabled && current == null,
    error: current?.error ?? null,
  };
}

const EMPTY: Detection[] = [];
