import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return { supabase: h.fake.client, isSupabaseConfigured: () => h.configured };
});

import { searchVehicles, fetchTrajectoryByPlate } from './api';
import { mockVehicles, mockTrajectories } from '@/mocks/fixtures/mockTrajectories';

const SQL = ['20260925_init_schema.sql', '20260927_add_detection_pipeline_columns.sql', '20260927_add_detection_tracking.sql']
  .map((f) => readFileSync(resolve(process.cwd(), `supabase/migrations/${f}`), "utf8"))
  .join('\n');

beforeEach(() => {
  h.configured = false;
  h.fake.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('searchVehicles — mock mode', () => {
  it('returns all mock vehicles for empty query', async () => {
    expect(await searchVehicles('   ')).toBe(mockVehicles);
  });

  it('matches case-insensitively and ignoring hyphens', async () => {
    const plate = mockVehicles[0].plate_text;
    const res = await searchVehicles(plate.toLowerCase());
    expect(res.map((v) => v.plate_text)).toContain(plate);
    const noHyphen = plate.replace(/-/g, '');
    expect((await searchVehicles(noHyphen)).map((v) => v.plate_text)).toContain(plate);
  });

  it('returns [] for a plate that does not exist', async () => {
    expect(await searchVehicles('ZZZZZZZZ')).toEqual([]);
  });
});

describe('searchVehicles — Supabase configured', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('uses ilike for a query and uppercases it', async () => {
    h.fake.enqueue('vehicles', { data: [{ plate_text: 'DL 1', detection_count: 0 }] });
    const [v] = await searchVehicles(' dl ');
    expect(v.plate_text).toBe('DL 1');
    expect(v.detection_count).toBe(0); // ?? keeps 0
    expect(h.fake.opsFor(h.fake.calls[0], 'ilike')[0]).toEqual(['plate_text', '%DL%']);
  });

  it('lists recent vehicles (ordered, limited) for empty query', async () => {
    h.fake.enqueue('vehicles', { data: [] });
    await searchVehicles();
    const c = h.fake.calls[0];
    expect(h.fake.opsFor(c, 'order')[0]).toEqual(['last_seen', { ascending: false }]);
    expect(h.fake.opsFor(c, 'limit')[0]).toEqual([100]);
  });

  it('falls back to mock vehicles on error or throw', async () => {
    h.fake.enqueue('vehicles', { error: { message: 'x' } });
    expect(await searchVehicles('a')).toBe(mockVehicles);
    h.fake.enqueue('vehicles', new Error('net'));
    expect(await searchVehicles('a')).toBe(mockVehicles);
  });

  // BUG: DB plates are stored as "DL 01 AB 1234" (spaces). Searching "DL01AB1234"
  // or "DL-01-AB-1234" (the format mock data + UI use) with ilike on the raw
  // column finds nothing, whereas mock mode strips separators.
  it('documents that the DB search does not normalise separators (see report)', async () => {
    h.fake.enqueue('vehicles', { data: [] });
    await searchVehicles('DL-01-AB-1234');
    expect(h.fake.opsFor(h.fake.calls[0], 'ilike')[0]).toEqual(['plate_text', '%DL-01-AB-1234%']);
  });
});

describe('fetchTrajectoryByPlate', () => {
  it('mock mode: matches plate ignoring hyphens/case, null when missing', async () => {
    const key = Object.keys(mockTrajectories)[0];
    expect(await fetchTrajectoryByPlate(key.toLowerCase())).toBe(mockTrajectories[key]);
    expect(await fetchTrajectoryByPlate(key.replace(/-/g, ''))).toBe(mockTrajectories[key]);
    expect(await fetchTrajectoryByPlate('NOPE')).toBeNull();
  });

  it('DB: returns the trajectories row directly when present', async () => {
    h.configured = true;
    const row = { id: 't', plate_text: 'X', waypoints: [] };
    h.fake.enqueue('trajectories', { data: row });
    expect(await fetchTrajectoryByPlate('x')).toBe(row);
  });

  it('DB: reconstructs a trajectory from detections when the view is empty', async () => {
    h.configured = true;
    h.fake.enqueue('trajectories', { data: null });
    h.fake.enqueue('detections', {
      data: [
        { camera_id: 'c1', detected_at: '2026-01-01T00:00:00Z', lat: 1, lng: 2, plate_text_raw: 'DL 01', vehicle_type: 'bus', cameras: { name: 'Cam1' } },
        { camera_id: 'c2', detected_at: '2026-01-01T00:01:30Z', lat: 3, lng: 4, cameras: {} },
        { camera_id: 'c2', detected_at: '2026-01-01T00:02:00Z', lat: 3, lng: 4, cameras: {} },
      ],
    });
    const t = await fetchTrajectoryByPlate('dl-01');
    expect(t).toMatchObject({
      id: 'traj-DL-01',
      plate_text: 'DL 01',
      vehicle_type: 'bus',
      total_travel_time_seconds: 120,
      camera_count: 2,
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: '2026-01-01T00:02:00Z',
    });
    expect(t!.waypoints.map((w) => w.time_since_previous_seconds)).toEqual([null, 90, 30]);
    expect(t!.waypoints[0].camera_name).toBe('Cam1');
    expect(t!.waypoints[1].camera_name).toBe('CCTV Node');
    const detCall = h.fake.calls.find((c) => c.table === 'detections')!;
    expect(h.fake.opsFor(detCall, 'eq')[0]).toEqual(['plate_text_normalized', 'DL01']);
  });

  it('DB: falls back to mock trajectory when no detections match', async () => {
    h.configured = true;
    const key = Object.keys(mockTrajectories)[0];
    h.fake.enqueue('trajectories', { error: { message: 'relation does not exist' } });
    h.fake.enqueue('detections', { data: [] });
    expect(await fetchTrajectoryByPlate(key)).toBe(mockTrajectories[key]);
  });

  it('DB: returns null if the client throws', async () => {
    h.configured = true;
    h.fake.enqueue('trajectories', new Error('net'));
    expect(await fetchTrajectoryByPlate('x')).toBeNull();
  });

  // BUG (schema drift): features/vehicles/api.ts queries a `trajectories` relation, orders
  // detections by `detected_at`, and embeds cameras(latitude, longitude). None of
  // these exist in supabase/migrations (detections has `timestamp`; cameras has
  // lat/lng; there is no trajectories table/view). Against a migration-built DB the
  // reconstruction path always errors and the UI silently shows mock trajectories.
  it.fails('BUG: migrations define a trajectories relation and detections.detected_at', () => {
    expect(SQL).toMatch(/(TABLE|VIEW)[^;]*public\.trajectories/i);
    expect(SQL).toMatch(/\bdetected_at\b/);
  });
});
