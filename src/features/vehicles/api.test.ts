import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeDataApi, fail, rows, type FakeApiReply } from '@/test/dataApiMock';
import { allMigrationsSql, migrationFiles } from '@/test/migrations';

const h = vi.hoisted(() => ({ configured: false }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => null,
}));

import { searchVehicles, fetchTrajectoryByPlate } from './api';
import { resetSimCache } from './sim';

const SQL = allMigrationsSql();

const SUMMARY = JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim/summary.json'), 'utf8'));
const WATCH = SUMMARY.demo.watchlist[0].plate_text as string; // e.g. "MH 01 CS 0126"
const CLONE = SUMMARY.demo.anomalies.find((a: { kind: string }) => a.kind === 'cloned_plate').plate_text as string;
const CIRCLE = SUMMARY.demo.anomalies.find((a: { kind: string }) => a.kind === 'circling').plate_text as string;

let api = createFakeDataApi();

/** Serve /sim/*.json from public/ like the dev server would; /api/data/* goes to the fake API. */
function serveSimFiles() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const file = resolve(process.cwd(), 'public', String(url).replace(/^\//, ''));
    if (!existsSync(file)) return new Response('{}', { status: 404 });
    return new Response(readFileSync(file, 'utf8'), { status: 200 });
  });
  api = createFakeDataApi(fetchMock);
  vi.stubGlobal('fetch', api.fetch);
  return fetchMock;
}

const trajectory = (t: unknown, detections: unknown[] = []): FakeApiReply => ({ body: { trajectory: t, detections } });

beforeEach(() => {
  h.configured = false;
  resetSimCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  serveSimFiles();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchVehicles — simulated network (Supabase not configured)', () => {
  it('lists simulated vehicles, most cameras first, for an empty query', async () => {
    const all = await searchVehicles('   ');
    expect(all.length).toBeGreaterThan(100);
    expect(all[0].camera_count).toBeGreaterThanOrEqual(all[all.length - 1].camera_count);
  });

  it('matches ignoring spaces, hyphens and case', async () => {
    for (const q of [WATCH, WATCH.toLowerCase(), WATCH.replace(/ /g, ''), WATCH.replace(/ /g, '-')]) {
      expect((await searchVehicles(q)).map((v) => v.plate_text)).toContain(WATCH);
    }
  });

  it('returns [] for a plate that does not exist', async () => {
    expect(await searchVehicles('ZZ99ZZ9999')).toEqual([]);
  });

  it('loads the journeys file lazily and only once', async () => {
    const f = serveSimFiles();
    resetSimCache();
    await searchVehicles('DL');
    await searchVehicles('HR');
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls.filter((u) => u === '/sim/journeys.json')).toHaveLength(1);
  });

  it('returns [] (no throw) when the simulation files are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    resetSimCache();
    expect(await searchVehicles('DL')).toEqual([]);
  });
});

describe('searchVehicles — live (via /api/data)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('sends the normalised query and keeps a 0 detection count', async () => {
    api.enqueue('vehicles', rows([{ plate_text: 'MH 1', detection_count: 0 }]));
    const [v] = await searchVehicles(' dl ');
    expect(v.plate_text).toBe('MH 1');
    expect(v.detection_count).toBe(0); // ?? keeps 0
    expect(api.calls[0].params.get('q')).toBe('DL');
  });

  it('ignores separators and case (the server matches plate_text_normalized)', async () => {
    api.enqueue('vehicles', rows([]));
    await searchVehicles('mh-01 ab-1234');
    expect(api.calls[0].params.get('q')).toBe('MH01AB1234');
  });

  it('lists recent vehicles for an empty query (no q)', async () => {
    api.enqueue('vehicles', rows([{ plate_text: 'X' }]));
    await searchVehicles();
    expect(api.calls[0].params.has('q')).toBe(false);
  });

  it('surfaces API errors (ErrorState) instead of silently switching to the simulation', async () => {
    api.enqueue('vehicles', fail(502, 'x'));
    await expect(searchVehicles(WATCH)).rejects.toThrow('Failed to search vehicles: x');
    api.enqueue('vehicles', new TypeError('net'));
    await expect(searchVehicles(WATCH)).rejects.toThrow('Data API is unreachable');
  });

  it('uses the (labelled) simulated network when the database has no match', async () => {
    api.enqueue('vehicles', rows([]));
    expect((await searchVehicles(WATCH)).map((v) => v.plate_text)).toContain(WATCH);
  });
});

