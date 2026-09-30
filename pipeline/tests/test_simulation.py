"""Tests for the city-network trajectory simulation (pipeline/simulation)."""

import json
import random
import sys
from datetime import datetime, timedelta

import pytest

from conftest import PIPELINE_DIR, ROOT_DIR

sys.path.insert(0, str(PIPELINE_DIR / "simulation"))

import geo  # noqa: E402
import simulate_city_network as sim  # noqa: E402
import build_road_routes as brr  # noqa: E402

ROUTES_PATH = ROOT_DIR / "public" / "sim" / "road_routes.json"
CONFIG_PATH = PIPELINE_DIR / "camera_config.json"
DAY = datetime(2026, 9, 29, tzinfo=sim.IST)


@pytest.fixture(scope="module")
def routes_doc():
    return json.loads(ROUTES_PATH.read_text())


@pytest.fixture(scope="module")
def net(routes_doc):
    return sim.Network(routes_doc, sim.load_cameras(CONFIG_PATH))


def make_vehicles(n=240, seed=3):
    rng = random.Random(seed)
    codes = sorted(sim.load_cameras(CONFIG_PATH))
    types = ["car", "car", "bus", "truck", "motorcycle"]
    out, seen = [], set()
    while len(out) < n:
        plate = f"{rng.choice(['DL', 'HR', 'UP', 'MH'])} {rng.randint(1, 99):02d} " \
                f"{chr(65 + rng.randint(0, 25))}{chr(65 + rng.randint(0, 25))} {rng.randint(1000, 9999)}"
        if plate in seen:
            continue
        seen.add(plate)
        out.append(sim.Vehicle(plate, rng.choice(types), [rng.choice(codes)]))
    return out


@pytest.fixture(scope="module")
def result(net):
    return sim.simulate(make_vehicles(), net, seed=7, day=DAY)


def hops(journeys):
    for j in journeys:
        for prev, cur in zip(j.sightings, j.sightings[1:]):
            yield j, prev, cur


# ── geo helpers ─────────────────────────────────────────────────────────

class TestGeo:
    def test_compass8(self):
        assert [geo.compass8(b) for b in (0, 44, 46, 90, 180, 225, 270, 337.6, 359)] == \
            ["N", "NE", "NE", "E", "S", "SW", "W", "N", "N"]

    def test_haversine_known_distance(self):
        # India Gate → Connaught Place is ~2.1 km as the crow flies
        d = geo.haversine_m((28.6129, 77.2295), (28.6315, 77.2167))
        assert 2000 < d < 2500

    def test_douglas_peucker_keeps_ends_and_drops_collinear(self):
        line = [(28.6, 77.2 + i * 0.001) for i in range(20)]
        simple = geo.douglas_peucker(line, 5)
        assert simple == [line[0], line[-1]]
        bent = line + [(28.61, 77.22)]
        assert len(geo.douglas_peucker(bent, 5)) == 3

    def test_locate_on_polyline(self):
        line = [(28.6, 77.2), (28.6, 77.21)]
        d, along = geo.locate_on_polyline((28.6003, 77.205), line)
        assert 30 < d < 40
        assert abs(along - geo.haversine_m(line[0], line[1]) / 2) < 5


# ── road routes ─────────────────────────────────────────────────────────

class TestRoadRoutes:
    def test_every_ordered_pair_present(self, routes_doc):
        codes = [c["code"] for c in routes_doc["cameras"]]
        assert len(codes) == 9
        assert set(routes_doc["routes"]) == {f"{a}>{b}" for a in codes for b in codes if a != b}

    def test_routes_start_and_end_at_cameras(self, routes_doc):
        cams = {c["code"]: (c["lat"], c["lng"]) for c in routes_doc["cameras"]}
        for r in routes_doc["routes"].values():
            assert geo.haversine_m(tuple(r["coordinates"][0]), cams[r["from"]]) < 5
            assert geo.haversine_m(tuple(r["coordinates"][-1]), cams[r["to"]]) < 5
            assert r["distance_m"] > 0 and r["duration_s"] > 0
            # a road route is never shorter than the straight line
            assert r["distance_m"] >= geo.haversine_m(cams[r["from"]], cams[r["to"]]) * 0.98

    def test_offline_fallback_uses_straight_lines(self, tmp_path):
        cams = brr.load_cameras(CONFIG_PATH)[:3]
        doc = brr.build_all(cams, tmp_path, offline=True, tolerance_m=10, via_radius_m=40,
                            delay_s=0, timeout_s=1)
        assert doc["source"] == "straight-line"
        assert len(doc["routes"]) == 6
        r = next(iter(doc["routes"].values()))
        assert len(r["coordinates"]) == 2 and r["source"] == "straight-line"


