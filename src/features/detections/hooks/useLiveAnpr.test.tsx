import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const remote = vi.hoisted(() => ({
  capture: vi.fn(),
  detect: vi.fn(),
}));

vi.mock('../remote/detectFrame', async () => {
  const actual = await vi.importActual<typeof import('../remote/detectFrame')>('../remote/detectFrame');
  return { ...actual, captureVideoFrameWithCanvas: remote.capture, detectCapturedFrame: remote.detect };
});

import { DetectFrameError, type RemoteDetectResponse } from '../remote/detectFrame';
import { useLiveAnpr } from './useLiveAnpr';

function playingVideo(over: Partial<Record<'paused' | 'ended' | 'readyState' | 'videoWidth', unknown>> = {}) {
  const v = document.createElement('video');
  const props = { paused: false, ended: false, readyState: 4, videoWidth: 1280, ...over };
  for (const [k, value] of Object.entries(props)) Object.defineProperty(v, k, { value, configurable: true, writable: true });
  return v;
}

const RESPONSE: RemoteDetectResponse = {
  engine: 'lpu_on_gpu',
  model_version: 'deim50k+raw35',
  latency_ms: 840,
  image: { width: 1280, height: 720 },
  detections: [
    {
      plate_text: 'MH 02 DJ 8770', plate_confidence: 0.94, vehicle_type: 'car', confidence: 0.9, grammar_valid: true,
      bbox: { x: 400, y: 300, width: 200, height: 160 }, plate_bbox: { x: 470, y: 420, width: 60, height: 16 }, bbox_source: 'vehicle',
    },
  ],
};

beforeEach(() => {
  const ctx = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,CROP');
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  remote.capture.mockReset().mockReturnValue({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, timestampSec: 3.2, canvas });
  remote.detect.mockReset().mockResolvedValue(RESPONSE);
});

afterEach(() => vi.restoreAllMocks());

describe('useLiveAnpr', () => {
  it('is off without a playing video', () => {
    const { result } = renderHook(() => useLiveAnpr(null, 'JG-01'));
    expect(result.current.status).toBe('off');
    expect(remote.detect).not.toHaveBeenCalled();
  });

  it('sends frames to the model and turns good reads into rows with real crops', async () => {
    const video = playingVideo();
    const { result } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 5 }));
    expect(result.current.status).toBe('connecting');
    await waitFor(() => expect(result.current.status).toBe('live'));
    expect(remote.detect).toHaveBeenCalledWith(expect.objectContaining({ timestampSec: 3.2 }), expect.objectContaining({ cameraCode: 'JG-01' }));
    const [row] = result.current.reads;
    expect(row).toMatchObject({ plate: 'MH 02 DJ 8770', key: 'MH02DJ8770', confidence: 0.94, camera_code: 'JG-01' });
    expect(row.plateCrop?.dataUrl).toBe('data:image/jpeg;base64,CROP');
    expect(row.vehicleCrop?.dataUrl).toBe('data:image/jpeg;base64,CROP');
    expect(result.current).toMatchObject({ latencyMs: 840, modelVersion: 'deim50k+raw35' });
  });

  it('folds the same vehicle seen in consecutive frames into one row', async () => {
    const video = playingVideo();
    const { result } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 5 }));
    await waitFor(() => expect(result.current.frames).toBeGreaterThanOrEqual(3));
    expect(result.current.reads).toHaveLength(1);
    expect(result.current.reads[0].sightings).toBeGreaterThanOrEqual(3);
  });

  it('never has two requests in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    remote.detect.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return RESPONSE;
    });
    const video = playingVideo();
    const { result } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 1 }));
    await waitFor(() => expect(result.current.frames).toBeGreaterThanOrEqual(3));
    expect(maxInFlight).toBe(1);
  });

  it('does not analyse a paused video', async () => {
    const video = playingVideo({ paused: true });
    const { result } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 5 }));
    await new Promise((r) => setTimeout(r, 120));
    expect(remote.detect).not.toHaveBeenCalled();
    expect(result.current.status).toBe('connecting');
  });

  it('reports unavailable when the model API cannot be reached and keeps the reason', async () => {
    remote.detect.mockRejectedValue(new DetectFrameError('http', 'The ANPR model API is LAN/VPN-only and is not reachable from this deployment.', 503));
    const video = playingVideo();
    const { result } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 5 }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.reason).toMatch(/LAN\/VPN-only/);
    expect(result.current.reads).toEqual([]);
  });

  it('stops requesting when unmounted', async () => {
    const video = playingVideo();
    const { result, unmount } = renderHook(() => useLiveAnpr(video, 'JG-01', { intervalMs: 5 }));
    await waitFor(() => expect(result.current.frames).toBeGreaterThanOrEqual(1));
    unmount();
    const calls = remote.detect.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(remote.detect.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});
