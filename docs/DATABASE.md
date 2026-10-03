# Database (Supabase Postgres)

The schema, row level security (RLS), audit trail and retention policy live in
`supabase/migrations/`. The pgTAP tests in `supabase/tests/database/` check them.

## Migrations

The Supabase CLI applies migrations in **byte order of the filename**. Every
file has a unique 14-digit version (`YYYYMMDDHHMMSS`); the schema-contract tests
(`src/test/migrations.ts`) read *all* files in that order and fail if a version
is duplicated or not 14 digits.

| File | What it does |
| --- | --- |
| `20260925000000_init_schema.sql` | Original tables and the old `vehicles` view (legacy). |
| `20260927000000_add_detection_pipeline_columns.sql` | `tracked_vehicle_id`, `frame_timestamp_sec` (legacy). |
| `20260927000100_add_detection_tracking.sql` | Same columns again (`IF NOT EXISTS`, so a no-op after the file above; kept for history). |
| `20260930000000_delhi_camera_network.sql` | Old Delhi camera registry (kept for history). |
| `20261001000000_reconcile_schema.sql` | **Makes the schema match the code** (details below). |
| `20261001000100_rls.sql` | **RLS, grants, audit triggers, `purge_old_detections()`.** |
| `20261001000200_mumbai_camera_network.sql` | Mumbai camera registry (cam-001..cam-008, new clips); retires cam-009. Sorts after the Delhi seed, so it wins on a fresh reset. |
| `20261001000300_alerts_realtime.sql` | Adds **`alerts` (only)** to the `supabase_realtime` publication, so the dashboard gets new alerts instantly. `detections` is deliberately not published (high volume). No-op on plain Postgres. |
| `20261003000200_detect_jobs.sql` | **Live frame queue** for the hosted site: private tables `detect_jobs` (frames waiting for the GPU, cleared when read, purged after 2 min) and `detect_worker` (worker heartbeat) plus the functions `enqueue_detect_job`, `claim_detect_jobs`, `detect_worker_beat`, `purge_detect_jobs`, `detect_worker_status`. `service_role` only (the `/api/detect` function and the worker on the GPU box); `enqueue_detect_job` answers `PT503` when no worker checked in within 30 s and `PT429` when 8 frames are already waiting. See `pipeline/detect/README.md`. |

The `20261001*` files are idempotent and don't depend on the camera-network
files, so you can apply them to any project built from the older migrations.
They also work on an empty database.

> **Renamed versions (Sept 2026).** The first four files used to be
> `20260925_…`, `20260927_…` (twice — a duplicate version that made
> `supabase db push` fail) and `20260930_…`. If your hosted project's migration
> history still records the old 8-digit versions, re-map it once:
>
> ```bash
> supabase migration repair --status reverted 20260925 20260927 20260930
> supabase migration repair --status applied 20260925000000 20260927000000 20260927000100 20260930000000
> ```
>
> The SQL itself did not change (only comments), so nothing is re-run.

### What the reconcile migration fixes

The code used columns that the migrations never created. This migration adds
them and backfills them from the old columns:

* `detections`: `detected_at` (the old `timestamp` column is no longer
  `NOT NULL`, and a trigger keeps it in sync with `detected_at`),
  `latitude`/`longitude` (kept in sync with `lat`/`lng`), `plate_confidence`,
  `engine`, `model_version`, `source_video`. `tracked_vehicle_id` becomes `text`,
  which removes the 32-vs-64 width conflict.
* `cameras`: `latitude`/`longitude` (kept in sync with `lat`/`lng`) and `road`.
* `alerts`: `created_at`, `status` (`open|acknowledged|dismissed|escalated`,
  kept in sync with the legacy `acknowledged` flag), `detection_id`,
  `alert_type`, `source_key` (unique, used for idempotent seeding) and `details`.
  There is now a single foreign key to `detections`, on `detection_id` with
  `ON DELETE SET NULL`. The old foreign key on `detection_event_id` is dropped
  because two foreign keys between the same tables break PostgREST embedding.
  The foreign key to `blacklist_entries` is `ON DELETE SET NULL`.
* `blacklist_entries`: `plate_text_normalized` (derived from `plate_text`,
  with a unique index) and `notes` (kept in sync with `reason`). The `id`
  column gets a server-side default.
