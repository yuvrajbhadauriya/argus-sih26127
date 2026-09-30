#!/usr/bin/env python3
"""
NERO Pipeline — Remote GPU ANPR Detection
==========================================
Samples frames from the camera videos, sends each frame to the team's trained
YOLOv7-tiny Indian number-plate model (HTTP API on the GPU machine, protected
by an API key), tracks vehicles across frames with a lightweight IoU tracker,
and writes one compact JSON file per camera in the schema the dashboard reads:

    camera_code, tracked_vehicle_id, plate_text, plate_confidence, vehicle_type,
    confidence, frame_timestamp_sec, bbox{x,y,width,height} (640x360 canvas),
    engine, model_version

There is NO local/heuristic fallback: if the model API is not configured or
unreachable the script exits non-zero.

Config (env or repo-root .env — never VITE_ prefixed):
    DETECTION_API_URL, DETECTION_API_KEY
    DETECTION_API_AUTH_HEADER (default Authorization -> "Bearer <key>")
    DETECTION_API_TIMEOUT_MS  (default 15000)

Usage:
    python pipeline/detect/run_remote_detection.py --videos_dir ./videos \
        --output_dir ./public/detections --sample_interval 0.2 --conf_threshold 0.4

Exit codes: 0 ok · 1 nothing processed · 2 API not configured/unreachable/rejected
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import json
import os
import sys
import time
import urllib.request
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_PIPELINE)
if _PIPELINE not in sys.path:  # allow `python pipeline/detect/run_remote_detection.py`
    sys.path.insert(0, _PIPELINE)

from detect.adapter import read_model_api_config
from detect.client import (
    DetectionAPIError,
    DetectionAPIUnavailable,
    RemoteDetectionClient,
)
from detect.tracker import LightweightTracker

DEFAULT_CONFIG = os.path.join(_PIPELINE, "camera_config.json")

# Reference canvas the frontend overlay uses for bbox scaling
OVERLAY_WIDTH = 640
OVERLAY_HEIGHT = 360
VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    with contextlib.suppress(AttributeError, ValueError, OSError):  # captured / non-text stdout
        sys.stdout.reconfigure(encoding="utf-8")


# ──────────────────────────────────────────────────────────────────────
# Env loading
# ──────────────────────────────────────────────────────────────────────
def load_env(path: str | None = None) -> None:
    """Loads .env (python-dotenv if installed, else a minimal parser). Never overrides real env."""
    path = path or os.path.join(_ROOT, ".env")
    if not os.path.exists(path):
        return
    try:
        from dotenv import load_dotenv

        if load_dotenv(path, override=False):
            return
    except ImportError:
        pass
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


# ──────────────────────────────────────────────────────────────────────
# Frame helpers
# ──────────────────────────────────────────────────────────────────────
def encode_frame(frame, max_width: int, jpeg_quality: int) -> tuple[bytes, int, int]:
    """Downscales to max_width (if wider) and JPEG-encodes. Returns (bytes, w, h)."""
    import cv2

    h, w = frame.shape[:2]
    if max_width and w > max_width:
        scale = max_width / w
        w, h = max_width, max(1, round(h * scale))
        frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)])
    if not ok:
        raise RuntimeError("cv2.imencode failed to encode frame as JPEG")
    return bytes(buf), w, h


def to_overlay_bbox(bbox: dict, frame_w: int, frame_h: int) -> list:
    """Frame-pixel {x,y,width,height} -> [x, y, w, h] on the 640x360 overlay canvas."""
    sx, sy = OVERLAY_WIDTH / frame_w, OVERLAY_HEIGHT / frame_h
    return [
        round(bbox["x"] * sx, 1),
        round(bbox["y"] * sy, 1),
        round(bbox["width"] * sx, 1),
        round(bbox["height"] * sy, 1),
    ]


def iter_sampled_frames(video_path: str, sample_interval: float):
    """Yields (frame_timestamp_sec, frame) every `sample_interval` seconds of video time."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {video_path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        step = max(1, round(fps * sample_interval))
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            idx += 1
            if (idx - 1) % step != 0:
                continue
            yield round((idx - 1) / fps, 3), frame
    finally:
        cap.release()


