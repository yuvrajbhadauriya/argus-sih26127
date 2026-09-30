# PS SIH26127 compliance matrix

**Problem statement (BEL):** *City-Wide AI Engine for Multi-Camera ANPR Trajectory Tracking and
Urban Traffic Analytics.*

Every requirement sentence of the PS is mapped to the screen/route and the code that implements
it, how to show it in the demo, and an honest status.

**Status legend**

| Status | Meaning |
| --- | --- |
| **Done** | Works end-to-end in the prototype on real inputs (real clips, real roads, real database when configured). |
| **Done-simulated** | Feature complete, but the *traffic* driving it is the simulated Mumbai day (`public/sim/*`), because the 8 real clips share no vehicles. The same code runs on Supabase data when `VITE_SUPABASE_URL` is set. |
| **Needs model API** | Everything is built and tested against a mock of the model API contract; the number or the live reads appear once the trained GPU model is plugged in (`api/_lib/modelAdapter.ts`, `pipeline/detect/adapter.py` — contract unchanged). |

The data source is always shown once in the top bar (status pill → **Live** / **Simulated** /
**Demo data**), and simulated panels carry the amber *Simulated city network* badge.

## 1. High-precision OCR (> 90 % under varied conditions)

| PS requirement | Where | How to demo | Status |
| --- | --- | --- | --- |
| Detect and read Indian number plates from CCTV video | Model API behind `api/detect.ts` (Vercel proxy, key server-side) → `api/_lib/modelAdapter.ts`; batch: `pipeline/detect/run_remote_detection.py` | Cameras (`/cameras`) → select a feed → **Run AI detection on this frame** sends the current frame to `/api/detect` and draws the boxes/plates | Needs model API (proxy, adapter, overlay, tracker and mock server are done and tested) |
| > 90 % plate-recognition accuracy | Evaluation harness `pipeline/eval/` → `public/eval/results.json` → **Model Performance** page (`/model`) | Open `/model`: plate / character / OCR accuracy, per-dataset and per-condition breakdown, confusions | Needs model API — the page currently shows a *sample* run against the mock oracle; re-run `pipeline/eval/evaluate.py` against the trained model |
| Varied conditions: lighting, weather, angles, blur, damaged plates | Night clip **KR-01** (Kurla), rain clip **BH-01** (Bhandup); `/model` per-condition table; `pipeline/eval/video_consistency.py` for label-free read stability on the Mumbai clips | `/cameras` → KR-01 and BH-01 tiles; `/model` condition rows | Needs model API |
| Multi-lane, multi-vehicle frames | Video wall + overlay (`src/features/detections/hooks/useDetectionOverlay.ts`, `remote/drawDetections.ts`) with IoU tracking (`pipeline/detect/tracker.py`) | `/cameras` video wall (8 real Mumbai clips) | Needs model API (overlay renders pipeline output as soon as `public/detections/manifest.json` lists a camera) |
| Plate normalisation / Indian formats (MH 01 AB 1234, BH series, commercial/EV colours) | `src/shared/lib/plate.ts`, `PlateChip`, `modelAdapter.normalisePlateText` | Type `mh01cs0126` in the top search → normalised `MH 01 CS 0126` | Done |

## 2. Trajectory Reconstruction Engine

| PS requirement | Where | How to demo | Status |
| --- | --- | --- | --- |
| Query-based interface | Global plate search (top bar, `Ctrl K`) → **Vehicle Trace** `/vehicles?plate=…` (`src/features/vehicles/pages/VehiclesPage.tsx`) | Search `MH 01 CS 0126` | Done |
| Plot a vehicle's historical path on the city map | `TrajectoryMap.tsx`: road-snapped path (OSRM geometry, `public/sim/road_routes.json`), numbered stops | Same plate — the path follows the Western Express Highway | Done-simulated |
| Chronological, with timestamps and camera locations | `TrajectoryTimeline.tsx` (IST times, camera code + name, gap since previous stop) | Journey timeline panel | Done-simulated |
| Direction and route taken | Direction arrows on the path, heading per stop (N/NE/…), road distance and average speed per hop | Hover a stop / read the timeline | Done-simulated |
| Replay the journey | Route replay (`lib/replay.ts`, `[`/`]`/`Space`) | Press play on the trace map | Done |
| Reads from the database in production | `features/vehicles/api.ts`: `trajectories` / `vehicles` views (`20261001000000_reconcile_schema.sql`), reconstruction from `detections` as fallback | Set `VITE_SUPABASE_URL`; status pill shows **Live** | Done (DB path tested against a fake client; errors surface as ErrorState) |

## 3. City Traffic Analytics Dashboard

