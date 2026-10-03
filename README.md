# NERO — Traffic Video Intelligence & ANPR Analytics System

NERO is a city-wide multi-camera ANPR trajectory-tracking and traffic-analytics platform (Smart India Hackathon 2026, BEL PS **SIH26127**). This repository contains the React + TypeScript dashboard (deployed on Vercel from the repo root) and the Python detection / Supabase ingest / simulation / evaluation pipeline.

| Doc | What's in it |
| --- | --- |
| [docs/PS_COMPLIANCE.md](docs/PS_COMPLIANCE.md) | Every PS requirement → screen, code, how to demo, status |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | 5–7 minute judge walkthrough (plates, clicks, talking points) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current architecture + production scale-out (edge inference, event bus, partitioned PostGIS, HLS/CDN) |
| [docs/DATABASE.md](docs/DATABASE.md) | Migrations, private-database access model, `/api/data` routes, applying to the hosted project |
| [pipeline/detect/README.md](pipeline/detect/README.md) | Model API contract and how to plug in the trained GPU model |

## Quick start

```bash
npm install
python3 pipeline/tools/link_local_videos.py   # optional: local camera clips for `npm run dev`
npm run dev                                   # http://localhost:5173
```

With no `.env` the app runs on the **simulated Mumbai network** (status pill: *Simulated*). Sign in
at `/login` with the **demo operator** to acknowledge alerts and edit the watchlist, and press
**Replay the day** on the Live Map or Alerts page to watch plate reads stream in and alerts fire
live. With `VITE_SUPABASE_URL` set the same screens read the database (status pill: *Live*),
sign-in uses Supabase Auth and new alerts arrive through a 10 s poll of the server API.

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | Live mode (data through `/api/data`; the anon key is only used for sign-in; writes need a signed-in operator/admin). Unset → simulated/demo mode. |
| `VITE_VIDEO_SOURCE` | browser | `local` → `/videos-local/<slug>.mp4` (default in `npm run dev`), `supabase` → Storage `videos/mumbai/720p/<slug>.mp4` (default in builds). The player falls back to the other source once. |
| `DETECTION_API_URL`, `DETECTION_API_KEY` | server only | Trained ANPR model API used by `/api/detect` and the batch pipeline. **Never** prefix with `VITE_`. |
| `DETECTION_API_AUTH_HEADER`, `DETECTION_API_TIMEOUT_MS`, `DETECTION_API_REQUEST_FORMAT`, `DETECTION_API_IMAGE_FIELD`, `DETECTION_API_HEALTH_URL` | server only | Optional adapter settings (see `.env.example`, `pipeline/detect/README.md`). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | pipeline only | Ingest / seeding scripts (bypass RLS). |

### What is real and what is simulated

* **Real:** 8 Mumbai traffic clips at their real junctions, the road network and OSRM routes, the
  database schema / RLS / auth / Realtime, the alert, trajectory and analytics engines.
* **Simulated:** the vehicles travelling *between* cameras (2,600 plates, 3,471 journeys, 8,523
  reads on 29 Sep 2026) and the watchlist/anomaly cases — marked with the *Simulated city network*
  badge and the top-bar data-source pill.
* **Live ANPR (needs the model API reachable):** on the Cameras page the selected feed is analysed in
  real time by the GPU model — frames go to `/api/detect`, and each read is shown with the real vehicle
  and plate crops cut from the analysed frame plus the OCR text. Without a reachable model API (e.g. the
  Vercel deployment) the panel shows the recorded reads of the clip and says so.
* **Needs the model API:** plate reads from the clips themselves and the > 90 % accuracy figure
  (Model Performance page shows a sample run until `pipeline/eval/evaluate.py` is run against the
  trained model).

## Repository layout

