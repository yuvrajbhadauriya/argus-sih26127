-- ═══════════════════════════════════════════════════
-- Delhi camera network: real junction placements for the 9 prototype cameras
--
-- The camera clips are stock traffic footage, so each virtual camera is pinned
-- to a real, recognisable Delhi junction / arterial road (coordinates verified
-- against OpenStreetMap via the OSRM `nearest` service). This keeps the map,
-- the ingestion pipeline and the trajectory simulator on one registry:
--   * src/mocks/fixtures/mockCameras.ts
--   * pipeline/camera_config.json
--   * this file
-- (consistency is enforced by pipeline/tests/test_simulation_registry.py).
--
-- Safe to re-run. Upserts all 9 cameras (the init migration seeded only 5),
-- keeps any existing video_url/status, and re-stamps stored detection
-- coordinates so they match their camera.
-- ═══════════════════════════════════════════════════

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS road TEXT;

INSERT INTO public.cameras (id, name, code, lat, lng, zone, direction, road, status, video_url)
VALUES
  ('cam-001', 'India Gate Junction', 'IG-01', 28.6155, 77.2297, 'Central Delhi', 'Southbound', 'C-Hexagon at Kasturba Gandhi Marg', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13052823_3840_2160_30fps.mp4'),
  ('cam-002', 'Connaught Place Circle', 'CP-01', 28.6315, 77.2167, 'Central Delhi', 'Northbound', 'Outer Circle at Baba Kharak Singh Marg', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13067896_3840_2160_30fps.mp4'),
  ('cam-003', 'Karol Bagh Crossing', 'KB-01', 28.6440, 77.1883, 'West Delhi', 'Eastbound', 'Pusa Road near Karol Bagh Metro', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13268898_3840_2160_30fps.mp4'),
  ('cam-004', 'Lajpat Nagar Flyover', 'LN-01', 28.5650, 77.2402, 'South Delhi', 'Westbound', 'Ring Road (Mahatma Gandhi Marg), Lajpat Nagar Flyover', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13172888_3840_2160_30fps.mp4'),
  ('cam-005', 'AIIMS T-Junction', 'AI-01', 28.5706, 77.2080, 'South Delhi', 'Eastbound', 'Ring Road (AIIMS Flyover) at Aurobindo Marg', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13269027_3840_2160_30fps.mp4'),
  ('cam-006', 'Nehru Place Underpass', 'NP-01', 28.5463, 77.2510, 'South Delhi', 'Eastbound', 'Outer Ring Road at Nehru Place', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13269676_3840_2160_30fps.mp4'),
  ('cam-007', 'Chandni Chowk Gate', 'CC-01', 28.6561, 77.2367, 'Old Delhi', 'Northbound', 'Netaji Subhash Marg at Chandni Chowk (Lal Qila crossing)', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13052823_3840_2160_30fps.mp4'),
  ('cam-008', 'Dwarka Expressway Entry', 'DW-01', 28.5437, 77.0676, 'West Delhi', 'Eastbound', 'Dwarka Expressway (NH-248BB) near Sector 25', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13067896_3840_2160_30fps.mp4'),
  ('cam-009', 'Dhaula Kuan Interchange', 'DK-01', 28.5924, 77.1611, 'South West Delhi', 'Westbound', 'NH-48 at Dhaula Kuan Interchange', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/13268898_3840_2160_30fps.mp4')
ON CONFLICT (id) DO UPDATE SET
  name       = EXCLUDED.name,
  code       = EXCLUDED.code,
  lat        = EXCLUDED.lat,
  lng        = EXCLUDED.lng,
  zone       = EXCLUDED.zone,
  direction  = EXCLUDED.direction,
  road       = EXCLUDED.road,
  updated_at = NOW();

-- Keep denormalised detection coordinates in step with their camera.
UPDATE public.detections d
SET lat = c.lat,
    lng = c.lng
FROM public.cameras c
WHERE d.camera_id = c.id
  AND (d.lat IS DISTINCT FROM c.lat OR d.lng IS DISTINCT FROM c.lng);
