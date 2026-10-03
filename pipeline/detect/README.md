# Remote GPU ANPR detection

All number-plate detection runs on the team's **LPU ANPR model API** on the
GPU box: vehicle + plate detector **DEIM** (`deim50k`) and **PARSeq** OCR
(`raw35`), engine `lpu_on_gpu`, model version `deim50k+raw35`. Nothing in this
repo runs a model locally — `pipeline/legacy_local_model/` (the old untrained
YOLOv7-tiny script) is reference only.

The API listens on the team's **Tailscale/LAN address only**. Per the model
README and the DPDP Act it must never be exposed publicly — no public tunnels.

```
Browser ─POST /api/detect (JPEG)─▶ api/detect.ts ─raw JPEG + X-API-Key─▶ <base>/v1/frame?tiles=2x3…
             (npm run dev: mounted by api/_lib/viteDevBridge.ts · Vercel: 503, model API is LAN/VPN-only)
Batch:  run_remote_detection.py ─▶ <base>/v1/video (whole clip, one event per vehicle)
                                 ─▶ <base>/v1/frame (frames at ~5 fps, overlay boxes)
```

| File | Purpose |
| --- | --- |
| `api/_lib/modelAdapter.ts` | **The** TS adapter: env config, upstream URL/request, response normalisation |
| `pipeline/detect/adapter.py` | Python twin of the adapter (same mapping, same output) |
| `api/detect.ts`, `api/health.ts` | Serverless proxy + health check (Vercel, and `npm run dev` via the bridge) |
| `api/_lib/viteDevBridge.ts` | Dev-only Vite plugin mounting the two handlers on the dev server |
| `pipeline/detect/client.py` | Python HTTP client: `/v1/frame`, `/v1/video`, `/health`; retries, no key in errors |
| `pipeline/detect/run_remote_detection.py` | Batch pipeline → `public/detections/*` |
| `pipeline/detect/tracker.py` | Lightweight IoU tracker |
| `pipeline/detect/mock_model_server.py` | Stdlib mock of the same API, for tests / offline work |

## The model API contract

`GET /health` (no key) → `{"ok": true, "engine": "lpu_on_gpu", "model_version": "deim50k+raw35", "model_loaded": true, "gpu_busy": false}`

`POST /v1/frame?tiles=2x3&roi_top=0.33&min_conf=60`, body = raw JPEG/PNG,
header `X-API-Key: <key>` (or `Authorization: Bearer <key>`):

```json
{"image": {"width": 1920, "height": 1080}, "engine": "lpu_on_gpu", "model_version": "deim50k+raw35",
 "inference_ms": 330.2, "latency_ms": 1284.6,
 "detections": [{"plate": "MH02EZ1785", "ocr_confidence": 93.4, "raw_ocr": "MH02EZ1785", "grammar_valid": true,
                 "plate_score": 0.8, "plate_box_xywh": [830, 935, 46, 12],
                 "vehicle_class": "Car", "vehicle_confidence": 0.5731, "vehicle_box_xywh": [778, 809, 186, 189]}]}
```

`"plate": "Not Found"` = a vehicle without a read. Boxes are top-left
`[x, y, w, h]` in pixels of the submitted image. `POST /v1/video?frame_step=1&tiles=2x3`
(raw mp4) returns `{"events": [...]}`, one per vehicle, with `time_sec`/`frame`.
Real responses are checked in as fixtures:
`src/features/detections/remote/fixtures/lpu_frame_vp01.json` and `lpu_video_jg01.json`
(used by both the TS and the Python adapter tests).

Practical notes (measured on the Mumbai clips):

- Wide overhead city views **need `tiles=2x3`**; untiled the detector sees ~1 vehicle.
- A read is **good** at `ocr_confidence ≥ 75` **and** `grammar_valid` — only good
  reads become plate text in the dashboard; weaker ones keep their box as `UNKNOWN`.
