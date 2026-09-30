#!/usr/bin/env python3
"""
NERO Pipeline — Remote GPU ANPR Detection
==========================================
Runs the team's LPU ANPR model API (GPU box, LAN/Tailscale only; detector
DEIM ``deim50k`` + PARSeq OCR ``raw35``) over the camera clips and writes, per
camera, the files the dashboard reads:

  public/detections/detections_<CODE>.json   per-frame overlay rows
      camera_code, tracked_vehicle_id, plate_text, plate_confidence,
      vehicle_type, confidence, frame_timestamp_sec,
      bbox{x,y,width,height} (640x360 overlay canvas), engine, model_version
  public/detections/events_<CODE>.json       one event per vehicle (/v1/video)
  public/detections/manifest.json            camera codes + per-camera stats

Two passes per clip, strictly one request in flight (the GPU is shared):

  (a) POST /v1/video?frame_step=1&tiles=2x3 — the authoritative
      one-plate-per-vehicle events (server-side tracking + OCR voting);
  (b) POST /v1/frame?tiles=2x3 on frames sampled at ~5 fps — per-frame
      vehicle boxes for the video overlay, tracked here with an IoU tracker.

Each overlay track gets the plate of the /v1/video event whose box and time
match it, else its own best per-frame read. Only GOOD reads become plate text:
OCR confidence >= 75 and grammar_valid; weaker reads keep the box but show
"UNKNOWN". Tile-sized vehicle boxes (a tiling artefact of the detector) are
dropped. Raw API responses are cached (``--cache_dir``) so the linking can be
re-run without GPU time (``--from_cache``).

There is NO local/heuristic fallback: if the model API is not configured or
unreachable the script exits non-zero.

Config (env or repo-root .env — never VITE_ prefixed):
    DETECTION_API_URL (…/v1/frame) or ANPR_API_BASE, DETECTION_API_KEY,
    DETECTION_API_AUTH_HEADER (default X-API-Key), DETECTION_API_TIMEOUT_MS

Usage:
    python3 pipeline/detect/run_remote_detection.py            # all cameras
    python3 pipeline/detect/run_remote_detection.py --cameras VP-01 --from_cache

Exit codes: 0 ok · 1 nothing processed · 2 API not configured/unreachable/rejected
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_PIPELINE)
if _PIPELINE not in sys.path:  # allow `python pipeline/detect/run_remote_detection.py`
    sys.path.insert(0, _PIPELINE)

from detect.adapter import (
    GOOD_READ_MIN_CONF,
    is_good_read,
    normalise_lpu_detection,
    normalise_upstream_response,
    parse_tiles,
    read_model_api_config,
)
from detect.client import (
    DetectionAPIError,
    DetectionAPIUnavailable,
    RemoteDetectionClient,
)
from detect.tracker import LightweightTracker, compute_iou

DEFAULT_CONFIG = os.path.join(_PIPELINE, "camera_config.json")
DEFAULT_VIDEOS = os.path.join(_PIPELINE, "data", "videos_1080p")
DEFAULT_OUTPUT = os.path.join(_ROOT, "public", "detections")
DEFAULT_CACHE = os.path.join(_PIPELINE, "data", "detect_cache")

# Reference canvas the frontend overlay uses for bbox scaling (useDetectionOverlay.ts)
OVERLAY_WIDTH = 640
OVERLAY_HEIGHT = 360
VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")

FRAME_QUERY = "tiles=2x3&roi_top=0.33&min_conf=0"
VIDEO_QUERY = "frame_step=1&tiles=2x3&roi_top=0.33&min_conf=0"
#: Vehicles without any plate read below this detector confidence are noise.
MIN_VEHICLE_CONF = 0.5
#: Plate-only boxes are padded to at least this size on the overlay canvas.
MIN_OVERLAY_BOX = 26.0

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
# Plates
# ──────────────────────────────────────────────────────────────────────
_STD_PLATE = re.compile(r"^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$")
_BH_PLATE = re.compile(r"^(\d{2})(BH)(\d{4})([A-Z]{1,2})$")


def format_plate(text: str) -> str:
    """'MH02FG0919' -> 'MH 02 FG 0919', '24BH5283G' -> '24 BH 5283 G' (the dashboard's display form)."""
    compact = re.sub(r"[^A-Z0-9]", "", (text or "").upper())
    m = _BH_PLATE.match(compact) or _STD_PLATE.match(compact)
    if not m:
        return compact
    parts = list(m.groups())
    if m.re is _STD_PLATE:
        parts[1] = parts[1].zfill(2)
        parts[3] = parts[3].zfill(4)
    return " ".join(p for p in parts if p)


# ──────────────────────────────────────────────────────────────────────
# Geometry
# ──────────────────────────────────────────────────────────────────────
def overlay_transform(frame_w: int, frame_h: int) -> tuple[float, float, float]:
    """(scale, offset_x, offset_y) from frame pixels to the 640x360 overlay canvas.

    The player shows the clip with object-fit: contain in a 16:9 tile, so a
    portrait clip is pillar-boxed; the offsets put boxes on the visible picture.
    """
    s = min(OVERLAY_WIDTH / frame_w, OVERLAY_HEIGHT / frame_h)
    return s, (OVERLAY_WIDTH - frame_w * s) / 2, (OVERLAY_HEIGHT - frame_h * s) / 2


def to_overlay_box(bbox: dict, tf: tuple[float, float, float], pad_to: float = 0.0) -> dict:
    s, ox, oy = tf
    x, y, w, h = bbox["x"] * s + ox, bbox["y"] * s + oy, bbox["width"] * s, bbox["height"] * s
    if pad_to and (w < pad_to or h < pad_to):
        cx, cy = x + w / 2, y + h / 2
        w, h = max(w, pad_to), max(h, pad_to)
        x, y = cx - w / 2, cy - h / 2
    x = min(max(x, 0.0), OVERLAY_WIDTH - w)
    y = min(max(y, 0.0), OVERLAY_HEIGHT - h)
    return {"x": round(x, 1), "y": round(y, 1), "width": round(w, 1), "height": round(h, 1)}


def _xywh(b: dict) -> list:
    return [b["x"], b["y"], b["width"], b["height"]]


def _contains(box: dict, px: float, py: float) -> bool:
    return box["x"] <= px <= box["x"] + box["width"] and box["y"] <= py <= box["y"] + box["height"]


def _centre(b: dict) -> tuple[float, float]:
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def track_box(det: dict) -> dict:
    """Box used for tracking. A plate-only detection gets a vehicle-sized proxy around its plate
    (plates are tiny and move more than their own size between samples, so raw plate boxes never overlap)."""
    if det.get("bbox_source") != "plate":
        return det["bbox"]
    b = det["bbox"]
    cx = b["x"] + b["width"] / 2
    w, h = b["width"] * 4.0, b["height"] * 10.0
    bottom = b["y"] + b["height"] * 2.0
    return {"x": cx - w / 2, "y": bottom - h, "width": w, "height": h}


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def dedupe_frame(dets: list[dict], iou: float = 0.7) -> list[dict]:
    """The detector often reports one box several times with different classes: keep the best."""
    order = sorted(dets, key=lambda d: (d["plate_text"] is not None, d["confidence"]), reverse=True)
    kept: list[dict] = []
    for d in order:
        dup = next((k for k in kept if compute_iou(_xywh(k["bbox"]), _xywh(d["bbox"])) >= iou), None)
        if dup is None:
            kept.append(dict(d, classes=Counter({d["vehicle_type"]: d["confidence"]})))
            continue
        dup["classes"][d["vehicle_type"]] += d["confidence"]
        if dup["plate_text"] is None and d["plate_text"] is not None:
            for k in ("plate_text", "plate_confidence", "grammar_valid", "raw_ocr", "plate_bbox"):
                dup[k] = d[k]
    return kept


# ──────────────────────────────────────────────────────────────────────
# Frame sampling
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


def probe_video(video_path: str) -> dict:
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {video_path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        ok, frame = cap.read()
        h, w = frame.shape[:2] if ok and frame is not None else (0, 0)
    finally:
        cap.release()
    return {"fps": float(fps), "frames": frames, "width": int(w), "height": int(h)}


def iter_sampled_frames(video_path: str, sample_interval: float):
    """Yields (frame_index, frame_timestamp_sec, frame) every `sample_interval` seconds of video time."""
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
            yield idx - 1, round((idx - 1) / fps, 3), frame
    finally:
        cap.release()


# ──────────────────────────────────────────────────────────────────────
# GPU passes (raw responses, cached)
# ──────────────────────────────────────────────────────────────────────
def _read_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: str, doc) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, path)


