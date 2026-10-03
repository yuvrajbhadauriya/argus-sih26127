# GPU box: live-frame worker

These two files run **on the GPU box**, inside the release folder
`~/anpr_pipeline/lpu_on_gpu_release/` (next to `api_server.py` and `watchdog.py`). The copy in that folder is the
one that runs; this directory is the versioned source, so copy changes over by hand (steps below).

| File | Purpose |
| --- | --- |
| `detect_worker.py` | Lets the hosted dashboard run real-time ANPR on the GPU without exposing the model API. Standard library only, uses the release `venv`. |
| `run_api.sh` | The box's `run_api.sh`, extended to start/stop/check the worker as a second background process next to the watchdog. |

## How it works

```
Browser ─► Vercel /api/detect ─► enqueue_detect_job()                 (Supabase, service role)
                ▲                        │
                │ polls the row          ▼
                └────────────────  public.detect_jobs
                                         ▲
GPU box:  detect_worker.py ── claim_detect_jobs() ──┘
            └─► POST the frame to this box's own /v1/frame (X-API-Key from .env)
            └─► PATCH the row with the raw answer, frame cleared
```

- **Outbound only.** The worker dials Supabase over HTTPS and calls the ANPR API on this box. It opens no port; the
  API stays on its Tailscale address and nothing is made public. The API address and key come from `.env`, never from
  the database.
- **Privacy.** A frame lives in the private `detect_jobs` table (RLS forced, service role only) for a few seconds. It
  is cleared the moment the job finishes, and rows are purged after 2 minutes.
- **Safe by construction.** Frames that are not a JPEG, are empty or exceed 4 MB never reach the GPU. A job can only
  ask for `tiles`, `roi_top` and `min_conf` within sane ranges; anything else falls back to the default query
  (`tiles=2x3&roi_top=0.33&min_conf=60`, or `ANPR_FRAME_QUERY` from `.env`).
- **Liveness.** A heartbeat every 10 s (`detect_worker_beat`). The API refuses new frames when it is older than 30 s,
  and the dashboard then falls back to the recorded reads.

`.env` (same file as the API/watchdog) needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `ANPR_API_KEY`;
`ANPR_API_HOST`, `ANPR_API_PORT`, `ANPR_FRAME_QUERY` and `WORKER_ID` are optional.

## Deploy

Apply the migration `supabase/migrations/20261003000200_detect_jobs.sql` first (until then the worker just logs
`HTTP 404` and retries with backoff). Then, from the repo root:

```bash
BOX=rd@100.64.0.1; DIR='~/anpr_pipeline/lpu_on_gpu_release'
ssh $BOX "cd $DIR && cp -p run_api.sh run_api.sh.bak-before-worker"           # keep the old script
scp pipeline/gpu_box/detect_worker.py pipeline/gpu_box/run_api.sh $BOX:$DIR/
ssh $BOX "cd $DIR && chmod +x run_api.sh && ./run_api.sh ensure && ./run_api.sh status"
```

`ensure` leaves the running watchdog and API alone and starts only the worker. The existing cron entries (`@reboot`
and every minute, `run_api.sh ensure`) keep the worker alive from then on; no crontab change is needed.

## Check

```bash
ssh rd@100.64.0.1 'cd ~/anpr_pipeline/lpu_on_gpu_release && ./run_api.sh status && tail -n 20 worker.log'
```

`worker.log` has one line per job (id prefix, duration, detection count) and rate-limited warnings. It never contains
frames, plate text, keys or URLs. Stop only the worker with `kill $(cat worker.pid)` (cron restarts it within a minute
unless `detect_worker.py` is removed). Dev: `venv/bin/python detect_worker.py --once` drains the queue and exits.

Tests: `pipeline/tests/test_detect_worker.py` (real local HTTP servers standing in for Supabase and the model API).
