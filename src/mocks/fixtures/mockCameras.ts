// ═══════════════════════════════════════════════════
// Mock Camera Data — 9 Virtual Cameras linked to Supabase Storage Traffic Videos
// Camera placements are real Delhi junctions/arterials (the clips themselves are
// stock footage). Keep in sync with pipeline/camera_config.json and
// supabase/migrations/20260930_delhi_camera_network.sql (checked by
// pipeline/tests/test_simulation_registry.py).
// Reads directly from Supabase Storage Public Bucket:
// https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/
// ═══════════════════════════════════════════════════

import type { CameraFeed } from '@/types';

export const mockCameras: CameraFeed[] = [
  {
    id: 'cam-001',
    name: 'India Gate Junction',
    code: 'IG-01',
    lat: 28.6155,
    lng: 77.2297,
    zone: 'Central Delhi',
    direction: 'Southbound',
    road: 'C-Hexagon at Kasturba Gandhi Marg',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13052823_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-002',
    name: 'Connaught Place Circle',
    code: 'CP-01',
    lat: 28.6315,
    lng: 77.2167,
    zone: 'Central Delhi',
    direction: 'Northbound',
    road: 'Outer Circle at Baba Kharak Singh Marg',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13067896_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-003',
    name: 'Karol Bagh Crossing',
    code: 'KB-01',
    lat: 28.644,
    lng: 77.1883,
    zone: 'West Delhi',
    direction: 'Eastbound',
    road: 'Pusa Road near Karol Bagh Metro',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13268898_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-004',
    name: 'Lajpat Nagar Flyover',
    code: 'LN-01',
    lat: 28.565,
    lng: 77.2402,
    zone: 'South Delhi',
    direction: 'Westbound',
    road: 'Ring Road (Mahatma Gandhi Marg), Lajpat Nagar Flyover',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13172888_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-005',
    name: 'AIIMS T-Junction',
    code: 'AI-01',
    lat: 28.5706,
    lng: 77.208,
    zone: 'South Delhi',
    direction: 'Eastbound',
    road: 'Ring Road (AIIMS Flyover) at Aurobindo Marg',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13269027_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-006',
    name: 'Nehru Place Underpass',
    code: 'NP-01',
    lat: 28.5463,
    lng: 77.251,
    zone: 'South Delhi',
    direction: 'Eastbound',
    road: 'Outer Ring Road at Nehru Place',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13269676_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-007',
    name: 'Chandni Chowk Gate',
    code: 'CC-01',
    lat: 28.6561,
    lng: 77.2367,
    zone: 'Old Delhi',
    direction: 'Northbound',
    road: 'Netaji Subhash Marg at Chandni Chowk (Lal Qila crossing)',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13052823_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-008',
    name: 'Dwarka Expressway Entry',
    code: 'DW-01',
    lat: 28.5437,
    lng: 77.0676,
    zone: 'West Delhi',
    direction: 'Eastbound',
    road: 'Dwarka Expressway (NH-248BB) near Sector 25',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13067896_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
  {
    id: 'cam-009',
    name: 'Dhaula Kuan Interchange',
    code: 'DK-01',
    lat: 28.5924,
    lng: 77.1611,
    zone: 'South West Delhi',
    direction: 'Westbound',
    road: 'NH-48 at Dhaula Kuan Interchange',
    status: 'online',
    video_url: 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13268898_3840_2160_30fps.mp4',
    thumbnail_url: '',
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  },
];

export function getCameraStatusCounts(cameras: CameraFeed[]) {
  return {
    online: cameras.filter((c) => c.status === 'online').length,
    offline: cameras.filter((c) => c.status === 'offline').length,
    maintenance: cameras.filter((c) => c.status === 'maintenance').length,
    total: cameras.length,
  };
}

export function getUniqueZones(cameras: CameraFeed[]): string[] {
  return [...new Set(cameras.map((c) => c.zone))].sort();
}