def _cache_matches_clip(doc: dict | None, video_path: str) -> bool:
    """A cached response belongs to the clip it was made from (the cache is per camera, the clip can change).
    Docs written before the clip name was recorded (no "video" key) are still accepted."""
    return bool(doc) and doc.get("video", os.path.basename(video_path)) == os.path.basename(video_path)


def fetch_video_events(client: RemoteDetectionClient, video_path: str, query: str, cache: str | None) -> dict:
    if cache and os.path.exists(cache):
        doc = _read_json(cache)
        if _cache_matches_clip(doc, video_path):
            return doc
    with open(video_path, "rb") as f:
        data = f.read()
    raw = client.detect_video(data, query=query)
    raw["query"] = query
    raw["video"] = os.path.basename(video_path)
    if cache:
        _write_json(cache, raw)
    return raw


def fetch_frame_samples(
    client: RemoteDetectionClient,
    video_path: str,
    camera_code: str,
    query: str,
    sample_interval: float,
    max_width: int,
    jpeg_quality: int,
    cache: str | None,
) -> dict:
    """Raw /v1/frame responses for frames sampled every `sample_interval` s (resumable via `cache`)."""
    doc = _read_json(cache) if cache and os.path.exists(cache) else None
    if not _cache_matches_clip(doc, video_path):
        doc = None
    if doc and doc.get("complete") and doc.get("query") == query and doc.get("sample_interval") == sample_interval:
        return doc
    if not doc or doc.get("query") != query or doc.get("sample_interval") != sample_interval:
        doc = {"query": query, "sample_interval": sample_interval, "complete": False, "samples": []}
    doc["video"] = os.path.basename(video_path)
    done = {s["frame"] for s in doc["samples"]}
    since_save = 0
    for frame_idx, ts, frame in iter_sampled_frames(video_path, sample_interval):
        if frame_idx in done:
            continue
        data, w, h = encode_frame(frame, max_width, jpeg_quality)
        res = client.detect(data, (w, h), camera_code=camera_code, frame_timestamp_sec=ts, query=query, return_raw=True)
        raw = res["raw"]
        doc["samples"].append({
            "frame": frame_idx, "t": ts, "width": w, "height": h,
            "latency_ms": res["latency_ms"], "raw": raw,
        })
        since_save += 1
        if cache and since_save >= 25:
            _write_json(cache, doc)
            since_save = 0
    doc["samples"].sort(key=lambda s: s["frame"])
    doc["complete"] = True
    if cache:
        _write_json(cache, doc)
    return doc


