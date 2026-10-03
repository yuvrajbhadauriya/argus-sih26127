-- ═══════════════════════════════════════════════════════════════════════════
-- Live frame queue: real-time ANPR on the hosted dashboard without exposing
-- the model API.
--
--   Browser ─► Vercel /api/detect ─► enqueue_detect_job()        (service_role)
--                  ▲                         │
--                  │ polls the row           ▼
--                  └──────────────────  public.detect_jobs
--                                            ▲
--   GPU box: detect_worker.py (outbound HTTPS only, no listening port)
--        claim_detect_jobs() ─► POST the frame to the box's own /v1/frame
--        ─► PATCH the row with the raw answer (frame cleared)
--
-- The model API stays on the Tailscale address; the worker only dials out to
-- Supabase, like the watchdog's heartbeat (model_status). Private like the rest
-- of the database (20261001000700_private_database.sql): RLS forced, no policy,
-- no grants for anon/authenticated. Only service_role (the API, the worker) can
-- read or write these tables or call these functions.
--
-- Errors raised for the API use PostgREST custom status codes (SQLSTATE PTnnn
-- → HTTP nnn): PT503 = no worker is running, PT429 = too many frames waiting.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Frames waiting for / being read by the GPU ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.detect_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  done_at      timestamptz,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'done', 'error')),
  camera_code  text,
  query        text,                    -- /v1/frame query the API asked for (the worker whitelists it)
  width        integer,
  height       integer,
  frame_b64    text,                    -- the JPEG, base64; cleared the moment the job finishes
  result       jsonb,                   -- the model's raw /v1/frame answer
  error        text
);

CREATE INDEX IF NOT EXISTS detect_jobs_status_created_idx
  ON public.detect_jobs (status, created_at);

-- ── Is a worker alive? (one row per GPU box) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.detect_worker (
  id         text PRIMARY KEY,           -- e.g. 'gpu-primary'
  seen_at    timestamptz NOT NULL DEFAULT now(),
  version    text,
  jobs_done  bigint NOT NULL DEFAULT 0
);

ALTER TABLE public.detect_jobs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detect_jobs   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.detect_worker ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detect_worker FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.detect_jobs, public.detect_worker FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.detect_jobs, public.detect_worker TO service_role;

-- ── API side: add one frame, refusing when nobody can read it ──────────────
CREATE OR REPLACE FUNCTION public.enqueue_detect_job(
  p_camera_code text,
  p_query       text,
  p_width       integer,
  p_height      integer,
  p_frame_b64   text
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM detect_worker WHERE seen_at > now() - interval '30 seconds') THEN
    RAISE EXCEPTION 'GPU worker is offline' USING ERRCODE = 'PT503';
  END IF;
  IF (SELECT count(*) FROM detect_jobs
       WHERE status IN ('pending', 'processing')
         AND created_at > now() - interval '15 seconds') >= 8 THEN
    RAISE EXCEPTION 'Too many frames waiting' USING ERRCODE = 'PT429';
  END IF;
  INSERT INTO detect_jobs (camera_code, query, width, height, frame_b64)
  VALUES (left(p_camera_code, 64), left(p_query, 200), p_width, p_height, p_frame_b64)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ── Worker side: take the oldest fresh frames (a viewer gave up after ~8 s) ─
CREATE OR REPLACE FUNCTION public.claim_detect_jobs(p_limit integer DEFAULT 1)
RETURNS TABLE (id uuid, camera_code text, query text, width integer, height integer, frame_b64 text)
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE detect_jobs j
     SET status = 'processing', claimed_at = now()
   WHERE j.id IN (
           SELECT d.id FROM detect_jobs d
            WHERE d.status = 'pending'
              AND d.created_at > now() - interval '8 seconds'
            ORDER BY d.created_at
            LIMIT greatest(1, least(p_limit, 4))
            FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.camera_code, j.query, j.width, j.height, j.frame_b64;
$$;

-- ── Worker side: "I am alive" (time comes from the database, not the box) ──
CREATE OR REPLACE FUNCTION public.detect_worker_beat(
  p_id        text,
  p_version   text,
  p_jobs_done bigint
) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO detect_worker (id, seen_at, version, jobs_done)
  VALUES (left(p_id, 64), now(), left(p_version, 64), p_jobs_done)
  ON CONFLICT (id) DO UPDATE
    SET seen_at = now(), version = EXCLUDED.version, jobs_done = EXCLUDED.jobs_done;
$$;

-- ── Worker side: keep the table small ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_detect_jobs()
RETURNS integer
LANGUAGE sql
SET search_path = public
AS $$
  WITH gone AS (
    DELETE FROM detect_jobs WHERE created_at < now() - interval '2 minutes' RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;

-- ── API side: for /api/health ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.detect_worker_status()
RETURNS TABLE (online boolean, version text, seen_seconds_ago numeric, jobs_done bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT seen_at > now() - interval '30 seconds',
         w.version,
         round(extract(epoch FROM now() - seen_at)::numeric, 1),
         w.jobs_done
    FROM detect_worker w
   ORDER BY seen_at DESC
   LIMIT 1;
$$;

-- New functions are executable by PUBLIC (and so by anon) unless revoked.
REVOKE ALL ON FUNCTION
  public.enqueue_detect_job(text, text, integer, integer, text),
  public.claim_detect_jobs(integer),
  public.detect_worker_beat(text, text, bigint),
  public.purge_detect_jobs(),
  public.detect_worker_status()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.enqueue_detect_job(text, text, integer, integer, text),
  public.claim_detect_jobs(integer),
  public.detect_worker_beat(text, text, bigint),
  public.purge_detect_jobs(),
  public.detect_worker_status()
TO service_role;