| PS requirement | Where | How to demo | Status |
| --- | --- | --- | --- |
| GIS-integrated dashboard | Leaflet maps with theme-aware Esri tiles on Live Map (`/`), Analytics (`/analytics`), Vehicle Trace, Alerts | Any map page | Done |
| Heatmaps (incl. real-time) | Analytics **Congestion heatmap** (`components/CongestionMap.tsx`: corridor intensity + camera load heat circles); Live Map **Alert hotspots** layer, which updates live during *Replay the day* | `/analytics` → Congestion heatmap; `/` → Replay the day, watch hotspots appear | Done-simulated |
| Average speeds | Analytics **Average speed by zone**, **Speed distribution** (P10–P90), Live Map KPI *Network avg speed* | `/analytics` | Done-simulated |
| Route densities | Analytics **Corridors** (busiest camera-pair corridors, both directions), **Camera load and route density** | `/analytics` | Done-simulated |
| Traffic-flow trends across all camera nodes | **Hourly volume**, **Flow trends by zone**, **Zone volume**, time windows (AM peak / midday / PM peak / night) | `/analytics` → switch Time window | Done-simulated |
| Density | Camera load, Detections · last hour (Live Map KPI, follows the replay clock) | `/` | Done-simulated |
| Origin–destination patterns | **Origin–destination matrix** (zone × zone) and **Top flows** (camera to camera) | `/analytics` | Done-simulated |
| Congestion bottlenecks | **Congestion bottlenecks** (cameras ranked by volume × slowdown vs network mean), **Travel time comparison** | `/analytics` | Done-simulated |
| Aggregation code | `src/features/analytics/lib/aggregate.ts` (tested); production plan: materialised views over `detections` (see `docs/ARCHITECTURE.md`) | — | Done (client-side); server-side views are the scale-out step |

## 4. Alert system

| PS requirement | Where | How to demo | Status |
| --- | --- | --- | --- |
| Flag blacklisted (watchlist) vehicles | Watchlist in Admin (`/admin` → Watchlist, add / pause, operator-only); alerts table + `pipeline/seed_alerts_and_watchlist.py`; triage queue `/alerts` | `/alerts`: `MH 01 CS 0126` (stolen, critical) | Done-simulated (Supabase path live when configured) |
| Suspicious route anomalies | Cloned-plate detection (physically impossible hop: `MH 04 AK 4356`, DD-01 → BH-01, 18.2 km in 3 min) and circling (`MH 05 DN 0114`, VP-01 ↔ SC-01 ×3); evidence timeline + mini-map | `/alerts` → Type: Route anomalies | Done-simulated |
| In real time | Live mode: 10 s poll of `/api/data/alerts` (`src/features/alerts/livePoll.ts`; the database is private, so no anon Realtime) → toast + sidebar badge. Simulated mode: **Replay the day** (`src/features/replay/`) fires the same events as the clock passes each alert | `/alerts` → **Replay the day** → toast *Watchlist hit: MH 01 CS 0126* at 08:05 | Done (live path tested with a mocked data API) |
| Operator workflow | Acknowledge (server stamps who/when from the JWT), filters, median time-to-acknowledge, deep link `/alerts?id=` | Acknowledge the alert; KPI updates | Done |
| Access control / audit | `/login` (Supabase Auth; demo identity when not configured), role from `app_metadata.role`, write buttons prompt guests to sign in; RLS + audit trigger (`20261001000100_rls.sql`), Admin → Audit Log | Sign out → press Acknowledge → *Sign in required* | Done |

## 5. Scalable, enterprise-grade platform

| PS requirement | Where | How to demo | Status |
| --- | --- | --- | --- |
| Multi-camera, city-wide | 8 real Mumbai camera nodes (WEH, LBS Marg, Dadar, Sion) on a connected road graph; registry in `pipeline/camera_config.json` / migrations | `/cameras`, `/` | Done |
| Scalable architecture | `docs/ARCHITECTURE.md` — current architecture and the production scale-out (edge inference, stream ingestion, event bus, partitioned Postgres/PostGIS, CDN/HLS) | Show the diagram | Design (prototype runs the single-region version) |
| Security & privacy (DPDP Act) | private database (no anon access; reads/writes via the `/api/data` server routes), private Storage with signed URLs, service-role pipeline, audit trail, 90-day retention (`purge_old_detections`), API key server-side only | `docs/DATABASE.md` | Done |
| Performance | Code-split routes, lazy Supabase SDK, route-level preload, videos never bundled | `npm run build` | Done |
| Quality | Vitest (web), pytest (pipeline), pgTAP (RLS + schema), CI (`.github/workflows/ci.yml`) | `npm test`, `npm run test:py` | Done |

## What exactly is simulated

* **Real:** the 8 camera clips (Mumbai traffic footage, credits in
  `pipeline/data/candidate_clips/SOURCES.md`), the junction locations, the road network and routes
  (OSRM), the schema, auth, RLS, alerts pipeline, analytics code.
* **Simulated:** the vehicles that travel between cameras — 2,600 plates, 3,471 journeys and
  8,523 camera reads on 29 Sep 2026 (`pipeline/simulation/simulate_city_network.py`, seed 26127),
  the watchlist/anomaly cases, and the OCR confidences shown in the live feed.
* **Pending the model:** plate reads *from the clips themselves* and the accuracy figure. Once the
  model API is live, `python pipeline/detect/run_remote_detection.py` writes
  `public/detections/*`, and `simulate_city_network.py --plates-from public/detections` seeds the
  simulated fleet from real reads.