# ──────────────────────────────────────────────────────────────────────
# Linking + output
# ──────────────────────────────────────────────────────────────────────
def _vote_type(classes: Counter) -> str:
    for vt, _ in classes.most_common():
        if vt != "unknown":
            return vt
    return "unknown"


def build_camera_outputs(camera_code: str, frames_doc: dict, video_doc: dict | None, clip: dict,
                         min_good_conf: float = GOOD_READ_MIN_CONF) -> tuple[list, dict, dict]:
    """(overlay rows, events document, summary) from the raw API responses of one clip."""
    tiles = parse_tiles(frames_doc.get("query"))
    samples = frames_doc.get("samples") or []
    engine = model_version = None
    tracker = LightweightTracker(iou_thresh=0.2, max_missed=4, match_types=False)
    rows: list[dict] = []  # internal rows in frame pixels
    frame_ms = 0.0
    fw = fh = 0
    for s in samples:
        raw = s["raw"]
        engine = engine or raw.get("engine")
        model_version = model_version or raw.get("model_version")
        frame_ms += float(raw.get("inference_ms") or 0)
        norm = normalise_upstream_response(raw, (s["width"], s["height"]), tiles)
        fw, fh = norm["image"]["width"], norm["image"]["height"]
        dets = [d for d in norm["detections"] if d["plate_text"] is not None or d["confidence"] >= MIN_VEHICLE_CONF]
        dets = dedupe_frame(dets)
        tracked = tracker.update([dict(d, box=d["bbox"], bbox=_xywh(track_box(d))) for d in dets])
        for d in tracked:
            d["bbox"] = d.pop("box")
            rows.append(dict(d, t=s["t"]))

    by_track: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_track[r["tracked_vehicle_id"]].append(r)
    times = sorted({s["t"] for s in samples})

    # ── /v1/video events: one per vehicle ───────────────────────────────
    events_out = []
    video_ms = 0.0
    video_wall_ms = 0.0
    track_plate: dict[str, tuple[float, str, str]] = {}  # track -> (conf, plate, source)
    fps = clip.get("fps") or 30.0
    for ev in (video_doc or {}).get("events", []):
        det = normalise_lpu_detection(ev, (fw, fh) if fw else None, parse_tiles((video_doc or {}).get("query")))
        t = float(ev.get("time_sec") if ev.get("time_sec") is not None else (ev.get("frame") or 0) / fps)
        good = det is not None and is_good_read(det, min_good_conf)
        link = None
        if det is not None and times:
            nearest = min(times, key=lambda x: abs(x - t))
            if abs(nearest - t) <= frames_doc.get("sample_interval", 0.2) * 0.75:
                probe = det.get("plate_bbox") or det["bbox"]
                px, py = _centre(probe)
                cands = []
                for r in rows:
                    if r["t"] != nearest:
                        continue
                    if r.get("plate_bbox") and compute_iou(_xywh(r["plate_bbox"]), _xywh(probe)) >= 0.2:
                        cands.append((0, r["bbox"]["width"] * r["bbox"]["height"], r))
                    elif _contains(r["bbox"], px, py):
                        cands.append((1, r["bbox"]["width"] * r["bbox"]["height"], r))
                if cands:
                    link = min(cands, key=lambda c: (c[0], c[1]))[2]["tracked_vehicle_id"]
        plate = format_plate(det["plate_text"]) if good else None
        if good and link:
            prev = track_plate.get(link)
            if prev is None or det["plate_confidence"] > prev[0]:
                track_plate[link] = (det["plate_confidence"], plate, "event")
        events_out.append({
            "plate_text": plate,
            "plate_read": det["plate_text"] if det else (ev.get("plate") if ev.get("plate") != "Not Found" else None),
            "plate_confidence": det["plate_confidence"] if det else None,
            "grammar_valid": ev.get("grammar_valid"),
            "good_read": good,
            "vehicle_type": det["vehicle_type"] if det else "unknown",
            "vehicle_class": ev.get("vehicle_class"),
            "time_sec": round(t, 3),
            "frame": ev.get("frame"),
            "tracked_vehicle_id": link,
            "_det": det,
        })
    if video_doc:
        engine = engine or video_doc.get("engine")
        model_version = model_version or video_doc.get("model_version")
        video_ms = float(video_doc.get("inference_ms") or 0)
        video_wall_ms = float(video_doc.get("client_latency_ms") or video_doc.get("latency_ms") or 0)

    # ── per-track plate: linked event, else the track's own best good read ──
    # A frame read within one character of a nearby good event read is that
    # event's plate (per-frame OCR jitter); otherwise it must be read
    # identically (good) in at least two frames of the track.
    good_events = [(e["time_sec"], e["plate_text"]) for e in events_out if e["good_read"]]
    for tid, trs in by_track.items():
        if tid in track_plate:
            continue
        reads = [r for r in trs if is_good_read(r, min_good_conf)]
        if not reads:
            continue
        best = max(reads, key=lambda r: r["plate_confidence"])
        plate = format_plate(best["plate_text"])
        compact = plate.replace(" ", "")
        near = [p for (t, p) in good_events
                if abs(t - best["t"]) <= 3.0 and levenshtein(p.replace(" ", ""), compact) <= 1]
        if near:
            track_plate[tid] = (best["plate_confidence"], near[0], "frame~event")
        elif sum(1 for r in reads if format_plate(r["plate_text"]) == plate) >= 2:
            track_plate[tid] = (best["plate_confidence"], plate, "frame")

    # One plate = one vehicle in a clip: merge the tracks that carry the same plate.
    first_tid: dict[str, str] = {}
    for tid in sorted(by_track, key=lambda k: by_track[k][0]["t"]):
        if tid in track_plate:
            first_tid.setdefault(track_plate[tid][1], tid)
    for tid in list(by_track):
        if tid in track_plate:
            keep = first_tid[track_plate[tid][1]]
            if keep != tid:
                by_track[keep].extend(by_track.pop(tid))
                prev = track_plate.pop(tid)
                if prev[0] > track_plate[keep][0]:
                    track_plate[keep] = (prev[0], track_plate[keep][1], track_plate[keep][2])
                for e in events_out:
                    if e["tracked_vehicle_id"] == tid:
                        e["tracked_vehicle_id"] = keep

    engine = engine or "unknown"
    model_version = model_version or "unknown"
    tf = overlay_transform(fw or clip.get("width") or 1920, fh or clip.get("height") or 1080)

    out: list[dict] = []
    kept_tracks = set()
    for tid, trs in by_track.items():
        plate = track_plate.get(tid)
        if len(trs) < 2 and plate is None:
            continue  # one-frame blip without a read
        kept_tracks.add(tid)
        classes: Counter = Counter()
        for r in trs:
            classes.update(r.get("classes") or {r["vehicle_type"]: r["confidence"]})
        vtype = _vote_type(classes)
        # Track confidence: the detector's peak confidence on this vehicle, or the
        # OCR confidence of its assigned read when that is higher.
        track_conf = max([r["confidence"] for r in trs] + ([plate[0]] if plate else []))
        for r in trs:
            out.append({
                "camera_code": camera_code,
                "tracked_vehicle_id": tid,
                "plate_text": plate[1] if plate else "UNKNOWN",
                "plate_confidence": round(plate[0], 3) if plate else None,
                "vehicle_type": vtype,
                "confidence": round(track_conf, 3),
                "frame_timestamp_sec": r["t"],
                "bbox": to_overlay_box(r["bbox"], tf, MIN_OVERLAY_BOX if r.get("bbox_source") == "plate" else 0.0),
                "engine": engine,
                "model_version": model_version,
            })

    # Good event reads the frame pass never boxed: show them at their event time.
    ev_n = 0
    for e in events_out:
        det = e.pop("_det")
        if det is not None:
            e["bbox"] = to_overlay_box(det["bbox"], tf, MIN_OVERLAY_BOX if det.get("bbox_source") == "plate" else 0.0)
        if e["good_read"] and e["tracked_vehicle_id"] is None and det is not None:
            ev_n += 1
            tid = f"evt_{ev_n:04d}"
            e["tracked_vehicle_id"] = tid
            out.append({
                "camera_code": camera_code,
                "tracked_vehicle_id": tid,
                "plate_text": e["plate_text"],
                "plate_confidence": round(e["plate_confidence"], 3),
                "vehicle_type": e["vehicle_type"],
                "confidence": round(max(det["confidence"], e["plate_confidence"]), 3),
                "frame_timestamp_sec": e["time_sec"],
                "bbox": e["bbox"],
                "engine": engine,
                "model_version": model_version,
            })
    out.sort(key=lambda r: (r["frame_timestamp_sec"], r["tracked_vehicle_id"]))

    plates = sorted({r["plate_text"] for r in out if r["plate_text"] != "UNKNOWN"})
    good_evts = [e for e in events_out if e["good_read"]]
    events_doc = {
        "camera_code": camera_code,
        "engine": engine,
        "model_version": model_version,
        "clip": clip,
        "query": (video_doc or {}).get("query"),
        "good_read_rule": f"ocr_confidence >= {min_good_conf:g} and grammar_valid",
        "gpu": {"video_inference_ms": round(video_ms), "video_latency_ms": round(video_wall_ms),
                "frames_inference_ms": round(frame_ms), "frames": len(samples)},
        "events": events_out,
    }
    summary = {
        "camera_code": camera_code,
        "video_filename": clip.get("file"),
        "vehicles": len(events_out),
        "good_reads": len(good_evts),
        "plates": len(plates),
        "overlay_tracks": len(kept_tracks) + ev_n,
        "total_frames_sampled": len(samples),
        "total_detections": len(out),
        "gpu_seconds": round((video_ms + frame_ms) / 1000, 1),
        "video_gpu_seconds": round(video_ms / 1000, 1),
        "frames_gpu_seconds": round(frame_ms / 1000, 1),
        "engine": engine,
        "model_version": model_version,
        "example_reads": [e["plate_text"] for e in sorted(good_evts, key=lambda e: -e["plate_confidence"])[:5]],
    }
    return out, events_doc, summary