- With tiling, the vehicle detector often returns a box the size of a whole tile
  ("the tile is one truck"). The adapters drop such boxes (`isTileArtifact` /
  `is_tile_artifact`); a plate inside one is drawn at its plate box instead.
- The GPU is shared: one request in flight at a time. A tiled 1080p frame takes
  ~0.2–0.5 s of GPU (≈1 s round trip over Tailscale); `/v1/video` with
  `frame_step=1` needs ≈3.3 s of GPU per second of 1080p video.

## Mapping to the dashboard contract

| Model API | `/api/detect` / pipeline field |
| --- | --- |
| `plate` (`"Not Found"` → `null`) | `plate_text` |
| `ocr_confidence` (0–100) | `plate_confidence` (0–1) |
| `vehicle_class` Car/Auto → `car`, Bike → `motorcycle`, Bus → `bus`, Truck/LCV/Mini-LCV/Tractor → `truck` | `vehicle_type` (raw class kept in `vehicle_class`) |
| `vehicle_confidence` | `confidence` |
| `vehicle_box_xywh` (else `plate_box_xywh`) | `bbox {x, y, width, height}` + `bbox_source` |
| `plate_box_xywh` | `plate_bbox` |
| `grammar_valid`, `raw_ocr` | passed through |

The tolerant YOLO-style readers (`detections`/`predictions`/…, `xyxy`/`xywh`/…)
remain as a fallback for other servers.

## Configuration (server-only — never `VITE_`)

| Variable | Default | Notes |
| --- | --- | --- |
| `DETECTION_API_URL` | `<ANPR_API_BASE>/v1/frame` | Frame endpoint |
| `ANPR_API_BASE` | — | Base URL; also used by the pipeline for `/v1/video` |
| `DETECTION_API_KEY` | — | Secret key (`.env`, chmod 600) |
| `DETECTION_API_AUTH_HEADER` | `X-API-Key` | `Authorization` sends `Bearer <key>` |
| `DETECTION_API_QUERY` | `tiles=2x3&roi_top=0.33&min_conf=60` | Added to every `/api/detect` upstream call |
| `DETECTION_API_TIMEOUT_MS` | `15000` | Per-frame upstream timeout |
| `DETECTION_API_HEALTH_URL` | `<origin>/health` | Probe used by `/api/health` |
| `DETECTION_API_REQUEST_FORMAT` | `raw` | Legacy servers only: `multipart` · `json` |

## Live ANPR on the Cameras page (real-time crops + OCR)

While the selected feed plays, the Cameras page runs **real-time ANPR on it**: it captures the
current frame, posts it to `/api/detect` (→ the GPU model), and every good read (OCR ≥ 75 % **and**
valid plate grammar) comes back with its plate box. The **plate is cropped from that same frame**
(`src/features/detections/remote/plateCrop.ts`) and shown next to the vehicle crop, the OCR text and
the confidence in the *Live plate reads* panel. Details:

- One request in flight at a time (the GPU is shared), started at most once a second, only while the
  video is playing in a visible tab (`useLiveAnpr.ts`). Only the selected feed is analysed, not the wall.
- One row per vehicle: repeat sightings of a plate (one character of OCR jitter allowed) within 20 s
  are merged and the most confident crop is kept (`liveAnpr.ts`).
- When `/api/detect` cannot reach the model (503/502/network — e.g. the Vercel deployment) the panel
  falls back to the **recorded reads** of the clip with a visible note, and retries slowly
  (60 s when it is simply not configured), so it recovers by itself when the GPU box is reachable.
- Crops are cut from the 720p stream the browser plays. Plates that are tiny in that frame stay
  small; the offline pipeline (below) analyses the 1080p originals.

To demo it you must run the dashboard where the model API is reachable (`npm run dev` on the team
network / Tailscale, see below) — a Vercel deployment cannot reach it.

## Local dev: Live detect

