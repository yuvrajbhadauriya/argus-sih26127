#!/usr/bin/env python3
"""
NERO Pipeline — seed the watchlist and alerts
=============================================
Seeds ``blacklist_entries`` (the watchlist) and ``alerts`` from the curated
demo cases of the simulated city network (``public/sim/summary.json`` ->
``demo.watchlist`` / ``demo.anomalies``), plus alerts for any real ANPR
detections of watchlisted plates already in ``detections``.

Only the generic shape of the simulation output is assumed, so a regenerated
network (another city, other plates/cameras) needs no code change:

    demo.watchlist[]:  {plate_text, category?, priority?, reason?, vehicle_type?, cameras?[]}
    demo.anomalies[]:  {kind, plate_text, description?, evidence[]: {camera_code, timestamp}}
    journeys.json:     {sighting_fields: [...camera_code, timestamp...],
                        journeys[]: {plate_text, sightings: [[...], ...]}}   (optional)

Idempotent: watchlist rows are upserted on ``plate_text_normalized``; alerts
carry a deterministic ``source_key`` and are inserted with ON CONFLICT DO
NOTHING, so re-seeding never duplicates and never resets an acknowledgement.
Writes are batched (one request per chunk) and retried with backoff.

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (no anon fallback).

Usage
    python pipeline/seed_alerts_and_watchlist.py [--summary public/sim/summary.json] [--dry_run]

Exit codes: 0 ok · 1 nothing to seed · 2 configuration error · 3 some writes failed
"""

from __future__ import annotations

import argparse
import json
import os
import sys

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

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SUMMARY = os.path.join(ROOT_DIR, "public", "sim", "summary.json")

ANOMALY_PRIORITY = {"cloned_plate": "critical", "circling": "high"}
DEFAULT_PRIORITY = "high"
DEFAULT_CATEGORY = "flagged"

load_dotenv()


