#!/usr/bin/env python3
"""
Export the demo cases of the simulated Mumbai network to a TypeScript module.

The frontend's mock fixtures (alert feed, watchlist, live ANPR feed, detection
log, admin audit trail) must show the *same* plates, cameras and times as
``public/sim/{summary,journeys}.json``. Instead of copying tuples by hand, run
this after ``simulate_city_network.py``::

    python3 pipeline/simulation/export_demo_fixtures.py

It writes ``src/mocks/fixtures/simDemo.generated.ts`` (plain data, no logic);
the hand-written fixtures in ``src/mocks/fixtures`` build on it and
``src/features/alerts/fixtures.test.ts`` cross-checks it against the JSON.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import List, Optional

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SIM_DIR = ROOT / "public" / "sim"
CONFIG = ROOT / "pipeline" / "camera_config.json"
OUT = ROOT / "src" / "mocks" / "fixtures" / "simDemo.generated.ts"
DETECTIONS = ROOT / "public" / "detections"

LIVE_FEED_SIZE = 8
READS_PER_CAMERA = 3


def hms(ts: str) -> str:
    return datetime.fromisoformat(ts).strftime("%H:%M:%S")


def ts_literal(items: list) -> str:
    """A list literal with one compact JSON object per line."""
    return "[\n" + "".join(f"  {json.dumps(x, ensure_ascii=False)},\n" for x in items) + "]"


def load_real_reads(detections_dir: Path) -> dict:
    """camera code -> good ANPR reads on its clip [(plate, confidence 0-1, time_sec)] from events_<code>.json."""
    out: dict = {}
    for path in sorted(Path(detections_dir).glob("events_*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        reads = [(e["plate_text"], e["plate_confidence"], e["time_sec"])
                 for e in doc.get("events", []) if e.get("good_read") and e.get("plate_text")]
        best: dict = {}
        for plate, conf, t in reads:  # one row per plate, its most confident read
            if plate not in best or conf > best[plate][1]:
                best[plate] = (plate, conf, t)
        out[doc.get("camera_code") or path.stem.split("_", 1)[1]] = sorted(best.values(), key=lambda r: -r[1])
    return out


def build(summary: dict, journeys: List[dict], cameras: List[dict], seed: int,
          real_reads: Optional[dict] = None) -> dict:
    rng = random.Random(f"fixtures:{seed}")
    names = {c["camera_code"]: c["camera_name"] for c in cameras}
    watch = summary["demo"]["watchlist"]
    watch_idx = {w["plate_text"]: i for i, w in enumerate(watch)}
    anomaly_plates = {a["plate_text"] for a in summary["demo"]["anomalies"]}

    # Every sighting of a watchlist plate is one watchlist hit.
    hits = []
    for j in journeys:
        wi = watch_idx.get(j["plate_text"])
        if wi is None:
            continue
        for k, s in enumerate(j["sightings"]):
            hits.append([wi, j["id"], k, s[0], hms(s[1]), s[1]])
    hits.sort(key=lambda h: (h[0], h[5]))
    watch_hits = [h[:5] for h in hits]

    def locate(plate: str, code: str, ts: str) -> tuple:
        for j in journeys:
            if j["plate_text"] != plate:
                continue
            for k, s in enumerate(j["sightings"]):
                if s[0] == code and datetime.fromisoformat(s[1]) == datetime.fromisoformat(ts):
                    return j["id"], k
        raise ValueError(f"no sighting of {plate} at {code} {ts}")

    anomalies = []
    for a in summary["demo"]["anomalies"]:
        last = a["evidence"][-1]
        jid, k = locate(a["plate_text"], last["camera_code"], last["timestamp"])
        rec = {
            "kind": a["kind"],
            "plate_text": a["plate_text"],
            "journey": jid,
            "index": k,
            "camera_code": last["camera_code"],
            "time": hms(last["timestamp"]),
            "evidence": [[e["camera_code"], hms(e["timestamp"])] for e in a["evidence"]],
        }
        if a["kind"] == "cloned_plate":
            first = a["evidence"][0]
            rec["reason"] = (
                f"Possible cloned plate: read at {names[first['camera_code']]} and {names[last['camera_code']]} "
                f"{a['gap_seconds'] // 60} min apart; {a['road_distance_m'] / 1000:.1f} km by road needs "
                f"~{a['road_distance_m'] / 1000 / 30 * 60:.0f} min (implied {a['implied_speed_kmph']:.0f} km/h)"
            )
        else:
            visits = a.get("visits", {})
            loop = sorted(visits, key=lambda c: -visits[c])[:2]
            mins = int((datetime.fromisoformat(last["timestamp"])
                        - datetime.fromisoformat(a["evidence"][0]["timestamp"])).total_seconds() // 60)
            rec["reason"] = (
                f"Suspicious circling: looped {names[loop[0]]} and {names[loop[1]]} "
                f"{max(visits.values()) - 1} times in {mins} min with no destination"
            )
        anomalies.append(rec)

    # "Now" of the live feed: the last watchlist hit of the day. The rail shows
    # the newest reads up to that instant, so it includes that hit.
    all_s = []
    for j in journeys:
        for k, s in enumerate(j["sightings"]):
            all_s.append((datetime.fromisoformat(s[1]), j, k, s))
    all_s.sort(key=lambda x: x[0])
    now = max(datetime.fromisoformat(h[5]) for h in hits)
    feed, seen = [], set()
    for t, j, k, s in reversed([x for x in all_s if x[0] <= now]):
        if j["plate_text"] in seen:
            continue
        seen.add(j["plate_text"])
        w = watch_idx.get(j["plate_text"])
        feed.append({
            "id": f"lf-{j['id']}-{k}",
            "plate": j["plate_text"],
            "cameraCode": s[0],
            "cameraName": names[s[0]],
            "vehicleType": j["vehicle_type"],
            "plateVariant": j.get("plate_variant", "private"),
            "confidence": rng.randint(84, 98),
            "secondsAgo": int((now - t).total_seconds()),
            "watchlist": None if w is None else watch[w]["priority"],
        })
        if len(feed) >= LIVE_FEED_SIZE:
            break

    # Sample pipeline reads per camera (detection log): plates really seen there.
    by_cam = defaultdict(list)
    for t, j, k, s in all_s:
        by_cam[s[0]].append(j)
    reads, shown_demo = [], set()
    for idx, c in enumerate(cameras, 1):
        code = c["camera_code"]
        pool, used = by_cam.get(code, []), set()
        # Show each demo plate once in the log, at a camera it really passes.
        chosen = [j for j in pool if (j["plate_text"] in watch_idx or j["plate_text"] in anomaly_plates)
                  and j["plate_text"] not in shown_demo][:1]
        shown_demo.update(j["plate_text"] for j in chosen)
        used.update(j["plate_text"] for j in chosen)
        # Then plates the ANPR model really read on this camera's clip (with their
        # real confidence and clip time) when the simulation has them at this camera.
        real = {}
        by_plate = {j["plate_text"]: j for j in pool}
        for plate, conf, t in (real_reads or {}).get(code, []):
            if len(chosen) >= READS_PER_CAMERA:
                break
            j = by_plate.get(plate)
            if j is not None and plate not in used:
                chosen.append(j)
                used.add(plate)
                real[plate] = (conf, t)
        for j in rng.sample(pool, min(len(pool), 40)):
            if len(chosen) >= READS_PER_CAMERA:
                break
            if j["plate_text"] not in used:
                chosen.append(j)
                used.add(j["plate_text"])
        for n, j in enumerate(chosen):
            conf = round(rng.uniform(0.72, 0.98), 2)
            frame_sec = round(2.0 + n * 4.5 + rng.uniform(0, 2.5), 1)
            if j["plate_text"] in real:
                conf, frame_sec = round(real[j["plate_text"]][0], 2), round(real[j["plate_text"]][1], 1)
            reads.append({
                "camera_id": f"cam-{idx:03d}",
                "camera_code": code,
                "plate_text": j["plate_text"],
                "vehicle_type": j["vehicle_type"],
                "plate_variant": j.get("plate_variant", "private"),
                "confidence": conf,
                "frame_sec": frame_sec,
            })

    return {
        "date": summary["date"],
        "watchlist": [
            {k: w[k] for k in ("plate_text", "vehicle_type", "plate_variant", "category", "priority", "reason")}
            for w in watch
        ],
        "hits": watch_hits,
        "anomalies": anomalies,
        "feed": feed,
        "feed_now": now.isoformat(),
        "reads": reads,
    }


def render(d: dict) -> str:
    return f"""// ═══════════════════════════════════════════════════
