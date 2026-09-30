#!/usr/bin/env python3
"""
Video-level plate-read stability — a label-free proxy for accuracy on the
multi-lane Mumbai camera clips.

For each camera clip, frames are sampled and sent to the live API
(``POST /v1/frame?tiles=2x3``), and the vehicle boxes are tracked across frames
(same IoU tracker as the production pipeline). For every track with at least ``--min_reads`` plate reads:

    stability = reads agreeing with the track's majority plate / reads on the track

A perfect reader gives 1.0 on every track; OCR flicker (MH02AB1234 in one
frame, MH02A81234 in the next) lowers it. It is NOT ground-truth accuracy:
a reader that is consistently wrong also scores 1.0, and tracker ID switches
lower it. Report it next to the labelled-set accuracy, never instead of it.

    python pipeline/eval/video_consistency.py                        # live API, sequential
    python pipeline/eval/video_consistency.py --events               # + one /v1/video call per clip
    python pipeline/eval/video_consistency.py --mock --max_frames 40  # offline plumbing test

``--events`` also uploads each clip to ``POST /v1/video`` (one event per vehicle)
and reports events, grammar-valid share and mean OCR confidence per camera.

Writes public/eval/video_consistency.json (read by the Model Performance page).
Needs opencv-python for frame extraction.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from collections import Counter, deque
from collections.abc import Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_PIPELINE)
if _PIPELINE not in sys.path:
    sys.path.insert(0, _PIPELINE)

from detect.tracker import LightweightTracker  # noqa: E402
from eval.lpu_client import LpuClient, LpuConfig, LpuError, LpuUnavailable, plate_or_none, read_lpu_config  # noqa: E402
from eval.metrics import lenient_plate, normalise_plate, percentile  # noqa: E402

SCHEMA_VERSION = 1
DEFAULT_OUT = os.path.join(_ROOT, "public", "eval", "video_consistency.json")
DEFAULT_VIDEOS = os.path.join(_PIPELINE, "data", "videos_1080p")
DEFAULT_CONFIG = os.path.join(_PIPELINE, "camera_config.json")
STABLE_AT = 0.8


# ──────────────────────────────────────────────────────────────────────
# Pure metric
# ──────────────────────────────────────────────────────────────────────
def track_stability(records: Iterable[dict], min_reads: int = 3) -> dict:
    """records: [{"track": id, "plate": raw text | None}] -> summary + per-track rows."""
    reads: dict[str, list[str]] = {}
    for r in records:
        p = normalise_plate(r.get("plate"))
        reads.setdefault(r["track"], [])
        if p:
            reads[r["track"]].append(p)
    tracks = []
    for tid, ps in reads.items():
        if len(ps) < min_reads:
            continue
        plate, n = Counter(ps).most_common(1)[0]
        lplate, ln = Counter(lenient_plate(p) for p in ps).most_common(1)[0]
        tracks.append({"track": tid, "reads": len(ps), "majority_plate": plate, "agree": n,
                       "stability": round(n / len(ps), 4), "lenient_stability": round(ln / len(ps), 4),
                       "distinct_reads": len(set(ps))})
    total_reads = sum(t["reads"] for t in tracks)
    stabs = [t["stability"] for t in tracks]
    return {
        "tracks_total": len(reads),
        "tracks_scored": len(tracks),
        "reads_scored": total_reads,
        "mean_stability": round(sum(stabs) / len(stabs), 4) if stabs else None,
        "read_weighted_stability": round(sum(t["agree"] for t in tracks) / total_reads, 4) if total_reads else None,
        "lenient_mean_stability": round(sum(t["lenient_stability"] for t in tracks) / len(tracks), 4) if tracks else None,
        "stable_track_share": round(sum(s >= STABLE_AT for s in stabs) / len(stabs), 4) if stabs else None,
        "median_distinct_reads": percentile([t["distinct_reads"] for t in tracks], 50),
        "tracks": sorted(tracks, key=lambda t: t["stability"]),
    }


class PlateTracker:
    """Greedy nearest-centre tracker on PLATE boxes ([x, y, w, h]).

    In dense overhead jams the vehicle boxes overlap heavily and an IoU tracker on
    them merges neighbouring vehicles (which would make every read look unstable).
    Plates are small and well separated, so their centres are matched instead: a
    detection joins the nearest live track whose centre is within ``gate`` plate
    widths; tracks die after ``max_missed`` frames without a match.
    """

    def __init__(self, gate: float = 1.5, max_missed: int = 2):
        self.gate, self.max_missed = gate, max_missed
        self.tracks: dict[int, dict] = {}
        self.next_id = 1

    def update(self, dets: list[dict]) -> list[dict]:
        centres = [(d["bbox"][0] + d["bbox"][2] / 2, d["bbox"][1] + d["bbox"][3] / 2, max(d["bbox"][2], 8.0)) for d in dets]
        pairs = []
        for tid, t in self.tracks.items():
            for i, (cx, cy, w) in enumerate(centres):
                dist = ((cx - t["cx"]) ** 2 + (cy - t["cy"]) ** 2) ** 0.5
                if dist <= self.gate * max(w, t["w"]):
                    pairs.append((dist, tid, i))
        pairs.sort()
        used_t, used_d, out = set(), set(), []
        for _, tid, i in pairs:
            if tid in used_t or i in used_d:
                continue
            used_t.add(tid)
            used_d.add(i)
            self.tracks[tid].update(cx=centres[i][0], cy=centres[i][1], w=centres[i][2], missed=0)
            out.append({**dets[i], "tracked_vehicle_id": f"plt_{tid:04d}"})
        for tid in [t for t in self.tracks if t not in used_t]:
            self.tracks[tid]["missed"] += 1
            if self.tracks[tid]["missed"] > self.max_missed:
                del self.tracks[tid]
        for i, d in enumerate(dets):
            if i not in used_d:
                tid = self.next_id
                self.next_id += 1
                self.tracks[tid] = {"cx": centres[i][0], "cy": centres[i][1], "w": centres[i][2], "missed": 0}
                out.append({**d, "tracked_vehicle_id": f"plt_{tid:04d}"})
        return out


# ──────────────────────────────────────────────────────────────────────
# Frames -> API -> tracker
# ──────────────────────────────────────────────────────────────────────
def video_frames(path: str, sample_interval: float, max_width: int, max_frames: int = 0, jpeg_quality: int = 85):
    """Yields (ts, jpeg_bytes, w, h) every ``sample_interval`` seconds of video time (needs opencv-python)."""
    import cv2  # noqa: PLC0415

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        step = max(1, round(fps * sample_interval))
        idx = sent = 0
        while True:
            ok, frame = cap.read()
            if not ok or (max_frames and sent >= max_frames):
                break
            idx += 1
            if (idx - 1) % step:
                continue
            h, w = frame.shape[:2]
            if max_width and w > max_width:
                w, h = max_width, max(1, round(h * max_width / w))
                frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)])
            if ok:
                sent += 1
                yield round((idx - 1) / fps, 3), bytes(buf), w, h
    finally:
        cap.release()


def process_frames(frames: Iterable[tuple], client: LpuClient, camera_code: str | None = None,
                   workers: int = 1, conf_threshold: float = 0.3, tiles: str = "2x3",
                   track_on: str = "plate") -> tuple[list[dict], dict]:
    """Runs frames through the API in order-preserving windows and tracks the detections
    (on plate boxes by default; ``track_on="vehicle"`` uses the production IoU tracker on vehicle boxes)."""
    tracker = PlateTracker() if track_on == "plate" else LightweightTracker(iou_thresh=0.2, max_missed=5)
    records: list[dict] = []
    lat: list[float] = []
    meta = {"frames": 0, "detections": 0, "engine": None, "model_version": None, "errors": 0}

    def consume(fut: Future) -> None:
        ts, res = fut.result()
        if res is None:
            meta["errors"] += 1
            tracker.update([])
            return
        meta["engine"] = meta["engine"] or res.get("engine")
        meta["model_version"] = meta["model_version"] or res.get("model_version")
        if res.get("latency_ms") is not None:
            lat.append(res["latency_ms"])
        key = "bbox" if track_on == "plate" else "vehicle_bbox"
        dets = [
            {"bbox": d.get(key) or d.get("bbox"), "vehicle_type": d.get("vehicle_type") or "unknown",
             "plate_text": d.get("plate_text"), "grammar_valid": d.get("grammar_valid")}
            for d in res.get("detections", [])
            if (d.get(key) or d.get("bbox")) and (d.get("confidence") or 0) >= conf_threshold
            and (track_on != "plate" or d.get("plate_text"))
        ]
        meta["detections"] += len(dets)
        for det in tracker.update(dets):
            records.append({"track": det["tracked_vehicle_id"], "plate": det["plate_text"], "ts": ts})

    def call(ts, data, w, h):
        try:
            return ts, client.frame(data, "image/jpeg", tiles=tiles)
        except LpuUnavailable:
            return ts, None

    pending: deque[Future] = deque()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for ts, data, w, h in frames:
            meta["frames"] += 1
            pending.append(pool.submit(call, ts, data, w, h))
            if len(pending) >= max(1, workers) * 2:
                consume(pending.popleft())
        while pending:
            consume(pending.popleft())
    meta["latency_p95_ms"] = percentile(lat, 95)
    return records, meta


def summarise_events(raw: dict) -> dict:
    """/v1/video response -> per-clip event summary (one event per vehicle)."""
    events = [e for e in raw.get("events") or [] if isinstance(e, dict)]
    read = [e for e in events if plate_or_none(e.get("plate"))]
    conf = [e["ocr_confidence"] / 100 for e in read if isinstance(e.get("ocr_confidence"), (int, float))]
    return {
        "events": len(events),
        "events_with_plate": len(read),
        "grammar_valid_share": round(sum(1 for e in read if e.get("grammar_valid")) / len(read), 4) if read else None,
        "mean_ocr_confidence": round(sum(conf) / len(conf), 4) if conf else None,
        "unique_plates": len({normalise_plate(e["plate"]) for e in read}),
        "inference_ms": raw.get("inference_ms"),
    }


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Per-track plate-read stability on the camera clips")
    p.add_argument("--videos_dir", default=DEFAULT_VIDEOS)
    p.add_argument("--config", default=DEFAULT_CONFIG)
    p.add_argument("--cameras", nargs="*", default=None)
    p.add_argument("--sample_interval", type=float, default=0.2)
    p.add_argument("--max_frames", type=int, default=0, help="Per clip (0 = whole clip)")
    p.add_argument("--max_width", type=int, default=1280)
    p.add_argument("--workers", type=int, default=1, help="Requests in flight (max 2 on the live API; GPU is shared)")
    p.add_argument("--track_on", choices=["plate", "vehicle"], default="plate",
                   help="Associate reads by plate box (default; robust in dense jams) or by vehicle box")
    p.add_argument("--tiles", default="2x3", help="Detector tiling for the multi-lane frames (default 2x3)")
    p.add_argument("--events", action="store_true", help="Also run each clip through POST /v1/video")
    p.add_argument("--frame_step", type=int, default=5, help="/v1/video frame_step (with --events)")
    p.add_argument("--min_reads", type=int, default=3)
    p.add_argument("--conf_threshold", type=float, default=0.3)
    p.add_argument("--max_retries", type=int, default=3)
    p.add_argument("--timeout_ms", type=int, default=None)
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--env_file", default=None)
    p.add_argument("--mock", action="store_true", help="In-process mock API (status=sample)")
    args = p.parse_args(argv)

    server = None
    if args.mock:
        from eval.mock_eval_server import start_oracle_server  # noqa: PLC0415

        server, _, _ = start_oracle_server({}, api_key="eval-mock-key")
        cfg = LpuConfig(base=f"http://127.0.0.1:{server.server_address[1]}", api_key="eval-mock-key")
        args.events = False  # the mock has no /v1/video
    else:
        from detect.run_remote_detection import load_env  # noqa: PLC0415

        load_env(args.env_file)
        cfg = read_lpu_config()
        if cfg is None:
            print("[x] ANPR_API_BASE (or DETECTION_API_URL) and DETECTION_API_KEY must be set. Use --mock for an offline run.", file=sys.stderr)
            return 2
        args.workers = min(args.workers, 2)
    if args.timeout_ms:
        cfg = replace(cfg, timeout_s=args.timeout_ms / 1000)
    client = LpuClient(cfg, max_retries=args.max_retries)
    try:
        try:
            client.health()
        except LpuUnavailable as e:
            print(f"[x] {e}", file=sys.stderr)
            return 2
        with open(args.config, encoding="utf-8") as f:
            cameras = json.load(f)
        if args.cameras:
            cameras = [c for c in cameras if c["camera_code"] in set(args.cameras)]
        t0 = time.time()
        per_camera, all_records, engine, version = [], [], None, None
        for cam in cameras:
            path = os.path.join(args.videos_dir, cam["video_filename"])
            if not os.path.exists(path):
                print(f"[!] {cam['camera_code']}: {cam['video_filename']} not in {args.videos_dir}")
                continue
            try:
                records, meta = process_frames(
                    video_frames(path, args.sample_interval, args.max_width, args.max_frames),
                    client, cam["camera_code"], args.workers, args.conf_threshold, args.tiles, args.track_on)
                ev = None
                if args.events:
                    with open(path, "rb") as f:
                        ev = summarise_events(client.video(f.read(), frame_step=args.frame_step, tiles=args.tiles))
            except LpuError as e:
                print(f"[x] {cam['camera_code']}: {e}", file=sys.stderr)
                return 2
            engine, version = engine or meta["engine"], version or meta["model_version"]
            stab = track_stability(records, args.min_reads)
            all_records += [{**r, "track": f"{cam['camera_code']}:{r['track']}"} for r in records]
            per_camera.append({
                "camera_code": cam["camera_code"], "camera_name": cam.get("camera_name"), "video": cam["video_filename"],
                "frames": meta["frames"], "detections": meta["detections"], "api_errors": meta["errors"],
                "latency_p95_ms": meta["latency_p95_ms"],
                **{k: v for k, v in stab.items() if k != "tracks"},
                "least_stable_tracks": stab["tracks"][:5],
                "video_events": ev,
            })
            print(f"[*] {cam['camera_code']}: {meta['frames']} frames, {stab['tracks_scored']}/{stab['tracks_total']} tracks scored, "
                  f"mean stability {stab['mean_stability']}")
        if not per_camera:
            print("[x] No clips processed.", file=sys.stderr)
            return 1
        overall = {k: v for k, v in track_stability(all_records, args.min_reads).items() if k != "tracks"}
        overall["frames"] = sum(c["frames"] for c in per_camera)
        overall["cameras"] = len(per_camera)
        result = {
            "schema_version": SCHEMA_VERSION,
            "status": "sample" if args.mock else "measured",
            "note": "replace by running video_consistency.py against the trained model" if args.mock
            else "measured against the configured model API",
            "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "duration_s": round(time.time() - t0, 1),
            "metric": "per-track plate-read stability (reads agreeing with the track's majority plate); label-free proxy",
            "model": {"engine": engine, "model_version": version, "api": "mock" if args.mock else "live"},
            "params": {"endpoint": "POST /v1/frame", "tiles": args.tiles, "track_on": args.track_on, "sample_interval": args.sample_interval, "min_reads": args.min_reads, "max_frames": args.max_frames,
                       "stable_at": STABLE_AT, "conf_threshold": args.conf_threshold},
            "overall": overall,
            "per_camera": per_camera,
        }
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
            f.write("\n")
        print(f"[OK] mean track stability {overall['mean_stability']} over {overall['tracks_scored']} tracks -> "
              f"{os.path.relpath(args.out, _ROOT)}")
        return 0
    finally:
        if server is not None:
            server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
