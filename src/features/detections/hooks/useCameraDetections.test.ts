import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return { supabase: h.fake.client, isSupabaseConfigured: () => h.configured };
});

import { useCameraDetections } from './useCameraDetections';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
}

const pipelineRow = {
  camera_code: 'IG-01',
  tracked_vehicle_id: 'trk_0001',
  plate_text: 'DL 01 AB 1234',
  vehicle_type: 'bus',
  confidence: 0.91,
  frame_timestamp_sec: 1.2,
  bbox: { x: 1, y: 2, width: 3, height: 4 },
};

beforeEach(() => {
  h.configured = false;
  h.fake.reset();
  fetchMock.mockReset();
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
    fetchMock.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('IG-01', 'cam-001'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/detections/detections_IG-01.json');
    expect(result.current.detections[0]).toEqual({
      event_id: 'det-IG-01-0',
      camera_id: 'IG-01',
      tracked_vehicle_id: 'trk_0001',
      plate_text_raw: 'DL 01 AB 1234',
      plate_text_normalized: 'DL01AB1234',
      confidence_score: 0.91,
      vehicle_type: 'bus',
      timestamp: 1.2,
      frame_timestamp_sec: 1.2,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it('maps legacy CAM-X codes through the alias table', async () => {
    fetchMock.mockReturnValue(jsonResponse([]));
    renderHook(() => useCameraDetections('CAM-D'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/detections/detections_DW-01.json'));
  });

  it('fills defaults for missing fields', async () => {
    fetchMock.mockReturnValue(jsonResponse([{}]));
    const { result } = renderHook(() => useCameraDetections('KB-01'));
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
    fetchMock.mockReturnValue(jsonResponse(null, false, 404));
    const { result } = renderHook(() => useCameraDetections('XX-01'));
    await waitFor(() => expect(result.current.error).toBe('HTTP error 404'));
    expect(result.current.detections).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('prefers Supabase rows when configured and parses string bbox', async () => {
    h.configured = true;
    h.fake.enqueue('detections', {
      data: [{ event_id: 'ev1', camera_id: 'cam-001', plate_text_raw: 'A', confidence_score: 0, frame_timestamp_sec: 2, bbox: '{"x":1,"y":1,"width":2,"height":2}' }],
    });
    const { result } = renderHook(() => useCameraDetections('IG-01', 'cam-001'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(result.current.detections[0]).toMatchObject({ event_id: 'ev1', confidence_score: 0, bbox: { x: 1, y: 1, width: 2, height: 2 } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.fake.opsFor(h.fake.calls[0], 'eq')[0]).toEqual(['camera_id', 'cam-001']);
  });

  it('falls back to local JSON when Supabase returns no rows', async () => {
    h.configured = true;
    h.fake.enqueue('detections', { data: [] });
    fetchMock.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('IG-01', 'cam-001'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to local JSON when Supabase throws (e.g. malformed bbox JSON)', async () => {
    h.configured = true;
    h.fake.enqueue('detections', { data: [{ bbox: '{not json' }] });
    fetchMock.mockReturnValue(jsonResponse([pipelineRow]));
    const { result } = renderHook(() => useCameraDetections('IG-01', 'cam-001'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    expect(result.current.detections[0].event_id).toBe('det-IG-01-0');
  });

  // BUG: the Supabase query has no .range()/.limit() and no ordering. PostgREST caps
  // responses at 1000 rows by default, while the shipped detection files hold
  // 1.7k–25.8k rows per camera, so DB mode silently truncates to an arbitrary
  // 1000-row subset (features/detections/api.ts fetchDetectionsFromSupabase).
  it.fails('BUG: DB query paginates or orders by frame_timestamp_sec to avoid 1000-row truncation', async () => {
    h.configured = true;
    h.fake.enqueue('detections', { data: [{ event_id: 'x', bbox: {} }] });
    const { result } = renderHook(() => useCameraDetections('IG-01', 'cam-001'));
    await waitFor(() => expect(result.current.detections).toHaveLength(1));
    const methods = h.fake.calls[0].ops.map((o) => o.method);
    expect(methods.some((m) => m === 'order' || m === 'range')).toBe(true);
  });
});
