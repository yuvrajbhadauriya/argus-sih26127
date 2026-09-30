// ═══════════════════════════════════════════════════
// Data layer — Traffic Analytics
//
// Network analytics are aggregated client-side from the simulated city
// network (public/sim, loaded lazily and shared with Vehicle Trace).
// Production: the same aggregates come from Postgres materialised views over
// `detections` (see docs/ARCHITECTURE.md).
// ═══════════════════════════════════════════════════

import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { loadSimNetwork, loadSimSummary, type SimSummaryDoc } from '@/features/vehicles/sim';
import { aggregateNetwork, type CameraMeta, type NetworkAnalytics, type TimeWindowId } from './lib/aggregate';

/** Camera registry used for zones / coordinates in analytics. */
export const ANALYTICS_CAMERAS: CameraMeta[] = mockCameras.map((c) => ({ code: c.code, name: c.name, zone: c.zone, lat: c.lat, lng: c.lng }));

const cache = new Map<string, NetworkAnalytics>();

/** Aggregated network analytics for a time window (memoised per window). */
export async function fetchNetworkAnalytics(windowId: TimeWindowId = 'all'): Promise<NetworkAnalytics> {
  const hit = cache.get(windowId);
  if (hit) return hit;
  const net = await loadSimNetwork();
  const out = aggregateNetwork(net.doc.journeys, ANALYTICS_CAMERAS, windowId);
  cache.set(windowId, out);
  return out;
}

/** Pre-computed headline stats (small file; available before journeys load). */
export function fetchSimSummaryStats(): Promise<SimSummaryDoc> {
  return loadSimSummary();
}

/** Test hook. */
export function clearAnalyticsCache() {
  cache.clear();
}
