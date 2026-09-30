import { describe, it, expect } from 'vitest';
import type { TrajectoryWaypoint } from '@/types';
import { compass8, formatDistance, formatDuration, formatIstTime, normalizePlate, pointAlong, cumulativeM, haversineM } from './geo';
import { buildReplayModel, positionsAt, realTimeAt, replayMsAt, stopIndexAt } from './replay';
import { detectAnomalies, finalize, trajectoryFromJourneys, vehiclesFromJourneys, type SimJourneysDoc, type CameraRef } from './trajectory';

const CAMS = new Map<string, CameraRef>([
  ['A', { id: 'cam-a', code: 'A', name: 'Alpha', lat: 28.60, lng: 77.20 }],
  ['B', { id: 'cam-b', code: 'B', name: 'Bravo', lat: 28.62, lng: 77.20 }],
  ['C', { id: 'cam-c', code: 'C', name: 'Charlie', lat: 28.62, lng: 77.23 }],
  ['Z', { id: 'cam-z', code: 'Z', name: 'Zulu', lat: 28.40, lng: 77.00 }],
]);
const ROUTES = {
  version: 1, source: 'osrm', cameras: [],
  routes: {
    'A>B': { from: 'A', to: 'B', distance_m: 2500, duration_s: 200, start_bearing: 0, end_bearing: 0, via: [], coordinates: [[28.6, 77.2], [28.61, 77.201], [28.62, 77.2]] as [number, number][] },
  },
};

describe('geo helpers', () => {
  it('normalises plates', () => {
    expect(normalizePlate(' mh-01 cs 0126 ')).toBe('MH01CS0126');
  });
  it('formats values', () => {
    expect(compass8(91)).toBe('E');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(640)).toBe('640 m');
    expect(formatDuration(3725)).toBe('1h 02m');
    expect(formatDuration(125)).toBe('2 min');
    expect(formatIstTime('2026-09-29T03:30:05Z')).toBe('09:00:05');
  });
  it('interpolates along a polyline', () => {
    const path: [number, number][] = [[28.6, 77.2], [28.61, 77.2]];
    const cum = cumulativeM(path);
    const { at, bearing } = pointAlong(path, cum, cum[1] / 2);
    expect(at[0]).toBeCloseTo(28.605, 4);
    expect(bearing).toBeCloseTo(0, 0);
    expect(haversineM(path[0], path[1])).toBeCloseTo(cum[1]);
  });
});

const DOC: SimJourneysDoc = {
  version: 1, simulated: true, seed: 1, date: '2026-09-29', timezone: '+05:30', routes_source: 'osrm',
  sighting_fields: [],
  journeys: [
    { id: 'J2', plate_text: 'MH 01 AB 1234', vehicle_type: 'car', trip: 1, sightings: [['B', '2026-09-29T18:00:00+05:30', 'S', null, null]] },
    {
      id: 'J1', plate_text: 'MH 01 AB 1234', vehicle_type: 'car', trip: 0, tags: ['watchlist'],
      sightings: [['A', '2026-09-29T08:00:00+05:30', 'N', null, null], ['B', '2026-09-29T08:10:00+05:30', 'N', 15, 2500]],
    },
    { id: 'J3', plate_text: 'MH 43 BM 3816', vehicle_type: 'truck', trip: 0, sightings: [['C', '2026-09-29T02:00:00+05:30', 'E', null, null]] },
  ],
};

describe('trajectoryFromJourneys', () => {
  it('orders trips chronologically and attaches road geometry', () => {
    const t = trajectoryFromJourneys(DOC.journeys.filter((j) => j.plate_text.startsWith('MH 01')), CAMS, ROUTES)!;
    expect(t.waypoints.map((w) => w.camera_code)).toEqual(['A', 'B', 'B']);
    expect(t.waypoints.map((w) => w.trip_index)).toEqual([0, 0, 1]);
    expect(t.waypoints[1].path_from_prev).toHaveLength(3);
    expect(t.waypoints[2].path_from_prev).toBeNull();
    expect(t.waypoints.map((w) => w.time_since_previous_seconds)).toEqual([null, 600, 9 * 3600 + 50 * 60]);
    expect(t).toMatchObject({ total_distance_m: 2500, moving_time_seconds: 600, camera_count: 2, source: 'simulation', tags: ['watchlist'] });
  });

  it('falls back to straight lines when a route is unknown', () => {
    const t = trajectoryFromJourneys([
      { id: 'x', plate_text: 'P', vehicle_type: 'car', trip: 0, sightings: [['B', '2026-09-29T08:00:00+05:30', 'E', null, null], ['C', '2026-09-29T08:10:00+05:30', 'E', 18, 3000]] },
    ], CAMS, ROUTES)!;
    expect(t.waypoints[1].path_from_prev).toEqual([[28.62, 77.2], [28.62, 77.23]]);
  });

  it('aggregates vehicles for search', () => {
    const v = vehiclesFromJourneys(DOC);
    expect(v[0]).toMatchObject({ plate_text: 'MH 01 AB 1234', detection_count: 3, camera_count: 2, first_seen: '2026-09-29T08:00:00+05:30' });
  });
});

