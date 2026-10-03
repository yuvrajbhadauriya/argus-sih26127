import type { Camera } from '@/types/camera';

/** Camera shown on /cameras when the URL has no ?cam=: Santacruz Airport Approach. */
export const DEFAULT_CAMERA_CODE = 'SC-01';

/**
 * Selected camera: the URL's ?cam= if it is in view, else the default camera
 * (SC-01) when it is online, else the first online one, else the first.
 */
export function pickCamera(cameras: Camera[], code: string | null): Camera | null {
  return (
    cameras.find((c) => c.code === code) ??
    cameras.find((c) => c.code === DEFAULT_CAMERA_CODE && c.status === 'online') ??
    cameras.find((c) => c.status === 'online') ??
    cameras[0] ??
    null
  );
}
