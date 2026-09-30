#!/usr/bin/env python3
"""
Simulate one day of vehicle journeys across the Mumbai camera network.

Why: the camera clips are real Mumbai traffic footage (Pexels) but have no
exact location, and the team has no access to live city cameras. To
demonstrate the Trajectory Reconstruction Engine (SIH26127) we pin each clip
to the Mumbai junction it was plausibly shot at (see
pipeline/camera_config.json) and simulate how vehicles are re-sighted as they
drive across the city.

Inputs
  * Plates: by default a synthetic but realistic Mumbai fleet (see
    ``generate_fleet``: MH01/02/03/47 city RTOs, MH04/05/43/46/48 MMR RTOs, a
    share of out-of-state and BH-series plates, yellow commercial plates for
    taxis/buses/trucks and green EV plates). With ``--plates-from DIR`` the
    plates the ANPR pipeline actually read (``DIR/detections_<code>.json``)
    seed the fleet first, keeping each plate's source camera so the video
    evidence and the trajectory agree; synthetic plates top up to --vehicles.
  * public/sim/road_routes.json – road-snapped OSRM routes between cameras
    (build with build_road_routes.py)

Model
  * Every hop between consecutive sightings is a road route with no other
    camera on it: if the A→B route passes camera C the vehicle is seen at C too.
  * Hop duration = OSRM distance / speed, where speed = OSRM free-flow speed x
    a Mumbai time-of-day congestion factor x a vehicle-class factor x noise,
    clamped to 10–55 km/h (morning / evening peaks ~15–22 km/h, nights ~35–45).
  * Trip start times follow commuter peaks for cars/two-wheelers, all-day for
    buses and mostly off-peak hours for heavy goods vehicles (Mumbai Traffic
    Police peak-hour no-entry 07:00–11:00 and 17:00–21:00).
  * Curated demo cases: watchlist plates with long multi-camera journeys, a
    cloned plate (same plate at two far-apart cameras within an impossible
    time) and a vehicle circling the same junctions.

Outputs (all deterministic for a given --seed)
  * public/sim/journeys.json – compact journeys; each sighting is
    [camera_code, timestamp (ISO, +05:30), heading, speed_kmph_from_prev,
     distance_m_from_prev] and the plate (with its plate_variant: private /
     commercial / ev) is stored once per journey.
  * public/sim/summary.json  – stats, curated plates and anomaly evidence.
  * --supabase-rows PATH     – optional detections-table rows (never inserted).
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from geo import compass8, haversine_m  # noqa: E402

ROOT = HERE.parents[1]
DEFAULT_ROUTES = ROOT / "public" / "sim" / "road_routes.json"
DEFAULT_CONFIG = ROOT / "pipeline" / "camera_config.json"
DEFAULT_OUT_DIR = ROOT / "public" / "sim"

IST = timezone(timedelta(hours=5, minutes=30))
SIGHTING_FIELDS = ["camera_code", "timestamp", "heading", "speed_kmph_from_prev", "distance_m_from_prev"]

MIN_SPEED_KMPH = 10.0
MAX_SPEED_KMPH = 55.0

# Mumbai congestion factor applied to OSRM free-flow speed, per hour of day (IST).
# WEH / EEH free-flow is high, so Mumbai peaks sit well below Delhi's.
TOD_FACTOR = [
    0.78, 0.80, 0.80, 0.80, 0.77, 0.70,   # 00-05  night
    0.58, 0.44, 0.33, 0.30, 0.34, 0.42,   # 06-11  morning peak 08-11
    0.44, 0.42, 0.42, 0.40, 0.36, 0.32,   # 12-17
    0.29, 0.29, 0.33, 0.44, 0.56, 0.68,   # 18-23  evening peak 18-21
]
VEHICLE_FACTOR = {"car": 1.0, "motorcycle": 1.06, "bus": 0.84, "truck": 0.8, "unknown": 0.95}
DIRECTION_TO_COMPASS = {"northbound": "N", "southbound": "S", "eastbound": "E", "westbound": "W"}

WATCHLIST_SPECS = [
    # (source camera, category, priority, reason, [(start "HH:MM", [camera plan]), ...])
    ("JG-01", "stolen", "critical", "Reported stolen from Jogeshwari East (simulated FIR, MIDC police station)",
     [("08:05", ["JG-01", "AN-01", "VP-01", "SC-01", "DD-01"]),
      ("18:40", ["DD-01", "SN-01", "KR-01", "BH-01"])]),
    ("BH-01", "wanted", "high", "Linked to chain-snatching cases along LBS Marg (simulated)",
     [("07:30", ["BH-01", "KR-01", "SN-01", "DD-01"]),
      ("13:10", ["DD-01", "SC-01", "VP-01"]),
      ("20:15", ["VP-01", "AN-01", "JG-01", "BH-01"])]),
    ("SN-01", "flagged", "medium", "Repeated signal-jumping e-challans at Sion Circle (simulated)",
     [("10:20", ["SN-01", "KR-01", "SC-01"]),
      ("16:45", ["SC-01", "VP-01", "AN-01", "JG-01"])]),
    ("DD-01", "missing", "high", "Vehicle of a missing person report, Dadar police (simulated)",
     [("06:50", ["DD-01", "SC-01", "VP-01", "AN-01"]),
      ("11:30", ["AN-01", "KR-01", "BH-01"]),
      ("19:05", ["BH-01", "JG-01"])]),
]
# Cloned plate: genuine car Sion → Dadar while a clone with the same plate is
# read on LBS Marg at Bhandup minutes later.
CLONE_SOURCE = "SN-01"
CLONE_GENUINE_PLAN = ["SN-01", "DD-01"]
CLONE_SUSPECT_PLAN = ["BH-01", "KR-01"]
CLONE_AT = "DD-01"
# Circling: looping the Vile Parle flyover ↔ Santacruz (airport approach) late evening.
CIRCLING_SOURCE = "VP-01"
CIRCLING_LOOP = ["VP-01", "SC-01", "VP-01", "SC-01", "VP-01", "SC-01", "VP-01"]


# ──────────────────────────────────────────────────────────────────────
# Data loading
# ──────────────────────────────────────────────────────────────────────

PLATE_VARIANTS = ("private", "commercial", "ev")


@dataclass
class Vehicle:
    plate_text: str
    vehicle_type: str
    source_cameras: List[str]
    # Plate colour: private (white), commercial (yellow: taxis, buses, goods), ev (green).
    plate_variant: str = ""

    def __post_init__(self) -> None:
        if not self.plate_variant:
            self.plate_variant = "commercial" if self.vehicle_type in ("bus", "truck") else "private"


# ──────────────────────────────────────────────────────────────────────
# Synthetic Mumbai fleet (HSRP plate formats)
# ──────────────────────────────────────────────────────────────────────

# Mumbai city RTOs, then the wider MMR (Mumbai Metropolitan Region) RTOs.
MUMBAI_RTOS = {
    "MH01": 0.14,  # Mumbai (Central) – Tardeo
    "MH02": 0.20,  # Mumbai (West) – Andheri
    "MH03": 0.15,  # Mumbai (East) – Wadala
    "MH47": 0.12,  # Mumbai (North) – Borivali
    "MH04": 0.14,  # Thane
    "MH05": 0.05,  # Kalyan
    "MH43": 0.10,  # Navi Mumbai – Vashi
    "MH46": 0.04,  # Panvel
    "MH48": 0.06,  # Vasai-Virar
}
# Out-of-state plates commonly seen in Mumbai, with plausible RTO numbers.
OUT_OF_STATE = {
    "GJ": ([1, 5, 6, 15, 16, 21, 27], 0.30),
    "KA": ([1, 2, 3, 4, 5, 51, 53], 0.12),
    "DL": ([1, 2, 3, 4, 8, 9, 12], 0.10),
    "RJ": ([14, 19, 27, 45], 0.12),
    "MP": ([4, 9, 20], 0.08),
    "UP": ([14, 16, 32, 65], 0.10),
    "TS": ([7, 8, 9], 0.06),
    "GA": ([3, 7], 0.06),
    "KL": ([7, 43], 0.06),
}
# Other Maharashtra RTOs (Pune, Nashik, Aurangabad...) seen on Mumbai roads.
OTHER_MH = ["MH12", "MH14", "MH15", "MH20", "MH06", "MH08"]

# vehicle class → (vehicle_type, weight, commercial?, EV share)
FLEET_MIX = [
    ("car", 0.44, False, 0.06),         # private cars
    ("taxi", 0.12, True, 0.18),         # kaali-peeli taxis and app cabs
    ("motorcycle", 0.28, False, 0.07),  # two-wheelers
    ("bus", 0.05, True, 0.30),          # BEST (large e-bus fleet), private & school buses
    ("truck", 0.11, True, 0.02),        # goods vehicles / tempos
]
# Relative traffic volume per camera (WEH carries the most).
CAMERA_VOLUME = {"JG-01": 1.25, "AN-01": 1.35, "VP-01": 1.35, "SC-01": 1.2,
                 "DD-01": 0.95, "SN-01": 1.05, "KR-01": 0.8, "BH-01": 0.85}
SERIES_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # HSRP series skip I and O


def _series(rng: random.Random, n: int) -> str:
    return "".join(rng.choice(SERIES_LETTERS) for _ in range(n))


def synth_plate(rng: random.Random, vehicle_class: str) -> str:
    """One plate in HSRP display format, e.g. 'MH 02 FX 1802', '24 BH 5283 G'."""
    commercial = vehicle_class in ("taxi", "bus", "truck")
    r = rng.random()
    out_of_state = 0.22 if vehicle_class == "truck" else 0.07
    if not commercial and r < 0.015:  # Bharat series (private, transferable jobs)
        return f"{rng.choice([21, 22, 23, 24, 25])} BH {rng.randint(1, 9999):04d} {_series(rng, rng.choice([1, 2]))}"
    if r < out_of_state:
        states = list(OUT_OF_STATE)
        st = rng.choices(states, weights=[OUT_OF_STATE[k][1] for k in states])[0]
        return f"{st} {rng.choice(OUT_OF_STATE[st][0]):02d} {_series(rng, 2)} {rng.randint(1, 9999):04d}"
    if r < out_of_state + 0.05:
        rto = rng.choice(OTHER_MH)
    else:
        rtos = list(MUMBAI_RTOS)
        rto = rng.choices(rtos, weights=[MUMBAI_RTOS[k] for k in rtos])[0]
    # Older kaali-peeli taxis and BEST-era buses often carry single-letter series.
    letters = 1 if commercial and rng.random() < 0.3 else 2
    return f"{rto[:2]} {rto[2:]} {_series(rng, letters)} {rng.randint(1, 9999):04d}"


def generate_fleet(n: int, codes: Sequence[str], seed: int, taken: Sequence[str] = ()) -> List[Vehicle]:
    """Deterministic synthetic fleet of `n` distinct plates spread over `codes`."""
    rng = random.Random(f"fleet:{seed}")
    seen = {normalize_plate(p) for p in taken}
    classes = [c[0] for c in FLEET_MIX]
    cls_w = [c[1] for c in FLEET_MIX]
    info = {c[0]: c for c in FLEET_MIX}
    cam_w = [CAMERA_VOLUME.get(c, 1.0) for c in codes]
    out: List[Vehicle] = []
    while len(out) < n:
        cls = rng.choices(classes, weights=cls_w)[0]
        _, _, commercial, ev_share = info[cls]
        plate = synth_plate(rng, cls)
        key = normalize_plate(plate)
        if key in seen:
            continue
        seen.add(key)
        variant = "ev" if rng.random() < ev_share else ("commercial" if commercial else "private")
        vtype = "car" if cls == "taxi" else cls
        out.append(Vehicle(plate, vtype, [rng.choices(list(codes), weights=cam_w)[0]], variant))
    return out


def load_vehicles(detections_dir: Path) -> List[Vehicle]:
    """
    One vehicle per distinct plate across all detections_<code>.json files.
    The model's vehicle class is unreliable on the clips (sedans come out as
    trucks), so it only drives the simulation (speeds, demo-plate picks) and
    never the plate colour: real plates stay white.
    """
    types: Dict[str, Counter] = defaultdict(Counter)
    sources: Dict[str, set] = defaultdict(set)
    for path in sorted(glob.glob(str(Path(detections_dir) / "detections_*.json"))):
        code = Path(path).stem.split("_", 1)[1]
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f)
        for r in rows:
            plate = (r.get("plate_text") or "").strip()
            if not plate or plate.upper() == "UNKNOWN":
                continue
            types[plate][r.get("vehicle_type") or "unknown"] += 1
            sources[plate].add(r.get("camera_code") or code)
    return [
        Vehicle(p, types[p].most_common(1)[0][0], sorted(sources[p]), plate_variant="private")
        for p in sorted(types)
    ]


def load_routes(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_cameras(path: Path) -> Dict[str, dict]:
    return {c["camera_code"]: c for c in json.loads(Path(path).read_text(encoding="utf-8"))}


def normalize_plate(p: str) -> str:
    return "".join(ch for ch in p.upper() if ch.isalnum())


# ──────────────────────────────────────────────────────────────────────
# Network
# ──────────────────────────────────────────────────────────────────────

class Network:
    def __init__(self, routes_doc: dict, cameras: Dict[str, dict]):
        self.routes: Dict[str, dict] = routes_doc["routes"]
        self.cameras = cameras
        self.codes = sorted(cameras)
        self._expand_cache: Dict[Tuple[str, str], List[str]] = {}

    def route(self, a: str, b: str) -> dict:
        return self.routes[f"{a}>{b}"]

    def expand(self, a: str, b: str, depth: int = 0) -> List[str]:
        """Camera sequence actually passed driving a→b (endpoints included)."""
        key = (a, b)
        if key in self._expand_cache:
            return self._expand_cache[key]
        vias = [v["camera_code"] for v in self.route(a, b)["via"]]
        seq = [a, b]
        if vias and depth < 4:
            plan = [a] + vias + [b]
            out = [a]
            for x, y in zip(plan, plan[1:]):
                out += self.expand(x, y, depth + 1)[1:]
            if len(set(out)) == len(out):  # no loops introduced by the split
                seq = out
        self._expand_cache[key] = seq
        return seq

    def expand_plan(self, plan: Sequence[str]) -> List[str]:
        out = [plan[0]]
        for x, y in zip(plan, plan[1:]):
            out += self.expand(x, y)[1:]
        return out

    def straight_km(self, a: str, b: str) -> float:
        ca, cb = self.cameras[a], self.cameras[b]
        return haversine_m((ca["lat"], ca["lng"]), (cb["lat"], cb["lng"])) / 1000.0


# ──────────────────────────────────────────────────────────────────────
# Simulation
# ──────────────────────────────────────────────────────────────────────

@dataclass
class Sighting:
    camera_code: str
    t: datetime
    heading: str
    speed_kmph_from_prev: Optional[float]
    distance_m_from_prev: Optional[int]


@dataclass
class Journey:
    plate_text: str
    vehicle_type: str
    sightings: List[Sighting]
    tags: List[str] = field(default_factory=list)
    plate_variant: str = "private"

    @property
    def start(self) -> datetime:
        return self.sightings[0].t

    @property
    def end(self) -> datetime:
        return self.sightings[-1].t


class Simulator:
    def __init__(self, net: Network, rng: random.Random, day: datetime):
        self.net = net
        self.rng = rng
        self.day_start = day
        self.day_end = day + timedelta(days=1) - timedelta(seconds=1)

    # ── speeds ──
    def hop_speed_kmph(self, a: str, b: str, t: datetime, vehicle_type: str, noise: bool = True) -> float:
        r = self.net.route(a, b)
        free_flow = r["distance_m"] / max(r["duration_s"], 1) * 3.6
        hour = t.hour + t.minute / 60.0
        h0 = int(hour) % 24
        h1 = (h0 + 1) % 24
        frac = hour - int(hour)
        tod = TOD_FACTOR[h0] * (1 - frac) + TOD_FACTOR[h1] * frac
        v = free_flow * tod * VEHICLE_FACTOR.get(vehicle_type, 0.95)
        if noise:
            v *= math.exp(self.rng.gauss(0.0, 0.12))
        return max(MIN_SPEED_KMPH, min(MAX_SPEED_KMPH, v))

    def heading_at(self, seq: List[str], i: int) -> str:
        if i > 0:
            return compass8(self.net.route(seq[i - 1], seq[i])["end_bearing"])
        if len(seq) > 1:
            return compass8(self.net.route(seq[0], seq[1])["start_bearing"])
        cam = self.net.cameras[seq[0]]
        return DIRECTION_TO_COMPASS.get(str(cam.get("direction", "")).lower(), "N")

    def drive(self, plate: str, vtype: str, seq: List[str], start: datetime,
              tags: Optional[List[str]] = None, noise: bool = True, variant: str = "") -> Journey:
        t = start
        out: List[Sighting] = []
        for i, code in enumerate(seq):
            if i == 0:
                out.append(Sighting(code, t, self.heading_at(seq, 0), None, None))
                continue
            prev = seq[i - 1]
            dist = self.net.route(prev, code)["distance_m"]
            speed = self.hop_speed_kmph(prev, code, t, vtype, noise)
            secs = max(60, round(dist / (speed / 3.6)))
            t = t + timedelta(seconds=secs)
            actual = dist / secs * 3.6
            out.append(Sighting(code, t, self.heading_at(seq, i), round(actual, 1), int(dist)))
        if not variant:
            variant = "commercial" if vtype in ("bus", "truck") else "private"
        return Journey(plate, vtype, out, list(tags or []), variant)

    # ── trip generation ──
    def sample_start_hour(self, vtype: str) -> float:
        r = self.rng.random()
        if vtype in ("car", "motorcycle", "unknown"):
            if r < 0.36:
                return self.rng.gauss(9.0, 1.0)
            if r < 0.70:
                return self.rng.gauss(18.4, 1.2)
            return self.rng.uniform(6.0, 23.0)
        if vtype == "truck":
            # Mumbai peak-hour no-entry for heavy goods: 07:00-11:00 and 17:00-21:00.
            if r < 0.55:
                return (21.0 + self.rng.uniform(0.0, 10.0)) % 24
            if r < 0.85:
                return self.rng.uniform(11.0, 17.0)
            return self.rng.uniform(5.0, 7.0)
        # bus: roughly uniform service day with mild peaks
        if r < 0.25:
            return self.rng.gauss(9.0, 1.2)
        if r < 0.5:
            return self.rng.gauss(18.0, 1.3)
        return self.rng.uniform(5.5, 23.0)

    def pick_partner(self, src: str, exclude: Sequence[str] = ()) -> str:
        cands = [c for c in self.net.codes if c != src and c not in exclude]
        weights = [1.0 / (max(self.net.straight_km(src, c), 1.0) ** 0.7) for c in cands]
        return self.rng.choices(cands, weights=weights, k=1)[0]

    def random_plan(self, src: str) -> List[str]:
        """Camera plan for one trip that touches `src`."""
        if self.rng.random() < 0.28:
            return [src]
        other = self.pick_partner(src)
        plan = [src, other] if self.rng.random() < 0.5 else [other, src]
        if self.rng.random() < 0.18:
            plan.append(self.pick_partner(plan[-1], exclude=plan))
        return self.net.expand_plan(plan)

    def at(self, hour: float) -> datetime:
        hour = min(max(hour, 0.0), 23.9)
        return self.day_start + timedelta(seconds=round(hour * 3600) + self.rng.randint(0, 59))

    def fits(self, j: Journey) -> bool:
        return self.day_start <= j.start and j.end <= self.day_end

    def vehicle_day(self, v: Vehicle) -> List[Journey]:
        src = self.rng.choice(v.source_cameras)
        vt = v.vehicle_type
        if vt in ("car", "motorcycle", "unknown"):
            n = self.rng.choices([1, 2, 3], weights=[0.55, 0.35, 0.10])[0]
        elif vt == "bus":
            n = self.rng.choices([1, 2, 3], weights=[0.45, 0.35, 0.20])[0]
        else:
            n = self.rng.choices([1, 2], weights=[0.8, 0.2])[0]

        journeys: List[Journey] = []
        first_plan = self.random_plan(src)
        for _ in range(5):
            j = self.drive(v.plate_text, vt, first_plan, self.at(self.sample_start_hour(vt)),
                           variant=v.plate_variant)
            if self.fits(j):
                journeys.append(j)
                break
        if not journeys:
            return []
        for k in range(1, n):
            last = journeys[-1]
            if k == 1 and vt in ("car", "motorcycle") and len(first_plan) > 1:
                plan = list(reversed(first_plan))  # commuter return trip
                plan = self.net.expand_plan([plan[0], plan[-1]]) if len(plan) == 2 else self.net.expand_plan(plan)
                dwell_h = self.rng.uniform(5.0, 10.0)
            else:
                plan = self.random_plan(self.rng.choice([last.sightings[-1].camera_code, src]))
                dwell_h = self.rng.uniform(0.5, 4.0)
            j = self.drive(v.plate_text, vt, plan, last.end + timedelta(hours=dwell_h, seconds=self.rng.randint(0, 900)),
                           variant=v.plate_variant)
            if not self.fits(j):
                break
            journeys.append(j)
        return journeys


def hhmm(day: datetime, s: str, rng: random.Random) -> datetime:
    h, m = map(int, s.split(":"))
    return day + timedelta(hours=h, minutes=m, seconds=rng.randint(0, 59))


def pick_plate(vehicles: List[Vehicle], camera: str, taken: set) -> Vehicle:
    """Deterministically pick a demo-friendly plate seen at `camera`."""
    def score(v: Vehicle):
        return (
            v.vehicle_type != "car",
            v.plate_variant != "private",
            not v.plate_text.startswith(("MH 01", "MH 02", "MH 03", "MH 47")),
            not v.plate_text.startswith("MH"),
            v.plate_text,
        )
    cands = [v for v in vehicles if camera in v.source_cameras and v.plate_text not in taken]
    # Spread the demo plates over RTOs so the cases don't all look alike.
    rtos = {t.split(" ")[0] + t.split(" ")[1] for t in taken if t.startswith("MH")}
    fresh = [v for v in cands if v.plate_text.replace(" ", "")[:4] not in rtos]
    cands = fresh or cands
    if not cands:
        cands = [v for v in vehicles if v.plate_text not in taken]
    if not cands:
        raise ValueError("not enough plates to build curated demo cases")
    return sorted(cands, key=score)[0]


def build_curated(sim: Simulator, vehicles: List[Vehicle]) -> Tuple[List[Journey], dict]:
    net, rng, day = sim.net, sim.rng, sim.day_start
    taken: set = set()
    journeys: List[Journey] = []
    watchlist = []

    for src, category, priority, reason, trips in WATCHLIST_SPECS:
        v = pick_plate(vehicles, src, taken)
        taken.add(v.plate_text)
        cams: set = set()
        for start, plan in trips:
            j = sim.drive(v.plate_text, v.vehicle_type, net.expand_plan(plan), hhmm(day, start, rng),
                          tags=["watchlist"], variant=v.plate_variant)
            journeys.append(j)
            cams.update(s.camera_code for s in j.sightings)
        watchlist.append({
            "plate_text": v.plate_text, "vehicle_type": v.vehicle_type, "plate_variant": v.plate_variant,
            "category": category,
            "priority": priority, "reason": reason, "cameras": sorted(cams),
            "sightings": sum(len(j.sightings) for j in journeys if j.plate_text == v.plate_text),
        })

    anomalies = []

    # Cloned plate: the genuine car is read at one camera while a clone with the
    # same plate is read far across the city minutes later.
    v = pick_plate(vehicles, CLONE_SOURCE, taken)
    taken.add(v.plate_text)
    genuine = sim.drive(v.plate_text, v.vehicle_type, net.expand_plan(CLONE_GENUINE_PLAN),
                        hhmm(day, "08:50", rng), tags=["anomaly:cloned_plate", "clone:genuine"],
                        variant=v.plate_variant)
    at_cp = next(s for s in genuine.sightings if s.camera_code == CLONE_AT)
    clone = sim.drive(v.plate_text, v.vehicle_type, net.expand_plan(CLONE_SUSPECT_PLAN),
                      at_cp.t + timedelta(minutes=3, seconds=rng.randint(0, 40)),
                      tags=["anomaly:cloned_plate", "clone:suspect"], variant=v.plate_variant)
    journeys += [genuine, clone]
    a, b = at_cp, clone.sightings[0]
    road_m = net.route(a.camera_code, b.camera_code)["distance_m"]
    gap_s = abs((b.t - a.t).total_seconds())
    anomalies.append({
        "kind": "cloned_plate",
        "plate_text": v.plate_text,
        "description": (f"{v.plate_text} read at {a.camera_code} and {b.camera_code} "
                        f"{int(gap_s // 60)} min apart; {road_m / 1000:.1f} km by road needs ~"
                        f"{road_m / 1000 / 30 * 60:.0f} min at city speeds"),
        "evidence": [
            {"camera_code": a.camera_code, "timestamp": a.t.isoformat()},
            {"camera_code": b.camera_code, "timestamp": b.t.isoformat()},
        ],
        "road_distance_m": road_m,
        "gap_seconds": int(gap_s),
        "implied_speed_kmph": round(road_m / max(gap_s, 1) * 3.6, 1),
    })

    # Circling: repeatedly looping the same two junctions late evening.
    v = pick_plate(vehicles, CIRCLING_SOURCE, taken)
    taken.add(v.plate_text)
    loop = CIRCLING_LOOP
    circ = sim.drive(v.plate_text, v.vehicle_type, net.expand_plan(loop), hhmm(day, "21:05", rng),
                     tags=["anomaly:circling"], variant=v.plate_variant)
    journeys.append(circ)
    visits = Counter(s.camera_code for s in circ.sightings)
    name = lambda c: net.cameras[c].get("camera_name", c)  # noqa: E731
    anomalies.append({
        "kind": "circling",
        "plate_text": v.plate_text,
        "description": (f"{v.plate_text} looped {name(loop[0])} ↔ {name(loop[1])} "
                        f"{visits[loop[0]] - 1} times in "
                        f"{int((circ.end - circ.start).total_seconds() // 60)} min with no destination"),
        "evidence": [{"camera_code": s.camera_code, "timestamp": s.t.isoformat()} for s in circ.sightings],
        "visits": dict(visits),
    })
    return journeys, {"watchlist": watchlist, "anomalies": anomalies, "taken": sorted(taken)}


def simulate(vehicles: List[Vehicle], net: Network, seed: int, day: datetime,
             max_vehicles: Optional[int] = None) -> Tuple[List[Journey], dict]:
    rng = random.Random(seed)
    sim = Simulator(net, rng, day)
    curated, meta = build_curated(sim, vehicles)
    taken = set(meta["taken"])
    pool = [v for v in vehicles if v.plate_text not in taken]
    if max_vehicles is not None and len(pool) > max_vehicles:
        pool = sorted(rng.sample(pool, max_vehicles), key=lambda v: v.plate_text)
    journeys = list(curated)
    for v in pool:
        journeys.extend(sim.vehicle_day(v))
    journeys.sort(key=lambda j: (j.start, j.plate_text))
    return journeys, meta


# ──────────────────────────────────────────────────────────────────────
# Output
# ──────────────────────────────────────────────────────────────────────

def journeys_doc(journeys: List[Journey], seed: int, day: datetime, routes_source: str) -> dict:
    per_plate: Dict[str, int] = defaultdict(int)
    out = []
    for i, j in enumerate(journeys, 1):
        out.append({
            "id": f"J{i:05d}",
            "plate_text": j.plate_text,
            "vehicle_type": j.vehicle_type,
            "trip": per_plate[j.plate_text],
            "plate_variant": j.plate_variant,
            **({"tags": j.tags} if j.tags else {}),
            "sightings": [
                [s.camera_code, s.t.isoformat(), s.heading, s.speed_kmph_from_prev, s.distance_m_from_prev]
                for s in j.sightings
            ],
        })
        per_plate[j.plate_text] += 1
    return {
        "version": 1,
        "simulated": True,
        "seed": seed,
        "date": day.date().isoformat(),
        "timezone": "+05:30",
        "routes_source": routes_source,
        "sighting_fields": SIGHTING_FIELDS,
        "journeys": out,
    }


def summarize(journeys: List[Journey], meta: dict, net: Network, seed: int, day: datetime,
              vehicles_in: int, routes_source: str, plates_from_detections: int = 0) -> dict:
    sightings = [s for j in journeys for s in j.sightings]
    speeds = sorted(s.speed_kmph_from_prev for s in sightings if s.speed_kmph_from_prev is not None)
    per_cam = Counter(s.camera_code for s in sightings)
    hourly = [0] * 24
    for s in sightings:
        hourly[s.t.hour] += 1
    distinct = [len({s.camera_code for s in j.sightings}) for j in journeys]
    plates = {j.plate_text for j in journeys}
    variants = Counter(v for v in {j.plate_text: j.plate_variant for j in journeys}.values())
    prefixes = Counter()
    for p in plates:
        prefixes["BH" if " BH " in p else (p[:5].replace(" ", "") if p.startswith("MH") else p[:2])] += 1
    total_m = sum(s.distance_m_from_prev or 0 for s in sightings)

    def pct(p: float) -> Optional[float]:
        return None if not speeds else round(speeds[min(len(speeds) - 1, int(p * len(speeds)))], 1)

    multi = Counter()
    for j in journeys:
        multi[j.plate_text] += len({s.camera_code for s in j.sightings})
    top = [p for p, _ in multi.most_common(40) if p not in set(meta["taken"])][:12]

    return {
        "version": 1,
        "simulated": True,
        "seed": seed,
        "date": day.date().isoformat(),
        "timezone": "+05:30",
        "routes_source": routes_source,
        "stats": {
            "plates_in": vehicles_in,
            "plates_from_detections": plates_from_detections,
            "vehicles": len(plates),
            "journeys": len(journeys),
            "sightings": len(sightings),
            "multi_camera_journeys": sum(1 for d in distinct if d > 1),
            "avg_cameras_per_journey": round(sum(distinct) / max(len(distinct), 1), 2),
            "avg_sightings_per_journey": round(len(sightings) / max(len(journeys), 1), 2),
            "total_distance_km": round(total_m / 1000, 1),
            "hop_speed_kmph": {"mean": round(sum(speeds) / len(speeds), 1) if speeds else None,
                               "p10": pct(0.10), "p50": pct(0.50), "p90": pct(0.90),
                               "min": speeds[0] if speeds else None, "max": speeds[-1] if speeds else None},
            "sightings_per_camera": dict(sorted(per_cam.items())),
            "plate_variants": dict(sorted(variants.items())),
            "plates_by_rto": dict(prefixes.most_common()),
            "sightings_per_hour": hourly,
        },
        "demo": {
            "watchlist": meta["watchlist"],
            "anomalies": meta["anomalies"],
            "suggested_plates": [w["plate_text"] for w in meta["watchlist"]]
                                + [a["plate_text"] for a in meta["anomalies"]] + top,
        },
    }


def supabase_rows(journeys: List[Journey], cameras: Dict[str, dict], seed: int) -> List[dict]:
    """Rows shaped like public.detections (see supabase/migrations). Never inserted here."""
    # Camera ids follow the registry order (cam-001 = first entry of camera_config.json).
    ids = {code: f"cam-{i:03d}" for i, code in enumerate(cameras, 1)}
    rng = random.Random(seed + 1)
    rows = []
    for j in journeys:
        for s in j.sightings:
            cam = cameras[s.camera_code]
            rows.append({
                "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"sim:{seed}:{j.plate_text}:{s.camera_code}:{s.t.isoformat()}")),
                "camera_id": ids.get(s.camera_code, s.camera_code),
                "plate_text_raw": j.plate_text,
                "plate_text_normalized": normalize_plate(j.plate_text),
                "confidence_score": round(rng.uniform(0.8, 0.99), 2),
                "vehicle_type": j.vehicle_type,
                "timestamp": s.t.isoformat(),
                "lat": cam["lat"],
                "lng": cam["lng"],
                "bbox": {"x": 0, "y": 0, "width": 0, "height": 0},
                "image_ref": None,
            })
    return rows


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=26127)
    ap.add_argument("--date", default="2026-09-29", help="simulated day (IST), YYYY-MM-DD")
    ap.add_argument("--plates-from", "--detections", dest="plates_from", type=Path, default=None,
                    help="seed the fleet with real ANPR reads from DIR/detections_<code>.json "
                         "(plates whose camera is not in the registry are ignored)")
    ap.add_argument("--vehicles", type=int, default=2600,
                    help="fleet size; synthetic Mumbai plates top up any real reads")
    ap.add_argument("--routes", type=Path, default=DEFAULT_ROUTES)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    ap.add_argument("--max-vehicles", type=int, default=None, help="cap on non-curated vehicles")
    ap.add_argument("--supabase-rows", type=Path, default=None,
                    help="also write detections-table rows (JSON) to this path; nothing is inserted")
    args = ap.parse_args(argv)

    day = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=IST)
    routes_doc = load_routes(args.routes)
    cameras = load_cameras(args.config)
    net = Network(routes_doc, cameras)
    real: List[Vehicle] = []
    if args.plates_from is not None:
        real = load_vehicles(args.plates_from)
        for v in real:
            v.source_cameras = [c for c in v.source_cameras if c in cameras]
        real = [v for v in real if v.source_cameras]
        if not real:
            print(f"[!] no plates for registry cameras found in {args.plates_from}")
            return 1
        print(f"Seeding {len(real)} plates from real reads in {args.plates_from}")
    synthetic = generate_fleet(max(0, args.vehicles - len(real)), list(cameras), args.seed,
                               taken=[v.plate_text for v in real])
    vehicles = real + synthetic

    journeys, meta = simulate(vehicles, net, args.seed, day, args.max_vehicles)
    source = routes_doc.get("source", "unknown")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    jdoc = journeys_doc(journeys, args.seed, day, source)
    (args.out_dir / "journeys.json").write_text(json.dumps(jdoc, separators=(",", ":"), ensure_ascii=False),
                                                encoding="utf-8")
    summary = summarize(journeys, meta, net, args.seed, day, len(vehicles), source, len(real))
    (args.out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
                                               encoding="utf-8")
    st = summary["stats"]
    print(f"Simulated {st['vehicles']} vehicles → {st['journeys']} journeys, {st['sightings']} sightings "
          f"(avg {st['avg_cameras_per_journey']} cameras/journey, routes={source})")
    print("Watchlist plates:", ", ".join(w["plate_text"] for w in meta["watchlist"]))
    for a in meta["anomalies"]:
        print(f"Anomaly [{a['kind']}]: {a['description']}")
    if args.supabase_rows:
        rows = supabase_rows(journeys, cameras, args.seed)
        args.supabase_rows.parent.mkdir(parents=True, exist_ok=True)
        args.supabase_rows.write_text(json.dumps(rows), encoding="utf-8")
        print(f"Wrote {len(rows)} Supabase-ready detection rows to {args.supabase_rows} (not inserted)")
    size_kb = os.path.getsize(args.out_dir / "journeys.json") / 1024
    print(f"journeys.json: {size_kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