# ── simulation invariants ───────────────────────────────────────────────

class TestSimulation:
    def test_sightings_are_chronological_and_in_window(self, result):
        journeys, _ = result
        assert len(journeys) > 200
        for j in journeys:
            ts = [s.t for s in j.sightings]
            assert ts == sorted(ts) and len(set(ts)) == len(ts)
            assert DAY <= ts[0] and ts[-1] < DAY + timedelta(days=1)
        # a plate's separate trips never overlap, except the flagged cloned plate
        by_plate = {}
        for j in journeys:
            by_plate.setdefault(j.plate_text, []).append(j)
        for plate, js in by_plate.items():
            if any("anomaly:cloned_plate" in j.tags for j in js):
                continue
            js.sort(key=lambda j: j.start)
            for a, b in zip(js, js[1:]):
                assert a.end < b.start, plate

    def test_hop_speeds_within_city_bounds(self, result):
        n = 0
        for _, prev, cur in hops(result[0]):
            n += 1
            assert sim.MIN_SPEED_KMPH - 0.5 <= cur.speed_kmph_from_prev <= sim.MAX_SPEED_KMPH + 0.5
            dt = (cur.t - prev.t).total_seconds()
            assert cur.speed_kmph_from_prev == pytest.approx(cur.distance_m_from_prev / dt * 3.6, abs=0.1)
        assert n > 200

    def test_first_sighting_has_no_hop_values(self, result):
        for j in result[0]:
            assert j.sightings[0].speed_kmph_from_prev is None
            assert j.sightings[0].distance_m_from_prev is None

    def test_cloned_plate_is_physically_impossible(self, result, net):
        _, meta = result
        clone = next(a for a in meta["anomalies"] if a["kind"] == "cloned_plate")
        assert clone["implied_speed_kmph"] > 150
        a, b = clone["evidence"]
        assert a["camera_code"] != b["camera_code"]
        assert net.straight_km(a["camera_code"], b["camera_code"]) > 10

    def test_circling_revisits_the_same_junctions(self, result):
        journeys, meta = result
        circ = next(a for a in meta["anomalies"] if a["kind"] == "circling")
        assert max(circ["visits"].values()) >= 3 and len(circ["visits"]) <= 3
        j = next(j for j in journeys if "anomaly:circling" in j.tags)
        assert (j.end - j.start) < timedelta(hours=2)

    def test_headings_match_road_geometry(self, result, net):
        for j in result[0]:
            seq = [s.camera_code for s in j.sightings]
            for i, s in enumerate(j.sightings):
                assert s.heading in geo.COMPASS_8
                if i > 0:
                    assert s.heading == geo.compass8(net.route(seq[i - 1], seq[i])["end_bearing"])
                elif len(seq) > 1:
                    assert s.heading == geo.compass8(net.route(seq[0], seq[1])["start_bearing"])

    def test_vehicle_is_seen_at_cameras_its_route_passes(self, result, net):
        for _, prev, cur in hops(result[0]):
            assert net.route(prev.camera_code, cur.camera_code)["via"] == [], (prev.camera_code, cur.camera_code)

    def test_every_vehicle_is_seen_at_its_source_camera(self, net):
        vehicles = make_vehicles(80, seed=11)
        journeys, meta = sim.simulate(vehicles, net, seed=5, day=DAY)
        seen = {}
        for j in journeys:
            seen.setdefault(j.plate_text, set()).update(s.camera_code for s in j.sightings)
        for v in vehicles:
            if v.plate_text in meta["taken"] or v.plate_text not in seen:
                continue
            assert v.source_cameras[0] in seen[v.plate_text]

    def test_watchlist_journeys_are_long(self, result):
        journeys, meta = result
        assert 3 <= len(meta["watchlist"]) <= 5
        for w in meta["watchlist"]:
            assert len(w["cameras"]) >= 4
            assert any(len(j.sightings) >= 4 for j in journeys if j.plate_text == w["plate_text"])

    def test_deterministic_by_seed(self, net):
        vehicles = make_vehicles(60, seed=1)
        a = sim.journeys_doc(sim.simulate(vehicles, net, 42, DAY)[0], 42, DAY, "osrm")
        b = sim.journeys_doc(sim.simulate(vehicles, net, 42, DAY)[0], 42, DAY, "osrm")
        c = sim.journeys_doc(sim.simulate(vehicles, net, 43, DAY)[0], 43, DAY, "osrm")
        assert json.dumps(a) == json.dumps(b)
        assert a["journeys"] != c["journeys"]


