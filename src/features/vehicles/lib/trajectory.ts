// ═══════════════════════════════════════════════════
// Trajectory reconstruction helpers (pure; unit-tested)
//  • build a Trajectory from simulated journeys
//  • snap any trajectory's hops onto road geometry
//  • flag anomalies (cloned plates, circling)
// ═══════════════════════════════════════════════════

import type { Trajectory, TrajectoryAnomaly, TrajectoryWaypoint, Vehicle, VehicleType } from '@/types';
import { IMPOSSIBLE_SPEED_KMPH, TRIP_GAP_SECONDS } from '../config';
import { bearingDeg, compass8, formatDistance, formatDuration, haversineM, normalizePlate } from './geo';
import type { LatLngTuple } from './geo';

// ── Static simulation file shapes (see pipeline/simulation) ──

export type SimSighting = [
  camera_code: string,
  timestamp: string,
  heading: string,
  speed_kmph_from_prev: number | null,
  distance_m_from_prev: number | null,
];

export interface SimJourney {
  id: string;
  plate_text: string;
  vehicle_type: string;
  trip: number;
  tags?: string[];
  sightings: SimSighting[];
}

export interface SimJourneysDoc {
  version: number;
  simulated: boolean;
  seed: number;
  date: string;
  timezone: string;
  routes_source: string;
  sighting_fields: string[];
  journeys: SimJourney[];
}

export interface RoadRoute {
  from: string;
  to: string;
  distance_m: number;
  duration_s: number;
  start_bearing: number;
  end_bearing: number;
  via: { camera_code: string; along_m: number }[];
  coordinates: LatLngTuple[];
  source?: string;
}

export interface RoadRoutesDoc {
  version: number;
  source: string;
  cameras: { code: string; name: string; lat: number; lng: number; road?: string; direction?: string; zone?: string }[];
  routes: Record<string, RoadRoute>;
}

export interface CameraRef {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  road?: string;
}

export const routeKey = (from: string, to: string) => `${from}>${to}`;

const VEHICLE_TYPES: VehicleType[] = ['car', 'truck', 'bus', 'motorcycle', 'unknown'];
const asVehicleType = (t: string): VehicleType => (VEHICLE_TYPES.includes(t as VehicleType) ? (t as VehicleType) : 'unknown');

/** Index journeys by normalised plate. */
export function indexJourneys(doc: SimJourneysDoc): Map<string, SimJourney[]> {
  const idx = new Map<string, SimJourney[]>();
  for (const j of doc.journeys) {
    const k = normalizePlate(j.plate_text);
    const list = idx.get(k);
    if (list) list.push(j);
    else idx.set(k, [j]);
  }
  return idx;
}

/** Aggregate simulated journeys into the `Vehicle` list shape used by search. */
export function vehiclesFromJourneys(doc: SimJourneysDoc): Vehicle[] {
  const acc = new Map<string, Vehicle & { cams: Set<string> }>();
  for (const j of doc.journeys) {
    let v = acc.get(j.plate_text);
    if (!v) {
      v = {
        plate_text: j.plate_text, vehicle_type: asVehicleType(j.vehicle_type), first_seen: j.sightings[0][1],
        last_seen: j.sightings[0][1], detection_count: 0, camera_count: 0, cams: new Set(),
      };
      acc.set(j.plate_text, v);
    }
    for (const s of j.sightings) {
      v.detection_count++;
      v.cams.add(s[0]);
      if (Date.parse(s[1]) < Date.parse(v.first_seen)) v.first_seen = s[1];
      if (Date.parse(s[1]) > Date.parse(v.last_seen)) v.last_seen = s[1];
    }
  }
  return [...acc.values()]
    .map(({ cams, ...v }) => ({ ...v, camera_count: cams.size }))
    .sort((a, b) => b.camera_count - a.camera_count || a.plate_text.localeCompare(b.plate_text));
}

/** Road geometry between two cameras, or a straight line when unknown. */
export function hopPath(routes: RoadRoutesDoc | null, from: CameraRef, to: CameraRef): LatLngTuple[] {
  const r = routes?.routes[routeKey(from.code, to.code)];
  if (r && r.coordinates.length >= 2) return r.coordinates;
  return [[from.lat, from.lng], [to.lat, to.lng]];
}