const wp = (code: string, ts: string, trip: number, extra: Partial<TrajectoryWaypoint> = {}): TrajectoryWaypoint => {
  const c = CAMS.get(code)!;
  return { camera_id: c.id, camera_code: code, camera_name: c.name, lat: c.lat, lng: c.lng, timestamp: ts, time_since_previous_seconds: null, trip_index: trip, ...extra };
};

describe('detectAnomalies', () => {
  it('flags an impossible jump between two trips as a cloned plate', () => {
    const t = finalize({
      id: 't', plate_text: 'X', vehicle_type: 'car', total_travel_time_seconds: 0, camera_count: 0, first_seen: '', last_seen: '',
      waypoints: [wp('A', '2026-09-29T09:00:00+05:30', 0), wp('Z', '2026-09-29T09:04:00+05:30', 1)],
    });
    expect(t.anomalies).toHaveLength(1);
    expect(t.anomalies![0]).toMatchObject({ kind: 'cloned_plate', waypoint_indices: [0, 1] });
  });

  it('flags circling and ignores ordinary journeys', () => {
    const loop = ['A', 'B', 'A', 'B', 'A'].map((c, i) => wp(c, `2026-09-29T21:${String(i * 8).padStart(2, '0')}:00+05:30`, 0, i ? { distance_m_from_prev: 2500 } : {}));
    const base = { id: 't', plate_text: 'X', vehicle_type: 'car' as const, total_travel_time_seconds: 0, camera_count: 0, first_seen: '', last_seen: '' };
    expect(detectAnomalies({ ...base, waypoints: loop }).map((a) => a.kind)).toEqual(['circling']);
    expect(detectAnomalies({ ...base, waypoints: loop.slice(0, 3) })).toEqual([]);
  });
});

describe('replay model', () => {
  const path: [number, number][] = [[28.6, 77.2], [28.62, 77.2]];
  const waypoints = [
    wp('A', '2026-09-29T08:00:00+05:30', 0),
    wp('B', '2026-09-29T08:10:00+05:30', 0, { path_from_prev: path, distance_m_from_prev: 2200 }),
    wp('C', '2026-09-29T18:00:00+05:30', 1),
  ];
  const m = buildReplayModel(waypoints, 10000, 1000);

  it('compresses the off-network gap and maps time monotonically', () => {
    expect(m.intervals).toHaveLength(2);
    expect(m.intervals[1].r1 - m.intervals[1].r0).toBe(1000);
    expect(m.duration).toBeCloseTo(10000, -1);
    let prev = -Infinity;
    for (let ms = 0; ms <= m.duration; ms += 250) {
      const t = realTimeAt(m, ms);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(realTimeAt(m, m.duration)).toBe(Date.parse(waypoints[2].timestamp));
    expect(replayMsAt(m, Date.parse(waypoints[1].timestamp))).toBeCloseTo(m.intervals[0].r1);
  });

  it('moves the vehicle along the road between stops', () => {
    const mid = realTimeAt(m, m.intervals[0].r1 / 2);
    const [p] = positionsAt(m, mid);
    expect(p.moving).toBe(true);
    expect(p.at[0]).toBeCloseTo(28.61, 2);
    expect(stopIndexAt(m, mid)).toBe(0);
    expect(stopIndexAt(m, Date.parse(waypoints[1].timestamp))).toBe(1);
    // during the gap nobody is on the network
    expect(positionsAt(m, Date.parse('2026-09-29T12:00:00+05:30'))).toEqual([]);
  });
});
