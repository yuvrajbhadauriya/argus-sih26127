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
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cameraCode && !cameraId) {
      setDetections([]);
      return;
    }
    if (!enabled) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchCameraDetections(cameraCode, cameraId, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setDetections(rows);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setDetections([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [cameraCode, cameraId, enabled]);

  return { detections, loading, error };
}