```
.
├── index.html, vite.config.ts, vercel.json, package.json   # web app (root = Vercel root)
├── public/detections/        # ANPR pipeline output per camera (manifest.json lists which cameras have it)
├── public/sim/               # simulated Mumbai network: road routes, journeys, demo summary
├── src/
│   ├── main.tsx              # entry: ErrorBoundary + App
│   ├── app/                  # App router, ErrorBoundary, cross-page smoke test
│   ├── config/               # env.ts (import.meta.env), constants.ts (map, tiles, storage)
│   ├── lib/                  # supabase/client.ts (lazy SDK), dataSource.ts (Live/Simulated/Demo)
│   ├── shared/               # generic ui/, layout/, map/ (BaseTileLayer)
│   ├── features/
│   │   ├── cameras/          # api.ts, hooks/useCameras, components/CameraVideoPlayer, pages/
│   │   ├── live-map/         # components/MapView + CameraMarker, pages/LiveMapPage
│   │   ├── detections/       # api.ts, hooks/useCameraDetections + useDetectionOverlay, pages/
│   │   ├── vehicles/         # api.ts, components/TrajectoryMap, pages/
│   │   ├── alerts/           # api.ts, realtime.ts, live.ts (event bus), LiveAlertBridge, pages/
│   │   ├── analytics/        # api.ts, lib/aggregate.ts, pages/
│   │   ├── auth/             # session.ts, guard.ts, LoginPage, SignInPrompt
│   │   ├── replay/           # "Replay the day": clock.ts, engine.ts, ReplayControls
│   │   └── admin/            # api.ts (audit log), pages/
│   ├── mocks/fixtures/       # demo fixtures generated from the simulation (simulated/demo mode only)
│   ├── types/                # shared TS types
│   └── test/                 # Vitest setup + Supabase fake
├── pipeline/
│   ├── insert_detections.py  # bulk ingest detection JSON into Supabase
│   ├── seed_alerts_and_watchlist.py
│   ├── camera_config.json    # camera registry: code, Mumbai location, clip slug
│   ├── simulation/           # OSRM road routes + city-network simulation (+ demo fixture export)
│   ├── requirements.txt
│   ├── tests/                # pytest suite
│   └── legacy_local_model/   # old untrained local YOLOv7 inference (reference only)
└── supabase/migrations/      # database schema
```

Tests are colocated with the code they cover (`*.test.ts(x)`); cross-feature imports use the `@/` alias (→ `src/`).

## Web dashboard (Vite + React + TS)

```bash
cp .env.example .env          # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (optional)
npm install
npm run dev                   # http://localhost:5173
npm run build                 # tsc -b && vite build  (public/videos-local is never copied to dist/)
npm run preview               # serves dist/ (+ /videos-local from public/ for local clips)
npm run lint                  # oxlint
```

Without Supabase env vars the dashboard runs in simulated mode (never as a silent fallback: when
Supabase *is* configured and a request fails, the page shows the error and the status pill says
*Live · degraded*). The Supabase SDK is only downloaded in live mode.

Camera clips stream from `VITE_VIDEO_SOURCE`: `local` (default in `npm run dev`) plays
`public/videos-local/<slug>.mp4` — create it with `python3 pipeline/tools/link_local_videos.py` —
and `supabase` (default in production builds) plays `videos/mumbai/720p/<slug>.mp4` from Supabase
Storage. If the chosen source fails, the player tries the other one once.

## Camera network (Mumbai)

Eight cameras play real Mumbai traffic clips (Pexels; credits in
`pipeline/data/candidate_clips/SOURCES.md`). Each clip is pinned to the junction it was plausibly
shot at, on a connected corridor network: the Western Express Highway (Jogeshwari–Andheri–Vile
Parle–Santacruz), Dadar TT and Sion Circle in the island city, and LBS Marg at Kurla and Bhandup.
Every clip was chosen by scoring candidates on the real ANPR model API (good read = OCR confidence
≥ 75 and grammar-valid); the 30-clip search behind SC-01, KR-01 and BH-01 is in
`pipeline/data/candidate_clips_v2/SOURCES.md` and `SCORES.md`. No openly licensed night or rain
clip gave a single good read at 1080p, so all eight feeds are daytime; night accuracy is shown on
`/accuracy` (golden set: night-IR, night-visible, dusk/dawn and glare crops).

| Code | Camera | Road | Zone |
| --- | --- | --- | --- |
| JG-01 | Jogeshwari JVLR Junction | Western Express Highway at the JVLR interchange | Western Suburbs |
| AN-01 | Andheri Flyover (Gundavali) | WEH at Andheri–Kurla Road | Western Suburbs |
| VP-01 | Vile Parle Flyover | WEH at Vile Parle Flyover (the sign is visible in the clip) | Western Suburbs |
| SC-01 | Santacruz Airport Approach | WEH near Airport Terminal 1, roadside on the flyover | Western Suburbs |
| DD-01 | Dadar TT Junction | Dr Babasaheb Ambedkar Road beside Dadar TT Flyover | Island City |
| SN-01 | Sion Circle | Sion Circle at Sion–Panvel Highway | Island City |
| KR-01 | Kurla Depot Junction | LBS Marg, Kurla West (flyover approach) | Eastern Suburbs |
| BH-01 | Bhandup LBS Marg | LBS Marg, Bhandup West, Metro Line 4 (roadside, BEST buses) | Eastern Suburbs |