class TestIO:
    def test_load_vehicles_reads_plates_per_camera(self, tmp_path):
        (tmp_path / "detections_AI-01.json").write_text(json.dumps([
            {"camera_code": "AI-01", "tracked_vehicle_id": "t1", "plate_text": "DL 01 AB 1234", "vehicle_type": "car"},
            {"camera_code": "AI-01", "tracked_vehicle_id": "t1", "plate_text": "DL 01 AB 1234", "vehicle_type": "car"},
            {"camera_code": "AI-01", "tracked_vehicle_id": "t2", "plate_text": "UNKNOWN", "vehicle_type": "bus"},
        ]))
        (tmp_path / "detections_CP-01.json").write_text(json.dumps([
            {"camera_code": "CP-01", "tracked_vehicle_id": "t9", "plate_text": "DL 01 AB 1234", "vehicle_type": "car"},
        ]))
        vs = sim.load_vehicles(tmp_path)
        assert [(v.plate_text, v.vehicle_type, v.source_cameras) for v in vs] == \
            [("DL 01 AB 1234", "car", ["AI-01", "CP-01"])]

    def test_main_writes_outputs_and_optional_rows(self, tmp_path, monkeypatch):
        det = tmp_path / "det"
        det.mkdir()
        rows = [{"camera_code": c, "tracked_vehicle_id": f"t{i}", "plate_text": p, "vehicle_type": "car"}
                for i, (c, p) in enumerate(
                    [(c, f"DL {i:02d} AB {1000 + i}") for i, c in enumerate(
                        ["IG-01", "CP-01", "KB-01", "LN-01", "AI-01", "NP-01", "CC-01", "DW-01", "DK-01"] * 3)])]
        for code in {r["camera_code"] for r in rows}:
            (det / f"detections_{code}.json").write_text(json.dumps([r for r in rows if r["camera_code"] == code]))
        out = tmp_path / "out"
        assert sim.main(["--detections", str(det), "--out-dir", str(out), "--seed", "9",
                         "--supabase-rows", str(tmp_path / "rows.json")]) == 0
        jd = json.loads((out / "journeys.json").read_text())
        summary = json.loads((out / "summary.json").read_text())
        assert jd["sighting_fields"] == sim.SIGHTING_FIELDS
        assert summary["stats"]["sightings"] == sum(len(j["sightings"]) for j in jd["journeys"])
        assert all(s[1].endswith("+05:30") for j in jd["journeys"] for s in j["sightings"])
        db_rows = json.loads((tmp_path / "rows.json").read_text())
        assert len(db_rows) == summary["stats"]["sightings"]
        assert {r["camera_id"] for r in db_rows} <= {f"cam-00{i}" for i in range(1, 10)}
        assert all(r["plate_text_normalized"] == r["plate_text_raw"].replace(" ", "") for r in db_rows)


@pytest.fixture(scope="module")
def doc():
    path = ROOT_DIR / "public" / "sim" / "journeys.json"
    if not path.exists():
        pytest.skip("public/sim/journeys.json not generated")
    return json.loads(path.read_text())


class TestCommittedOutput:
    """The committed public/sim/journeys.json must satisfy the same invariants."""

    def test_structure_and_bounds(self, doc, net):
        assert doc["sighting_fields"] == sim.SIGHTING_FIELDS
        for j in doc["journeys"]:
            prev = None
            for code, ts, heading, speed, dist in j["sightings"]:
                t = datetime.fromisoformat(ts)
                assert code in net.cameras and heading in geo.COMPASS_8
                if prev is None:
                    assert speed is None and dist is None
                else:
                    assert t > prev[1]
                    assert sim.MIN_SPEED_KMPH - 0.5 <= speed <= sim.MAX_SPEED_KMPH + 0.5
                    assert dist == net.route(prev[0], code)["distance_m"]
                prev = (code, t)
