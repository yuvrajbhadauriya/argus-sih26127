-- ═══════════════════════════════════════════════════════════════════════════
-- Private database + private storage
--
-- The dashboard stays PUBLIC (no login to browse), but the database no longer
-- is: the anon key that ships in the browser bundle can't read anything.
--
--   Browser ─► Vercel /api/data/*  (api/_lib/dataRoutes.ts, service-role key,
--              column-limited responses, per-IP rate limit, short CDN cache)
--          ─► /api/media/sign      (1 h signed URLs for allowlisted objects)
--          ─► Supabase Auth        (sign-in only; needs no table grants)
--
-- Access after this migration:
--   role            tables / views in public          storage (videos, golden)
--   anon            nothing                           nothing (buckets private)
--   authenticated   nothing (the API does all reads   nothing
--                   and writes, after verifying the
--                   JWT + app_metadata.role)
--   service_role    everything (BYPASSRLS)            everything
--
-- Decision: `authenticated` loses its direct access too. Every read the UI
-- needs is served by /api/data (including the operator-only audit trail, which
-- the API gates on the verified role), so a direct grant would only widen the
-- surface — e.g. anyone able to sign up would get a JWT that reads all ANPR
-- data. Operator writes go through the API, which stamps the actor explicitly
-- (20261001000600_audit_actor_headers.sql) so the audit trail is unchanged.
--
-- Realtime: nothing is published any more (anon can't subscribe to rows it
-- can't read); the dashboard polls /api/data (alerts 10 s, model_status 5 s).
--
-- Rollback (emergency re-open of the demo read path), in the SQL editor:
--   grant select on public.cameras, public.detections, public.alerts,
--     public.blacklist_entries, public.vehicles, public.trajectories,
--     public.model_status to anon, authenticated;
--   create policy <t>_read on public.<t> for select to anon, authenticated using (true);
--   update storage.buckets set public = true where id in ('videos', 'golden');
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Policies: drop every read/write policy aimed at anon/authenticated ──
-- (RLS stays enabled + forced; with no policy only service_role gets rows.)
DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies
           WHERE schemaname = 'public'
             AND (roles && ARRAY['anon', 'authenticated', 'public']::name[])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$$;

-- ── 2. Grants: no table, view or sequence privileges for the client roles ─
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Tables/views created later by the migration role start private too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- RPC surface: the helper functions expose no rows, but anon has no reason to
-- call any of them. (Trigger functions are not callable through PostgREST.)
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('normalize_plate', 'plate_display', 'app_role', 'is_operator', 'is_admin')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END
$$;

-- ── 3. Realtime: stop publishing public tables ───────────────────────────
DO $$
DECLARE
  t RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOR t IN SELECT tablename FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    LOOP
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t.tablename);
    END LOOP;
  END IF;
END
$$;

-- ── 4. Storage: camera clips and golden-set crops are private ────────────
-- Served only as short-lived signed URLs by /api/media/sign (allowlisted
-- prefixes). No storage.objects policies exist for these buckets, so anon and
-- authenticated can neither list nor download. No-op on plain Postgres (CI).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets SET public = false WHERE id IN ('videos', 'golden');
  END IF;
END
$$;
