#!/usr/bin/env python3
"""
NERO Pipeline — Supabase detections ingestion
=============================================
Reads the per-camera files written by pipeline/detect/run_remote_detection.py
(``detections_<CAMERA_CODE>.json`` + ``summary.json``) and upserts them into the
``detections`` table (schema: supabase/migrations/20261001000000_reconcile_schema.sql).

Guarantees
  * Idempotent: ``event_id = sha1(camera_code|source_video|frame_timestamp_sec|tracked_vehicle_id)``
    and rows are upserted on ``event_id``, so re-running never duplicates.
  * Deterministic time base: absolute ``detected_at = start_time + frame_timestamp_sec``.
    ``--start_time`` is timezone-aware (naive values are read in ``--tz``,
    default Asia/Kolkata). If omitted it is derived from the simulated day in
    public/sim/summary.json (08:00 local) so real reads line up with the
    simulated network; without that file it is required.
  * Trusted writer: requires SUPABASE_SERVICE_ROLE_KEY (no anon fallback).
  * Cameras are resolved by ``code`` from the ``cameras`` table only. Unknown
    codes abort before anything is written.
  * Each chunk is retried with exponential backoff; any chunk that still fails
    makes the script exit non-zero.
  * ``--prune`` makes the table mirror the files exactly: after a camera's rows
    are upserted without error, its rows whose event_id is no longer in its
    file (a read the pipeline dropped, a renumbered track) are deleted. Cameras
    without a file, or with an empty one, are never touched.

Usage
    python pipeline/insert_detections.py --detections_dir ./public/detections \
        [--start_time 2026-09-29T08:00:00] [--tz Asia/Kolkata] [--prune] [--dry_run]

Exit codes: 0 ok · 1 nothing to ingest · 2 configuration error · 3 some chunks failed
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from db.supabase_admin import (
    EXIT_PARTIAL,
    ConfigError,
    chunked,
    fetch_cameras_by_code,
    get_service_client,
    missing_codes,
    normalize_plate,
    with_retries,
)
from dotenv import load_dotenv

PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PIPELINE_DIR)
DEFAULT_CONFIG = os.path.join(PIPELINE_DIR, "camera_config.json")
DEFAULT_SIM_SUMMARY = os.path.join(ROOT_DIR, "public", "sim", "summary.json")
DEFAULT_TZ = "Asia/Kolkata"
DERIVED_START_CLOCK = "08:00:00"

load_dotenv()

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────
# Helpers (pure — unit tested)
# ──────────────────────────────────────────────────────────────────────
def get_supabase_client():
    """Service-role client; exits 2 when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing."""
    return get_service_client()


def fetch_camera_mapping(client) -> dict:
    """{camera code: cameras row} straight from the database (no alias maps)."""
    return fetch_cameras_by_code(client)


def load_config_fallback(config_path: str) -> dict:
    """camera_config.json keyed by camera_code (used only for source-video names)."""
    if not config_path or not os.path.exists(config_path):
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        items = json.load(f)
    return {item["camera_code"]: item for item in items if "camera_code" in item}


def load_run_summary(detections_dir: str) -> dict:
    """summary.json written next to the detection files, keyed by camera_code."""
    path = os.path.join(detections_dir, "summary.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        items = json.load(f)
    if isinstance(items, dict):  # tolerate {"cameras": [...]} shapes
        items = items.get("cameras", [])
    return {item["camera_code"]: item for item in items if isinstance(item, dict) and "camera_code" in item}


def resolve_tz(name: str):
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ConfigError(f"Unknown --tz '{name}' (use an IANA name such as Asia/Kolkata).") from exc


def parse_start_time(value: str, tz_name: str = DEFAULT_TZ) -> datetime:
    """ISO 8601 -> aware datetime. Naive values are interpreted in tz_name."""
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ConfigError(
            f"Invalid --start_time '{value}'. Expected ISO 8601, e.g. 2026-09-29T08:00:00 or 2026-09-29T02:30:00Z."
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=resolve_tz(tz_name))
    return dt


def derive_start_time(sim_summary_path: str, tz_name: str = DEFAULT_TZ) -> datetime | None:
    """08:00 local on the simulated day from public/sim/summary.json, else None."""
    if not sim_summary_path or not os.path.exists(sim_summary_path):
        return None
    try:
        with open(sim_summary_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    day = meta.get("date") if isinstance(meta, dict) else None
    if not day:
        return None
    offset = meta.get("timezone") or ""
    stamp = f"{day}T{DERIVED_START_CLOCK}{offset}"
    try:
        return parse_start_time(stamp, tz_name)
    except SystemExit:
        return None


def make_event_id(camera_code: str, source_video: str, frame_ts: float, tracked_vehicle_id: str) -> str:
    """Stable id for one (camera, clip, frame, track) observation."""
    key = f"{camera_code}|{source_video}|{frame_ts:.3f}|{tracked_vehicle_id}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def _float_or_none(value):
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def build_rows(
    camera_code: str,
    detections: list[dict],
    camera: dict,
    base_time: datetime,
    source_video: str,
    run_meta: dict | None = None,
) -> list[dict]:
    """detections_<code>.json records -> `detections` table rows (deduplicated by event_id)."""
    run_meta = run_meta or {}
    rows: dict[str, dict] = {}
    for det in detections:
        frame_ts = float(det.get("frame_timestamp_sec") or 0.0)
        track = str(det.get("tracked_vehicle_id") or "trk_0000")
        raw_plate = (det.get("plate_text") or "UNKNOWN").strip() or "UNKNOWN"
        detected_at = (base_time + timedelta(seconds=frame_ts)).isoformat()
        event_id = make_event_id(camera_code, source_video, frame_ts, track)
        rows[event_id] = {
            "event_id": event_id,
            "camera_id": camera["id"],
            "plate_text_raw": raw_plate[:32],
            "plate_text_normalized": normalize_plate(raw_plate)[:32] or "UNKNOWN",
            "confidence_score": float(det.get("confidence") or 0.0),
            "plate_confidence": _float_or_none(det.get("plate_confidence")),
            "vehicle_type": det.get("vehicle_type") or "car",
            "detected_at": detected_at,
            "timestamp": detected_at,
            "lat": _float_or_none(camera.get("lat")),
            "lng": _float_or_none(camera.get("lng")),
            "bbox": det.get("bbox") or {"x": 0, "y": 0, "width": 0, "height": 0},
            "tracked_vehicle_id": track,
            "frame_timestamp_sec": frame_ts,
            "engine": det.get("engine") or run_meta.get("engine"),
            "model_version": det.get("model_version") or run_meta.get("model_version"),
            "source_video": source_video or None,
        }
    return list(rows.values())


def stale_event_ids(client, camera_id: str, keep: set[str], page_size: int = 1000) -> list[str]:
    """event_ids stored for `camera_id` that are not in `keep` (read page by page)."""
    stored: list[str] = []
    start = 0
    while True:
        page = (client.table("detections").select("event_id").eq("camera_id", camera_id)
                .order("event_id").range(start, start + page_size - 1).execute().data) or []
        stored += [r["event_id"] for r in page]
        if len(page) < page_size:
            break
        start += page_size
    return sorted(set(stored) - keep)


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="NERO — upsert ANPR detections into Supabase")
    p.add_argument("--detections_dir", default=os.path.join(ROOT_DIR, "public", "detections"),
                   help="Directory with detections_<camera_code>.json (+ summary.json)")
    p.add_argument("--config", default=DEFAULT_CONFIG,
                   help="camera_config.json (source-video names when summary.json is absent)")
    p.add_argument("--start_time", default=None,
                   help="Clip start, ISO 8601. Naive values use --tz. Default: 08:00 on the simulated day.")
    p.add_argument("--tz", default=DEFAULT_TZ, help=f"Timezone for a naive --start_time (default {DEFAULT_TZ})")
    p.add_argument("--sim_summary", default=DEFAULT_SIM_SUMMARY,
                   help="Simulation summary used to derive --start_time")
    p.add_argument("--batch_size", type=int, default=500, help="Rows per upsert (default 500)")
    p.add_argument("--retries", type=int, default=4, help="Attempts per chunk (default 4)")
    p.add_argument("--retry_base_delay", type=float, default=1.0, help="First backoff delay in seconds")
    p.add_argument("--prune", action="store_true",
                   help="After a camera's rows are upserted, delete its rows that are no longer in its file")
    p.add_argument("--dry_run", action="store_true", help="Build rows and print a summary; write nothing")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    print("\n" + "=" * 60 + "\n  NERO — Supabase Detection Ingestor\n" + "=" * 60)

    if args.batch_size < 1:
        raise ConfigError("--batch_size must be >= 1")
    if not os.path.isdir(args.detections_dir):
        print(f"[!] Detections directory not found: {args.detections_dir}")
        return 1
    files = sorted(glob.glob(os.path.join(args.detections_dir, "detections_*.json")))
    if not files:
        print(f"[!] No detections_*.json files in '{args.detections_dir}'. Run pipeline/detect/run_remote_detection.py first.")
        return 1

    if args.start_time:
        base_time = parse_start_time(args.start_time, args.tz)
    else:
        base_time = derive_start_time(args.sim_summary, args.tz)
        if base_time is None:
            raise ConfigError("--start_time is required (no simulated day found in --sim_summary to derive it from).")
    print(f"[*] Clip start time (t=0): {base_time.isoformat()}")

    per_camera: dict[str, list] = {}
    for path in files:
        code = os.path.basename(path)[len("detections_"):-len(".json")]
        with open(path, "r", encoding="utf-8") as f:
            per_camera[code] = json.load(f) or []

    run_summary = load_run_summary(args.detections_dir)
    config = load_config_fallback(args.config)

    client = None
    if args.dry_run:
        cameras = {code: {"id": f"<{code}>", "lat": None, "lng": None} for code in per_camera}
    else:
        client = get_supabase_client()
        try:
            cameras = fetch_camera_mapping(client)
        except Exception as exc:
            raise ConfigError(f"Could not read the cameras table: {exc}") from exc
        unknown = missing_codes([c for c, d in per_camera.items() if d], cameras)
        if unknown:
            raise ConfigError(
                f"Camera code(s) not in the cameras table: {', '.join(unknown)}. "
                "Apply the camera-network migration (or fix the file names) and re-run."
            )

    written = failed = pruned = 0
    failed_chunks: list[str] = []
    for code, dets in per_camera.items():
        if not dets:
            print(f"  {code}: empty file — skipped")
            continue
        meta = run_summary.get(code, {})
        source_video = meta.get("video_filename") or config.get(code, {}).get("video_filename") or ""
        rows = build_rows(code, dets, cameras[code], base_time, source_video, meta)
        print(f"  {code}: {len(rows)} rows (camera {cameras[code]['id']}, clip '{source_video or '?'}')")
        if args.dry_run:
            continue
        camera_ok = True
        for n, chunk in enumerate(chunked(rows, args.batch_size), start=1):
            label = f"{code} chunk {n}"
            try:
                with_retries(
                    lambda chunk=chunk: client.table("detections").upsert(chunk, on_conflict="event_id").execute(),
                    attempts=args.retries, base_delay=args.retry_base_delay, label=label,
                )
                written += len(chunk)
            except Exception as exc:  # noqa: BLE001
                camera_ok = False
                failed += len(chunk)
                failed_chunks.append(label)
                print(f"  [!] {label}: giving up after {args.retries} attempts: {exc}")
        if not args.prune:
            continue
        if not camera_ok:
            print(f"  [!] {code}: not pruned (some rows failed to upsert)")
            continue
        label = f"{code} prune"
        try:
            stale = with_retries(
                lambda code=code: stale_event_ids(client, cameras[code]["id"], {r["event_id"] for r in rows}),
                attempts=args.retries, base_delay=args.retry_base_delay, label=label,
            )
            for chunk in chunked(stale, args.batch_size):
                with_retries(
                    lambda chunk=chunk: client.table("detections").delete().in_("event_id", chunk).execute(),
                    attempts=args.retries, base_delay=args.retry_base_delay, label=label,
                )
                pruned += len(chunk)
            print(f"  {code}: pruned {len(stale)} stale rows")
        except Exception as exc:  # noqa: BLE001
            failed_chunks.append(label)
            print(f"  [!] {label}: giving up after {args.retries} attempts: {exc}")

    print("\n" + "=" * 60)
    print(f"  Files: {len(files)} · rows upserted: {written} · rows failed: {failed}"
          + (f" · stale rows pruned: {pruned}" if args.prune else ""))
    print(f"  Clip start time: {base_time.isoformat()}")
    print("=" * 60)
    if failed_chunks:
        print(f"[!] Failed chunks: {', '.join(failed_chunks)} — re-run to retry (upserts are idempotent).")
        return EXIT_PARTIAL
    return 0


if __name__ == "__main__":
    sys.exit(main())
