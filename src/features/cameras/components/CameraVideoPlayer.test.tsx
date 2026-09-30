// CameraVideoPlayer bandwidth behaviour: nothing loads/plays until visible,
// pauses off screen, explicit offline state on error.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { Camera } from '@/types/camera';

const h = vi.hoisted(() => ({ fetchCameraDetections: vi.fn(), fetchCameraEvents: vi.fn() }));
vi.mock('@/features/detections/api', () => ({ fetchCameraDetections: h.fetchCameraDetections, fetchCameraEvents: h.fetchCameraEvents }));
vi.mock('@/features/detections/hooks/useDetectionOverlay', () => ({ useDetectionOverlay: () => ({ activeDetections: [] }) }));

import { CameraVideoPlayer } from './CameraVideoPlayer';
import { livePosition } from '../lib/liveClock';

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
  id: 'cam-001', name: 'Jogeshwari JVLR Junction', code: 'JG-01', latitude: 19.14, longitude: 72.85,
  zone: 'Western Suburbs', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't',
};

let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
let pause: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  ioCallback = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  h.fetchCameraDetections.mockReset().mockResolvedValue([]);
  h.fetchCameraEvents.mockReset().mockResolvedValue(null);
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
    expect(h.fetchCameraDetections).toHaveBeenCalledWith('JG-01', 'cam-001', expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

  describe('live clock', () => {
    /** Give the jsdom <video> real-looking media state. */
    function media(v: HTMLVideoElement, duration: number, currentTime = 0) {
      let t = currentTime;
      Object.defineProperty(v, 'duration', { configurable: true, get: () => duration });
      Object.defineProperty(v, 'readyState', { configurable: true, get: () => 4 });
      Object.defineProperty(v, 'currentTime', { configurable: true, get: () => t, set: (x: number) => { t = x; } });
      return () => t;
    }

    afterEach(() => vi.useRealTimers());

    it('starts at the camera\'s live position when metadata loads (not at 0)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
      render(<CameraVideoPlayer camera={camera} />);
      const time = media(video(), 57);
      setVisible(true);
      fireEvent.loadedMetadata(video());
      expect(time()).toBeCloseTo(livePosition('JG-01', 57), 3);
    });

    it('resumes at the live position after being paused off screen', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
      render(<CameraVideoPlayer camera={camera} />);
      const time = media(video(), 57);
      setVisible(true);
      fireEvent.loadedMetadata(video());
      const first = time();
      Object.defineProperty(video(), 'paused', { configurable: true, value: false });
      setVisible(false); // paused where it was
      expect(pause).toHaveBeenCalled();
      vi.setSystemTime(new Date('2026-09-30T10:00:20Z')); // 20 s later
      Object.defineProperty(video(), 'paused', { configurable: true, value: true });
      setVisible(true);
      expect(time()).toBeCloseTo(livePosition('JG-01', 57), 3);
      expect(time()).toBeCloseTo((first + 20) % 57, 3);
      expect(play).toHaveBeenCalledTimes(2);
    });

    it('corrects drift while playing but leaves small jitter alone', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
      render(<CameraVideoPlayer camera={camera} />);
      const time = media(video(), 57);
      setVisible(true);
      Object.defineProperty(video(), 'paused', { configurable: true, value: false });
      Object.defineProperty(video(), 'seeking', { configurable: true, value: false });
      const live = livePosition('JG-01', 57);
      video().currentTime = (live + 0.5) % 57;
      fireEvent.timeUpdate(video());
      expect(time()).toBeCloseTo((live + 0.5) % 57, 3);
      video().currentTime = (live + 10) % 57; // e.g. stalled / looped early
      fireEvent.timeUpdate(video());
      expect(time()).toBeCloseTo(live, 3);
    });

    it('uses the canonical clip duration from the ANPR events file', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
      h.fetchCameraEvents.mockResolvedValue({ camera_code: 'JG-01', duration_sec: 50, events: [] });
      render(<CameraVideoPlayer camera={camera} />);
      const time = media(video(), 57);
      setVisible(true);
      await act(async () => {});
      expect(h.fetchCameraEvents).toHaveBeenCalledWith('JG-01');
      expect(time()).toBeCloseTo(livePosition('JG-01', 50), 3);
    });
  });
});
