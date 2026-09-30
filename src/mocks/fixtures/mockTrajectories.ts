// ═══════════════════════════════════════════════════
// Mock Vehicles & Trajectories Data (Phase 3)
// Small, hand-written fixtures kept for unit tests. The Vehicles page itself
// now uses Supabase or the simulated city network (public/sim/*.json).
// Camera coordinates come from the shared registry in mockCameras.ts.
// ═══════════════════════════════════════════════════

import type { Vehicle, Trajectory } from '@/types';
import { mockCameras } from './mockCameras';

const cam = (id: string) => {
  const c = mockCameras.find((x) => x.id === id)!;
  return { camera_id: c.id, camera_name: c.name, camera_code: c.code, lat: c.lat, lng: c.lng };
};

export const mockVehicles: Vehicle[] = [
  {
    plate_text: 'DL-01-AB-1234',
    vehicle_type: 'car',
    first_seen: '2026-09-25T08:12:00Z',
    last_seen: '2026-09-25T08:45:00Z',
    detection_count: 5,
    camera_count: 3,
  },
  {
    plate_text: 'HR-26-CD-5678',
    vehicle_type: 'truck',
    first_seen: '2026-09-25T07:30:00Z',
    last_seen: '2026-09-25T09:15:00Z',
    detection_count: 4,
    camera_count: 2,
  },
  {
    plate_text: 'DL-02-EF-9012',
    vehicle_type: 'car',
    first_seen: '2026-09-25T09:00:00Z',
    last_seen: '2026-09-25T09:20:00Z',
    detection_count: 3,
    camera_count: 2,
  },
  {
    plate_text: 'UP-16-GH-3456',
    vehicle_type: 'bus',
    first_seen: '2026-09-25T06:45:00Z',
    last_seen: '2026-09-25T08:30:00Z',
    detection_count: 6,
    camera_count: 4,
  },
  {
    plate_text: 'DL-03-IJ-7890',
    vehicle_type: 'motorcycle',
    first_seen: '2026-09-25T10:00:00Z',
    last_seen: '2026-09-25T10:15:00Z',
    detection_count: 2,
    camera_count: 2,
  },
];

export const mockTrajectories: Record<string, Trajectory> = {
  'DL-01-AB-1234': {
    id: 'traj-001',
    plate_text: 'DL-01-AB-1234',
    vehicle_type: 'car',
    waypoints: [
      {
        ...cam('cam-001'),
        timestamp: '2026-09-25T08:12:00Z',
        time_since_previous_seconds: null,
      },
      {
        ...cam('cam-002'),
        timestamp: '2026-09-25T08:27:00Z',
        time_since_previous_seconds: 900, // 15 mins
      },
      {
        ...cam('cam-003'),
        timestamp: '2026-09-25T08:45:00Z',
        time_since_previous_seconds: 1080, // 18 mins
      },
    ],
    total_travel_time_seconds: 1980, // 33 mins
    camera_count: 3,
    first_seen: '2026-09-25T08:12:00Z',
    last_seen: '2026-09-25T08:45:00Z',
  },
  'HR-26-CD-5678': {
    id: 'traj-002',
    plate_text: 'HR-26-CD-5678',
    vehicle_type: 'truck',
    waypoints: [
      {
        ...cam('cam-001'),
        timestamp: '2026-09-25T07:30:00Z',
        time_since_previous_seconds: null,
      },
      {
        ...cam('cam-005'),
        timestamp: '2026-09-25T09:15:00Z',
        time_since_previous_seconds: 6300, // 1h 45m
      },
    ],
    total_travel_time_seconds: 6300,
    camera_count: 2,
    first_seen: '2026-09-25T07:30:00Z',
    last_seen: '2026-09-25T09:15:00Z',
  },
  'DL-02-EF-9012': {
    id: 'traj-003',
    plate_text: 'DL-02-EF-9012',
    vehicle_type: 'car',
    waypoints: [
      {
        ...cam('cam-005'),
        timestamp: '2026-09-25T09:00:00Z',
        time_since_previous_seconds: null,
      },
      {
        ...cam('cam-006'),
        timestamp: '2026-09-25T09:20:00Z',
        time_since_previous_seconds: 1200, // 20 mins
      },
    ],
    total_travel_time_seconds: 1200,
    camera_count: 2,
    first_seen: '2026-09-25T09:00:00Z',
    last_seen: '2026-09-25T09:20:00Z',
  },
};