The registry lives in `pipeline/camera_config.json`, `src/mocks/fixtures/mockCameras.ts` and
`supabase/migrations/20261001000200_mumbai_camera_network.sql`; `pipeline/tests/test_simulation_registry.py`
keeps them identical.

Cross-camera journeys are simulated (the clips have no shared vehicles):

```bash
python3 pipeline/simulation/build_road_routes.py        # OSRM road routes between every camera pair (cached)
python3 pipeline/simulation/simulate_city_network.py    # --seed 26127 → public/sim/{journeys,summary}.json
python3 pipeline/simulation/export_demo_fixtures.py     # → src/mocks/fixtures/simDemo.generated.ts
```

The simulator generates a realistic Mumbai fleet: MH01/02/03/47 city RTOs, MH04/05/43/46/48 MMR RTOs,
other Maharashtra and out-of-state (GJ, KA, DL, RJ…) plates, BH-series plates, yellow commercial plates
for taxis, buses and goods vehicles, and green EV plates. Once the ANPR model has been run on the new
clips, seed the fleet from its real reads with `--plates-from public/detections`.

## Tests

```bash
npm test                      # Vitest (web)
npm run typecheck:test        # type-check tests

python3 -m venv .venv-test && .venv-test/bin/pip install -r requirements-dev.txt
npm run test:py               # pytest (pipeline/tests)
```

Tests marked `it.fails` / `xfail(strict=True)` would document known bugs; there are none left — the former ones are now regression tests.

## Detection pipeline (Python)

Run everything from the repo root. `.env` needs `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` for ingestion.

```bash
pip install -r pipeline/requirements.txt

# Ingest detection JSON into Supabase
python pipeline/insert_detections.py --detections_dir ./public/detections

# Seed watchlist entries and match alerts
python pipeline/seed_alerts_and_watchlist.py
```

`insert_detections.py` options:

* `--detections_dir`: default `public/detections`.
* `--start_time`: ISO 8601. A value without a timezone is read in `--tz`, which defaults to `Asia/Kolkata`. If omitted, it defaults to 08:00 on the simulated day.
* `--batch_size`: default 500.
* `--retries`: default 4.
* `--dry_run`: build the rows without writing anything.

Both scripts:

* require `SUPABASE_SERVICE_ROLE_KEY` and never fall back to the anon key;
* are idempotent, so re-running them is safe;
* exit non-zero on any failed write.

`seed_alerts_and_watchlist.py` builds the watchlist and alerts from `public/sim/summary.json`.

## Database & security

Schema, row level security, audit trail and retention are defined in `supabase/migrations/`. [docs/DATABASE.md](docs/DATABASE.md) covers:

* which files to apply, and in what order
* the full RLS policy matrix
* how to verify the setup
* the pgTAP tests (`supabase test db`)

**Access model today:** the dashboard is public, the **database and Storage are private**. The anon key can read no table and no bucket; every read goes through the server routes `/api/data/*` (service-role key on Vercel, column-limited answers, per-IP rate limit, short CDN cache) and clips play from 1-hour signed URLs (`/api/media/sign`). Writes (acknowledging alerts, registering/editing cameras, editing the watchlist) **require a signed-in user whose `app_metadata.role` is `operator` or `admin`** — the API verifies the Supabase access token and records the operator in the audit trail; guests who press a write button are asked to sign in. New alerts arrive through a 10 s poll. Server env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (never `VITE_*`). See [docs/DATABASE.md](docs/DATABASE.md).

### Detection JSON format (`detections_<camera_code>.json`)

The dashboard only draws static detections for cameras listed in `public/detections/manifest.json`
(`{"cameras": ["VP-01", …]}`); every other camera shows "No detections yet — run the AI pipeline".

```json
[
  {
    "camera_code": "VP-01",
    "tracked_vehicle_id": "trk_0001",
    "plate_text": "MH 02 AB 1234",
    "vehicle_type": "car",
    "confidence": 0.87,
    "frame_timestamp_sec": 12.4,
    "bbox": { "x": 120, "y": 340, "width": 80, "height": 60 }
  }
]
```

### Legacy local model

`pipeline/legacy_local_model/` holds the old untrained YOLOv7-tiny inference (`run_detection.py` etc.) that produced the old (Delhi-era) `public/detections` files, which were removed when the network moved to Mumbai. It is superseded by the remote detection API and kept for reference only — see its [README](pipeline/legacy_local_model/README.md).