// AUTO-GENERATED by pipeline/simulation/export_demo_fixtures.py from
// public/sim/summary.json + journeys.json — do not edit by hand; re-run the
// script after re-simulating. Cross-checked by src/features/alerts/fixtures.test.ts.
// ═══════════════════════════════════════════════════

/* eslint-disable */

/** Simulated day (IST). */
export const SIM_DATE = {json.dumps(d['date'])};

/** Curated watchlist plates (summary.json demo.watchlist order). */
export const SIM_WATCHLIST = {ts_literal(d['watchlist'])} as const;

/** Every sighting of a watchlist plate: [watchlist index, journey id, sighting index, camera code, IST time]. */
export const SIM_WATCH_HITS: [number, string, number, string, string][] = {ts_literal(d['hits'])};

/** Route anomalies (summary.json demo.anomalies); the alert fires at the last evidence sighting. */
export const SIM_ANOMALIES = {ts_literal(d['anomalies'])} as const;

/** Newest ANPR reads up to {d['feed_now']} (the last watchlist hit), newest first. */
export const SIM_LIVE_FEED = {ts_literal(d['feed'])} as const;

/** Sample pipeline plate reads per camera (plates really seen at that camera; real ANPR reads of its clip first). */
export const SIM_CAMERA_READS = {ts_literal(d['reads'])} as const;
"""


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sim-dir", type=Path, default=SIM_DIR)
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--detections", type=Path, default=DETECTIONS,
                    help="public/detections: real good reads per camera (events_<code>.json) seed the camera reads")
    args = ap.parse_args(argv)
    summary = json.loads((args.sim_dir / "summary.json").read_text(encoding="utf-8"))
    journeys = json.loads((args.sim_dir / "journeys.json").read_text(encoding="utf-8"))["journeys"]
    cameras = json.loads(args.config.read_text(encoding="utf-8"))
    real = load_real_reads(args.detections) if args.detections and args.detections.is_dir() else None
    data = build(summary, journeys, cameras, summary.get("seed", 0), real)
    args.out.write_text(render(data), encoding="utf-8")
    print(f"Wrote {args.out} ({len(data['hits'])} watchlist hits, {len(data['anomalies'])} anomalies, "
          f"{len(data['feed'])} live reads, {len(data['reads'])} camera reads)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
