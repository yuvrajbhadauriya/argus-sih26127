// ═══════════════════════════════════════════════════
// Simulated city network — lazy loaders for /sim/*.json
// Files are fetched on first use only (never bundled) and memoised.
// ═══════════════════════════════════════════════════

import type { Trajectory, Vehicle } from '@/types';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { reportSimUnavailable } from '@/lib/dataSource';
import { SIM_JOURNEYS_URL, SIM_ROUTES_URL, SIM_SUMMARY_URL } from './config';
import { normalizePlate } from './lib/geo';
import {
  indexJourneys,
  trajectoryFromJourneys,
  vehiclesFromJourneys,
  type CameraRef,
  type RoadRoutesDoc,
  type SimJourney,
  type SimJourneysDoc,
} from './lib/trajectory';

export interface SimSummaryDoc {
  seed: number;
  date: string;
  routes_source: string;
  stats: {
    vehicles: number;
    journeys: number;
    sightings: number;
    avg_cameras_per_journey: number;
    multi_camera_journeys: number;
  };
  demo: {
    watchlist: { plate_text: string; category: string; priority: string; reason: string; cameras: string[] }[];
    anomalies: { kind: string; plate_text: string; description: string }[];
    suggested_plates: string[];
  };
}

export interface SimNetwork {
  doc: SimJourneysDoc;
  routes: RoadRoutesDoc | null;
  cameras: Map<string, CameraRef>;
  byPlate: Map<string, SimJourney[]>;
  vehicles: Vehicle[];
}

export interface PlateSuggestion {
  plate_text: string;
  label: string;
  kind: 'watchlist' | 'anomaly' | 'multi-camera';
  /** Watchlist priority (watchlist suggestions from summary.json). */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Watchlist reason / anomaly description. */
  reason?: string;
}

async function getJson<T>(url: string): Promise<T> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
    return (await res.json()) as T;
  } catch (err) {
    // Tell the data-source indicator (top bar) that only fixtures are left.
    reportSimUnavailable();
    throw err;
  }
}

/** Memoise an async loader; a failed load is forgotten so it can be retried. */
function memo<T>(load: () => Promise<T>): { get: () => Promise<T>; reset: () => void } {
  let p: Promise<T> | null = null;
  return {
    get: () => {
      if (!p) p = load().catch((e) => { p = null; throw e; });
      return p;
    },
    reset: () => { p = null; },
  };
}

/** Camera registry keyed by code: road-routes file first, mock registry as fallback. */
export function buildCameraIndex(routes: RoadRoutesDoc | null): Map<string, CameraRef> {
  const out = new Map<string, CameraRef>();
  for (const c of mockCameras) out.set(c.code, { id: c.id, code: c.code, name: c.name, lat: c.lat, lng: c.lng, road: c.road });
  for (const c of routes?.cameras ?? []) {
    const base = out.get(c.code);
    out.set(c.code, { id: base?.id ?? c.code, code: c.code, name: base?.name ?? c.name, lat: c.lat, lng: c.lng, road: c.road ?? base?.road });
  }
  return out;
}

const routesLoader = memo(async () => {
  try {
    return await getJson<RoadRoutesDoc>(SIM_ROUTES_URL);
  } catch (err) {
    console.warn('Road routes unavailable; trajectories will use straight lines.', err);
    return null;
  }
});

const networkLoader = memo(async (): Promise<SimNetwork> => {
  const [doc, routes] = await Promise.all([getJson<SimJourneysDoc>(SIM_JOURNEYS_URL), routesLoader.get()]);
  return {
    doc,
    routes,
    cameras: buildCameraIndex(routes),
    byPlate: indexJourneys(doc),
    vehicles: vehiclesFromJourneys(doc),
  };
});

const summaryLoader = memo(() => getJson<SimSummaryDoc>(SIM_SUMMARY_URL));

export const loadRoadRoutes = () => routesLoader.get();
export const loadSimNetwork = () => networkLoader.get();
export const loadSimSummary = () => summaryLoader.get();

/** Test hook: forget memoised files. */
export function resetSimCache() {
  routesLoader.reset();
  networkLoader.reset();
  summaryLoader.reset();
}

export async function getSimTrajectory(plate: string): Promise<Trajectory | null> {
  const net = await loadSimNetwork();
  const journeys = net.byPlate.get(normalizePlate(plate));
  return journeys ? trajectoryFromJourneys(journeys, net.cameras, net.routes) : null;
}

export async function searchSimVehicles(query: string): Promise<Vehicle[]> {
  const net = await loadSimNetwork();
  const q = normalizePlate(query);
  if (!q) return net.vehicles;
  return net.vehicles.filter((v) => normalizePlate(v.plate_text).includes(q));
}

const CATEGORY_LABEL: Record<string, string> = {
  stolen: 'Stolen', wanted: 'Wanted', missing: 'Missing', flagged: 'Flagged',
};
const ANOMALY_LABEL: Record<string, string> = { cloned_plate: 'Cloned plate', circling: 'Circling' };

/** Demo plates: watchlist first, then anomalies, then long multi-camera journeys. */
export async function getPlateSuggestions(limit = 10): Promise<PlateSuggestion[]> {
  const out: PlateSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: PlateSuggestion) => {
    if (seen.has(s.plate_text) || out.length >= limit) return;
    seen.add(s.plate_text);
    out.push(s);
  };
  try {
    const summary = await loadSimSummary();
    summary.demo.watchlist.forEach((w) =>
      push({
        plate_text: w.plate_text,
        kind: 'watchlist',
        label: CATEGORY_LABEL[w.category] ?? 'Watchlist',
        priority: (['critical', 'high', 'medium', 'low'] as const).find((p) => p === w.priority),
        reason: w.reason,
      }),
    );
    summary.demo.anomalies.forEach((a) =>
      push({ plate_text: a.plate_text, kind: 'anomaly', label: ANOMALY_LABEL[a.kind] ?? 'Anomaly', reason: a.description.replace(/\s*\u2194\s*/g, ' and ') }),
    );
    summary.demo.suggested_plates.forEach((p) => push({ plate_text: p, kind: 'multi-camera', label: 'Multi-camera' }));
    return out;
  } catch {
    // summary.json missing — derive from the journeys themselves.
  }
  const net = await loadSimNetwork();
  for (const j of net.doc.journeys) {
    if (j.tags?.includes('watchlist')) push({ plate_text: j.plate_text, kind: 'watchlist', label: 'Watchlist' });
  }
  for (const j of net.doc.journeys) {
    const a = j.tags?.find((t) => t.startsWith('anomaly:'));
    if (a) push({ plate_text: j.plate_text, kind: 'anomaly', label: ANOMALY_LABEL[a.slice(8)] ?? 'Anomaly' });
  }
  net.vehicles.forEach((v) => push({ plate_text: v.plate_text, kind: 'multi-camera', label: 'Multi-camera' }));
  return out;
}