# ──────────────────────────────────────────────────────────────────────
# Loading the simulation output
# ──────────────────────────────────────────────────────────────────────
def load_demo(summary_path: str) -> tuple[list[dict], list[dict], dict]:
    """(watchlist, anomalies, summary meta) from the simulation summary."""
    if not os.path.exists(summary_path):
        raise ConfigError(f"Simulation summary not found: {summary_path} (run pipeline/simulation/simulate_city_network.py)")
    with open(summary_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    demo = meta.get("demo") or {}
    watchlist = [w for w in demo.get("watchlist") or [] if isinstance(w, dict) and w.get("plate_text")]
    anomalies = [a for a in demo.get("anomalies") or [] if isinstance(a, dict) and a.get("plate_text")]
    return watchlist, anomalies, meta


def load_sightings(journeys_path: str, plates: set[str]) -> dict[str, list[tuple[str, str]]]:
    """{normalised plate: [(camera_code, iso timestamp), ...]} for the given plates."""
    if not journeys_path or not os.path.exists(journeys_path):
        return {}
    with open(journeys_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    fields = data.get("sighting_fields") or ["camera_code", "timestamp"]
    try:
        i_cam, i_ts = fields.index("camera_code"), fields.index("timestamp")
    except ValueError:
        return {}
    out: dict[str, list[tuple[str, str]]] = {}
    for journey in data.get("journeys") or []:
        plate = normalize_plate(journey.get("plate_text"))
        if plate not in plates:
            continue
        for s in journey.get("sightings") or []:
            if isinstance(s, dict):
                cam, ts = s.get("camera_code"), s.get("timestamp")
            else:
                cam, ts = s[i_cam], s[i_ts]
            if cam and ts:
                out.setdefault(plate, []).append((cam, ts))
    for hits in out.values():
        hits.sort(key=lambda x: x[1])
    return out


# ──────────────────────────────────────────────────────────────────────
# Row builders (pure)
# ──────────────────────────────────────────────────────────────────────
def watchlist_rows(watchlist: list[dict]) -> list[dict]:
    rows: dict[str, dict] = {}
    for w in watchlist:
        norm = normalize_plate(w["plate_text"])
        reason = w.get("reason") or "Watchlist target (simulated)"
        rows[norm] = {
            "plate_text": w["plate_text"].strip()[:32],
            "plate_text_normalized": norm[:32],
            "category": w.get("category") or DEFAULT_CATEGORY,
            "priority": w.get("priority") or DEFAULT_PRIORITY,
            "reason": reason,
            "notes": reason,
            "vehicle_type": w.get("vehicle_type"),
            "is_active": True,
            "source": "simulation",
        }
    return list(rows.values())


def _camera_fields(camera: dict) -> dict:
    return {
        "camera_id": camera["id"],
        "camera_name": camera.get("name") or camera["id"],
        "lat": camera.get("lat"),
        "lng": camera.get("lng"),
    }


def watchlist_alert_rows(watchlist, sightings, cameras, blacklist_ids) -> list[dict]:
    """One alert per simulated sighting of a watchlisted plate."""
    rows = []
    for w in watchlist:
        norm = normalize_plate(w["plate_text"])
        hits = sightings.get(norm) or [(code, None) for code in (w.get("cameras") or [])]
        for code, ts in hits:
            camera = cameras[code]
            row = {
                "source_key": f"sim:watchlist:{norm}:{code}:{ts or '-'}",
                "alert_type": "watchlist",
                "blacklist_entry_id": blacklist_ids.get(norm),
                "plate_text": w["plate_text"].strip()[:32],
                "priority": w.get("priority") or DEFAULT_PRIORITY,
                "category": w.get("category") or DEFAULT_CATEGORY,
                "reason": w.get("reason") or "Watchlist match",
                "status": "open",
                "details": {"source": "simulation", "camera_code": code},
                **_camera_fields(camera),
            }
            if ts:
                row["created_at"] = ts
            rows.append(row)
    return rows


def anomaly_alert_rows(anomalies, cameras) -> list[dict]:
    """One alert per anomaly, located at the camera of its last piece of evidence."""
    rows = []
    for a in anomalies:
        evidence = [e for e in a.get("evidence") or [] if e.get("camera_code")]
        if not evidence:
            continue
        last = max(evidence, key=lambda e: e.get("timestamp") or "")
        kind = a.get("kind") or "anomaly"
        norm = normalize_plate(a["plate_text"])
        row = {
            "source_key": f"sim:anomaly:{kind}:{norm}:{last.get('timestamp') or '-'}",
            "alert_type": kind,
            "plate_text": a["plate_text"].strip()[:32],
            "priority": ANOMALY_PRIORITY.get(kind, DEFAULT_PRIORITY),
            "category": kind[:32],
            "reason": a.get("description") or kind.replace("_", " "),
            "status": "open",
            "details": {"source": "simulation", **a},
            **_camera_fields(cameras[last["camera_code"]]),
        }
        if last.get("timestamp"):
            row["created_at"] = last["timestamp"]
        rows.append(row)
    return rows


def detection_alert_rows(detections, watchlist_by_plate, cameras_by_id, blacklist_ids) -> list[dict]:
    """Alerts for real detections (pipeline output) of watchlisted plates — one per camera visit track."""
    rows = []
    seen = set()
    for d in detections:
        norm = d.get("plate_text_normalized")
        w = watchlist_by_plate.get(norm)
        camera = cameras_by_id.get(d.get("camera_id"))
        if not w or not camera:
            continue
        # A tracked vehicle is seen in many frames; alert once per track per camera.
        key = (norm, d.get("camera_id"), d.get("tracked_vehicle_id") or d.get("event_id"))
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "source_key": f"det:{d['event_id']}",
            "alert_type": "watchlist",
            "detection_id": d["event_id"],
            "blacklist_entry_id": blacklist_ids.get(norm),
            "plate_text": (d.get("plate_text_raw") or w["plate_text"])[:32],
            "priority": w.get("priority") or DEFAULT_PRIORITY,
            "category": w.get("category") or DEFAULT_CATEGORY,
            "reason": w.get("reason") or "Watchlist match",
            "status": "open",
            "created_at": d.get("detected_at"),
            "details": {"source": "anpr"},
            **_camera_fields(camera),
        })
    return rows