`npm run dev` mounts `/api/detect` and `/api/health` through
`api/_lib/viteDevBridge.ts` (Vite `configureServer`, dev only). It reads `.env`
server-side with `loadEnv(mode, root, '')`, keeps only `DETECTION_API_*` /
`ANPR_API_*`, and passes them to the handlers — nothing is exposed through
`import.meta.env`, and `npm run build` output contains neither the key nor the
model host. The bridge only answers loopback clients (`NERO_DEV_API_ALLOW_LAN=1`
lifts that). On the team network/Tailscale:

```bash
npm run dev
curl -s localhost:5173/api/health     # {"ok":true,"engine":"lpu_on_gpu",…}
```

**Vercel:** functions run in Vercel's cloud and cannot reach a Tailscale-only
host, so the variables stay unset there; `/api/detect` answers 503 and the
Live plate reads panel falls back to the recorded reads ("Live GPU model not reachable from here"). Only set them on
Vercel if the team runs a private, authenticated tunnel it controls.

## Batch pipeline → `public/detections`

```bash
python3 pipeline/detect/run_remote_detection.py                 # all cameras in camera_config.json
python3 pipeline/detect/run_remote_detection.py --cameras VP-01  # one camera
python3 pipeline/detect/run_remote_detection.py --from_cache     # rebuild outputs, no GPU calls
```

Per camera it (a) posts the 1080p analysis clip (`pipeline/data/videos_1080p/`)
to `/v1/video?frame_step=1&tiles=2x3` for the authoritative one-plate-per-vehicle
events, and (b) posts frames sampled every 0.2 s (5 fps) to
`/v1/frame?tiles=2x3` for the per-frame overlay boxes, strictly sequentially.
Raw responses are cached in `pipeline/data/detect_cache/` (gitignored), so
linking/filters can be re-run with `--from_cache`.

Linking: frame boxes are tracked with the IoU tracker (plate-only boxes track
on a vehicle-sized proxy around the plate); each video event is matched to the
track at the nearest sampled frame whose box contains / overlaps its plate box,
and the track takes that event's plate. Unlinked tracks keep their own best
per-frame read only if it is within one character of a nearby good event read
or read identically in ≥ 2 frames. Tracks that end up with the same plate are
merged. Reads below 75 % or grammar-invalid never become plate text.

Outputs (in `--output_dir`, default `public/detections`):

- `detections_<CODE>.json` — compact array of overlay rows `camera_code,
  tracked_vehicle_id, plate_text ("MH 02 FG 0919" or "UNKNOWN"),
  plate_confidence, vehicle_type, confidence, frame_timestamp_sec, bbox,
  engine, model_version`. `bbox` is on the **640×360 canvas** of
  `useDetectionOverlay.ts` (the 16:9 tile; portrait clips are pillar-boxed, so
  their boxes get the same x offset as the picture). `confidence` is the track's
  peak detector confidence, or the OCR confidence of its read when higher.
- `events_<CODE>.json` — `{camera_code, engine, model_version, clip, gpu,
  good_read_rule, events: [{plate_text, plate_read, plate_confidence,
  grammar_valid, good_read, vehicle_type, vehicle_class, time_sec, frame,
  tracked_vehicle_id, bbox}]}`.
- `manifest.json` — `cameras` (read by the dashboard) + per-camera stats.
- `<cache_dir>/summary.json|csv` — run summary.

Then re-seed the simulation from the real reads:
`python3 pipeline/simulation/simulate_city_network.py --plates-from public/detections`
and `python3 pipeline/simulation/export_demo_fixtures.py`.

Exit codes: 0 ok · 1 nothing processed · 2 API not configured / unreachable /
key rejected — there is no silent fallback.

## Offline (no GPU)

```bash
python3 pipeline/detect/mock_model_server.py --port 8766 --api_key dev-key
DETECTION_API_URL=http://127.0.0.1:8766/v1/frame DETECTION_API_KEY=dev-key npm run dev
```