/** Build a chronological trajectory for one plate from its simulated journeys. */
export function trajectoryFromJourneys(
  journeys: SimJourney[],
  cameras: Map<string, CameraRef>,
  routes: RoadRoutesDoc | null,
): Trajectory | null {
  if (journeys.length === 0) return null;
  const ordered = [...journeys].sort((a, b) => Date.parse(a.sightings[0][1]) - Date.parse(b.sightings[0][1]));
  const tags = new Set<string>();
  type Row = { wp: TrajectoryWaypoint; t: number; order: number };
  const rows: Row[] = [];
  ordered.forEach((j, tripIndex) => {
    j.tags?.forEach((t) => tags.add(t));
    j.sightings.forEach(([code, ts, heading, speed, dist], i) => {
      const cam = cameras.get(code) ?? { id: code, code, name: code, lat: 0, lng: 0 };
      const prevCode = i > 0 ? j.sightings[i - 1][0] : null;
      const prevCam = prevCode ? cameras.get(prevCode) : undefined;
      rows.push({
        t: Date.parse(ts),
        order: rows.length,
        wp: {
          camera_id: cam.id, camera_name: cam.name, camera_code: code, lat: cam.lat, lng: cam.lng,
          timestamp: ts, time_since_previous_seconds: null, heading,
          speed_kmph_from_prev: speed, distance_m_from_prev: dist, trip_index: tripIndex,
          path_from_prev: prevCam ? hopPath(routes, prevCam, cam) : null,
        },
      });
    });
  });
  rows.sort((a, b) => a.t - b.t || a.order - b.order);
  const waypoints = rows.map((r) => r.wp);
  return finalize(
    {
      id: `sim-${normalizePlate(ordered[0].plate_text)}`,
      plate_text: ordered[0].plate_text,
      vehicle_type: asVehicleType(ordered[0].vehicle_type),
      waypoints,
      total_travel_time_seconds: 0,
      camera_count: 0,
      first_seen: '',
      last_seen: '',
      source: 'simulation',
      tags: [...tags],
    },
  );
}

/** Recompute derived totals, gaps and anomalies. Mutates and returns `t`. */
export function finalize(t: Trajectory): Trajectory {
  const w = t.waypoints;
  if (w.length === 0) return t;
  w.forEach((wp, i) => {
    wp.time_since_previous_seconds = i === 0 ? null : Math.round((Date.parse(wp.timestamp) - Date.parse(w[i - 1].timestamp)) / 1000);
  });
  t.first_seen = w[0].timestamp;
  t.last_seen = w[w.length - 1].timestamp;
  t.total_travel_time_seconds = Math.max(0, Math.round((Date.parse(t.last_seen) - Date.parse(t.first_seen)) / 1000));
  t.camera_count = new Set(w.map((x) => x.camera_code ?? x.camera_id)).size;
  let dist = 0;
  let moving = 0;
  const lastInTrip = new Map<number, TrajectoryWaypoint>();
  for (const wp of w) {
    const trip = wp.trip_index ?? 0;
    const prev = lastInTrip.get(trip);
    if (prev && wp.distance_m_from_prev != null) {
      dist += wp.distance_m_from_prev;
      moving += (Date.parse(wp.timestamp) - Date.parse(prev.timestamp)) / 1000;
    }
    lastInTrip.set(trip, wp);
  }
  t.total_distance_m = Math.round(dist);
  t.moving_time_seconds = Math.round(moving);
  t.anomalies = detectAnomalies(t);
  return t;
}

/**
 * Enrich a trajectory that came from the database: split it into trips at long
 * gaps and give every in-trip hop road geometry, distance, speed and heading.
 */
