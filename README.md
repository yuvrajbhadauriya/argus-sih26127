# NERO — Traffic Video Intelligence & ANPR Analytics System

NERO is an automated traffic monitoring and licence plate tracking system (Smart India Hackathon, BEL PS 127). This repository contains the React + TypeScript dashboard (deployed on Vercel from the repo root) and the Python offline detection / Supabase ingest pipeline.

## Repository layout

```
.
├── index.html, vite.config.ts, vercel.json, package.json   # web app (root = Vercel root)
├── public/detections/        # precomputed detection JSON served to the dashboard
├── src/
│   ├── main.tsx              # entry: ErrorBoundary + App
│   ├── app/                  # App router, ErrorBoundary, cross-page smoke test
│   ├── config/               # env.ts (import.meta.env), constants.ts (map, tiles, storage)
│   ├── lib/supabase/         # client.ts — the single Supabase client
│   ├── shared/               # generic ui/, layout/, map/ (BaseTileLayer)
│   ├── features/
│   │   ├── cameras/          # api.ts, hooks/useCameras, components/CameraVideoPlayer, pages/
│   │   ├── live-map/         # components/MapView + CameraMarker, pages/LiveMapPage
│   │   ├── detections/       # api.ts, hooks/useCameraDetections + useDetectionOverlay, pages/
│   │   ├── vehicles/         # api.ts, components/TrajectoryMap, pages/
│   │   ├── alerts/           # api.ts, pages/
│   │   ├── analytics/        # api.ts, pages/
│   │   └── admin/            # pages/
│   ├── mocks/fixtures/       # mock data used as fallbacks when Supabase is not configured
│   ├── types/                # shared TS types
│   └── test/                 # Vitest setup + Supabase fake
├── pipeline/
│   ├── insert_detections.py  # bulk ingest detection JSON into Supabase
│   ├── seed_alerts_and_watchlist.py
│   ├── camera_config.json    # camera code ↔ video mapping
│   ├── requirements.txt
│   ├── tests/                # pytest suite
│   └── legacy_local_model/   # old untrained local YOLOv7 inference (reference only)
└── supabase/migrations/      # database schema
```

Tests are colocated with the code they cover (`*.test.ts(x)`); cross-feature imports use the `@/` alias (→ `src/`).

## Web dashboard (Vite + React + TS)

```bash
cp .env.example .env          # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm install
npm run dev                   # http://localhost:5173
npm run build                 # tsc -b && vite build
npm run lint                  # oxlint
```

Without Supabase env vars the dashboard falls back to the mock fixtures in `src/mocks/fixtures`.

## Tests

```bash
npm test                      # Vitest (web)
npm run typecheck:test        # type-check tests

python3 -m venv .venv-test && .venv-test/bin/pip install -r requirements-dev.txt
npm run test:py               # pytest (pipeline/tests)
```

Tests marked `it.fails` / `xfail(strict=True)` document known bugs; they flip to failures once the bug is fixed.

## Detection pipeline (Python)

Run everything from the repo root. `.env` needs `SUPABASE_SERVICE_ROLE_KEY` (and `VITE_SUPABASE_URL`) for ingestion.

```bash
pip install -r pipeline/requirements.txt

# Ingest detection JSON into Supabase
python pipeline/insert_detections.py --detections_dir ./public/detections

# Seed watchlist entries and match alerts
python pipeline/seed_alerts_and_watchlist.py
```

`insert_detections.py` options: `--detections_dir` (default `./detections`), `--config` (default `pipeline/camera_config.json`), `--start_time` (ISO base timestamp), `--batch_size` (default 500).

### Detection JSON format (`detections_<camera_code>.json`)

```json
[
  {
    "camera_code": "IG-01",
    "tracked_vehicle_id": "trk_0001",
    "plate_text": "DL 01 AB 1234",
    "vehicle_type": "car",
    "confidence": 0.87,
    "frame_timestamp_sec": 12.4,
    "bbox": { "x": 120, "y": 340, "width": 80, "height": 60 }
  }
]
```

### Legacy local model

`pipeline/legacy_local_model/` holds the old untrained YOLOv7-tiny inference (`run_detection.py` etc.) that produced the committed `public/detections` files. It is superseded by the remote detection API and kept for reference only — see its [README](pipeline/legacy_local_model/README.md).
