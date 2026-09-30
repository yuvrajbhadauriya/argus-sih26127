# Legacy local model (reference only)

This folder is the **old, untrained local inference** path: stock COCO
`yolov7-tiny.pt` weights run on the camera videos with IoU tracking and
**mock licence plates**. It produced the `public/detections/*.json` files the
dashboard still ships with.

It is **superseded by the remote detection API** (trained model, key kept
server-side) and is kept only for reference and for regenerating the static
fallback JSON. Do not build new features on it.

| File | What it was |
|---|---|
| `run_detection.py` | Batch YOLOv7-tiny + IoU tracking over all videos in `pipeline/camera_config.json` |
| `run_yolov7_on_videos.py` | Single-video runner for custom weights (falls back to simulation) |
| `yolov7_offline_inference.py` | Pure simulation — generates fake detections, no model |
| `weights/yolov7-tiny.pt` | Untrained-for-ANPR COCO weights (git-tracked for history; `*.pt` is now gitignored) |

Run from the repo root (defaults for `--videos_dir`/`--output_dir` are relative to it):

```bash
pip install -r pipeline/requirements.txt
python pipeline/legacy_local_model/run_detection.py --videos_dir ./videos --output_dir ./pipeline/data/detections --download
```
