import { describe, it, expect } from 'vitest';
import { fetchCongestionMetrics, fetchODPairs, fetchCorridors } from './api';
import { mockCongestionMetrics, mockODPairs, mockCorridors } from '@/mocks/fixtures/mockAnalytics';

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
