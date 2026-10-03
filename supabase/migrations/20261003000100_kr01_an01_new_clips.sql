-- ═══════════════════════════════════════════════════
-- KR-01 and AN-01 get new clips (Pexels videos 12974288 and 13270133, Pexels License)
--
--   KR-01  mumbai_flyover-roadside-approach-taxis_pexels31048404 -> mumbai_kurla-depot-junction_pexels12974288
--   AN-01  mumbai_overhead-flyover-receding_pexels31048580       -> mumbai_andheri-flyover-gundavali_pexels13270133
--
-- Camera ids, codes, names, zones, directions, roads and coordinates are
-- unchanged. Apply this AFTER `pipeline/tools/replace_camera_clip.py --upload`
-- has put the new clips in the private `videos` bucket (mumbai/720p/) and
-- BEFORE running `pipeline/insert_detections.py --prune`, which writes the
-- reads the model found on the new clips.
--
-- Detections ingested from the old clips describe different footage (their
-- boxes and plates are not in the new videos), so they are removed; alerts
-- keep their own copy (alerts.detection_id is ON DELETE SET NULL). Safe to re-run.
-- ═══════════════════════════════════════════════════

UPDATE public.cameras AS c
SET video_url  = v.video_url,
    updated_at = NOW()
FROM (VALUES
  ('cam-007', 'KR-01', 'https://zkmtjqsljwwyjpgvgyyp.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_kurla-depot-junction_pexels12974288.mp4'),
  ('cam-002', 'AN-01', 'https://zkmtjqsljwwyjpgvgyyp.supabase.co/storage/v1/object/public/videos/mumbai/720p/mumbai_andheri-flyover-gundavali_pexels13270133.mp4')
) AS v(id, code, video_url)
WHERE c.id = v.id
  AND c.code = v.code
  AND c.video_url IS DISTINCT FROM v.video_url;

DELETE FROM public.detections d
USING public.cameras c
WHERE d.camera_id = c.id
  AND (c.code, d.source_video) IN (
    ('KR-01', 'mumbai_flyover-roadside-approach-taxis_pexels31048404.mp4'),
    ('AN-01', 'mumbai_overhead-flyover-receding_pexels31048580.mp4')
  );