export function enrichWithRoads(t: Trajectory, cameras: Map<string, CameraRef>, routes: RoadRoutesDoc | null): Trajectory {
  const byId = new Map([...cameras.values()].map((c) => [c.id, c]));
  // Collapse repeated reads of the same plate at the same camera (consecutive frames).
  const deduped = t.waypoints.filter((wp, i, all) => {
    if (i === 0) return true;
    const prev = all[i - 1];
    const dt = (Date.parse(wp.timestamp) - Date.parse(prev.timestamp)) / 1000;
    return !(prev.camera_id === wp.camera_id && dt < 120);
  });
  let trip = 0;
  const waypoints = deduped.map((wp, i, all) => {
    const cam = (wp.camera_code && cameras.get(wp.camera_code)) || byId.get(wp.camera_id);
    const out: TrajectoryWaypoint = { ...wp, camera_code: wp.camera_code ?? cam?.code };
    if (cam) {
      out.lat = cam.lat;
      out.lng = cam.lng;
    }
    if (i === 0) {
      out.trip_index = 0;
      return out;
    }
    const prev = all[i - 1];
    const prevCam = (prev.camera_code && cameras.get(prev.camera_code)) || byId.get(prev.camera_id);
    const dt = (Date.parse(wp.timestamp) - Date.parse(prev.timestamp)) / 1000;
    const sameCamera = prevCam && cam && prevCam.code === cam.code;
    if (dt > TRIP_GAP_SECONDS || sameCamera) trip++;
    out.trip_index = trip;
    if (!sameCamera && dt <= TRIP_GAP_SECONDS && prevCam && cam) {
      const path = hopPath(routes, prevCam, cam);
      const r = routes?.routes[routeKey(prevCam.code, cam.code)];
      const dist = r?.distance_m ?? Math.round(haversineM([prevCam.lat, prevCam.lng], [cam.lat, cam.lng]) * 1.3);
      out.path_from_prev = path;
      out.distance_m_from_prev = dist;
      out.speed_kmph_from_prev = dt > 0 ? Math.round((dist / dt) * 3.6 * 10) / 10 : null;
      out.heading = out.heading ?? compass8(r?.end_bearing ?? bearingDeg(path[path.length - 2], path[path.length - 1]));
    }
    return out;
  });
  return finalize({ ...t, waypoints, source: t.source ?? 'supabase' });
}

/** Detect cloned plates (impossible jumps) and circling (repeated junction visits). */
export function detectAnomalies(t: Trajectory): TrajectoryAnomaly[] {
  const out: TrajectoryAnomaly[] = [];
  const w = t.waypoints;

  // Cloned plate: consecutive sightings (in time) whose implied speed is impossible.
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1];
    const b = w[i];
    if (a.camera_id === b.camera_id) continue;
    const dt = (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 1000;
    const inTripHop = b.trip_index === a.trip_index && b.distance_m_from_prev != null;
    if (inTripHop) continue;
    const km = (haversineM([a.lat, a.lng], [b.lat, b.lng]) * 1.25) / 1000;
    if (km < 3) continue;
    const kmph = dt > 0 ? km / (dt / 3600) : Infinity;
    if (kmph > IMPOSSIBLE_SPEED_KMPH) {
      out.push({
        kind: 'cloned_plate',
        message:
          `Same plate read at ${a.camera_name} and ${b.camera_name} only ${formatDuration(dt)} apart ` +
          `— ~${formatDistance(km * 1000)} by road would need ${Number.isFinite(kmph) ? Math.round(kmph) : '∞'} km/h. ` +
          'Possible cloned / fake number plate.',
        waypoint_indices: [i - 1, i],
      });
      break;
    }
  }

  // Circling: a camera visited 3+ times within one trip inside two hours.
  const byTrip = new Map<number, number[]>();
  w.forEach((wp, i) => {
    const k = wp.trip_index ?? 0;
    byTrip.set(k, [...(byTrip.get(k) ?? []), i]);
  });
  for (const idxs of byTrip.values()) {
    const counts = new Map<string, number[]>();
    for (const i of idxs) {
      const key = w[i].camera_code ?? w[i].camera_id;
      counts.set(key, [...(counts.get(key) ?? []), i]);
    }
    const loops = [...counts.values()].filter((v) => v.length >= 3);
    if (loops.length === 0) continue;
    const first = idxs[0];
    const last = idxs[idxs.length - 1];
    const span = (Date.parse(w[last].timestamp) - Date.parse(w[first].timestamp)) / 1000;
    if (span > 2 * 3600) continue;
    const names = [...new Set(idxs.map((i) => w[i].camera_name))];
    out.push({
      kind: 'circling',
      message: `Circled ${names.join(' ↔ ')} ${Math.max(...loops.map((l) => l.length)) - 1} times in ${formatDuration(span)} without a destination.`,
      waypoint_indices: idxs,
    });
  }
  return out;
}
