// ═══════════════════════════════════════════════════
// Data layer — Traffic Analytics
//
// Network analytics are aggregated client-side from the simulated city
// network (public/sim, loaded lazily and shared with Vehicle Trace). The
// legacy zone/OD/corridor fetchers remain as a mock fallback API.
// ═══════════════════════════════════════════════════

import type { CongestionMetric, ODPair, CorridorStats } from '@/types';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { mockCongestionMetrics, mockODPairs, mockCorridors } from '@/mocks/fixtures/mockAnalytics';
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

export async function fetchCongestionMetrics(): Promise<CongestionMetric[]> {
  if (!isSupabaseConfigured()) {
    return mockCongestionMetrics;
  }
  return mockCongestionMetrics;
}

export async function fetchODPairs(): Promise<ODPair[]> {
  if (!isSupabaseConfigured()) {
    return mockODPairs;
  }
  return mockODPairs;
}

export async function fetchCorridors(): Promise<CorridorStats[]> {
  if (!isSupabaseConfigured()) {
    return mockCorridors;
  }
  return mockCorridors;
}