def uniform(rows: list[dict]) -> list[dict]:
    """PostgREST bulk writes need every object to carry the same keys."""
    keys = sorted({k for r in rows for k in r})
    return [{k: r.get(k) for k in keys} for r in rows]


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Seed watchlist + alerts from the simulated network")
    p.add_argument("--summary", default=DEFAULT_SUMMARY, help="public/sim/summary.json")
    p.add_argument("--journeys", default=None, help="journeys.json (default: next to --summary)")
    p.add_argument("--batch_size", type=int, default=200)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--retry_base_delay", type=float, default=1.0)
    p.add_argument("--no_detection_alerts", action="store_true",
                   help="Skip alerts for real detections of watchlisted plates")
    p.add_argument("--dry_run", action="store_true", help="Print what would be written; write nothing")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    watchlist, anomalies, _meta = load_demo(args.summary)
    if not watchlist and not anomalies:
        print("[!] The simulation summary has no demo.watchlist / demo.anomalies — nothing to seed.")
        return 1
    journeys_path = args.journeys or os.path.join(os.path.dirname(args.summary), "journeys.json")
    plates = {normalize_plate(w["plate_text"]) for w in watchlist}
    sightings = load_sightings(journeys_path, plates)

    needed_codes = {code for hits in sightings.values() for code, _ in hits}
    needed_codes |= {c for w in watchlist if normalize_plate(w["plate_text"]) not in sightings for c in w.get("cameras") or []}
    needed_codes |= {e["camera_code"] for a in anomalies for e in a.get("evidence") or [] if e.get("camera_code")}

    bl_rows = watchlist_rows(watchlist)
    if args.dry_run:
        fake_cams = {c: {"id": f"<{c}>", "name": c} for c in needed_codes}
        alerts = watchlist_alert_rows(watchlist, sightings, fake_cams, {}) + anomaly_alert_rows(anomalies, fake_cams)
        print(f"[dry-run] {len(bl_rows)} watchlist entries, {len(alerts)} simulated alerts")
        return 0

    client = get_service_client()
    retry = {"attempts": args.retries, "base_delay": args.retry_base_delay}
    try:
        cameras = fetch_cameras_by_code(client, **retry)
    except Exception as exc:
        raise ConfigError(f"Could not read the cameras table: {exc}") from exc
    unknown = missing_codes(needed_codes, cameras)
    if unknown:
        raise ConfigError(
            f"Camera code(s) used by the simulation are not in the cameras table: {', '.join(unknown)}. "
            "Apply the camera-network migration that matches public/sim first."
        )

    failures: list[str] = []

    def write(table: str, rows: list[dict], label: str, **upsert_kw) -> int:
        done = 0
        for n, chunk in enumerate(chunked(uniform(rows), args.batch_size), start=1):
            try:
                with_retries(lambda chunk=chunk: client.table(table).upsert(chunk, **upsert_kw).execute(),
                             label=f"{label} chunk {n}", **retry)
                done += len(chunk)
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{label} chunk {n}")
                print(f"  [!] {label} chunk {n}: giving up: {exc}")
        return done

    print(f"[*] Upserting {len(bl_rows)} watchlist entries...")
    write("blacklist_entries", bl_rows, "watchlist", on_conflict="plate_text_normalized")

    plate_list = sorted(plates)
    blacklist_ids: dict[str, str] = {}
    detections: list[dict] = []
    if plate_list:
        res = with_retries(
            lambda: client.table("blacklist_entries").select("id, plate_text_normalized")
            .in_("plate_text_normalized", plate_list).execute(),
            label="read watchlist ids", **retry)
        blacklist_ids = {r["plate_text_normalized"]: r["id"] for r in res.data or []}
        if not args.no_detection_alerts:
            res = with_retries(
                lambda: client.table("detections")
                .select("event_id, camera_id, plate_text_raw, plate_text_normalized, tracked_vehicle_id, detected_at")
                .in_("plate_text_normalized", plate_list).order("detected_at").limit(5000).execute(),
                label="read watchlist detections", **retry)
            detections = res.data or []

    cameras_by_id = {c["id"]: c for c in cameras.values()}
    watchlist_by_plate = {normalize_plate(w["plate_text"]): w for w in watchlist}
    alerts = (
        watchlist_alert_rows(watchlist, sightings, cameras, blacklist_ids)
        + anomaly_alert_rows(anomalies, cameras)
        + detection_alert_rows(detections, watchlist_by_plate, cameras_by_id, blacklist_ids)
    )
    print(f"[*] Inserting {len(alerts)} alerts (existing ones are left untouched)...")
    written = write("alerts", alerts, "alerts", on_conflict="source_key", ignore_duplicates=True)

    print(f"[OK] watchlist: {len(bl_rows)} · alerts sent: {written} "
          f"({len(detections)} matching detections in the DB)")
    if failures:
        print(f"[!] Failed: {', '.join(failures)} — re-run to retry (the seed is idempotent).")
        return EXIT_PARTIAL
    return 0


if __name__ == "__main__":
    sys.exit(main())
