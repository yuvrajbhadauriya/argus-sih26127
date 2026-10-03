// Loads the camera-feed reads and the human verification file together.

import { useEffect, useState } from 'react';
import { loadCameraReads, type CameraReadsState } from './cameraReads';
import { fetchVerified, type VerifiedFile } from './verification';

export function useCameraReads() {
  const [state, setState] = useState<{ reads: CameraReadsState | null; verified: VerifiedFile | null }>({ reads: null, verified: null });
  useEffect(() => {
    let alive = true;
    Promise.all([loadCameraReads(), fetchVerified()]).then(([reads, verified]) => alive && setState({ reads, verified }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