describe('fetchTrajectoryByPlate — simulated network', () => {
  it('reconstructs a chronological, road-snapped multi-camera journey', async () => {
    const t = (await fetchTrajectoryByPlate(WATCH.toLowerCase().replace(/ /g, '-')))!;
    expect(t.source).toBe('simulation');
    expect(t.plate_text).toBe(WATCH);
    expect(t.camera_count).toBeGreaterThanOrEqual(4);
    const times = t.waypoints.map((w) => Date.parse(w.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(t.waypoints[0].time_since_previous_seconds).toBeNull();
    const hops = t.waypoints.filter((w) => w.path_from_prev);
    expect(hops.length).toBeGreaterThan(3);
    for (const w of hops) {
      expect(w.path_from_prev!.length).toBeGreaterThan(2); // real road geometry, not a straight line
      expect(w.speed_kmph_from_prev).toBeGreaterThan(5);
      expect(w.speed_kmph_from_prev).toBeLessThan(60);
      const end = w.path_from_prev![w.path_from_prev!.length - 1];
      expect(end[0]).toBeCloseTo(w.lat, 3);
      expect(end[1]).toBeCloseTo(w.lng, 3);
    }
    expect(t.total_distance_m).toBe(hops.reduce((s, w) => s + (w.distance_m_from_prev ?? 0), 0));
    expect(t.moving_time_seconds).toBeGreaterThan(0);
    expect(t.anomalies).toEqual([]);
    expect(t.tags).toContain('watchlist');
  });

  it('flags the cloned plate and the circling vehicle', async () => {
    const clone = (await fetchTrajectoryByPlate(CLONE))!;
    expect(clone.anomalies!.map((a) => a.kind)).toContain('cloned_plate');
    const circ = (await fetchTrajectoryByPlate(CIRCLE))!;
    expect(circ.anomalies!.map((a) => a.kind)).toEqual(['circling']);
  });

  it('returns null for unknown plates or when files are missing', async () => {
    expect(await fetchTrajectoryByPlate('NOPE')).toBeNull();
    expect(await fetchTrajectoryByPlate('  ')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    resetSimCache();
    expect(await fetchTrajectoryByPlate(WATCH)).toBeNull();
  });
});

describe('fetchTrajectoryByPlate — live (via /api/data)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('uses a multi-camera trajectories row, snapped to roads', async () => {
    const row = {
      id: 't', plate_text: 'X', vehicle_type: 'car', camera_count: 2, first_seen: '', last_seen: '', total_travel_time_seconds: 0,
      waypoints: [
        { camera_id: 'cam-001', camera_name: 'JG', lat: 0, lng: 0, timestamp: '2026-09-29T08:00:00+05:30', time_since_previous_seconds: null },
        { camera_id: 'cam-005', camera_name: 'DD', lat: 0, lng: 0, timestamp: '2026-09-29T08:30:00+05:30', time_since_previous_seconds: 1800 },
      ],
    };
    api.enqueue('trajectory', trajectory(row));
    const t = (await fetchTrajectoryByPlate('x'))!;
    expect(t.source).toBe('supabase');
    expect(t.waypoints[1].camera_code).toBe('DD-01');
    expect(t.waypoints[1].path_from_prev!.length).toBeGreaterThan(2);
    expect(t.waypoints[1].distance_m_from_prev).toBeGreaterThan(10000);
    expect(t.waypoints[0].lat).toBeGreaterThan(19); // coordinates come from the camera registry
  });

  it('reconstructs from the plate reads, collapsing repeated reads at one camera', async () => {
    api.enqueue(
      'trajectory',
      trajectory(null, [
        { camera_id: 'c1', detected_at: '2026-01-01T00:00:00Z', lat: 1, lng: 2, plate_text_raw: 'MH 01', vehicle_type: 'bus', cameras: { name: 'Cam1' } },
        { camera_id: 'c2', detected_at: '2026-01-01T00:01:30Z', lat: 3, lng: 4, cameras: {} },
        { camera_id: 'c2', detected_at: '2026-01-01T00:02:00Z', lat: 3, lng: 4, cameras: {} },
      ]),
    );
    const t = (await fetchTrajectoryByPlate('mh-01'))!;
    expect(t).toMatchObject({
      plate_text: 'MH 01',
      vehicle_type: 'bus',
      total_travel_time_seconds: 90,
      camera_count: 2,
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: '2026-01-01T00:01:30Z',
      source: 'supabase',
    });
    expect(t.waypoints.map((w) => w.time_since_previous_seconds)).toEqual([null, 90]);
    expect(t.waypoints[0].camera_name).toBe('Cam1');
    expect(t.waypoints[1].camera_name).toBe('CCTV Node');
    expect(api.calls[0].params.get('plate')).toBe('MH01');
  });

  it('prefers the simulated journey when the DB only saw the plate at one camera', async () => {
    api.enqueue(
      'trajectory',
      trajectory(null, [{ camera_id: 'cam-008', detected_at: '2026-09-27T12:00:00Z', lat: 1, lng: 2, plate_text_raw: WATCH, cameras: { name: 'BH', code: 'BH-01' } }]),
    );
    const t = (await fetchTrajectoryByPlate(WATCH))!;
    expect(t.source).toBe('simulation');
    expect(t.camera_count).toBeGreaterThanOrEqual(4);
  });

  it('uses the simulated network when the database has no journey, but surfaces errors', async () => {
    api.enqueue('trajectory', trajectory(null, []));
    expect((await fetchTrajectoryByPlate(WATCH))!.source).toBe('simulation');
    api.enqueue('trajectory', new TypeError('net'));
    await expect(fetchTrajectoryByPlate(WATCH)).rejects.toThrow('Data API is unreachable');
    api.enqueue('trajectory', fail(502, 'boom'));
    await expect(fetchTrajectoryByPlate(WATCH)).rejects.toThrow('Failed to load trajectory: boom');
    api.enqueue('trajectory', trajectory(null, []));
    expect(await fetchTrajectoryByPlate('x')).toBeNull();
  });

  // Formerly schema drift (read only the first three migrations): the reconcile
  // migration now defines the trajectories view and detections.detected_at.
  it('migrations define a trajectories relation and detections.detected_at', () => {
    expect(SQL).toMatch(/(TABLE|VIEW)[^;]*public\.trajectories/i);
    expect(SQL).toMatch(/\bdetected_at\b/);
  });

  it('migration versions are unique 14-digit timestamps (supabase db push needs unique versions)', () => {
    const versions = migrationFiles().map((f) => f.split('_')[0]);
    for (const v of versions) expect(v).toMatch(/^\d{14}$/);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
