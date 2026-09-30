#!/usr/bin/env python3
"""
Build road-snapped routes between every ordered pair of cameras.

For each ordered pair (A, B) of cameras in ``pipeline/camera_config.json`` this
queries the public OSRM demo server once::

    https://router.project-osrm.org/route/v1/driving/{A};{B}?overview=full&geometries=geojson

Requests are sequential with a small delay and cached on disk
(``pipeline/simulation/.cache/osrm``) so re-runs never hit the server again.
Each route is simplified with Douglas-Peucker and written to
``public/sim/road_routes.json`` together with:

* ``distance_m`` / ``duration_s``  – OSRM free-flow values
* ``start_bearing`` / ``end_bearing`` – travel bearing leaving A / arriving at B
* ``via`` – other cameras the (unsimplified) route passes within
  ``--via-radius`` metres of, ordered by distance along the route. The
  simulator uses this so a vehicle driving A→B is also seen at those cameras.

Divided roads: a camera over a dual carriageway may set ``road_bearing`` (the
road axis in degrees) in the config. OSRM then snaps each endpoint once per
carriageway (``bearings=<axis>,60`` and ``<axis+180>,60``) and the shortest of
the candidate routes wins, so a vehicle never "U-turns past" a camera just
because the plain nearest-road snap picked the opposite carriageway.

If the network is unavailable the script falls back to straight lines with
haversine distance (``"source": "straight-line"``) so the rest of the pipeline
still works offline.

Usage::

    python pipeline/simulation/build_road_routes.py            # uses cache when present
    python pipeline/simulation/build_road_routes.py --offline  # force straight lines
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from geo import (  # noqa: E402
    bearing_over,
    douglas_peucker,
    haversine_m,
    locate_on_polyline,
    polyline_length_m,
)

ROOT = HERE.parents[1]
DEFAULT_CONFIG = ROOT / "pipeline" / "camera_config.json"
DEFAULT_OUT = ROOT / "public" / "sim" / "road_routes.json"
DEFAULT_CACHE = HERE / ".cache" / "osrm"
OSRM_BASE = "https://router.project-osrm.org/route/v1/driving"
USER_AGENT = "NERO-SIH26127-prototype/1.0 (road route precompute; low volume)"
FALLBACK_SPEED_KMPH = 30.0  # only used to give straight-line routes a duration


def load_cameras(config_path: Path) -> List[dict]:
    cams = json.loads(Path(config_path).read_text(encoding="utf-8"))
    for c in cams:
        if "lat" not in c or "lng" not in c:
            raise ValueError(f"camera {c.get('camera_code')} has no lat/lng in {config_path}")
    return cams


def route_key(a: str, b: str) -> str:
    return f"{a}>{b}"


BEARING_RANGE_DEG = 60


def snap_bearings(cam: dict) -> List[Optional[int]]:
    """Candidate travel bearings to snap `cam` with (None = plain nearest-road snap)."""
    axis = cam.get("road_bearing")
    if axis is None:
        return [None]
    axis = int(round(float(axis))) % 360
    return [axis, (axis + 180) % 360]


def fetch_osrm(a: dict, b: dict, cache_dir: Path, delay_s: float, timeout_s: float,
               bearing_a: Optional[int] = None, bearing_b: Optional[int] = None) -> Optional[dict]:
    """Return the raw OSRM response for a→b (cached), or None on failure."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    suffix = ""
    params = "overview=full&geometries=geojson&alternatives=false&steps=false"
    if bearing_a is not None or bearing_b is not None:
        suffix = f"__b{'' if bearing_a is None else bearing_a}_{'' if bearing_b is None else bearing_b}"
        fmt = lambda br: "" if br is None else f"{br},{BEARING_RANGE_DEG}"  # noqa: E731
        params += f"&bearings={fmt(bearing_a)};{fmt(bearing_b)}"
    cache_file = cache_dir / f"{a['camera_code']}__{b['camera_code']}{suffix}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    url = f"{OSRM_BASE}/{a['lng']},{a['lat']};{b['lng']},{b['lat']}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != "Ok" or not data.get("routes"):
                print(f"  [!] OSRM {a['camera_code']}→{b['camera_code']}: {data.get('code')}")
                return None
            cache_file.write_text(json.dumps(data), encoding="utf-8")
            time.sleep(delay_s)
            return data
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            wait = delay_s * (attempt + 2)
            print(f"  [!] OSRM request failed ({exc}); retry in {wait:.1f}s")
            time.sleep(wait)
    return None


