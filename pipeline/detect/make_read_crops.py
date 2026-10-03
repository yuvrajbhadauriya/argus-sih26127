#!/usr/bin/env python3
"""
NERO Pipeline — real vehicle + plate crops for the recorded ANPR reads
======================================================================
The Live Map feed replays the good reads of public/detections/events_<CAM>.json.
Those events carry no crops and no plate box, so this script produces them:

  for every good-read event of every events_<CAM>.json
    1. decode the clip frame at the event time from the HIGHEST-resolution
       rendition (pipeline/data/videos_1080p/<clip.file>, or a 4K source given
       with --video CAM=PATH). Never the 720p web file: a rendition smaller than
       the analysis rendition (events clip.width x clip.height) is refused,
    2. send that frame to the model API (/v1/frame, same query as the
       detection run) to get the plate box,
    3. cut the vehicle crop and the plate crop out of THAT frame with the same
       padding rules as src/features/detections/remote/plateCrop.ts,
    4. write small JPEGs and a manifest.

Output (not committed - review the crops first):

  public/detections/crops/<CAM>/<event-key>_vehicle.jpg
  public/detections/crops/<CAM>/<event-key>_plate.jpg
  public/detections/crops/manifest.json

EVENT KEY (shared with src/features/detections/lib/readCrops.ts):

  <CAM>_<tracked_vehicle_id>_<round(time_sec * 1000)>   e.g. VP-01_trk_0008_400

  every character outside [A-Za-z0-9_-] becomes "-". One vehicle track can hold
  several reads, so the clip time (ms) is part of the key.

Matching the event to a detection in the /v1/frame answer (no confident match
=> the event is skipped and keeps its row without crops):
  1. detections whose plate text equals the event's plate (spaces ignored) and
     that have a plate box; of those, the best overlap with the stored event box;
  2. else the detection with the best IoU (>= MIN_IOU) against the stored event
     box that has a plate box and whose plate text is empty or equal.
The vehicle crop needs a real vehicle box from the model (bbox_source ==
"vehicle"); a plate-only detection yields a plate crop and no vehicle crop.

Idempotent + resumable: events already in the manifest with their files on disk
are skipped (--force redoes them). Events skipped for lack of a match are
remembered in the manifest (--retry-skipped asks the GPU again). The manifest
is rewritten after every camera and every --save-every events.

Config: DETECTION_API_URL / DETECTION_API_KEY ... exactly like run_remote_detection.py
(env or repo-root .env).

Clips: --video-dir (default pipeline/data/videos_1080p) holds <clip.file> of each
events file; --video CAM=PATH points one camera at another file (e.g. the 4K
source in ~/Downloads). Event boxes refer to clip.width x clip.height; they are
rescaled to the frame actually decoded, so a 4K source gives sharper crops.
There is NO fallback: a missing file, a file under videos-local/ or videos_720p/,
or a frame smaller than clip.width x clip.height is reported and its events are
not processed.

Usage:
    python3 pipeline/detect/make_read_crops.py --dry-run             # what would run, no GPU
    python3 pipeline/detect/make_read_crops.py --camera VP-01 --camera SC-01
    python3 pipeline/detect/make_read_crops.py --camera KR-01 --video KR-01=~/Downloads/kurla.mp4
    python3 pipeline/detect/make_read_crops.py                       # everything
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_PIPELINE)
if _PIPELINE not in sys.path:  # allow `python pipeline/detect/make_read_crops.py`
    sys.path.insert(0, _PIPELINE)

DEFAULT_EVENTS_DIR = os.path.join(_ROOT, "public", "detections")
DEFAULT_OUT_DIR = os.path.join(DEFAULT_EVENTS_DIR, "crops")
DEFAULT_VIDEOS = os.path.join(_PIPELINE, "data", "videos_1080p")
#: Web renditions: never a source for crops.
WEB_RENDITION_DIRS = ("videos-local", "videos_720p", "720p")

#: Same query as the detection run's per-frame pass (run_remote_detection.FRAME_QUERY).
FRAME_QUERY = "tiles=2x3&roi_top=0.33&min_conf=0"
#: Frames wider than this are downscaled before they are sent (the crops are cut from the full frame).
SEND_MAX_WIDTH = 1920
SEND_JPEG_QUALITY = 85
#: Thumbnails: at most this wide, never upscaled.
CROP_MAX_WIDTH = 256
CROP_JPEG_QUALITY = 85
#: A fallback match (plate text not equal) needs at least this overlap with the stored event box.
MIN_IOU = 0.3
MANIFEST_SCHEMA = 1

# Padding rules, identical to PLATE_PAD / VEHICLE_PAD in plateCrop.ts.
PLATE_PAD = {"padX": 0.18, "padY": 0.45, "minSide": 24}
VEHICLE_PAD = {"padX": 0.04, "padY": 0.04, "minSide": 24}


# ──────────────────────────────────────────────────────────────────────
# Keys, geometry (pure)
# ──────────────────────────────────────────────────────────────────────
def event_key(camera_code: str, tracked_vehicle_id: str, time_sec: float) -> str:
    """See the module docstring; must stay identical to eventKey() in readCrops.ts."""
    raw = f"{camera_code}_{tracked_vehicle_id}_{int(round(float(time_sec) * 1000))}"
    return re.sub(r"[^A-Za-z0-9_-]", "-", raw)


def compact_plate(text: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def pad_box(box: dict, frame_w: int, frame_h: int, pad: dict) -> dict | None:
    """Port of padBox() in plateCrop.ts: expand, enforce a minimum, clamp inside the frame (integer pixels)."""
    pad_x, pad_y, min_side = pad.get("padX", 0), pad.get("padY", 0), pad.get("minSide", 0)
    if not (box["width"] > 0 and box["height"] > 0 and frame_w > 0 and frame_h > 0):
        return None
    w = min(frame_w, max(box["width"] * (1 + 2 * pad_x), min_side))
    h = min(frame_h, max(box["height"] * (1 + 2 * pad_y), min_side))
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    x = min(max(cx - w / 2, 0), frame_w - w)
    y = min(max(cy - h / 2, 0), frame_h - h)
    out = {"x": math.floor(x), "y": math.floor(y), "width": math.ceil(w), "height": math.ceil(h)}
    out["width"] = min(out["width"], frame_w - out["x"])
    out["height"] = min(out["height"], frame_h - out["y"])
    return out if out["width"] > 0 and out["height"] > 0 else None


def scale_box(box: dict, sx: float, sy: float) -> dict:
    return {"x": box["x"] * sx, "y": box["y"] * sy, "width": box["width"] * sx, "height": box["height"] * sy}


def iou(a: dict, b: dict) -> float:
    ix = max(0.0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def pick_detection(event: dict, dets: list[dict], event_box: dict) -> dict | None:
    """The detection of a /v1/frame answer that is this event's vehicle, or None (see module docstring).

    ``dets`` are normalised detections (boxes in the SAME pixel space as ``event_box``).
    """
    want = compact_plate(event.get("plate_text"))
    with_plate = [d for d in dets if d.get("plate_bbox")]
    same = [d for d in with_plate if want and compact_plate(d.get("plate_text")) == want]
    if same:
        return max(same, key=lambda d: iou(d["bbox"], event_box))
    close = [
        d for d in with_plate
        if iou(d["bbox"], event_box) >= MIN_IOU and compact_plate(d.get("plate_text")) in ("", want)
    ]
    return max(close, key=lambda d: iou(d["bbox"], event_box)) if close else None


# ──────────────────────────────────────────────────────────────────────
# Image helpers (cv2 imported lazily)
# ──────────────────────────────────────────────────────────────────────
def cut(frame, box: dict, pad: dict):
    """Padded crop of ``box`` (pixels of ``frame``) as an ndarray view, or None when degenerate."""
    h, w = frame.shape[:2]
    region = pad_box(box, w, h, pad)
    if region is None:
        return None
    return frame[region["y"]: region["y"] + region["height"], region["x"]: region["x"] + region["width"]]


def encode_thumb(img, max_width: int = CROP_MAX_WIDTH, quality: int = CROP_JPEG_QUALITY) -> bytes:
    """Downscales to ``max_width`` (never upscales) and JPEG-encodes."""
    import cv2

    h, w = img.shape[:2]
    if w > max_width:
        img = cv2.resize(img, (max_width, max(1, round(h * max_width / w))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("cv2.imencode failed to encode a crop as JPEG")
    return bytes(buf)


class ClipReader:
    """Random-access frame reader for one clip (the capture stays open between events)."""

    def __init__(self, path: str):
        import cv2

        self._cv2 = cv2
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise FileNotFoundError(f"Cannot open video: {path}")
        self.fps = float(self.cap.get(cv2.CAP_PROP_FPS) or 30.0)
        self.frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

    def frame_at(self, time_sec: float) -> tuple[Any, int] | None:
        """(BGR frame, frame index) at ``time_sec``, or None when it cannot be decoded."""
        idx = max(0, int(round(time_sec * self.fps)))
        if self.frames:
            idx = min(idx, self.frames - 1)
        self.cap.set(self._cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = self.cap.read()
        return (frame, idx) if ok and frame is not None else None

    def close(self) -> None:
        self.cap.release()


def is_web_rendition(path: str) -> bool:
    parts = {p.lower() for p in os.path.normpath(os.path.abspath(path)).split(os.sep)}
    return any(d in parts for d in WEB_RENDITION_DIRS)


def resolve_video(cam: str, clip_file: str, video_dir: str, overrides: dict[str, str]) -> tuple[str | None, str | None]:
    """(path, None) or (None, reason). Never falls back to another directory."""
    path = os.path.expanduser(overrides[cam]) if cam in overrides else os.path.join(video_dir, clip_file)
    if is_web_rendition(path):
        return None, f"{path} is a web (720p) rendition - crops are cut from the 1080p/4K file only"
    if not os.path.isfile(path):
        return None, f"{path} not found (expected the high-resolution file; use --video-dir or --video {cam}=PATH)"
    return path, None


def parse_video_overrides(items: list[str] | None) -> dict[str, str]:
    out = {}
    for it in items or []:
        cam, sep, path = it.partition("=")
        if not sep or not cam or not path:
            raise SystemExit(f"--video expects CAM=PATH, got '{it}'")
        out[cam] = path
    return out


# ──────────────────────────────────────────────────────────────────────
# Per-event work
# ──────────────────────────────────────────────────────────────────────
def good_events(doc: dict) -> list[dict]:
    """The events the Live Map replays: good reads with a plate text."""
    return [e for e in doc.get("events", []) if e.get("good_read") and e.get("plate_text") and isinstance(e.get("bbox"), dict)]


def process_event(
    event: dict,
    frame,
    frame_index: int,
    detect: Callable[[Any], dict],
    clip_size: tuple[int, int],
    key: str,
    cam_dir: str,
    write: Callable[[str, bytes], None],
) -> dict:
    """Crops one event from ``frame``. Returns {"status": "ok", "entry": {...}} or {"status": "skipped", "reason": str}.

    ``detect(frame)`` returns the normalised /v1/frame answer for the frame
    (boxes in pixels of ``answer["image"]``; ``frame`` itself is full resolution).
    ``clip_size`` is the (width, height) the stored event boxes refer to.
    """
    fh, fw = frame.shape[:2]
    answer = detect(frame)
    img = answer.get("image") or {}
    sent_w, sent_h = img.get("width") or fw, img.get("height") or fh
    to_frame = (fw / sent_w, fh / sent_h)
    dets = []
    for d in answer.get("detections", []):
        d = dict(d, bbox=scale_box(d["bbox"], *to_frame))
        if d.get("plate_bbox"):
            d["plate_bbox"] = scale_box(d["plate_bbox"], *to_frame)
        dets.append(d)
    event_box = scale_box(event["bbox"], fw / clip_size[0], fh / clip_size[1])
    det = pick_detection(event, dets, event_box)
    if det is None:
        return {"status": "skipped", "reason": "no confident match in the model answer"}

    plate = cut(frame, det["plate_bbox"], PLATE_PAD)
    if plate is None:
        return {"status": "skipped", "reason": "degenerate plate box"}
    vehicle = cut(frame, det["bbox"], VEHICLE_PAD) if det.get("bbox_source") == "vehicle" else None

    rel_dir = os.path.basename(cam_dir)
    entry: dict[str, Any] = {"plate": f"{rel_dir}/{key}_plate.jpg", "vehicle": None}
    write(os.path.join(cam_dir, f"{key}_plate.jpg"), encode_thumb(plate))
    if vehicle is not None:
        entry["vehicle"] = f"{rel_dir}/{key}_vehicle.jpg"
        write(os.path.join(cam_dir, f"{key}_vehicle.jpg"), encode_thumb(vehicle))
    pb = scale_box(det["plate_bbox"], clip_size[0] / fw, clip_size[1] / fh)  # back to the events' pixel space
    entry["plate_bbox"] = {k: round(v, 1) for k, v in pb.items()}
    entry["frame_time_sec"] = event["time_sec"]
    entry["frame_index"] = frame_index
    entry["source_size"] = [fw, fh]  # resolution the crops were cut from
    return {"status": "ok", "entry": entry}


# ──────────────────────────────────────────────────────────────────────
# Manifest
# ──────────────────────────────────────────────────────────────────────
def load_manifest(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        if isinstance(doc, dict) and isinstance(doc.get("crops"), dict):
            doc.setdefault("skipped", {})
            return doc
    except (OSError, ValueError):
        pass
    return {"schema": MANIFEST_SCHEMA, "crops": {}, "skipped": {}}


def save_manifest(path: str, doc: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def entry_done(entry: dict | None, out_dir: str) -> bool:
    """The files the entry names exist (the vehicle crop is optional)."""
    if not entry or not entry.get("plate"):
        return False
    files = [entry["plate"]] + ([entry["vehicle"]] if entry.get("vehicle") else [])
    return all(os.path.exists(os.path.join(out_dir, f)) for f in files)


def _write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# ──────────────────────────────────────────────────────────────────────
# Driver
# ──────────────────────────────────────────────────────────────────────
def find_events_files(events_dir: str, cameras: list[str] | None) -> list[tuple[str, str]]:
    out = []
    for name in sorted(os.listdir(events_dir)):
        m = re.fullmatch(r"events_(.+)\.json", name)
        if m and (not cameras or m.group(1) in cameras):
            out.append((m.group(1), os.path.join(events_dir, name)))
    return out


def run(
    args: argparse.Namespace,
    make_detect: Callable[[], Callable[[Any], dict] | None] | None = None,
    open_clip: Callable[[str], Any] = ClipReader,
    write: Callable[[str, bytes], None] = _write_file,
    log: Callable[[str], None] = print,
) -> int:
    """Returns 0 ok, 1 nothing found / nothing could be done, 2 model API not configured or unreachable."""
    files = find_events_files(args.events_dir, args.camera)
    overrides = parse_video_overrides(getattr(args, "video", None))
    if not files:
        log(f"[!] No events_<CAM>.json found in {args.events_dir}" + (f" for {args.camera}" if args.camera else ""))
        return 1
    manifest_path = os.path.join(args.out_dir, "manifest.json")
    manifest = load_manifest(manifest_path)

    # Plan first, so --dry-run needs neither the GPU nor the clips.
    plan: list[tuple[str, dict, list[tuple[dict, str]]]] = []
    for cam, path in files:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        todo, done, known_skipped = [], 0, 0
        for e in good_events(doc):
            key = event_key(cam, e.get("tracked_vehicle_id", ""), e.get("time_sec", 0))
            if not args.force and entry_done(manifest["crops"].get(key), args.out_dir):
                done += 1
            elif not args.force and not args.retry_skipped and key in manifest["skipped"]:
                known_skipped += 1
            else:
                todo.append((e, key))
        log(f"[{cam}] good reads: {len(todo) + done + known_skipped} | done: {done} | skipped before: {known_skipped} | to do: {len(todo)}")
        plan.append((cam, doc, todo))

    if args.dry_run:
        log(f"[dry-run] {sum(len(p[2]) for p in plan)} event(s) would be sent to the model API; nothing was written.")
        return 0
    if not any(p[2] for p in plan):
        log("[OK] Nothing to do.")
        return 0

    detect = (make_detect or _make_remote_detect)()
    if detect is None:
        return 2

    made = skipped = failed = 0
    t0 = time.time()
    for cam, doc, todo in plan:
        if not todo:
            continue
        clip = doc.get("clip") or {}
        clip_size = (int(clip.get("width") or 0), int(clip.get("height") or 0))
        video, why = (None, "events file has no clip.file / clip size") if not clip.get("file") or min(clip_size) <= 0 \
            else resolve_video(cam, clip["file"], args.video_dir, overrides)
        if video is None:
            log(f"[!] {cam}: {why} - skipped")
            failed += len(todo)
            continue
        reader = open_clip(video)
        if reader.width < clip_size[0] or reader.height < clip_size[1]:
            log(f"[!] {cam}: {video} is {reader.width}x{reader.height}, smaller than the analysis rendition "
                f"{clip_size[0]}x{clip_size[1]} - refused (no crops from a downscaled file)")
            reader.close()
            failed += len(todo)
            continue
        cam_dir = os.path.join(args.out_dir, cam)
        try:
            for i, (event, key) in enumerate(todo, 1):
                tag = f"    [{cam} {i}/{len(todo)}] {key}"
                got = reader.frame_at(event["time_sec"])
                if got is None:
                    log(f"{tag}: cannot decode the frame at {event['time_sec']} s")
                    failed += 1
                    continue
                frame, idx = got
                try:
                    res = process_event(event, frame, idx, detect, clip_size, key, cam_dir, write)
                except Exception as e:  # network / API error: keep what is done, report, go on
                    log(f"{tag}: model API error: {e}")
                    failed += 1
                    continue
                if res["status"] == "ok":
                    manifest["crops"][key] = res["entry"]
                    manifest["skipped"].pop(key, None)
                    made += 1
                    log(f"{tag} {event['plate_text']}: ok" + ("" if res["entry"]["vehicle"] else " (plate crop only)"))
                else:
                    manifest["crops"].pop(key, None)
                    manifest["skipped"][key] = res["reason"]
                    skipped += 1
                    log(f"{tag} {event['plate_text']}: skipped ({res['reason']})")
                if (made + skipped) % args.save_every == 0:
                    save_manifest(manifest_path, manifest)
        finally:
            reader.close()
            manifest["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_manifest(manifest_path, manifest)
    log(f"[OK] crops written: {made} | skipped (no confident match): {skipped} | failed: {failed} | {time.time() - t0:.0f} s")
    log(f"     manifest: {manifest_path} - review public/detections/crops/ before committing anything.")
    return 0 if (made or skipped or not failed) else 1


def _make_remote_detect() -> Callable[[Any], dict] | None:
    """Builds the /v1/frame caller from the same config as run_remote_detection.py (None when unconfigured)."""
    from detect.adapter import read_model_api_config
    from detect.client import DetectionAPIUnavailable, RemoteDetectionClient
    from detect.run_remote_detection import encode_frame, load_env

    load_env()
    cfg = read_model_api_config()
    if cfg is None:
        print("[x] DETECTION_API_URL (or ANPR_API_BASE) and DETECTION_API_KEY must be set (env or .env).", file=sys.stderr)
        return None
    client = RemoteDetectionClient(cfg)
    try:
        h = client.health()
        print(f"[OK] Model API reachable: engine={h.get('engine')} model={h.get('model_version')}")
    except DetectionAPIUnavailable as e:
        print(f"[x] {e}", file=sys.stderr)
        return None

    def detect(frame) -> dict:
        data, w, h = encode_frame(frame, SEND_MAX_WIDTH, SEND_JPEG_QUALITY)
        return client.detect(data, (w, h), query=FRAME_QUERY)

    return detect


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Cut real vehicle + plate crops for the recorded ANPR reads (see module docstring).")
    ap.add_argument("--events-dir", default=DEFAULT_EVENTS_DIR, help="folder with events_<CAM>.json")
    ap.add_argument("--video-dir", default=DEFAULT_VIDEOS, help="folder with the 1080p renditions (events' clip.file); never the 720p files")
    ap.add_argument("--video", action="append", metavar="CAM=PATH", help="use this file for one camera (e.g. a 4K source); repeatable")
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="where <CAM>/ and manifest.json go")
    ap.add_argument("--camera", action="append", help="only this camera code (repeatable)")
    ap.add_argument("--dry-run", action="store_true", help="list what would be done; no GPU, no clips, no writes")
    ap.add_argument("--force", action="store_true", help="redo events that already have crops")
    ap.add_argument("--retry-skipped", action="store_true", help="ask the model again for events skipped on an earlier run")
    ap.add_argument("--save-every", type=int, default=10, help="rewrite the manifest every N processed events")
    return ap


def main(argv: list[str] | None = None) -> int:
    return run(build_parser().parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
