-- ═══════════════════════════════════════════════════════════════════════════
-- Realtime for alerts (and only alerts)
--
-- The dashboard subscribes to postgres_changes INSERT/UPDATE on public.alerts
-- (src/features/alerts/realtime.ts) so a new watchlist hit or route anomaly
-- shows up as a toast + sidebar badge without waiting for the 30 s poll.
--
-- `detections` is deliberately NOT published: it is the high-volume table
-- (one row per plate read) and would flood every connected browser. Realtime
-- respects RLS, so subscribers only receive rows their role may SELECT
-- (see 20261001000100_rls.sql).
--
-- Idempotent, and a no-op on plain Postgres where the Supabase
-- `supabase_realtime` publication does not exist (e.g. pgTAP without Realtime).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'alerts'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
  END IF;
END
$$;
