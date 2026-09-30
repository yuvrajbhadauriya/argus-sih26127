// ═══════════════════════════════════════════════════
// Mock Analytics Data (Phase 5)
// Congestion metrics, OD pairs, and Corridor stats
// ═══════════════════════════════════════════════════

import type { CongestionMetric, ODPair, CorridorStats } from '@/types';

export const mockCongestionMetrics: CongestionMetric[] = [
  { zone: 'Western Suburbs', time_bucket: '08:00 - 09:00', detection_count: 1580, avg_speed: 17, congestion_level: 'high' },
  { zone: 'Island City', time_bucket: '08:00 - 09:00', detection_count: 1240, avg_speed: 21, congestion_level: 'medium' },
  { zone: 'Eastern Suburbs', time_bucket: '08:00 - 09:00', detection_count: 960, avg_speed: 26, congestion_level: 'medium' },
];

// Coordinates are camera sites from mockCameras.ts.
export const mockODPairs: ODPair[] = [
  {
    origin_zone: 'Western Suburbs',
    destination_zone: 'Island City',
    origin_lat: 19.0995, // VP-01 Vile Parle
    origin_lng: 72.85411,
    destination_lat: 19.02041, // DD-01 Dadar TT
    destination_lng: 72.84968,
    trip_count: 470,
    avg_travel_time_seconds: 1680, // 28 mins
  },
  {
    origin_zone: 'Eastern Suburbs',
    destination_zone: 'Island City',
    origin_lat: 19.14194, // BH-01 Bhandup
    origin_lng: 72.93236,
    destination_lat: 19.04273, // SN-01 Sion Circle
    destination_lng: 72.86349,
    trip_count: 340,
    avg_travel_time_seconds: 2040, // 34 mins
  },
  {
    origin_zone: 'Western Suburbs',
    destination_zone: 'Eastern Suburbs',
    origin_lat: 19.1395, // JG-01 Jogeshwari (JVLR)
    origin_lng: 72.85487,
    destination_lat: 19.14194, // BH-01 Bhandup
    destination_lng: 72.93236,
    trip_count: 260,
    avg_travel_time_seconds: 1860, // 31 mins
  },
];

export const mockCorridors: CorridorStats[] = [
  {
    id: 'corr-01',
    name: 'Western Express Highway (Jogeshwari – Santacruz)',
    from_zone: 'Western Suburbs',
    to_zone: 'Western Suburbs',
    trajectory_count: 720,
    avg_travel_time_seconds: 1020, // 17 mins
    peak_hour: '09:00 AM - 10:00 AM',
    peak_count: 240,
  },
  {
    id: 'corr-02',
    name: 'LBS Marg (Bhandup – Kurla – Sion)',
    from_zone: 'Eastern Suburbs',
    to_zone: 'Island City',
    trajectory_count: 480,
    avg_travel_time_seconds: 1560, // 26 mins
    peak_hour: '08:30 AM - 09:30 AM',
    peak_count: 165,
  },
  {
    id: 'corr-03',
    name: 'JVLR (Jogeshwari – Vikhroli link)',
    from_zone: 'Western Suburbs',
    to_zone: 'Eastern Suburbs',
    trajectory_count: 390,
    avg_travel_time_seconds: 1500, // 25 mins
    peak_hour: '06:00 PM - 07:00 PM',
    peak_count: 130,
  },
];
