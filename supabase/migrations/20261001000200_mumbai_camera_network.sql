-- ═══════════════════════════════════════════════════
-- Mumbai camera network: moves the prototype from Delhi to Mumbai
--
-- The camera feeds are now real Mumbai traffic clips (Pexels, see
-- pipeline/data/candidate_clips/SOURCES.md), transcoded to 720p and stored in
-- the public `videos` bucket at mumbai/720p/<slug>.mp4 (+ <slug>.jpg poster).
-- Each clip is pinned to the Mumbai junction it was plausibly shot at
-- (signage in the frame where visible, e.g. the "Vile Parle Flyover" sign on
-- the Western Express Highway); coordinates were snapped with the OSRM
-- `nearest` service and sit on the carriageway median of divided roads.
-- One registry, kept consistent by pipeline/tests/test_simulation_registry.py:
--   * src/mocks/fixtures/mockCameras.ts
--   * pipeline/camera_config.json
--   * this file
--
-- Supersedes 20260930_delhi_camera_network.sql (kept for history) and sorts
-- after it, so a fresh `supabase db reset` ends on the Mumbai registry. It
-- does not depend on the 20261001 reconcile/RLS migrations. Safe to re-run:
-- upserts cam-001..cam-008 with the new code, location and video, and retires
-- the ninth Delhi camera (cam-009).
-- ═══════════════════════════════════════════════════

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS road TEXT;

INSERT INTO public.cameras (id, name, code, lat, lng, zone, direction, road, status, video_url)
VALUES
  ('cam-001', 'Jogeshwari JVLR Junction', 'JG-01', 19.1395, 72.85487, 'Western Suburbs', 'Northbound', 'Western Express Highway at the JVLR interchange', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_overhead-jam-6lane_pexels31046764.mp4'),
  ('cam-002', 'Andheri Flyover (Gundavali)', 'AN-01', 19.1165, 72.85522, 'Western Suburbs', 'Southbound', 'Western Express Highway at Andheri–Kurla Road (Andheri Flyover)', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_overhead-flyover-receding_pexels31048580.mp4'),
  ('cam-003', 'Vile Parle Flyover', 'VP-01', 19.0995, 72.85411, 'Western Suburbs', 'Northbound', 'Western Express Highway at Vile Parle Flyover', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_overhead-dense-jam-plates_pexels31048534.mp4'),
  ('cam-004', 'Santacruz Airport Approach', 'SC-01', 19.089, 72.84355, 'Western Suburbs', 'Southbound', 'Western Express Highway near Airport Terminal 1 (Santacruz)', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_overhead-dense-bus-autos_pexels31046718.mp4'),
  ('cam-005', 'Dadar TT Junction', 'DD-01', 19.02041, 72.84968, 'Island City', 'Southbound', 'Dr Babasaheb Ambedkar Road beside Dadar TT Flyover', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_flyover-closeup-rear-plates_pexels30169858.mp4'),
  ('cam-006', 'Sion Circle', 'SN-01', 19.04273, 72.86349, 'Island City', 'Eastbound', 'Sion Circle at Sion–Panvel Highway (Sion Flyover)', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_overhead-signal-multilane_pexels30609021.mp4'),
  ('cam-007', 'Kurla Depot Junction', 'KR-01', 19.07447, 72.87619, 'Eastern Suburbs', 'Northbound', 'LBS Marg at Kurla Depot, Kurla West', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/india_night-overhead-junction_pexels34766759.mp4'),
  ('cam-008', 'Bhandup LBS Marg', 'BH-01', 19.14194, 72.93236, 'Eastern Suburbs', 'Southbound', 'LBS Marg at Bhandup West (Metro Line 4)', 'online', 'https://ngwrbxiaeressvmhfopb.supabase.co/storage/v1/object/public/videos/mumbai/720p/india_rain-overhead-wet-road_pexels33588922.mp4')
ON CONFLICT (id) DO UPDATE SET
  name       = EXCLUDED.name,
  code       = EXCLUDED.code,
  lat        = EXCLUDED.lat,
  lng        = EXCLUDED.lng,
  zone       = EXCLUDED.zone,
  direction  = EXCLUDED.direction,
  road       = EXCLUDED.road,
  status     = EXCLUDED.status,
  video_url  = EXCLUDED.video_url,
  updated_at = NOW();

-- The Delhi network had nine cameras; Mumbai has 8. Drop cam-009 when nothing
-- references it, otherwise keep the row but take it offline.
UPDATE public.cameras SET status = 'offline', updated_at = NOW() WHERE id = 'cam-009';
DELETE FROM public.cameras c
WHERE c.id = 'cam-009'
  AND NOT EXISTS (SELECT 1 FROM public.detections d WHERE d.camera_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.camera_id = c.id);

-- Keep denormalised detection coordinates in step with their camera.
UPDATE public.detections d
SET lat = c.lat,
    lng = c.lng
FROM public.cameras c
WHERE d.camera_id = c.id
  AND (d.lat IS DISTINCT FROM c.lat OR d.lng IS DISTINCT FROM c.lng);

-- Optional clean-up (NOT run automatically): detections ingested from the old
-- Delhi clips describe different footage, so their bounding boxes will not
-- line up with the new Mumbai videos. Once the ANPR pipeline has been re-run
-- on the new clips, the stale rows can be removed with e.g.
--   DELETE FROM public.alerts     WHERE camera_id IN (SELECT id FROM public.cameras)
--                                   AND created_at < '2026-09-30';
--   DELETE FROM public.detections WHERE detected_at < '2026-09-30';