# ──────────────────────────────────────────────────────────────────────
# Per-video processing
# ──────────────────────────────────────────────────────────────────────
def process_single_video(
    video_path: str,
    camera_code: str,
    client: RemoteDetectionClient,
    sample_interval: float = 0.2,
    conf_threshold: float = 0.4,
    workers: int = 4,
    max_width: int = 1280,
    jpeg_quality: int = 85,
):
    """Runs remote detection over one video. Raises DetectionAPIError on API failure."""
    tracker = LightweightTracker(iou_thresh=0.2, max_missed=5)
    records: list[dict] = []
    engine, model_version = None, None
    latencies: list[float] = []
    sampled = 0
    window = max(1, workers) * 2

    def submit(pool, ts, frame) -> Future:
        data, w, h = encode_frame(frame, max_width, jpeg_quality)
        return pool.submit(
            lambda: (ts, w, h, client.detect(data, (w, h), camera_code=camera_code, frame_timestamp_sec=ts))
        )

    def consume(fut: Future) -> None:
        nonlocal engine, model_version
        ts, w, h, result = fut.result()  # re-raises DetectionAPIError
        engine = engine or result["engine"]
        model_version = model_version or result["model_version"]
        latencies.append(result.get("latency_ms") or 0)
        raw = [
            {
                "bbox": to_overlay_bbox(d["bbox"], w, h),
                "vehicle_type": d["vehicle_type"],
                "confidence": round(d["confidence"], 2),
                "plate_text": d["plate_text"],
                "plate_confidence": d["plate_confidence"],
            }
            for d in result["detections"]
            if d["confidence"] >= conf_threshold
        ]
        for det in tracker.update(raw):
            records.append({**det, "frame_timestamp_sec": ts})

    pending: deque[Future] = deque()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        try:
            for ts, frame in iter_sampled_frames(video_path, sample_interval):
                sampled += 1
                pending.append(submit(pool, ts, frame))
                if len(pending) >= window:
                    consume(pending.popleft())  # keep frame order for the tracker
            while pending:
                consume(pending.popleft())
        except BaseException:
            for f in pending:
                f.cancel()
            raise

    # Track-level plate consensus: frames where OCR missed inherit the track's best read.
    best: dict[str, tuple[float, str]] = {}
    for r in records:
        if r["plate_text"]:
            score = r["plate_confidence"] if r["plate_confidence"] is not None else r["confidence"]
            if r["tracked_vehicle_id"] not in best or score > best[r["tracked_vehicle_id"]][0]:
                best[r["tracked_vehicle_id"]] = (score, r["plate_text"])

    engine = engine or "unknown"
    model_version = model_version or "unknown"
    out = []
    for r in records:
        plate = r["plate_text"] or (best.get(r["tracked_vehicle_id"], (None, None))[1]) or "UNKNOWN"
        out.append(
            {
                "camera_code": camera_code,
                "tracked_vehicle_id": r["tracked_vehicle_id"],
                "plate_text": plate,
                "plate_confidence": r["plate_confidence"],
                "vehicle_type": r["vehicle_type"],
                "confidence": r["confidence"],
                "frame_timestamp_sec": r["frame_timestamp_sec"],
                "bbox": {"x": r["bbox"][0], "y": r["bbox"][1], "width": r["bbox"][2], "height": r["bbox"][3]},
                "engine": engine,
                "model_version": model_version,
            }
        )

    unique = len({d["tracked_vehicle_id"] for d in out})
    summary = {
        "camera_code": camera_code,
        "video_filename": os.path.basename(video_path),
        "total_frames_sampled": sampled,
        "total_detections": len(out),
        "unique_tracked_vehicles": unique,
        "plates_read": sum(1 for d in out if d["plate_text"] != "UNKNOWN"),
        "average_confidence": round(sum(d["confidence"] for d in out) / len(out), 3) if out else 0.0,
        "average_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else 0.0,
        "engine": engine,
        "model_version": model_version,
    }
    return out, summary


# ──────────────────────────────────────────────────────────────────────
# Video discovery / download (same behaviour as the legacy script)
# ──────────────────────────────────────────────────────────────────────
def ensure_videos_downloaded(config_path: str, videos_dir: str) -> None:
    if not os.path.exists(config_path):
        print(f"[!] Config file '{config_path}' not found — skipping download.")
        return
    os.makedirs(videos_dir, exist_ok=True)
    with open(config_path, "r", encoding="utf-8") as f:
        configs = json.load(f)
    for item in configs:
        filename, url = item.get("video_filename"), item.get("video_url")
        if not filename or not url:
            continue
        target = os.path.join(videos_dir, filename)
        if os.path.exists(target):
            continue
        print(f"[*] Downloading {filename} for camera {item.get('camera_code', '?')}...")
        try:
            with urllib.request.urlopen(url, timeout=120) as resp, open(target, "wb") as fout:
                while chunk := resp.read(1024 * 1024):
                    fout.write(chunk)
        except Exception as e:  # noqa: BLE001
            print(f"[!] Failed to download {filename}: {e}")
            if os.path.exists(target):
                os.remove(target)


def load_camera_configs(config_path: str, videos_dir: str) -> list[dict]:
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    print(f"[!] Config '{config_path}' not found — scanning {videos_dir}...")
    if not os.path.isdir(videos_dir):
        return []
    vids = sorted(f for f in os.listdir(videos_dir) if f.lower().endswith(VIDEO_EXTS))
    return [{"camera_code": f"CAM-{chr(65 + i)}", "video_filename": v} for i, v in enumerate(vids)]


