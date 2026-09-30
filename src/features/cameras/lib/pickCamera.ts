import type { Camera } from '@/types/camera';

/** Selected camera: the URL's ?cam= if it is in view, else the first online one, else the first. */
export function pickCamera(cameras: Camera[], code: string | null): Camera | null {
  return cameras.find((c) => c.code === code) ?? cameras.find((c) => c.status === 'online') ?? cameras[0] ?? null;
}