def build_route(a: dict, b: dict, coords: List[tuple], distance_m: float, duration_s: float,
                cameras: List[dict], tolerance_m: float, via_radius_m: float) -> dict:
    """Assemble one route record from full-resolution coordinates."""
    via = []
    for c in cameras:
        if c["camera_code"] in (a["camera_code"], b["camera_code"]):
            continue
        d, along = locate_on_polyline((c["lat"], c["lng"]), coords)
        total = polyline_length_m(coords)
        # Ignore touches right at either end (those are the endpoints' junctions).
        if d <= via_radius_m and 150.0 < along < total - 150.0:
            via.append({"camera_code": c["camera_code"], "along_m": round(along), "offset_m": round(d, 1)})
    via.sort(key=lambda v: v["along_m"])

    simple = douglas_peucker(coords, tolerance_m)
    return {
        "from": a["camera_code"],
        "to": b["camera_code"],
        "distance_m": round(distance_m),
        "duration_s": round(duration_s),
        "start_bearing": round(bearing_over(coords, from_end=False), 1),
        "end_bearing": round(bearing_over(coords, from_end=True), 1),
        "via": via,
        "coordinates": [[round(lat, 5), round(lng, 5)] for lat, lng in simple],
    }


def build_all(cameras: List[dict], cache_dir: Path, offline: bool, tolerance_m: float,
              via_radius_m: float, delay_s: float, timeout_s: float) -> Dict[str, object]:
    routes: Dict[str, dict] = {}
    osrm_ok = 0
    fallback = 0
    for a in cameras:
        for b in cameras:
            if a is b:
                continue
            data = None
            if not offline:
                for ba in snap_bearings(a):
                    for bb in snap_bearings(b):
                        cand = fetch_osrm(a, b, cache_dir, delay_s, timeout_s, ba, bb)
                        if cand and (data is None or cand["routes"][0]["distance"] < data["routes"][0]["distance"]):
                            data = cand
            if data:
                r = data["routes"][0]
                coords = [(lat, lng) for lng, lat in r["geometry"]["coordinates"]]
                # OSRM snaps to the road; make the polyline start/end exactly at the cameras.
                coords = [(a["lat"], a["lng"])] + coords + [(b["lat"], b["lng"])]
                rec = build_route(a, b, coords, r["distance"], r["duration"], cameras, tolerance_m, via_radius_m)
                rec["source"] = "osrm"
                osrm_ok += 1
            else:
                coords = [(a["lat"], a["lng"]), (b["lat"], b["lng"])]
                dist = haversine_m(coords[0], coords[1])
                rec = build_route(a, b, coords, dist, dist / (FALLBACK_SPEED_KMPH / 3.6), cameras,
                                  tolerance_m, via_radius_m)
                rec["source"] = "straight-line"
                fallback += 1
            routes[route_key(a["camera_code"], b["camera_code"])] = rec
            print(f"  {a['camera_code']} → {b['camera_code']}: {rec['distance_m'] / 1000:.1f} km, "
                  f"{len(rec['coordinates'])} pts, via {[v['camera_code'] for v in rec['via']]} [{rec['source']}]")

    source = "osrm" if fallback == 0 else ("straight-line" if osrm_ok == 0 else "mixed")
    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": source,
        "osrm_server": None if source == "straight-line" else OSRM_BASE,
        "attribution": "Routes © OpenStreetMap contributors, computed with OSRM",
        "simplify_tolerance_m": tolerance_m,
        "via_radius_m": via_radius_m,
        "cameras": [
            {
                "code": c["camera_code"],
                "name": c["camera_name"],
                "lat": c["lat"],
                "lng": c["lng"],
                "road": c.get("road"),
                "direction": c.get("direction"),
                "zone": c.get("zone"),
            }
            for c in cameras
        ],
        "routes": routes,
    }


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--offline", action="store_true", help="skip OSRM, use straight lines")
    ap.add_argument("--tolerance", type=float, default=12.0, help="Douglas-Peucker tolerance (m)")
    ap.add_argument("--via-radius", type=float, default=40.0,
                    help="a camera within this many metres of a route counts as passed")
    ap.add_argument("--delay", type=float, default=1.1, help="seconds between OSRM requests")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args(argv)

    cameras = load_cameras(args.config)
    print(f"Building {len(cameras) * (len(cameras) - 1)} routes for {len(cameras)} cameras...")
    out = build_all(cameras, args.cache, args.offline, args.tolerance, args.via_radius, args.delay, args.timeout)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    kb = args.out.stat().st_size / 1024
    print(f"Wrote {args.out} ({kb:.0f} KB, source={out['source']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
