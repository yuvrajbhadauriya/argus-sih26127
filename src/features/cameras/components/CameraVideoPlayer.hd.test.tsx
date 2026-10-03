// HD of the selected feed in the private bucket: an HD object that cannot be signed (missing)
// silently drops the player to the 720p clip, with no offline state and no source flapping.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { Camera } from '@/types/camera';

const h = vi.hoisted(() => ({ hd: undefined as string | null | undefined }));
vi.mock('@/features/detections/api', () => ({ fetchCameraDetections: vi.fn().mockResolvedValue([]), fetchCameraEvents: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/detections/hooks/useDetectionOverlay', () => ({ useDetectionOverlay: () => ({ activeDetections: [] }) }));
vi.mock('../lib/signedMedia', () => ({
  // pass-through for everything except the HD object, whose signing result the test controls
  useSignedMediaUrl: (url?: string) => (url && url.includes('/mumbai/1080p/') ? h.hd : url),
  invalidateSignedMedia: () => false,
}));
vi.mock('@/config/env', () => ({ env: { videoSource: 'supabase' } }));

import { CameraVideoPlayer } from './CameraVideoPlayer';

const camera: Camera = {
  id: 'cam-001', name: 'Jogeshwari JVLR Junction', code: 'JG-01', latitude: 19.14, longitude: 72.85,
  zone: 'Western Suburbs', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't',
};
const video = () => document.querySelector('video')!;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CameraVideoPlayer HD from the private bucket', () => {
  it('plays the signed HD URL once it is signed', () => {
    h.hd = 'https://signed.example/mumbai/1080p/clip.mp4?token=1';
    render(<CameraVideoPlayer camera={camera} />);
    expect(video().dataset.quality).toBe('hd');
    expect(video().getAttribute('src')).toBe(h.hd);
  });

  it('waits for the HD signature instead of starting 720p first (no source swap while it loads)', () => {
    h.hd = undefined;
    render(<CameraVideoPlayer camera={camera} />);
    expect(video().getAttribute('src')).toBeNull();
  });

  it('uses the 720p clip when the HD object cannot be signed, and stays on it', () => {
    h.hd = null;
    const { rerender } = render(<CameraVideoPlayer camera={camera} />);
    expect(video().dataset.quality).toBe('sd');
    expect(video().getAttribute('src')).toMatch(/\/mumbai\/720p\/.*\.mp4$/);
    expect(screen.queryByText('Feed offline')).toBeNull();
    // signing is retried later and "loads" again: the player must not leave the working 720p source
    h.hd = undefined;
    act(() => rerender(<CameraVideoPlayer camera={camera} />));
    expect(video().getAttribute('src')).toMatch(/\/mumbai\/720p\//);
    h.hd = 'https://signed.example/mumbai/1080p/clip.mp4?token=2';
    act(() => rerender(<CameraVideoPlayer camera={camera} />));
    expect(video().dataset.quality).toBe('sd');
  });
});
