// CameraVideoPlayer bandwidth behaviour: nothing loads/plays until visible,
// pauses off screen, explicit offline state on error.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { Camera } from '@/types/camera';

const h = vi.hoisted(() => ({ fetchCameraDetections: vi.fn() }));
vi.mock('@/features/detections/api', () => ({ fetchCameraDetections: h.fetchCameraDetections }));
vi.mock('@/features/detections/hooks/useDetectionOverlay', () => ({ useDetectionOverlay: () => ({ activeDetections: [] }) }));

import { CameraVideoPlayer } from './CameraVideoPlayer';

let ioCallback: IntersectionObserverCallback | null = null;
class FakeIO {
  constructor(cb: IntersectionObserverCallback) { ioCallback = cb; }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}
function setVisible(visible: boolean) {
  act(() => ioCallback!([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
}

const camera: Camera = {
  id: 'cam-001', name: 'India Gate Junction', code: 'IG-01', latitude: 28.6, longitude: 77.2,
  zone: 'Central Delhi', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't',
};

let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
let pause: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  ioCallback = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  h.fetchCameraDetections.mockReset().mockResolvedValue([]);
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const video = () => document.querySelector('video')!;

describe('CameraVideoPlayer', () => {
  it('keeps the attributes needed for autoplay and canvas capture', () => {
    render(<CameraVideoPlayer camera={camera} />);
    const v = video();
    expect(v.muted).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(v.getAttribute('crossorigin')).toBe('anonymous');
    expect(v.hasAttribute('autoplay')).toBe(false);
  });

  it('loads nothing, plays nothing and fetches no detections before it is visible', () => {
    render(<CameraVideoPlayer camera={camera} />);
    expect(video().getAttribute('preload')).toBe('none');
    expect(play).not.toHaveBeenCalled();
    expect(h.fetchCameraDetections).not.toHaveBeenCalled();
  });

  it('plays and fetches detections once visible, pauses when scrolled away', async () => {
    render(<CameraVideoPlayer camera={camera} />);
    setVisible(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video().preload).toBe('auto');
    expect(h.fetchCameraDetections).toHaveBeenCalledWith('IG-01', 'cam-001', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    Object.defineProperty(video(), 'paused', { configurable: true, value: false });
    setVisible(false);
    expect(pause).toHaveBeenCalled();
    await act(async () => {});
  });

  it('shows "Feed offline" after the primary and fallback sources fail, and can retry', () => {
    render(<CameraVideoPlayer camera={camera} />);
    setVisible(true);
    fireEvent.error(video()); // primary failed → fallback
    expect(screen.queryByText('Feed offline')).toBeNull();
    fireEvent.error(video()); // fallback failed → offline
    expect(screen.getByText('Feed offline')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.queryByText('Feed offline')).toBeNull();
    expect(document.querySelector('video')).not.toBeNull();
  });

  it('reports its <video> element and feed status to the caller', () => {
    const onVideoElement = vi.fn();
    const onStatusChange = vi.fn();
    render(<CameraVideoPlayer camera={camera} onVideoElement={onVideoElement} onStatusChange={onStatusChange} />);
    expect(onVideoElement).toHaveBeenLastCalledWith(video());
    expect(onStatusChange).toHaveBeenLastCalledWith('connecting');
    setVisible(true);
    fireEvent.playing(video());
    expect(onStatusChange).toHaveBeenLastCalledWith('playing');
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    fireEvent.error(video());
    fireEvent.error(video());
    expect(onStatusChange).toHaveBeenLastCalledWith('offline');
    expect(onVideoElement).toHaveBeenLastCalledWith(null);
  });
});
