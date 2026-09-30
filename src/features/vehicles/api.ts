// ═══════════════════════════════════════════════════
// Data Access Layer — Vehicles & Trajectories
//
// Live (Supabase configured): the `vehicles` / `trajectories` views via
// /api/data/vehicles and /api/data/trajectory (the database is private). A query
// ERROR is thrown (the page shows ErrorState). When the database simply has no
// multi-camera journey for a plate (e.g. only the 8 demo clips were processed),
// the simulated city network is used instead and the result is tagged
// `source: 'simulation'`, which the page labels with the SimulationBadge.
// Not configured: the simulated city network (/sim/*.json, loaded lazily).
// ═══════════════════════════════════════════════════

import type { Vehicle, Trajectory } from '@/types';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { apiGet, apiRows } from '@/lib/dataApi';
import { reportLiveError, reportLiveOk } from '@/lib/dataSource';
import { DEFAULT_LOCATION } from '@/config/constants';
import { normalizePlate } from './lib/geo';
import { enrichWithRoads } from './lib/trajectory';
import { buildCameraIndex, getSimTrajectory, loadRoadRoutes, searchSimVehicles } from './sim';

export { normalizePlate };

async function simVehiclesOrEmpty(query: string): Promise<Vehicle[]> {
  try {
    return await searchSimVehicles(query);
  } catch (err) {
    console.warn('Simulated vehicle list unavailable:', err);
    return [];
  }
}

async function simTrajectoryOrNull(plate: string): Promise<Trajectory | null> {
  try {
    return await getSimTrajectory(plate);
  } catch (err) {
    console.warn('Simulated trajectory unavailable:', err);
    return null;
  }
}

/** Search vehicles by plate substring (ignores spaces, hyphens and case) or list recent vehicles */
export async function searchVehicles(query: string = ''): Promise<Vehicle[]> {
  const normalized = query.trim().toUpperCase();

  if (!isSupabaseConfigured()) {
    return simVehiclesOrEmpty(normalized);
  }

  // The server matches the normalised plate (spaces/hyphens ignored) or lists
  // the 100 most recently seen vehicles.
  let data: unknown[];
  try {
    data = await apiRows('vehicles', { q: normalizePlate(normalized) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportLiveError(message);
    throw new Error(`Failed to search vehicles: ${message}`);
  }
  reportLiveOk();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = data.map((row: any) => ({
    plate_text: row.plate_text || row.plate || 'UNKNOWN',
    vehicle_type: row.vehicle_type || 'car',
    first_seen: row.first_seen || new Date().toISOString(),
    last_seen: row.last_seen || new Date().toISOString(),
    detection_count: row.detection_count ?? 1,
    camera_count: row.camera_count ?? 1,
  })) as Vehicle[];
  return rows.length > 0 ? rows : simVehiclesOrEmpty(normalized);
}

/** Trajectory from the database (trajectories view, else reconstructed from the plate's reads). */
async function fetchDbTrajectory(normalized: string): Promise<Trajectory | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: { trajectory?: any; detections?: any[] };
  try {
    body = await apiGet('trajectory', { plate: normalizePlate(normalized) });
  } catch (err) {
    throw new Error(`Failed to load trajectory: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (body.trajectory) return { ...(body.trajectory as Trajectory), source: 'supabase' };

  const dets = Array.isArray(body.detections) ? body.detections : [];
  if (dets.length === 0) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = (d: any): string => d.detected_at ?? d.timestamp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waypoints = dets.map((d: any, idx: number) => {
    const cam = d.cameras || {};
    const prevTs = idx > 0 ? new Date(ts(dets[idx - 1])).getTime() : null;
    const curTs = new Date(ts(d)).getTime();
    return {
      camera_id: d.camera_id,
      camera_name: cam.name || 'CCTV Node',
      camera_code: cam.code || undefined,
      lat: d.latitude || d.lat || cam.lat || cam.latitude || DEFAULT_LOCATION.lat,
      lng: d.longitude || d.lng || cam.lng || cam.longitude || DEFAULT_LOCATION.lng,
      timestamp: ts(d),
      time_since_previous_seconds: prevTs ? Math.round((curTs - prevTs) / 1000) : null,
    };
  });

  const firstTime = new Date(ts(dets[0])).getTime();
  const lastTime = new Date(ts(dets[dets.length - 1])).getTime();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uniqueCams = new Set(dets.map((d: any) => d.camera_id)).size;

  return {
    id: `traj-${normalized}`,
    plate_text: dets[0].plate_text_raw || normalized,
    vehicle_type: dets[0].vehicle_type || 'car',
    waypoints,
    total_travel_time_seconds: Math.max(0, Math.round((lastTime - firstTime) / 1000)),
    camera_count: uniqueCams,
    first_seen: ts(dets[0]),
    last_seen: ts(dets[dets.length - 1]),
    source: 'supabase',
  };
}

/** Snap a database trajectory onto road geometry (best effort). */
async function withRoads(t: Trajectory): Promise<Trajectory> {
  if (!Array.isArray(t.waypoints) || t.waypoints.length === 0) return t;
  try {
    const routes = await loadRoadRoutes();
    return enrichWithRoads(t, buildCameraIndex(routes), routes);
  } catch {
    return t;
  }
}

/** Fetch vehicle trajectory by plate (spaces, hyphens and case are ignored) */
export async function fetchTrajectoryByPlate(plate: string): Promise<Trajectory | null> {
  const normalized = plate.trim().toUpperCase();
  if (!normalized) return null;

  if (!isSupabaseConfigured()) {
    return simTrajectoryOrNull(normalized);
  }

  let db: Trajectory | null;
  try {
    db = await fetchDbTrajectory(normalized);
    reportLiveOk();
  } catch (err) {
    reportLiveError(err);
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Prefer real data when it shows an actual cross-camera journey.
  if (db && db.camera_count >= 2) return withRoads(db);

  const sim = await simTrajectoryOrNull(normalized);
  if (sim) return sim;
  return db ? withRoads(db) : null;
}
