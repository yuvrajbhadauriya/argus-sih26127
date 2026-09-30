-- ═══════════════════════════════════════════════════
-- Camera clip upgrade: SC-01, KR-01 and BH-01 get clips the ANPR model can read
--
-- The three clips these cameras played gave 0 good reads (OCR confidence >= 75
-- and grammar-valid) from the team's LPU model: a far, dark portrait night
-- junction (KR-01), a far overhead rain view (BH-01) and a wide overhead view
-- whose plates are too small at 1080p (SC-01). They are replaced by roadside,
-- low-angle Mumbai clips (Pexels, aksinfo7 universe) with front plates close
-- to the camera, picked by scoring 30 candidates on the real model API (see
-- pipeline/data/candidate_clips_v2/SCORES.md):
--
--   SC-01  mumbai_flyover-roadside-front-plates_pexels30381474   0 -> 26 good reads
--   KR-01  mumbai_flyover-roadside-approach-taxis_pexels31048404 0 ->  7
--   BH-01  mumbai_roadside-best-bus-front_pexels30249348         0 -> 10
--
-- Camera ids, codes, names and coordinates are unchanged, so routes, the
-- simulation and every foreign key stay valid. New object names are used in
-- the private `videos` bucket (mumbai/720p/<slug>.mp4), so no stale CDN copy of
-- an old public URL can be served.
--
-- Detections ingested from the old clips describe different footage (their
-- boxes would not line up with the new videos), so they are removed; alerts
-- keep their own copy (alerts.detection_id is ON DELETE SET NULL). The new
-- reads are upserted by pipeline/insert_detections.py. Safe to re-run.
-- ═══════════════════════════════════════════════════

UPDATE public.cameras AS c
SET video_url  = v.video_url,
    updated_at = NOW()
FROM (VALUES
  ('cam-004', 'SC-01', 'https://zkmtjqsljwwyjpgvgyyp.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_flyover-roadside-front-plates_pexels30381474.mp4'),
  ('cam-007', 'KR-01', 'https://zkmtjqsljwwyjpgvgyyp.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_flyover-roadside-approach-taxis_pexels31048404.mp4'),
  ('cam-008', 'BH-01', 'https://zkmtjqsljwwyjpgvgyyp.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_roadside-best-bus-front_pexels30249348.mp4')
) AS v(id, code, video_url)
WHERE c.id = v.id
  AND c.code = v.code
  AND c.video_url IS DISTINCT FROM v.video_url;

DELETE FROM public.detections d
USING public.cameras c
WHERE d.camera_id = c.id
  AND (c.code, d.source_video) IN (
    ('SC-01', 'mumbai_overhead-dense-bus-autos_pexels31046718.mp4'),
    ('KR-01', 'india_night-overhead-junction_pexels34766759.mp4'),
    ('BH-01', 'india_rain-overhead-wet-road_pexels33588922.mp4')
  );
