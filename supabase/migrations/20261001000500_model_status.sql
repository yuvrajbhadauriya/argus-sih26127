-- ═══════════════════════════════════════════════════
-- model_status: heartbeat of the ANPR inference engine on the GPU box.
-- Written by the watchdog (service_role, outbound HTTPS only); read by the
-- dashboard (anon/authenticated) and streamed via Realtime so the top bar can
-- show "AI engine online" / "starting in N s" / "reconnecting".
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.model_status (
  id              text PRIMARY KEY,                 -- engine instance, e.g. 'gpu-primary'
  state           text NOT NULL DEFAULT 'down'
                  CHECK (state IN ('running', 'starting', 'restarting', 'down')),
  eta_seconds     integer CHECK (eta_seconds IS NULL OR eta_seconds >= 0),
  message         text,
  model_label     text NOT NULL DEFAULT 'AI ANPR engine',
  restarts        integer NOT NULL DEFAULT 0,
  uptime_seconds  integer NOT NULL DEFAULT 0,
  gpu_busy        boolean NOT NULL DEFAULT false,
  started_at      timestamptz,
  last_heartbeat  timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.model_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_status FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.model_status FROM anon, authenticated;
GRANT SELECT ON public.model_status TO anon, authenticated;

DROP POLICY IF EXISTS model_status_read ON public.model_status;
CREATE POLICY model_status_read ON public.model_status
  FOR SELECT TO anon, authenticated USING (true);
-- No insert/update policies: only service_role (the watchdog) writes.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'model_status'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.model_status;
  END IF;
END $$;