* Views, both `security_invoker`:
  * `vehicles` has one row per normalised plate.
  * `trajectories` has one row per plate, shaped like the frontend
    `Trajectory` type. Consecutive detections at the same camera collapse into
    one waypoint (`camera_id`, `camera_code`, `camera_name`, `lat`, `lng`,
    `timestamp`, `last_seen`, `time_since_previous_seconds`).
  * In both views, `plate_text` is `plate_display(plate_text_normalized)`, for
    example `MH 01 AB 1234`. Filters on it use an index.
* Indexes:
  * `detections(camera_id, detected_at desc)`
  * `detections(plate_text_normalized, detected_at)`
  * `detections(detected_at)`, used by the purge
  * pg_trgm GIN indexes on the plate, used by `ILIKE` search
  * A partial index on open alerts
  * Indexes on the foreign-key columns

## Access model: private database behind the server API

The dashboard is public (no login to browse), but the **database and the
Storage buckets are private** (`20261001000700_private_database.sql`). The
anon key that ships in the browser bundle can read nothing; it is only used
for Supabase Auth (sign-in).

```
Browser ─► /api/data/*     Vercel function (api/_lib/dataRoutes.ts), service-role key,
                           column-limited answers, per-IP rate limit, s-maxage CDN cache
        ─► /api/media/sign 1-hour signed URLs for allowlisted objects (videos, golden)
        ─► Supabase Auth   sign-in only
        ─► /api/detect     live frames → private detect_jobs queue → worker on the GPU box
                           (the worker dials out; the model API is never exposed)
```

RLS stays **enabled and forced** on every table in `public`, and no policy
targets `anon` or `authenticated`:

| role | tables / views in `public` | Storage (`videos`, `golden`) | Realtime |
| --- | --- | --- | --- |
| `anon` | none (401 / 42501) | none (buckets private) | nothing published |
| `authenticated` | none: all reads and writes go through `/api/data` | none | nothing published |
| `service_role` (pipeline, `/api/data`, `/api/media/sign`) | all (bypasses RLS) | all | – |

Routes (`GET` unless noted):

| route | returns | auth |
| --- | --- | --- |
| `cameras[?id=]`, `POST cameras`, `PATCH cameras?id=` | camera registry | writes: operator |
| `alerts[?id=]`, `POST alerts/acknowledge {id}` | alerts joined with detection → camera and watchlist entry | ack: operator |
| `watchlist`, `POST watchlist`, `PATCH watchlist?id=` | watchlist entries | writes: operator |
| `detections?camera_id=` | one clip's plate reads (paged past PostgREST's 1000-row cap) | – |
| `vehicles[?q=]`, `trajectory?plate=` | vehicles view; trajectories row or the plate's reads | – |
| `model-status` | AI engine heartbeat row | – |
| `audit-log[?limit=]` | audit trail | operator |

* **Writes** need `Authorization: Bearer <Supabase access token>`. The route
  checks the token with GoTrue (`/auth/v1/user`, same as
  `supabase.auth.getUser(token)`) and requires `app_metadata.role` `operator`
  or `admin`, then writes with the service key.
* **Audit trail.** `audit_logs` is append-only and written only by the
  `write_audit_log()` SECURITY DEFINER trigger (alert status changes,
  watchlist and camera changes, retention purges). Under the service role
  `auth.uid()` is null, so the API sends the verified operator as
  `X-Argus-Actor-Id` / `X-Argus-Actor-Email`; `public.request_actor()` reads
  them from `request.headers` **only when the JWT role is `service_role`**
  (`20261001000600_audit_actor_headers.sql`), and the triggers record that id
  and email. `acknowledged_by` is set by the API from the verified session.
* **Realtime** is off for `public` tables; the dashboard polls the API
  (alerts every 10 s, model status every 5 s).
* Roles come from `app_metadata`, which only the service role can change. To
  grant a role, run this in the SQL editor:

  ```sql
  update auth.users
     set raw_app_meta_data = raw_app_meta_data || '{"role":"operator"}'
   where email = 'operator@example.com';
  ```

  The user must sign in again to get a token with the new claim.
* Emergency rollback of the lockdown (re-open anon reads for a demo): see the
  header of `20261001000700_private_database.sql`.

## Applying to the hosted project

Take a backup first (Dashboard → Database → Backups), or run
`supabase db dump -f backup.sql`.

### Option A: Supabase CLI (recommended)

