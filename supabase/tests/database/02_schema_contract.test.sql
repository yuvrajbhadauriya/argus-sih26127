-- pgTAP: the schema matches what the frontend and the pipeline read/write.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(24);

-- Columns used by src/features/**/api.ts and pipeline/*.py
SELECT is(
  (SELECT array_agg(c ORDER BY c) FROM unnest(ARRAY[
     'event_id', 'camera_id', 'plate_text_raw', 'plate_text_normalized', 'confidence_score',
     'plate_confidence', 'vehicle_type', 'detected_at', 'timestamp', 'lat', 'lng', 'latitude',
     'longitude', 'bbox', 'tracked_vehicle_id', 'frame_timestamp_sec', 'engine', 'model_version',
     'source_video']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'detections' AND column_name = c)),
  NULL, 'detections has every column the app uses');
SELECT is(
  (SELECT array_agg(c ORDER BY c) FROM unnest(ARRAY[
     'id', 'detection_id', 'blacklist_entry_id', 'plate_text', 'camera_id', 'camera_name', 'priority',
     'category', 'reason', 'lat', 'lng', 'status', 'created_at', 'acknowledged', 'acknowledged_by',
     'acknowledged_at', 'alert_type', 'source_key', 'details']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'alerts' AND column_name = c)),
  NULL, 'alerts has every column the app uses');
SELECT is(
  (SELECT array_agg(c ORDER BY c) FROM unnest(ARRAY[
     'id', 'plate_text', 'plate_text_normalized', 'category', 'priority', 'reason', 'notes',
     'valid_from', 'valid_to', 'is_active', 'created_at', 'updated_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'blacklist_entries' AND column_name = c)),
  NULL, 'blacklist_entries has every column the app uses');
SELECT is(
  (SELECT array_agg(c ORDER BY c) FROM unnest(ARRAY[
     'id', 'name', 'code', 'lat', 'lng', 'latitude', 'longitude', 'zone', 'direction', 'road',
     'status', 'video_url', 'created_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'cameras' AND column_name = c)),
  NULL, 'cameras has every column the app uses');

-- Exactly one FK alerts -> detections (PostgREST embedding needs it unambiguous)
SELECT is(
  (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.alerts'::regclass
     AND contype = 'f' AND confrelid = 'public.detections'::regclass),
  1, 'exactly one FK from alerts to detections');
SELECT is(
  (SELECT confdeltype::text FROM pg_constraint WHERE conname = 'alerts_detection_id_fkey'),
  'n', 'alerts.detection_id is ON DELETE SET NULL');

-- Indexes for the real query patterns
SELECT ok(to_regclass('public.idx_detections_camera_detected_at') IS NOT NULL, 'index (camera_id, detected_at desc)');
SELECT ok(to_regclass('public.idx_detections_plate_detected_at') IS NOT NULL, 'index (plate_text_normalized, detected_at)');
SELECT ok(to_regclass('public.idx_detections_plate_trgm') IS NOT NULL, 'trigram index on plate');
SELECT ok(to_regclass('public.idx_alerts_open_created_at') IS NOT NULL, 'partial index on open alerts');
SELECT ok(to_regclass('public.idx_alerts_detection_id') IS NOT NULL, 'FK index alerts.detection_id');

-- Behaviour: sync triggers + views
INSERT INTO public.cameras (id, name, code, lat, lng, zone, direction, status, video_url)
VALUES ('cam-t-a', 'A', 'TA-01', 19.1, 72.8, 'T', 'N', 'online', 'a.mp4'),
       ('cam-t-b', 'B', 'TB-01', 19.2, 72.9, 'T', 'N', 'online', 'b.mp4');
SELECT is((SELECT latitude FROM public.cameras WHERE id = 'cam-t-a'), 19.1::float8, 'cameras.latitude mirrors lat');

-- Pipeline-shaped rows: detected_at only (no `timestamp`), lat/lng only.
INSERT INTO public.detections (event_id, camera_id, plate_text_raw, plate_text_normalized, confidence_score,
                               vehicle_type, detected_at, lat, lng, bbox, engine, model_version)
VALUES
  ('e1', 'cam-t-a', 'MH 02 CD 5678', 'MH02CD5678', 0.9, 'car', '2026-09-29T09:00:00+05:30', 19.1, 72.8, '{}', 'yolov7-tiny', 'v1'),
  ('e2', 'cam-t-a', 'MH 02 CD 5678', 'MH02CD5678', 0.9, 'car', '2026-09-29T09:00:05+05:30', 19.1, 72.8, '{}', 'yolov7-tiny', 'v1'),
  ('e3', 'cam-t-b', 'MH 02 CD 5678', 'MH02CD5678', 0.9, 'car', '2026-09-29T09:10:05+05:30', 19.2, 72.9, '{}', 'yolov7-tiny', 'v1'),
  ('e4', 'cam-t-a', 'MH 02 CD 5678', 'MH02CD5678', 0.9, 'car', '2026-09-29T09:30:00+05:30', 19.1, 72.8, '{}', 'yolov7-tiny', 'v1');
SELECT is((SELECT "timestamp" FROM public.detections WHERE event_id = 'e1'),
          '2026-09-29T09:00:00+05:30'::timestamptz, 'detections.timestamp mirrors detected_at');
SELECT is((SELECT longitude FROM public.detections WHERE event_id = 'e1'), 72.8::float8, 'detections.longitude mirrors lng');

SELECT is((SELECT detection_count::int FROM public.vehicles WHERE plate_text = 'MH 02 CD 5678'), 4, 'vehicles.detection_count');
SELECT is((SELECT camera_count::int FROM public.vehicles WHERE plate_text = 'MH 02 CD 5678'), 2, 'vehicles.camera_count');
SELECT is((SELECT jsonb_array_length(waypoints) FROM public.trajectories WHERE plate_text = 'MH 02 CD 5678'), 3,
          'trajectory collapses consecutive sightings into visits (A, B, A)');
SELECT is((SELECT waypoints -> 1 ->> 'camera_code' FROM public.trajectories WHERE plate_text = 'MH 02 CD 5678'), 'TB-01',
          'waypoint carries camera code');
SELECT is((SELECT (waypoints -> 1 ->> 'time_since_previous_seconds')::int FROM public.trajectories
           WHERE plate_text = 'MH 02 CD 5678'), 600, 'time since previous visit');
SELECT is((SELECT total_travel_time_seconds FROM public.trajectories WHERE plate_text = 'MH 02 CD 5678'), 1800,
          'total travel time');

-- Blacklist normalisation + alert status sync
INSERT INTO public.blacklist_entries (plate_text, category, priority, notes)
VALUES ('mh-02 cd 5678', 'stolen', 'high', 'from notes');
SELECT is((SELECT reason FROM public.blacklist_entries WHERE plate_text_normalized = 'MH02CD5678'), 'from notes',
          'blacklist reason mirrors notes');

INSERT INTO public.alerts (detection_id, plate_text, camera_id, camera_name, priority, category, reason, lat, lng)
VALUES ('e3', 'MH 02 CD 5678', 'cam-t-b', 'B', 'high', 'stolen', 'hit', 19.2, 72.9);
SELECT is((SELECT status FROM public.alerts WHERE detection_id = 'e3'), 'open', 'new alerts default to open');

-- Retention: alerts survive, their detection link is nulled
UPDATE public.detections SET detected_at = now() - interval '400 days' WHERE event_id = 'e3';
SELECT is(public.purge_old_detections(365), 1::bigint, 'purge deletes detections older than the window');
SELECT is((SELECT count(*)::int FROM public.alerts WHERE plate_text = 'MH 02 CD 5678' AND detection_id IS NULL), 1,
          'alert survives the purge with detection_id set to NULL');

SELECT * FROM finish();
ROLLBACK;