def resolve_video_path(item: dict, videos_dir: str) -> str | None:
    path = os.path.join(videos_dir, item["video_filename"])
    if os.path.exists(path):
        return path
    fallback = os.path.join(_ROOT, "public", "videos", item["video_filename"])
    if os.path.exists(fallback):
        return fallback
    url = item.get("video_url", "")
    return url if url.startswith("http") else None


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="NERO — Remote GPU ANPR detection pipeline")
    p.add_argument("--videos_dir", default="./videos", help="Directory containing traffic videos (default: ./videos)")
    p.add_argument("--output_dir", default="./detections", help="Output directory for detection JSON (default: ./detections)")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="Camera config mapping (default: pipeline/camera_config.json)")
    p.add_argument("--sample_interval", type=float, default=0.2, help="Frame sampling interval in seconds (default: 0.2)")
    p.add_argument("--conf_threshold", type=float, default=0.4, help="Minimum detection confidence (default: 0.4)")
    p.add_argument("--download", action="store_true", help="Download missing videos from Supabase Storage first")
    p.add_argument("--workers", type=int, default=4, help="Concurrent requests to the model API (default: 4)")
    p.add_argument("--max_retries", type=int, default=3, help="Retries per frame on network/5xx errors (default: 3)")
    p.add_argument("--timeout_ms", type=int, default=None, help="Per-request timeout (default: DETECTION_API_TIMEOUT_MS or 15000)")
    p.add_argument("--max_width", type=int, default=1280, help="Downscale frames wider than this before upload (default: 1280)")
    p.add_argument("--jpeg_quality", type=int, default=85, help="JPEG quality for uploaded frames (default: 85)")
    p.add_argument("--cameras", nargs="*", default=None, help="Only process these camera codes")
    p.add_argument("--env_file", default=None, help="Path to .env (default: repo-root .env)")
    # Legacy flag kept so old commands still parse; the model lives on the GPU server now.
    p.add_argument("--weights", default=None, help=argparse.SUPPRESS)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_env(args.env_file)

    cfg = read_model_api_config()
    if cfg is None:
        print("[x] DETECTION_API_URL and DETECTION_API_KEY must be set (env or .env). No local fallback.", file=sys.stderr)
        return 2
    if args.timeout_ms:
        from dataclasses import replace

        cfg = replace(cfg, timeout_ms=args.timeout_ms)
    if args.weights:
        print("[!] --weights is ignored: detection runs on the remote GPU model API.")

    client = RemoteDetectionClient(cfg, max_retries=args.max_retries)

    print("=" * 60)
    print("  NERO — Remote GPU ANPR Detection Pipeline")
    print("=" * 60)
    print(f"  Model API      : configured ({cfg.auth_header} auth, timeout {cfg.timeout_ms} ms)")
    print(f"  Videos dir     : {args.videos_dir}")
    print(f"  Output dir     : {args.output_dir}")
    print(f"  Sample interval: {args.sample_interval}s  |  Conf threshold: {args.conf_threshold}")
    print(f"  Workers        : {args.workers}  |  Retries: {args.max_retries}")
    print("=" * 60)

    try:
        status = client.check_reachable()
        print(f"[OK] Model API reachable (health probe HTTP {status})")
    except DetectionAPIUnavailable as e:
        print(f"[x] {e}", file=sys.stderr)
        return 2

    os.makedirs(args.output_dir, exist_ok=True)
    if args.download:
        ensure_videos_downloaded(args.config, args.videos_dir)

    configs = load_camera_configs(args.config, args.videos_dir)
    if args.cameras:
        configs = [c for c in configs if c.get("camera_code") in set(args.cameras)]
    if not configs:
        print("[!] No camera configs found. Nothing to process.", file=sys.stderr)
        return 1

    summaries = []
    t0 = time.time()
    for item in configs:
        cam = item["camera_code"]
        path = resolve_video_path(item, args.videos_dir)
        if not path:
            print(f"[!] Skipping {cam}: '{item['video_filename']}' not found locally.")
            continue
        print(f"[*] {cam}: {os.path.basename(path)}")
        try:
            detections, summary = process_single_video(
                path, cam, client,
                sample_interval=args.sample_interval,
                conf_threshold=args.conf_threshold,
                workers=args.workers,
                max_width=args.max_width,
                jpeg_quality=args.jpeg_quality,
            )
        except DetectionAPIError as e:
            print(f"[x] {cam}: {e}. Aborting — no fallback.", file=sys.stderr)
            return 2
        except FileNotFoundError as e:
            print(f"[!] {cam}: {e}")
            continue
        out_path = os.path.join(args.output_dir, f"detections_{cam}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(detections, f, separators=(",", ":"))
        summaries.append(summary)
        print(
            f"    {summary['total_detections']} detections | {summary['unique_tracked_vehicles']} vehicles | "
            f"{summary['plates_read']} plate reads | avg latency {summary['average_latency_ms']} ms"
        )

    if not summaries:
        print("[!] No videos were processed successfully.", file=sys.stderr)
        return 1

    with open(os.path.join(args.output_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summaries, f, indent=2)
    with open(os.path.join(args.output_dir, "summary.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(summaries[0].keys()))
        writer.writeheader()
        writer.writerows(summaries)
    print(f"[OK] {len(summaries)}/{len(configs)} videos in {round(time.time() - t0, 1)}s -> {args.output_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