# ──────────────────────────────────────────────────────────────────────
# Per-video processing
# ──────────────────────────────────────────────────────────────────────
def process_single_video(
    video_path: str,
    camera_code: str,
    client: RemoteDetectionClient | None,
    sample_interval: float = 0.2,
    frame_query: str = FRAME_QUERY,
    video_query: str | None = VIDEO_QUERY,
    max_width: int = 1920,
    jpeg_quality: int = 90,
    cache_dir: str | None = None,
    from_cache: bool = False,
    min_good_conf: float = GOOD_READ_MIN_CONF,
):
    """Runs both GPU passes (or reads them from cache) and links them. Raises DetectionAPIError on API failure."""
    clip = probe_video(video_path) if not from_cache else {}
    clip["file"] = os.path.basename(video_path)
    fcache = os.path.join(cache_dir, f"frames_{camera_code}.json") if cache_dir else None
    vcache = os.path.join(cache_dir, f"video_{camera_code}.json") if cache_dir else None
    if from_cache:
        if not (fcache and os.path.exists(fcache)):
            raise FileNotFoundError(f"No cached frame responses for {camera_code} in {cache_dir}")
        frames_doc = _read_json(fcache)
        video_doc = _read_json(vcache) if vcache and os.path.exists(vcache) else None
        if frames_doc.get("clip"):
            clip = {**frames_doc["clip"], "file": clip["file"]}
    else:
        video_doc = None
        if video_query:
            t0 = time.time()
            video_doc = fetch_video_events(client, video_path, video_query, vcache)
            print(f"    /v1/video: {len(video_doc.get('events', []))} events "
                  f"({round((video_doc.get('inference_ms') or 0) / 1000, 1)} s GPU, {round(time.time() - t0, 1)} s wall)")
        frames_doc = fetch_frame_samples(client, video_path, camera_code, frame_query, sample_interval,
                                         max_width, jpeg_quality, fcache)
        frames_doc["clip"] = {k: clip[k] for k in ("fps", "frames", "width", "height") if k in clip}
        if fcache:
            _write_json(fcache, frames_doc)
    rows, events_doc, summary = build_camera_outputs(camera_code, frames_doc, video_doc, clip, min_good_conf)
    return rows, events_doc, summary


