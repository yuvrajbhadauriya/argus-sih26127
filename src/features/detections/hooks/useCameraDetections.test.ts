import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createFakeDataApi, rows } from '@/test/dataApiMock';

const h = vi.hoisted(() => ({ configured: false }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => null,
}));

const api = createFakeDataApi();

import { useCameraDetections } from './useCameraDetections';
import { resetDetectionsManifest, DETECTIONS_MANIFEST_URL } from '../api';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
}

const pipelineRow = {
  camera_code: 'VP-01',
  tracked_vehicle_id: 'trk_0001',
  plate_text: 'MH 02 AB 1234',
  vehicle_type: 'bus',
  confidence: 0.91,
  frame_timestamp_sec: 1.2,
  bbox: { x: 1, y: 2, width: 3, height: 4 },
};

/** Cameras listed in /detections/manifest.json for the current test. */
let manifest: string[] = [];
/** fetch stub: serves the manifest, delegates detection files to `files`. */
const files = vi.fn();
const detectionCalls = () => fetchMock.mock.calls.filter((c) => c[0] !== DETECTIONS_MANIFEST_URL && !String(c[0]).startsWith('/api/data/'));

beforeEach(() => {
  h.configured = false;
  api.reset();
  fetchMock.mockReset();
  files.mockReset();
  manifest = ['VP-01', 'SC-01', 'AN-01', 'XX-01'];
  resetDetectionsManifest();
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    String(url).startsWith('/api/data/')
      ? api.fetch(url, init)
      : url === DETECTIONS_MANIFEST_URL
        ? jsonResponse({ cameras: manifest })
        : files(url, init),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('useCameraDetections', () => {
  it('returns empty and does not fetch without code or id', () => {
    const { result } = renderHook(() => useCameraDetections());
    expect(result.current).toEqual({ detections: [], loading: false, error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads local pipeline JSON and maps it to Detection', async () => {
    files.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('VP-01', 'cam-003'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(detectionCalls()[0][0]).toBe('/detections/detections_VP-01.json');
    expect(result.current.detections[0]).toEqual({
      event_id: 'det-VP-01-0',
      camera_id: 'VP-01',
      tracked_vehicle_id: 'trk_0001',
      plate_text_raw: 'MH 02 AB 1234',
      plate_text_normalized: 'MH02AB1234',
      confidence_score: 0.91,
      vehicle_type: 'bus',
      timestamp: 1.2,
      frame_timestamp_sec: 1.2,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it('maps legacy CAM-X codes through the alias table (registry order)', async () => {
    files.mockReturnValue(jsonResponse([]));
    renderHook(() => useCameraDetections('CAM-D'));
    await waitFor(() => expect(detectionCalls()[0]?.[0]).toBe('/detections/detections_SC-01.json'));
  });

  it('has no detections (and requests no file) for a camera the manifest does not list', async () => {
    const { result } = renderHook(() => useCameraDetections('BH-01', 'cam-008'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(DETECTIONS_MANIFEST_URL));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ detections: [], loading: false, error: null });
    expect(files).not.toHaveBeenCalled();
  });

  it('treats a missing manifest as "no pipeline output yet"', async () => {
    fetchMock.mockImplementation(() => jsonResponse(null, false, 404));
    const { result } = renderHook(() => useCameraDetections('VP-01'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detections).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fills defaults for missing fields', async () => {
    files.mockReturnValue(jsonResponse([{}]));
    const { result } = renderHook(() => useCameraDetections('AN-01'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(result.current.detections[0]).toMatchObject({
      confidence_score: 0.85,
      vehicle_type: 'car',
      timestamp: 0,
      plate_text_normalized: '',
      bbox: { x: 0, y: 0, width: 0, height: 0 },
    });
  });

  it('surfaces HTTP errors', async () => {
    files.mockReturnValue(jsonResponse(null, false, 404));
    const { result } = renderHook(() => useCameraDetections('XX-01'));
    await waitFor(() => expect(result.current.error).toBe('HTTP error 404'));
    expect(result.current.detections).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('prefers database rows (via /api/data) when configured and parses string bbox', async () => {
    h.configured = true;
    api.enqueue('detections', rows([{ event_id: 'ev1', camera_id: 'cam-001', plate_text_raw: 'A', confidence_score: 0, frame_timestamp_sec: 2, bbox: '{"x":1,"y":1,"width":2,"height":2}' }]));
    const { result } = renderHook(() => useCameraDetections('VP-01', 'cam-003'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(result.current.detections[0]).toMatchObject({ event_id: 'ev1', confidence_score: 0, bbox: { x: 1, y: 1, width: 2, height: 2 } });
    expect(files).not.toHaveBeenCalled();
    expect(api.calls[0].route).toBe('detections');
    expect(api.calls[0].params.get('camera_id')).toBe('cam-003');
  });

  it('falls back to local JSON when the database has no rows', async () => {
    h.configured = true;
    api.enqueue('detections', rows([]));
    files.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('VP-01', 'cam-003'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(files).toHaveBeenCalled();
  });

  it('falls back to local JSON when a row cannot be mapped (e.g. malformed bbox JSON)', async () => {
    h.configured = true;
    api.enqueue('detections', rows([{ bbox: '{not json' }]));
    files.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('VP-01', 'cam-003'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(result.current.detections[0].event_id).toBe('det-VP-01-0');
  });

  it('does not fetch while disabled, then fetches once enabled', async () => {
    files.mockReturnValue(jsonResponse([pipelineRow]));
    const { result, rerender } = renderHook(({ enabled }) => useCameraDetections('VP-01', undefined, { enabled }), {
      initialProps: { enabled: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
  });

  it('aborts the in-flight request on unmount and ignores its result', async () => {
    let signal: AbortSignal | undefined;
    files.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {}); // never resolves
    });
    const { unmount } = renderHook(() => useCameraDetections('VP-01'));
    await waitFor(() => expect(files).toHaveBeenCalled());
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
  });

  it('aborts the previous request when the camera changes', async () => {
    const signals: AbortSignal[] = [];
    files.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return jsonResponse([pipelineRow]);
    });
    const { rerender, result } = renderHook(({ code }) => useCameraDetections(code), { initialProps: { code: 'VP-01' } });
    await waitFor(() => expect(files).toHaveBeenCalledTimes(1)); // VP-01 file request in flight
    rerender({ code: 'SC-01' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(signals[0].aborted).toBe(true);
    expect(detectionCalls().at(-1)![0]).toBe('/detections/detections_SC-01.json');
  });

  // PostgREST caps a response at 1000 rows: /api/data/detections pages on the
  // server (api/_lib/dataRoutes.ts) and returns every row in frame order.
  it('keeps every row of a > 1000-row clip from one API answer', async () => {
    h.configured = true;
    const all = Array.from({ length: 1250 }, (_, i) => ({ event_id: `e${i}`, bbox: {}, frame_timestamp_sec: i }));
    api.enqueue('detections', rows(all));
    const { result } = renderHook(() => useCameraDetections('VP-01', 'cam-003'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1250));
    expect(api.calls).toHaveLength(1);
  });
});
