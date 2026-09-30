-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security, grants, audit trail and data retention
--
-- Access model (prototype demo — see docs/DATABASE.md):
--   role / claim                          cameras  detections  alerts   blacklist  audit_logs
--   anon                                  SELECT   SELECT      SELECT   SELECT     -
--   authenticated (no app role)           SELECT   SELECT      SELECT   SELECT     -
--   authenticated, app_metadata.role =
--     operator | admin                    +INS/UPD SELECT      +UPDATE  +INS/UPD   SELECT
--                                                              (ack columns only)
--   authenticated, role = admin           +DELETE  -           -        +DELETE    SELECT
--   service_role (pipeline, BYPASSRLS)    all      all         all      all        all
--
-- The public dashboard is read-only for anon so the SIH demo works without a
-- login. PRODUCTION must drop the `anon` SELECT policies (see the end of this
-- file) and require an authenticated session: this is ANPR data (personal
-- data under the DPDP Act 2023).
--
-- `app_metadata.role` is set server-side only (service role / dashboard):
--   update auth.users set raw_app_meta_data =
--     raw_app_meta_data || '{"role":"operator"}' where email = '...';
-- `user_metadata` is user-editable and is deliberately NOT trusted.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Local/CI shim: the Supabase roles and auth helpers already exist on a
--       real project; create minimal stand-ins only when they are missing
--       (plain Postgres used by supabase/tests in CI). ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
  IF to_regprocedure('auth.jwt()') IS NULL THEN
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claims', true), ''),
        '{}'
      )::jsonb
    $f$;
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
    $f$;
  END IF;
END
$$;

DO $$
BEGIN
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;  -- hosted Supabase: already granted by the platform
END
$$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── 1. Role helper ───────────────────────────────────────────────────────
-- Application role from the JWT's app_metadata ('' when absent).
CREATE OR REPLACE FUNCTION public.app_role()
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = ''
AS $$ SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') $$;

CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = ''
AS $$ SELECT public.app_role() IN ('operator', 'admin') $$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = ''
AS $$ SELECT public.app_role() = 'admin' $$;

-- ── 2. Enable + force RLS on every table in `public` ──────────────────────
-- Tables without a policy are then reachable only by service_role, which is
-- the safe default for anything added later.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;

-- FORCE also applies RLS to the table owner. On hosted Supabase the owner
-- (`postgres`) has BYPASSRLS, so migrations, the SQL editor and the SECURITY
-- DEFINER functions below are unaffected. If the migrating role lacks
-- BYPASSRLS (self-hosted setups), give it an explicit maintenance policy so
-- later migrations and the audit trigger keep working.
DO $$
DECLARE
  t RECORD;
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS owner_maintenance ON public.%I', t.relname);
      EXECUTE format('CREATE POLICY owner_maintenance ON public.%I AS PERMISSIVE FOR ALL TO %I '
                     'USING (true) WITH CHECK (true)', t.relname, current_user);
    END LOOP;
  END IF;
END
$$;

-- ── 3. Table privileges (RLS filters rows; grants gate the verbs) ────────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT SELECT ON public.cameras, public.detections, public.alerts, public.blacklist_entries
  TO anon, authenticated;
GRANT SELECT ON public.vehicles, public.trajectories TO anon, authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT INSERT, UPDATE ON public.cameras, public.blacklist_entries TO authenticated;
GRANT DELETE ON public.cameras, public.blacklist_entries TO authenticated;
-- Operators may only touch the acknowledgement columns of an alert.
GRANT UPDATE (status, acknowledged, acknowledged_at, acknowledged_by) ON public.alerts TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- New tables created by the migration role must not be anon-writable by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM authenticated;

-- ── 4. Policies ──────────────────────────────────────────────────────────
-- Read (prototype: public read-only dashboard).
DROP POLICY IF EXISTS cameras_read ON public.cameras;
CREATE POLICY cameras_read ON public.cameras
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS detections_read ON public.detections;
CREATE POLICY detections_read ON public.detections
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS alerts_read ON public.alerts;
CREATE POLICY alerts_read ON public.alerts
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS blacklist_entries_read ON public.blacklist_entries;
CREATE POLICY blacklist_entries_read ON public.blacklist_entries
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS audit_logs_read ON public.audit_logs;
CREATE POLICY audit_logs_read ON public.audit_logs
  FOR SELECT TO authenticated USING ((SELECT public.is_operator()));

-- Writes (operators/admins only).
DROP POLICY IF EXISTS alerts_acknowledge ON public.alerts;
CREATE POLICY alerts_acknowledge ON public.alerts
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_operator()))
  WITH CHECK ((SELECT public.is_operator()));

DROP POLICY IF EXISTS blacklist_entries_insert ON public.blacklist_entries;
CREATE POLICY blacklist_entries_insert ON public.blacklist_entries
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_operator()));

DROP POLICY IF EXISTS blacklist_entries_update ON public.blacklist_entries;
CREATE POLICY blacklist_entries_update ON public.blacklist_entries
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_operator()))
  WITH CHECK ((SELECT public.is_operator()));

DROP POLICY IF EXISTS blacklist_entries_delete ON public.blacklist_entries;
CREATE POLICY blacklist_entries_delete ON public.blacklist_entries
  FOR DELETE TO authenticated USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS cameras_insert ON public.cameras;