# ──────────────────────────────────────────────────────────────────────
# Video discovery
# ──────────────────────────────────────────────────────────────────────
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
    return path if os.path.exists(path) else None


def write_manifest(output_dir: str, summaries: list[dict]) -> None:
    path = os.path.join(output_dir, "manifest.json")
    doc = _read_json(path) if os.path.exists(path) else {}
    stats = {s["camera_code"]: s for s in doc.get("stats", [])} if isinstance(doc.get("stats"), list) else {}
    for s in summaries:
        stats[s["camera_code"]] = {k: s[k] for k in (
            "camera_code", "video_filename", "vehicles", "good_reads", "plates", "overlay_tracks", "gpu_seconds")}
    cameras = sorted(set(doc.get("cameras") or []) | {s["camera_code"] for s in summaries})
    cameras = [c for c in cameras if os.path.exists(os.path.join(output_dir, f"detections_{c}.json"))]
    out = {
        "note": ("Camera codes whose current clip has ANPR output in detections_<code>.json (per-frame overlay "
                 "boxes, 640x360 canvas) and events_<code>.json (one event per vehicle). Written by "
                 "pipeline/detect/run_remote_detection.py from the team's LPU model API."),
        "engine": summaries[0]["engine"] if summaries else doc.get("engine"),
        "model_version": summaries[0]["model_version"] if summaries else doc.get("model_version"),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cameras": cameras,
        "stats": [stats[c] for c in cameras if c in stats],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="NERO — Remote GPU ANPR detection pipeline (LPU model API)")
    p.add_argument("--videos_dir", default=DEFAULT_VIDEOS, help="Clips to analyse (default: pipeline/data/videos_1080p)")
    p.add_argument("--output_dir", default=DEFAULT_OUTPUT, help="Output directory (default: public/detections)")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="Camera config mapping (default: pipeline/camera_config.json)")
    p.add_argument("--cache_dir", default=DEFAULT_CACHE, help="Raw API response cache (default: pipeline/data/detect_cache)")
    p.add_argument("--from_cache", action="store_true", help="Rebuild outputs from cached responses only (no GPU calls)")
    p.add_argument("--sample_interval", type=float, default=0.2, help="Overlay frame sampling interval in s (default: 0.2 = 5 fps)")
    p.add_argument("--frame_query", default=FRAME_QUERY, help=f"/v1/frame query (default: {FRAME_QUERY})")
    p.add_argument("--video_query", default=VIDEO_QUERY, help=f"/v1/video query (default: {VIDEO_QUERY})")
    p.add_argument("--no_video_events", action="store_true", help="Skip the /v1/video pass (overlay-only)")
    p.add_argument("--min_good_conf", type=float, default=GOOD_READ_MIN_CONF, help="Good-read OCR confidence 0-100 (default: 75)")
    p.add_argument("--max_retries", type=int, default=3, help="Retries per frame on network/5xx errors (default: 3)")
    p.add_argument("--timeout_ms", type=int, default=None, help="Per-frame timeout (default: DETECTION_API_TIMEOUT_MS or 15000)")
    p.add_argument("--max_width", type=int, default=1920, help="Downscale frames wider than this before upload (default: 1920)")
    p.add_argument("--jpeg_quality", type=int, default=90, help="JPEG quality for uploaded frames (default: 90)")
    p.add_argument("--cameras", nargs="*", default=None, help="Only process these camera codes")
    p.add_argument("--env_file", default=None, help="Path to .env (default: repo-root .env)")
    # Legacy flags kept so old commands still parse.
    p.add_argument("--workers", type=int, default=1, help=argparse.SUPPRESS)
    p.add_argument("--conf_threshold", type=float, default=None, help=argparse.SUPPRESS)
    p.add_argument("--download", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--weights", default=None, help=argparse.SUPPRESS)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_env(args.env_file)

    client = None
    if not args.from_cache:
        cfg = read_model_api_config()
        if cfg is None:
            print("[x] DETECTION_API_URL (or ANPR_API_BASE) and DETECTION_API_KEY must be set (env or .env). "
                  "No local fallback.", file=sys.stderr)
            return 2
        if args.timeout_ms:
            from dataclasses import replace

            cfg = replace(cfg, timeout_ms=args.timeout_ms)
        if args.workers and args.workers > 1:
            print("[!] --workers is ignored: the GPU is shared, requests run one at a time.")
        client = RemoteDetectionClient(cfg, max_retries=args.max_retries)

    print("=" * 60)
    print("  NERO — Remote GPU ANPR Detection Pipeline (LPU model API)")
    print("=" * 60)
    print(f"  Mode           : {'from cache' if args.from_cache else 'live model API (1 request in flight)'}")
    print(f"  Videos dir     : {args.videos_dir}")
    print(f"  Output dir     : {args.output_dir}")
    print(f"  Frame query    : {args.frame_query} every {args.sample_interval}s")
    print(f"  Video query    : {'(skipped)' if args.no_video_events else args.video_query}")
    print("=" * 60)

    if client is not None:
        try:
            h = client.health()
            print(f"[OK] Model API reachable: engine={h.get('engine')} model={h.get('model_version')} "
                  f"loaded={h.get('model_loaded')} busy={h.get('gpu_busy')}")
        except DetectionAPIUnavailable as e:
            print(f"[x] {e}", file=sys.stderr)
            return 2

    os.makedirs(args.output_dir, exist_ok=True)
    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
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
        if not path and not args.from_cache:
            print(f"[!] Skipping {cam}: '{item['video_filename']}' not found in {args.videos_dir}.")
            continue
        path = path or os.path.join(args.videos_dir, item["video_filename"])
        print(f"[*] {cam}: {os.path.basename(path)}")
        tc = time.time()
        try:
            rows, events_doc, summary = process_single_video(
                path, cam, client,
                sample_interval=args.sample_interval,
                frame_query=args.frame_query,
                video_query=None if args.no_video_events else args.video_query,
                max_width=args.max_width,
                jpeg_quality=args.jpeg_quality,
                cache_dir=args.cache_dir or None,
                from_cache=args.from_cache,
                min_good_conf=args.min_good_conf,
            )
        except DetectionAPIError as e:
            print(f"[x] {cam}: {e}. Aborting — no fallback.", file=sys.stderr)
            return 2
        except FileNotFoundError as e:
            print(f"[!] {cam}: {e}")
            continue
        _write_json(os.path.join(args.output_dir, f"detections_{cam}.json"), rows)
        with open(os.path.join(args.output_dir, f"events_{cam}.json"), "w", encoding="utf-8") as f:
            json.dump(events_doc, f, separators=(",", ":"))
        summary["wall_seconds"] = round(time.time() - tc, 1)
        summaries.append(summary)
        print(
            f"    {summary['vehicles']} vehicles | {summary['good_reads']} good reads | "
            f"{summary['overlay_tracks']} overlay tracks | {summary['total_detections']} rows | "
            f"GPU {summary['gpu_seconds']} s"
        )

    if not summaries:
        print("[!] No videos were processed successfully.", file=sys.stderr)
        return 1

    write_manifest(args.output_dir, summaries)
    report_dir = args.cache_dir or args.output_dir
    with open(os.path.join(report_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summaries, f, indent=2)
    with open(os.path.join(report_dir, "summary.csv"), "w", newline="", encoding="utf-8") as f:
        fields = [k for k in summaries[0] if k != "example_reads"]
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(summaries)
    print(f"[OK] {len(summaries)}/{len(configs)} videos in {round(time.time() - t0, 1)}s -> {args.output_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
