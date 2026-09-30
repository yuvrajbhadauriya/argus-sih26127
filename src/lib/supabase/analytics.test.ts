import { describe, it, expect } from 'vitest';
import { fetchCongestionMetrics, fetchODPairs, fetchCorridors } from './analytics';
import { mockCongestionMetrics, mockODPairs, mockCorridors } from '@/data/mockAnalytics';
import * as barrel from './index';

describe('analytics data layer', () => {
  // NOTE: analytics is mock-only even when Supabase is configured (no DB query exists).
  it('returns mock analytics', async () => {
    expect(await fetchCongestionMetrics()).toBe(mockCongestionMetrics);
    expect(await fetchODPairs()).toBe(mockODPairs);
    expect(await fetchCorridors()).toBe(mockCorridors);
  });

  it('mock analytics data is internally consistent', () => {
    for (const m of mockCongestionMetrics) {
      expect(['low', 'medium', 'high']).toContain(m.congestion_level);
      expect(m.detection_count).toBeGreaterThanOrEqual(0);
    }
    for (const p of mockODPairs) {
      expect(p.trip_count).toBeGreaterThanOrEqual(0);
      expect(Math.abs(p.origin_lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.destination_lng)).toBeLessThanOrEqual(180);
    }
    expect(new Set(mockCorridors.map((c) => c.id)).size).toBe(mockCorridors.length);
  });
});

describe('supabase barrel export', () => {
  it('exposes the public data-access API', () => {
    for (const name of [
      'supabase', 'isSupabaseConfigured', 'getCameras', 'getCameraById', 'getCamerasByZone',
      'fetchCameras', 'searchVehicles', 'fetchTrajectoryByPlate', 'fetchAlerts', 'acknowledgeAlert',
      'fetchBlacklistEntries', 'fetchCongestionMetrics', 'fetchODPairs', 'fetchCorridors',
    ]) {
      expect(barrel).toHaveProperty(name);
    }
    expect(barrel.fetchCameras).toBe(barrel.getCameras);
  });

  it('isSupabaseConfigured() is false in the test env (no network)', () => {
    expect(barrel.isSupabaseConfigured()).toBe(false);
  });
});