```bash
supabase login
supabase link --project-ref <project-ref>
supabase migration list            # compare local vs remote history
supabase db push --dry-run         # shows what would run
supabase db push
```

If the project was originally built by pasting SQL into the editor, it has no
migration history, and `db push` would try to replay every file. Mark the
migrations that are already reflected in the database as applied, then push
the rest:

```bash
# example: init + pipeline columns were applied by hand
supabase migration repair --status applied 20260925000000 20260927000000 20260927000100
supabase db push
```

### Option B: SQL editor

Paste and run each file in this order:

1. `20261001000000_reconcile_schema.sql`
2. `20261001000100_rls.sql`
3. `20261001000200_mumbai_camera_network.sql`, if the Mumbai cameras aren't
   loaded yet
4. `20261001000300_alerts_realtime.sql` (live alert push)

If you use the CLI later, record these files as applied:

```bash
supabase migration repair --status applied 20261001000000 20261001000100 20261001000200 20261001000300
```

### Retention (pg_cron)

Enable **pg_cron** under Dashboard → Database → Extensions, then run:

```sql
select cron.schedule('purge-old-detections', '30 21 * * *',   -- 03:00 IST
                     $$select public.purge_old_detections(90)$$);
```

Alerts survive the purge. Their `detection_id` is set to NULL, and
`detection_event_id` keeps the historical reference.

## Verifying

### In the SQL editor

```sql
-- every public table: RLS on + forced
select relname, relrowsecurity, relforcerowsecurity
from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';

-- views run with the caller's rights
select relname, reloptions from pg_class where relname in ('vehicles', 'trajectories');

-- policies
select tablename, policyname, roles, cmd from pg_policies where schemaname = 'public' order by 1, 2;
```

### As `anon`, over the REST API (everything is denied)

```bash
URL=https://<project-ref>.supabase.co; ANON=<anon key>
H=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON")

for t in cameras detections alerts blacklist_entries vehicles trajectories model_status audit_logs detect_jobs detect_worker; do
  curl -s -o /dev/null -w "$t %{http_code}\n" "$URL/rest/v1/$t?select=*&limit=1" "${H[@]}"   # 401 (42501)
done
curl -s -o /dev/null -w "%{http_code}\n" "$URL/storage/v1/object/public/videos/mumbai/720p/<clip>.mp4"  # 400
curl -s "https://<site>/api/data/cameras" | head -c 200                                   # 200, via the API
```

### pgTAP tests (local stack, needs Docker)

```bash
supabase db start      # local Postgres with all migrations applied
supabase test db       # runs supabase/tests/database/*.test.sql
```

CI runs the same two commands (`.github/workflows/ci.yml`, job `database`).

## Loading data (service role)

The pipeline scripts need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, set
in `.env` or the environment. They **never fall back to the anon key**.

```bash
# 1. ANPR detections -> detections (idempotent upsert on a deterministic event_id)
python pipeline/insert_detections.py --detections_dir public/detections \
    --start_time 2026-09-29T08:00:00          # naive = Asia/Kolkata (--tz to change)
#    --start_time defaults to 08:00 on the simulated day in public/sim/summary.json
#    --dry_run builds the rows without touching the database

# 2. Watchlist + alerts from the simulation's curated cases (+ real detections of those plates)
python pipeline/seed_alerts_and_watchlist.py            # --dry_run to preview
```

Both scripts use the same exit codes:

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Nothing to do |
| 2 | Configuration error: missing env var, bad `--start_time`, or a camera code not in `cameras` |
| 3 | Some chunks still failed after the retries |

Re-running is always safe:

* Detections upsert on `event_id`.
* Watchlist entries upsert on `plate_text_normalized`.
* Alerts are inserted with `ON CONFLICT (source_key) DO NOTHING`, so an
  acknowledgement is never reset.

## Realtime

`20261001000300_alerts_realtime.sql` publishes `alerts`. The dashboard
(`src/features/alerts/realtime.ts`) subscribes to `postgres_changes`
INSERT/UPDATE on `public.alerts`, re-reads each new row with its joins, and
shows a toast + updates the sidebar badge. Realtime applies the same RLS as
REST, so every role that can read alerts receives them. The 30 s poll remains
as a fallback (the top-bar status popover shows whether the channel is
subscribed).

## Known issues

* None open for the migration set. (The duplicate `20260927` version was fixed
  by renaming every early migration to a 14-digit version, see above.)
