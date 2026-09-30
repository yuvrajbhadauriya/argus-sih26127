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

## Access model (RLS)

RLS is **enabled and forced** on every table in `public`. Any table added
later without a policy is reachable only by `service_role`.

| | cameras | detections | alerts | blacklist_entries | audit_logs | vehicles / trajectories |
| --- | --- | --- | --- | --- | --- | --- |
| `anon` | read | read | read | read | – | read |
| `authenticated` | read | read | read | read | – | read |
| `authenticated` + `app_metadata.role` = `operator` | read, insert, update | read | read, update of `status`/`acknowledged*` only | read, insert, update | read | read |
| `authenticated` + `app_metadata.role` = `admin` | above + delete | read | same as operator | above + delete | read | read |
| `service_role` (pipeline) | all (bypasses RLS) | all | all | all | all | all |

* `audit_logs` is append-only. Only the `write_audit_log()` SECURITY DEFINER
  trigger writes to it. It records:
  * alert status changes, such as an acknowledgement
  * watchlist insert, update and delete
  * camera changes
  * retention purges

  Each row records `auth.uid()` and the JWT email.
* When an alert is acknowledged, `acknowledged_by` and `acknowledged_at` are
  stamped **on the server** from the JWT. A name sent by the client is
  ignored.
* Roles come from `app_metadata`, which only the service role can change. To
  grant a role, run this in the SQL editor:

  ```sql
  update auth.users
     set raw_app_meta_data = raw_app_meta_data || '{"role":"operator"}'
   where email = 'operator@example.com';
  ```

  The user must sign in again to get a token with the new claim.

> **Prototype vs production.** The dashboard currently uses the **anon key for
> read-only access**, so the SIH demo works without a login. Every write from
> the Admin or Alerts pages (acknowledge, register/edit camera, watchlist add /
> pause) **requires a signed-in operator or admin**. The dashboard has an
> operator sign-in page (`/login`, Supabase Auth email + password) and asks a
> guest to sign in when they press a write button, instead of letting the
> write fail. Create operator accounts in Dashboard → Authentication → Users,
> then grant the role with the SQL above.
> ANPR reads are personal data under the DPDP Act 2023. For production, drop
> the `anon` read policies and require login. The statements are at the end of
> `20261001000100_rls.sql`.

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

### As `anon`, over the REST API

```bash
URL=https://<project-ref>.supabase.co; ANON=<anon key>
H=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json")

curl -s "$URL/rest/v1/cameras?select=id,code&limit=2" "${H[@]}"                   # 200, rows
curl -s "$URL/rest/v1/trajectories?select=plate_text,camera_count&limit=1" "${H[@]}"  # 200
curl -s -X POST "$URL/rest/v1/detections" "${H[@]}" -d '{"event_id":"x"}'           # 401/403, code 42501
curl -s -X PATCH "$URL/rest/v1/alerts?id=eq.x" "${H[@]}" -d '{"status":"acknowledged"}'  # 401, 42501
curl -s -X DELETE "$URL/rest/v1/blacklist_entries?id=eq.x" "${H[@]}"                # 401, 42501
curl -s -X POST "$URL/rest/v1/rpc/purge_old_detections" "${H[@]}" -d '{"retention_days":1}'  # 401/404
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
