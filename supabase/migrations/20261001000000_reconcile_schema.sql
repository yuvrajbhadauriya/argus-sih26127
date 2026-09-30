-- ═══════════════════════════════════════════════════════════════════════════
-- Reconcile the database schema with what the application actually uses
--
-- The earlier migrations (20260925 init, the two 20260927 files, the camera
-- network seeds) drifted from the code. This migration is the single source
-- of truth for the columns/relations read and written by:
--   * src/features/{cameras,detections,vehicles,alerts}/api.ts  (anon, read)
--   * pipeline/insert_detections.py                             (service_role)
--   * pipeline/seed_alerts_and_watchlist.py                     (service_role)
--
-- Design notes
--   * Idempotent: every statement is IF [NOT] EXISTS / CREATE OR REPLACE or is
--     guarded by a catalog check, so it can be re-run safely, and it does not
--     depend on (or conflict with) the camera-network seed migrations, whichever
--     order they are applied in.
--   * Legacy column pairs are kept and kept in sync by BEFORE triggers instead
--     of being dropped, so old rows / old writers keep working:
--       cameras.lat/lng           <-> cameras.latitude/longitude
--       detections.timestamp      <-> detections.detected_at
--       detections.lat/lng        <-> detections.latitude/longitude
--       alerts.timestamp          <-> alerts.created_at
--       alerts.detection_event_id <-> alerts.detection_id   (FK lives on detection_id)
--       alerts.acknowledged       <-> alerts.status
--       blacklist_entries.reason  <-> blacklist_entries.notes
--       blacklist_entries.plate_text -> plate_text_normalized (derived)
--   * `vehicles` and `trajectories` are security_invoker views, so the RLS
--     policies of `detections` apply to whoever queries them.
-- RLS / grants / audit / retention live in 20261001000100_rls.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Extensions ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ── 1. Base tables (no-ops on an existing project; lets a fresh DB start
--       from this file alone). Column lists match 20260925000000_init_schema.sql. ──
CREATE TABLE IF NOT EXISTS public.cameras (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(32) NOT NULL UNIQUE,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  zone VARCHAR(128),
  direction VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'online',
  video_url TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.detections (
  event_id VARCHAR(64) PRIMARY KEY,
  camera_id VARCHAR(64) NOT NULL REFERENCES public.cameras(id) ON DELETE CASCADE,
  plate_text_raw VARCHAR(32) NOT NULL,
  plate_text_normalized VARCHAR(32) NOT NULL,
  confidence_score FLOAT NOT NULL,
  vehicle_type VARCHAR(32) NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  bbox JSONB NOT NULL,
  image_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.blacklist_entries (
  id VARCHAR(64) PRIMARY KEY,
  plate_text VARCHAR(32),
  category VARCHAR(32) NOT NULL DEFAULT 'flagged',
  priority VARCHAR(32) NOT NULL DEFAULT 'medium',
  reason TEXT,
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.alerts (
  id VARCHAR(64) PRIMARY KEY,
  detection_event_id VARCHAR(64),
  blacklist_entry_id VARCHAR(64),
  plate_text VARCHAR(32) NOT NULL,
  camera_id VARCHAR(64) NOT NULL REFERENCES public.cameras(id),
  camera_name VARCHAR(255) NOT NULL,
  priority VARCHAR(32) NOT NULL,
  category VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by VARCHAR(128),
  acknowledged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_email VARCHAR(128) NOT NULL,
  details TEXT NOT NULL
);

-- Views are rebuilt at the end; drop them now so column type changes below
-- are not blocked by view dependencies.
DROP VIEW IF EXISTS public.trajectories;
DROP VIEW IF EXISTS public.vehicles;

-- ── 2. Helper functions ──────────────────────────────────────────────────
-- "DL 01-ab 1234" -> "DL01AB1234". Same rule as the pipeline and the frontend.
CREATE OR REPLACE FUNCTION public.normalize_plate(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$ SELECT upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- "DL01AB1234" -> "DL 01 AB 1234" (Indian series format); anything that does
-- not match (BH series, partial reads, UNKNOWN) is returned unchanged.
CREATE OR REPLACE FUNCTION public.plate_display(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{1,4}$'
      THEN regexp_replace(p, '^([A-Z]{2})([0-9]{1,2})([A-Z]{1,3})([0-9]{1,4})$', '\1 \2 \3 \4')
    ELSE p
  END
$$;

-- ── 3. cameras ───────────────────────────────────────────────────────────
ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS road TEXT,
  ADD COLUMN IF NOT EXISTS zone VARCHAR(128),
  ADD COLUMN IF NOT EXISTS direction VARCHAR(64),
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.cameras
SET lat = coalesce(lat, latitude),
    lng = coalesce(lng, longitude),
    latitude = coalesce(latitude, lat),
    longitude = coalesce(longitude, lng)
WHERE lat IS DISTINCT FROM coalesce(lat, latitude)
   OR lng IS DISTINCT FROM coalesce(lng, longitude)
   OR latitude IS DISTINCT FROM coalesce(latitude, lat)
   OR longitude IS DISTINCT FROM coalesce(longitude, lng);

CREATE OR REPLACE FUNCTION public.cameras_sync_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Whichever member of a pair was changed wins.
    IF NEW.latitude IS DISTINCT FROM OLD.latitude AND NEW.lat IS NOT DISTINCT FROM OLD.lat THEN
      NEW.lat := NEW.latitude;
    ELSIF NEW.lat IS DISTINCT FROM OLD.lat THEN
      NEW.latitude := NEW.lat;
    END IF;
    IF NEW.longitude IS DISTINCT FROM OLD.longitude AND NEW.lng IS NOT DISTINCT FROM OLD.lng THEN
      NEW.lng := NEW.longitude;
    ELSIF NEW.lng IS DISTINCT FROM OLD.lng THEN
      NEW.longitude := NEW.lng;
    END IF;
    NEW.updated_at := now();
  END IF;
  NEW.lat := coalesce(NEW.lat, NEW.latitude);
  NEW.lng := coalesce(NEW.lng, NEW.longitude);
  NEW.latitude := coalesce(NEW.latitude, NEW.lat);
  NEW.longitude := coalesce(NEW.longitude, NEW.lng);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cameras_sync_columns ON public.cameras;
CREATE TRIGGER cameras_sync_columns
  BEFORE INSERT OR UPDATE ON public.cameras
  FOR EACH ROW EXECUTE FUNCTION public.cameras_sync_columns();

CREATE INDEX IF NOT EXISTS idx_cameras_zone ON public.cameras (zone);

-- ── 4. detections ────────────────────────────────────────────────────────
ALTER TABLE public.detections
  ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tracked_vehicle_id TEXT,
  ADD COLUMN IF NOT EXISTS frame_timestamp_sec DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS plate_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS engine TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT,
  ADD COLUMN IF NOT EXISTS source_video TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- The two 20260927 migrations disagreed on the width (VARCHAR(32) vs 64).
ALTER TABLE public.detections ALTER COLUMN tracked_vehicle_id TYPE TEXT;
ALTER TABLE public.detections ALTER COLUMN frame_timestamp_sec TYPE DOUBLE PRECISION;
-- The pipeline has always sent detected_at, never `timestamp`.
ALTER TABLE public.detections ALTER COLUMN timestamp DROP NOT NULL;

UPDATE public.detections
SET detected_at = coalesce(detected_at, "timestamp", created_at, now()),
    "timestamp" = coalesce("timestamp", detected_at, created_at, now()),
    lat = coalesce(lat, latitude),
    lng = coalesce(lng, longitude),
    latitude = coalesce(latitude, lat),
    longitude = coalesce(longitude, lng)
WHERE detected_at IS NULL OR "timestamp" IS NULL
   OR (lat IS NULL AND latitude IS NOT NULL) OR (latitude IS NULL AND lat IS NOT NULL)
   OR (lng IS NULL AND longitude IS NOT NULL) OR (longitude IS NULL AND lng IS NOT NULL);

UPDATE public.detections
SET plate_text_normalized = public.normalize_plate(plate_text_raw)
WHERE plate_text_normalized IS DISTINCT FROM public.normalize_plate(plate_text_normalized)
  AND plate_text_raw IS NOT NULL;

ALTER TABLE public.detections ALTER COLUMN detected_at SET DEFAULT now();
ALTER TABLE public.detections ALTER COLUMN detected_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.detections_sync_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."timestamp" IS DISTINCT FROM OLD."timestamp" AND NEW.detected_at IS NOT DISTINCT FROM OLD.detected_at THEN
      NEW.detected_at := NEW."timestamp";
    ELSIF NEW.detected_at IS DISTINCT FROM OLD.detected_at THEN
      NEW."timestamp" := NEW.detected_at;
    END IF;
    IF NEW.latitude IS DISTINCT FROM OLD.latitude AND NEW.lat IS NOT DISTINCT FROM OLD.lat THEN
      NEW.lat := NEW.latitude;
    ELSIF NEW.lat IS DISTINCT FROM OLD.lat THEN
      NEW.latitude := NEW.lat;
    END IF;
    IF NEW.longitude IS DISTINCT FROM OLD.longitude AND NEW.lng IS NOT DISTINCT FROM OLD.lng THEN
      NEW.lng := NEW.longitude;
    ELSIF NEW.lng IS DISTINCT FROM OLD.lng THEN
      NEW.longitude := NEW.lng;
    END IF;
  END IF;
  NEW.detected_at := coalesce(NEW.detected_at, NEW."timestamp", now());
  NEW."timestamp" := coalesce(NEW."timestamp", NEW.detected_at);
  NEW.lat := coalesce(NEW.lat, NEW.latitude);
  NEW.lng := coalesce(NEW.lng, NEW.longitude);
  NEW.latitude := coalesce(NEW.latitude, NEW.lat);
  NEW.longitude := coalesce(NEW.longitude, NEW.lng);
  IF NEW.plate_text_normalized IS NULL OR NEW.plate_text_normalized = '' THEN
    NEW.plate_text_normalized := public.normalize_plate(NEW.plate_text_raw);
  ELSE
    NEW.plate_text_normalized := public.normalize_plate(NEW.plate_text_normalized);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS detections_sync_columns ON public.detections;
CREATE TRIGGER detections_sync_columns
  BEFORE INSERT OR UPDATE ON public.detections
  FOR EACH ROW EXECUTE FUNCTION public.detections_sync_columns();

-- Query patterns:
--   camera feed      .eq('camera_id').order(detected_at desc) / frame overlay sync
--   trajectory       .eq('plate_text_normalized').order('detected_at')
--   vehicle search   plate ILIKE '%q%'  (via the vehicles view)
--   retention purge  detected_at < now() - N days
CREATE INDEX IF NOT EXISTS idx_detections_camera_detected_at
  ON public.detections (camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_plate_detected_at
  ON public.detections (plate_text_normalized, detected_at);
CREATE INDEX IF NOT EXISTS idx_detections_detected_at
  ON public.detections (detected_at);
CREATE INDEX IF NOT EXISTS idx_detections_plate_display
  ON public.detections (public.plate_display(plate_text_normalized));
CREATE INDEX IF NOT EXISTS idx_detections_tracked_vehicle
  ON public.detections (tracked_vehicle_id);
CREATE INDEX IF NOT EXISTS idx_detections_frame_ts
  ON public.detections (camera_id, frame_timestamp_sec);
-- Superseded by the composite indexes above.
DROP INDEX IF EXISTS public.idx_detections_camera;
DROP INDEX IF EXISTS public.idx_detections_plate;
DROP INDEX IF EXISTS public.idx_detections_timestamp;

-- Trigram indexes: pg_trgm may live in `extensions` (Supabase default) or
-- `public` (older projects), so resolve the operator class schema at runtime.
DO $$
DECLARE
  trgm_schema TEXT;
BEGIN
  SELECT n.nspname INTO trgm_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_detections_plate_trgm ON public.detections '
    'USING gin (plate_text_normalized %I.gin_trgm_ops)', trgm_schema);
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_detections_plate_display_trgm ON public.detections '
    'USING gin (public.plate_display(plate_text_normalized) %I.gin_trgm_ops)', trgm_schema);
END
$$;

-- ── 5. blacklist_entries (watchlist) ─────────────────────────────────────
ALTER TABLE public.blacklist_entries
  ADD COLUMN IF NOT EXISTS plate_text VARCHAR(32),
  ADD COLUMN IF NOT EXISTS plate_text_normalized VARCHAR(32),
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.blacklist_entries
SET plate_text_normalized = public.normalize_plate(coalesce(plate_text, plate_text_normalized)),
    plate_text = coalesce(plate_text, public.plate_display(public.normalize_plate(plate_text_normalized))),
    reason = coalesce(reason, notes),
    notes = coalesce(notes, reason)
WHERE plate_text_normalized IS DISTINCT FROM public.normalize_plate(coalesce(plate_text, plate_text_normalized))
   OR plate_text IS NULL OR reason IS NULL OR notes IS NULL;

CREATE OR REPLACE FUNCTION public.blacklist_entries_sync_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.plate_text IS NOT DISTINCT FROM OLD.plate_text
       AND NEW.plate_text_normalized IS DISTINCT FROM OLD.plate_text_normalized THEN
      NEW.plate_text := public.plate_display(public.normalize_plate(NEW.plate_text_normalized));
    END IF;
    IF NEW.reason IS NOT DISTINCT FROM OLD.reason AND NEW.notes IS DISTINCT FROM OLD.notes THEN
      NEW.reason := NEW.notes;
    ELSIF NEW.reason IS DISTINCT FROM OLD.reason AND NEW.notes IS NOT DISTINCT FROM OLD.notes THEN
      NEW.notes := NEW.reason;
    END IF;
    NEW.updated_at := now();
  END IF;
  NEW.plate_text := coalesce(NEW.plate_text, public.plate_display(public.normalize_plate(NEW.plate_text_normalized)));
  NEW.plate_text_normalized := public.normalize_plate(NEW.plate_text);
  NEW.reason := coalesce(NEW.reason, NEW.notes, '');
  NEW.notes := coalesce(NEW.notes, NEW.reason);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS blacklist_entries_sync_columns ON public.blacklist_entries;
CREATE TRIGGER blacklist_entries_sync_columns
  BEFORE INSERT OR UPDATE ON public.blacklist_entries
  FOR EACH ROW EXECUTE FUNCTION public.blacklist_entries_sync_columns();

-- Upsert key for the seeder / admin UI: one entry per normalised plate.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklist_entries_plate_normalized
    ON public.blacklist_entries (plate_text_normalized);
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'blacklist_entries has duplicate normalised plates; dedupe them and re-run '
                'this migration to create uq_blacklist_entries_plate_normalized';
END
$$;
CREATE INDEX IF NOT EXISTS idx_blacklist_entries_active
  ON public.blacklist_entries (plate_text_normalized) WHERE is_active;

-- ── 6. alerts ────────────────────────────────────────────────────────────
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS detection_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS detection_event_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alert_type TEXT,
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS details JSONB,
  ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS acknowledged_by VARCHAR(128),
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

UPDATE public.alerts
SET created_at = coalesce(created_at, "timestamp", now()),
    "timestamp" = coalesce("timestamp", created_at, now()),
    -- only link detections that still exist (purged ones stay NULL)
    detection_id = coalesce(detection_id, (SELECT d.event_id FROM public.detections d
                                           WHERE d.event_id = alerts.detection_event_id)),
    detection_event_id = coalesce(detection_event_id, detection_id),
    status = coalesce(status, CASE WHEN acknowledged THEN 'acknowledged' ELSE 'open' END),
    acknowledged = coalesce(acknowledged, false) OR status = 'acknowledged',
    alert_type = coalesce(alert_type, 'watchlist')
WHERE created_at IS NULL OR "timestamp" IS NULL OR status IS NULL OR alert_type IS NULL
   OR (detection_id IS NULL AND detection_event_id IS NOT NULL)
   OR (detection_event_id IS NULL AND detection_id IS NOT NULL)
   OR (status = 'acknowledged' AND acknowledged IS NOT TRUE);

ALTER TABLE public.alerts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.alerts ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.alerts ALTER COLUMN "timestamp" SET DEFAULT now();
ALTER TABLE public.alerts ALTER COLUMN status SET DEFAULT 'open';
ALTER TABLE public.alerts ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.alerts ALTER COLUMN alert_type SET DEFAULT 'watchlist';
ALTER TABLE public.alerts ALTER COLUMN acknowledged SET DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_status_check'
                 AND conrelid = 'public.alerts'::regclass) THEN
    ALTER TABLE public.alerts ADD CONSTRAINT alerts_status_check
      CHECK (status IN ('open', 'acknowledged', 'dismissed', 'escalated'));
  END IF;
END
$$;

-- Foreign keys. PostgREST embeds `alerts -> detections(*)` only when exactly
-- one FK links the two tables, so the legacy FK on detection_event_id is
-- dropped and the canonical one lives on detection_id. Detections are purged
-- by retention, so alerts keep their denormalised copy and the link is nulled.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.alerts'::regclass
      AND con.contype = 'f'
      AND con.confrelid IN ('public.detections'::regclass, 'public.blacklist_entries'::regclass)
      AND con.conname NOT IN ('alerts_detection_id_fkey', 'alerts_blacklist_entry_id_fkey')
  LOOP
    EXECUTE format('ALTER TABLE public.alerts DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- Re-create with the right ON DELETE if an earlier run/hand edit made it differently.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_detection_id_fkey'
             AND conrelid = 'public.alerts'::regclass AND confdeltype <> 'n') THEN
    ALTER TABLE public.alerts DROP CONSTRAINT alerts_detection_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_blacklist_entry_id_fkey'
             AND conrelid = 'public.alerts'::regclass AND confdeltype <> 'n') THEN
    ALTER TABLE public.alerts DROP CONSTRAINT alerts_blacklist_entry_id_fkey;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_detection_id_fkey'
                 AND conrelid = 'public.alerts'::regclass) THEN
    -- Orphans (detections deleted before this FK existed) would block the FK.
    UPDATE public.alerts a SET detection_id = NULL
    WHERE detection_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.detections d WHERE d.event_id = a.detection_id);
    ALTER TABLE public.alerts ADD CONSTRAINT alerts_detection_id_fkey
      FOREIGN KEY (detection_id) REFERENCES public.detections(event_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_blacklist_entry_id_fkey'
                 AND conrelid = 'public.alerts'::regclass) THEN
    UPDATE public.alerts a SET blacklist_entry_id = NULL
    WHERE blacklist_entry_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.blacklist_entries b WHERE b.id = a.blacklist_entry_id);
    ALTER TABLE public.alerts ADD CONSTRAINT alerts_blacklist_entry_id_fkey
      FOREIGN KEY (blacklist_entry_id) REFERENCES public.blacklist_entries(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.alerts_sync_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := coalesce(NEW.created_at, NEW."timestamp", now());
    NEW."timestamp" := coalesce(NEW."timestamp", NEW.created_at);
    IF NEW.status IS NULL THEN
      NEW.status := CASE WHEN NEW.acknowledged THEN 'acknowledged' ELSE 'open' END;
    END IF;
    NEW.detection_id := coalesce(NEW.detection_id, NEW.detection_event_id);
    NEW.detection_event_id := coalesce(NEW.detection_event_id, NEW.detection_id);
  ELSE
    -- detection_id may be nulled by ON DELETE SET NULL (retention purge);
    -- detection_event_id then keeps the historical reference.
    IF NEW.detection_id IS DISTINCT FROM OLD.detection_id THEN
      IF NEW.detection_id IS NOT NULL THEN
        NEW.detection_event_id := NEW.detection_id;
      END IF;
    ELSIF NEW.detection_event_id IS DISTINCT FROM OLD.detection_event_id THEN
      NEW.detection_id := NEW.detection_event_id;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.acknowledged IS DISTINCT FROM OLD.acknowledged THEN
      NEW.status := CASE WHEN NEW.acknowledged THEN 'acknowledged' ELSE 'open' END;
    END IF;
  END IF;
  NEW.acknowledged := (NEW.status = 'acknowledged');
  IF NEW.acknowledged THEN
    NEW.acknowledged_at := coalesce(NEW.acknowledged_at, now());
  END IF;
  NEW.alert_type := coalesce(NEW.alert_type, 'watchlist');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS alerts_sync_columns ON public.alerts;
CREATE TRIGGER alerts_sync_columns
  BEFORE INSERT OR UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.alerts_sync_columns();

-- Query patterns: feed .order('created_at', desc); unacknowledged queue; FK joins.
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON public.alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_open_created_at
  ON public.alerts (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_alerts_detection_id ON public.alerts (detection_id);
CREATE INDEX IF NOT EXISTS idx_alerts_blacklist_entry_id ON public.alerts (blacklist_entry_id);
CREATE INDEX IF NOT EXISTS idx_alerts_camera_id ON public.alerts (camera_id);
-- Idempotent seeding/ingestion: at most one alert per source event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_source_key ON public.alerts (source_key);

-- ── 7. audit_logs ────────────────────────────────────────────────────────
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON public.audit_logs (timestamp DESC);

-- ── 8. Text primary keys get server-side defaults (seeders can omit ids) ──
DO $$
DECLARE
  t TEXT;
  typ TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alerts', 'blacklist_entries', 'audit_logs'] LOOP
    SELECT data_type INTO typ FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t AND column_name = 'id';
    IF typ = 'uuid' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT gen_random_uuid()', t);
    ELSE
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT gen_random_uuid()::text', t);
    END IF;
  END LOOP;
END
$$;

-- ── 9. Views ─────────────────────────────────────────────────────────────
-- One row per distinct (normalised) plate. `plate_text` is the display form
-- derived from the grouping key, so `.ilike('plate_text', ...)` and
-- `.eq('plate_text', ...)` are pushed down into the detections scan.
CREATE VIEW public.vehicles
WITH (security_invoker = true)
AS
SELECT
  public.plate_display(d.plate_text_normalized) AS plate_text,
  d.plate_text_normalized,
  mode() WITHIN GROUP (ORDER BY d.vehicle_type) AS vehicle_type,
  min(d.detected_at) AS first_seen,
  max(d.detected_at) AS last_seen,
  count(*) AS detection_count,
  count(DISTINCT d.camera_id) AS camera_count
FROM public.detections d
WHERE d.plate_text_normalized <> '' AND d.plate_text_normalized <> 'UNKNOWN'
GROUP BY d.plate_text_normalized;

COMMENT ON VIEW public.vehicles IS
  'Per-plate aggregate over detections (security_invoker: detections RLS applies).';

-- One row per plate, shaped like the frontend `Trajectory` type. Consecutive
-- detections of a plate at the same camera collapse into one "visit"
-- (gaps-and-islands); each visit becomes a waypoint.
CREATE VIEW public.trajectories
WITH (security_invoker = true)
AS
WITH ordered AS (
  SELECT
    d.plate_text_normalized AS plate,
    d.camera_id,
    d.detected_at,
    d.vehicle_type,
    d.event_id,
    lag(d.camera_id) OVER w AS prev_camera_id
  FROM public.detections d
  WHERE d.plate_text_normalized <> '' AND d.plate_text_normalized <> 'UNKNOWN'
  WINDOW w AS (PARTITION BY d.plate_text_normalized ORDER BY d.detected_at, d.event_id)
),
islands AS (
  SELECT
    o.*,
    sum(CASE WHEN o.prev_camera_id IS DISTINCT FROM o.camera_id THEN 1 ELSE 0 END)
      OVER (PARTITION BY o.plate ORDER BY o.detected_at, o.event_id) AS visit_no
  FROM ordered o
),
visits AS (
  SELECT
    i.plate,
    i.visit_no,
    i.camera_id,
    min(i.detected_at) AS first_seen,
    max(i.detected_at) AS last_seen,
    count(*) AS detections,
    mode() WITHIN GROUP (ORDER BY i.vehicle_type) AS vehicle_type
  FROM islands i
  GROUP BY i.plate, i.visit_no, i.camera_id
),
waypoints AS (
  SELECT
    v.*,
    c.name AS camera_name,
    c.code AS camera_code,
    coalesce(c.lat, c.latitude) AS lat,
    coalesce(c.lng, c.longitude) AS lng,
    round(extract(epoch FROM v.first_seen - lag(v.last_seen) OVER (PARTITION BY v.plate ORDER BY v.visit_no)))::int
      AS time_since_previous_seconds
  FROM visits v
  LEFT JOIN public.cameras c ON c.id = v.camera_id
)
SELECT
  'traj-' || w.plate AS id,
  public.plate_display(w.plate) AS plate_text,
  w.plate AS plate_text_normalized,
  mode() WITHIN GROUP (ORDER BY w.vehicle_type) AS vehicle_type,
  jsonb_agg(
    jsonb_build_object(
      'camera_id', w.camera_id,
      'camera_name', coalesce(w.camera_name, w.camera_id),
      'camera_code', w.camera_code,
      'lat', w.lat,
      'lng', w.lng,
      'timestamp', w.first_seen,
      'last_seen', w.last_seen,
      'detections', w.detections,
      'time_since_previous_seconds', w.time_since_previous_seconds
    ) ORDER BY w.visit_no
  ) AS waypoints,
  greatest(0, round(extract(epoch FROM max(w.last_seen) - min(w.first_seen))))::int AS total_travel_time_seconds,
  count(DISTINCT w.camera_id) AS camera_count,
  count(*) AS visit_count,
  min(w.first_seen) AS first_seen,
  max(w.last_seen) AS last_seen,
  'supabase'::text AS source
FROM waypoints w
GROUP BY w.plate;

COMMENT ON VIEW public.trajectories IS
  'Per-plate camera-to-camera trajectory reconstructed from detections '
  '(one waypoint per consecutive visit to a camera). security_invoker.';

-- Re-running this file drops and recreates the views; restore read access
-- (20261001000100_rls.sql owns the full grant matrix).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.vehicles, public.trajectories TO anon, authenticated;
  END IF;
END
$$;
