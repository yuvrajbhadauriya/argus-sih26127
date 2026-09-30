# Remote GPU ANPR detection

All number-plate detection runs on the team's **trained YOLOv7-tiny Indian
number-plate model** (GPU machine, HTTP API, API key). Nothing in this repo runs
a model locally any more — `pipeline/legacy_local_model/` is reference only.

```
Browser ──POST /api/detect (JPEG frame)──▶ Vercel function api/detect.ts ──(+ API key)──▶ GPU model API
                                               ▲ key lives only here (server env)
Batch:  pipeline/detect/run_remote_detection.py ──(+ API key from .env)──▶ GPU model API
```

| File | Purpose |
| --- | --- |
| `api/_lib/modelAdapter.ts` | **The** TS adapter: env config, upstream request, response normalisation |
| `pipeline/detect/adapter.py` | Python twin of the adapter (same shapes, same output) |
| `api/detect.ts`, `api/health.ts` | Vercel serverless proxy + health check |
| `pipeline/detect/client.py` | Python HTTP client: timeouts, retries with backoff, no key in errors |
| `pipeline/detect/run_remote_detection.py` | Batch pipeline: sample video frames → model API → IoU tracker → JSON |
| `pipeline/detect/tracker.py` | Lightweight IoU tracker (copied from the legacy script) |
| `pipeline/detect/mock_model_server.py` | Stdlib mock model API with key check, for local end-to-end tests |

## Configuration (server-only — never `VITE_`)

| Variable | Default | Notes |
| --- | --- | --- |
| `DETECTION_API_URL` | — | Full URL of the model's detect endpoint (POST) |
| `DETECTION_API_KEY` | — | Secret key |
| `DETECTION_API_AUTH_HEADER` | `Authorization` | `Authorization` → `Bearer <key>`; any other name (e.g. `x-api-key`) → raw key |
| `DETECTION_API_TIMEOUT_MS` | `15000` | Per-frame upstream timeout |
| `DETECTION_API_REQUEST_FORMAT` | `multipart` | `multipart` (file field) · `json` (base64) · `raw` (image body) |
| `DETECTION_API_IMAGE_FIELD` | `image` | Field name for multipart/json |
| `DETECTION_API_HEALTH_URL` | `<origin>/health` | Probe used by `/api/health` and the pipeline start-up check |

## Pointing at the real GPU API

1. Put the values in the repo-root `.env` (for `vercel dev` and the Python pipeline):
   ```
   DETECTION_API_URL=https://<gpu-host>/detect
   DETECTION_API_KEY=<key>
   ```
2. Check the contract with one frame:
   `curl -H "Authorization: Bearer $KEY" -F image=@frame.jpg $DETECTION_API_URL`
3. If the request/response differs from what the adapter already accepts, edit
   **only** `buildUpstreamRequest()` / `normaliseUpstreamResponse()` in
   `api/_lib/modelAdapter.ts` and the matching functions in
   `pipeline/detect/adapter.py`, then add the real response as a fixture to
   `src/features/detections/remote/modelAdapter.test.ts` and
   `pipeline/tests/test_remote_adapter.py`.

Shapes accepted today: detection lists under `detections` / `predictions` /
`results` / `objects` / `plates` / `data` (or a bare / batched array, or raw
`[x1,y1,x2,y2,conf,cls]` rows); boxes as `xyxy`, `xywh` (YOLO centre), `xyxyn` /
`xywhn` (0..1), `tlwh`, `bbox`/`box` arrays or `{x1,y1,x2,y2}` / `{xmin,…}` /
`{x,y,width,height}` objects or flat keys; class from `class` / `label` / `name`
/ `class_id` (COCO ids 2/3/5/7); plate from `plate` / `plate_text` / `text` /
`ocr` (string or `{text, confidence}`).

## Normalised contract

`POST /api/detect` with `{"image_base64": "<jpeg/png>", "camera_code": "VP-01", "frame_timestamp_sec": 12.4}`
(or multipart with an `image` file) returns:

```json
{
  "engine": "yolov7-tiny-anpr",
  "model_version": "1.0.0",
  "latency_ms": 84,
  "inference_ms": 11.2,
  "image": { "width": 1280, "height": 720 },
  "detections": [
    { "plate_text": "DL 01 AB 1234", "plate_confidence": 0.987, "vehicle_type": "car",
      "confidence": 0.94, "bbox": { "x": 412.0, "y": 300.5, "width": 180.0, "height": 96.0 } }
  ]
}
```

`bbox` is top-left + size in pixels of the submitted frame. Errors are
`{"error": "..."}` with 400 (bad body), 405 (method), 413 (> 4 MB), 415
(content type), 502 (upstream error/unreachable/unknown shape), 503 (not
configured) or 504 (upstream timeout). The key and upstream URL never appear in
responses.

## Run everything locally (no GPU)

```bash
# 1. mock model API (key: dev-key)
python pipeline/detect/mock_model_server.py --port 8765 --api_key dev-key

# 2. .env at repo root
DETECTION_API_URL=http://127.0.0.1:8765/detect
DETECTION_API_KEY=dev-key

# 3. dashboard + /api functions on one port
npx vercel dev            # http://localhost:3000, curl http://localhost:3000/api/health

# 4. batch pipeline (needs opencv-python, numpy, python-dotenv)
python pipeline/detect/run_remote_detection.py --videos_dir ./pipeline/data/videos_1080p \
    --output_dir ./public/detections --sample_interval 0.2 --conf_threshold 0.4 --workers 4
```

`pipeline/camera_config.json` maps each Mumbai camera to its clip (`<slug>.mp4`; the 1080p analysis
renditions come from `pipeline/tools/prepare_videos.py`). The dashboard overlay draws boxes in the
640×360 frame space of `useDetectionOverlay.ts`, whatever the source resolution. After a run, list the camera codes
that now have output in `public/detections/manifest.json` so the dashboard draws them, and re-seed the
simulation from the real reads:
`python3 pipeline/simulation/simulate_city_network.py --plates-from public/detections`.

The pipeline exits with code 2 if the API is not configured, unreachable,
or rejects the key — there is no silent fallback. Extra flags: `--workers`,
`--max_retries`, `--timeout_ms`, `--max_width`, `--jpeg_quality`, `--cameras`,
`--env_file`. Output per camera: `detections_<CODE>.json` (compact) with
`camera_code, tracked_vehicle_id, plate_text, plate_confidence, vehicle_type,
confidence, frame_timestamp_sec, bbox (640×360 canvas), engine, model_version`,
plus `summary.json` / `summary.csv`. Load into Supabase with
`pipeline/insert_detections.py` as before.

## Deploying the key to Vercel

Vercel → Project → **Settings → Environment Variables** → add
`DETECTION_API_URL`, `DETECTION_API_KEY` (and optionally
`DETECTION_API_AUTH_HEADER`, `DETECTION_API_TIMEOUT_MS`) for Production and
Preview → **Redeploy**. Or: `vercel env add DETECTION_API_KEY production`.
Do not add a `VITE_` prefix: `VITE_*` values are baked into the public JS bundle.
Verify with `GET /api/health` → `{"ok": true, "configured": true, "reachable": true, …}`.
The GPU API must be reachable from the public internet (Vercel functions run in
Vercel's cloud, not on the team's LAN) — use HTTPS and keep the key check on.
