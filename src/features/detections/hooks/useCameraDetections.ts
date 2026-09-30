// ═══════════════════════════════════════════════════
// useCameraDetections Hook
// Loads pipeline detection data for a camera (see ../api.ts for sources)
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import type { Detection } from '@/types';
import { fetchCameraDetections } from '../api';

export function useCameraDetections(cameraCode?: string, cameraId?: string) {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cameraCode && !cameraId) {
      setDetections([]);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    fetchCameraDetections(cameraCode, cameraId)
      .then((rows) => {
        if (isMounted) setDetections(rows);
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setDetections([]);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [cameraCode, cameraId]);

  return { detections, loading, error };
}