CREATE POLICY cameras_insert ON public.cameras
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_operator()));

DROP POLICY IF EXISTS cameras_update ON public.cameras;
CREATE POLICY cameras_update ON public.cameras
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_operator()))
  WITH CHECK ((SELECT public.is_operator()));

DROP POLICY IF EXISTS cameras_delete ON public.cameras;
CREATE POLICY cameras_delete ON public.cameras
  FOR DELETE TO authenticated USING ((SELECT public.is_admin()));

-- detections: no anon/authenticated write policy -> service_role only.
-- audit_logs: no write policy -> written only by the SECURITY DEFINER trigger.

-- ── 5. Audit trail ───────────────────────────────────────────────────────
-- Server-side identity on acknowledgement: never trust a client-sent name.
CREATE OR REPLACE FUNCTION public.alerts_stamp_acknowledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'acknowledged' AND OLD.status IS DISTINCT FROM 'acknowledged' THEN
    NEW.acknowledged_at := now();
    NEW.acknowledged_by := coalesce(
      auth.jwt() ->> 'email',
      auth.uid()::text,
      NEW.acknowledged_by,
      current_user::text
    );
  END IF;
  RETURN NEW;
END
$$;

-- Named so it fires after alerts_sync_columns (BEFORE triggers run alphabetically).
DROP TRIGGER IF EXISTS alerts_zz_stamp_acknowledger ON public.alerts;
CREATE TRIGGER alerts_zz_stamp_acknowledger
  BEFORE UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.alerts_stamp_acknowledger();

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rec JSONB;
  old_rec JSONB;
  act TEXT;
BEGIN
  rec := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_rec := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;

  IF TG_TABLE_NAME = 'alerts' THEN
    IF TG_OP <> 'UPDATE' OR (rec ->> 'status') IS NOT DISTINCT FROM (old_rec ->> 'status') THEN
      RETURN NULL;  -- only status transitions (acknowledge/dismiss/...) are audited
    END IF;
    act := 'alert.' || CASE rec ->> 'status' WHEN 'acknowledged' THEN 'acknowledge'
                                            ELSE 'status:' || (rec ->> 'status') END;
  ELSE
    act := CASE TG_TABLE_NAME WHEN 'blacklist_entries' THEN 'watchlist' ELSE TG_TABLE_NAME END
           || '.' || lower(TG_OP);
  END IF;

  INSERT INTO public.audit_logs (id, action, entity_type, entity_id, user_id, user_email, details, "timestamp")
  VALUES (
    gen_random_uuid()::text,
    left(act, 64),
    TG_TABLE_NAME,
    left(coalesce(rec ->> 'id', ''), 64),
    left(coalesce(auth.uid()::text, auth.jwt() ->> 'role', session_user::text), 64),
    left(coalesce(auth.jwt() ->> 'email', ''), 128),
    jsonb_build_object('op', TG_OP, 'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END,
                       'old', CASE WHEN TG_OP = 'DELETE' THEN rec ELSE old_rec END)::text,
    now()
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS audit_alerts ON public.alerts;
CREATE TRIGGER audit_alerts
  AFTER UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

DROP TRIGGER IF EXISTS audit_blacklist_entries ON public.blacklist_entries;
CREATE TRIGGER audit_blacklist_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.blacklist_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

DROP TRIGGER IF EXISTS audit_cameras ON public.cameras;
CREATE TRIGGER audit_cameras
  AFTER INSERT OR UPDATE OR DELETE ON public.cameras
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── 6. Retention (DPDP Act 2023: keep ANPR reads no longer than necessary) ─
CREATE OR REPLACE FUNCTION public.purge_old_detections(retention_days INT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n BIGINT;
BEGIN
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'retention_days must be >= 1 (got %)', retention_days;
  END IF;
  -- alerts.detection_id is ON DELETE SET NULL: alerts keep their own copy.
  DELETE FROM public.detections
  WHERE detected_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.audit_logs (id, action, entity_type, entity_id, user_id, user_email, details, "timestamp")
  VALUES (gen_random_uuid()::text, 'detections.purge', 'detections', '*',
          left(coalesce(auth.uid()::text, session_user::text), 64), '',
          jsonb_build_object('retention_days', retention_days, 'deleted', n)::text, now());
  RETURN n;
END
$$;

-- Function privileges: nothing here is callable through PostgREST by anon.
REVOKE ALL ON FUNCTION public.purge_old_detections(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_detections(INT) TO service_role;
REVOKE ALL ON FUNCTION public.write_audit_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alerts_stamp_acknowledger() FROM PUBLIC, anon, authenticated;

-- Daily purge with pg_cron (enable the extension in Dashboard -> Database ->
-- Extensions first, then run once in the SQL editor):
--
--   select cron.schedule(
--     'purge-old-detections',          -- job name
--     '30 21 * * *',                   -- 03:00 IST daily (cron runs in UTC)
--     $$select public.purge_old_detections(90)$$
--   );
--
--   -- inspect / remove:
--   select * from cron.job;  select cron.unschedule('purge-old-detections');

-- ── 7. Production hardening (run when the dashboard gets a login) ────────
--   drop policy cameras_read on public.cameras;
--   create policy cameras_read on public.cameras for select to authenticated using (true);
--   -- ...same for detections_read, alerts_read, blacklist_entries_read...
--   revoke select on all tables in schema public from anon;
