// ═══════════════════════════════════════════════════
// Supabase Data Access Layer — Vehicles & Trajectories
//
// Supabase is used whenever it is configured and actually holds a multi-camera
// trajectory for the plate. Otherwise the simulated city network
// (/sim/journeys.json + /sim/road_routes.json, loaded lazily) is used.
// ═══════════════════════════════════════════════════

import type { Vehicle, Trajectory } from '@/types';
import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';
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

  try {
    let dbQuery = supabase.from('vehicles').select('*');
    if (normalized) {
      dbQuery = dbQuery.ilike('plate_text', `%${normalized}%`);
    } else {
      dbQuery = dbQuery.order('last_seen', { ascending: false }).limit(100);
    }

    const { data, error } = await dbQuery;

    if (error || !data) {
      console.warn('DB vehicles query error, falling back to simulated network:', error);
      return simVehiclesOrEmpty(normalized);
    }

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
  } catch (err) {
    console.warn('Failed to query vehicles view:', err);
    return simVehiclesOrEmpty(normalized);
  }
}

/** Trajectory from Supabase (trajectories relation, else reconstructed from detections). */
async function fetchDbTrajectory(normalized: string): Promise<Trajectory | null> {
  const { data, error } = await supabase
    .from('trajectories')
    .select('*')
    .eq('plate_text', normalized)
    .maybeSingle();

  if (!error && data) return data as Trajectory;

  const { data: dets } = await supabase
    .from('detections')
    .select('*, cameras(name, code, latitude, longitude)')
    .eq('plate_text_normalized', normalizePlate(normalized))
    .order('detected_at', { ascending: true });

  if (!dets || dets.length === 0) return null;

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

  let db: Trajectory | null = null;
  try {
    db = await fetchDbTrajectory(normalized);
  } catch (err) {
    console.warn('Error fetching trajectory from Supabase:', err);
  }

  // Prefer real data when it shows an actual cross-camera journey.
  if (db && db.camera_count >= 2) return withRoads(db);

  const sim = await simTrajectoryOrNull(normalized);
  if (sim) return sim;
  return db ? withRoads(db) : null;
}
