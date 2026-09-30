"""Tests for the city-network trajectory simulation (pipeline/simulation)."""

import json
import random
import re
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
        plate = f"MH {rng.choice([1, 2, 3, 4, 43, 47])} " \
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
        # Dadar TT → Sion Circle is ~3.2 km as the crow flies
        d = geo.haversine_m((19.02041, 72.84968), (19.04273, 72.86349))
        assert 2800 < d < 3200

    def test_douglas_peucker_keeps_ends_and_drops_collinear(self):
        line = [(19.1, 72.85 + i * 0.001) for i in range(20)]
        simple = geo.douglas_peucker(line, 5)
        assert simple == [line[0], line[-1]]
        bent = line + [(19.11, 72.87)]
        assert len(geo.douglas_peucker(bent, 5)) == 3

    def test_locate_on_polyline(self):
        line = [(19.1, 72.85), (19.1, 72.86)]
        d, along = geo.locate_on_polyline((19.1003, 72.855), line)
        assert 30 < d < 40
        assert abs(along - geo.haversine_m(line[0], line[1]) / 2) < 5


# ── road routes ─────────────────────────────────────────────────────────

class TestRoadRoutes:
    def test_every_ordered_pair_present(self, routes_doc):
        codes = [c["code"] for c in routes_doc["cameras"]]
        assert len(codes) == 8
        assert set(routes_doc["routes"]) == {f"{a}>{b}" for a in codes for b in codes if a != b}

    def test_routes_start_and_end_at_cameras(self, routes_doc):
        cams = {c["code"]: (c["lat"], c["lng"]) for c in routes_doc["cameras"]}
        for r in routes_doc["routes"].values():
            assert geo.haversine_m(tuple(r["coordinates"][0]), cams[r["from"]]) < 5
            assert geo.haversine_m(tuple(r["coordinates"][-1]), cams[r["to"]]) < 5
            assert r["distance_m"] > 0 and r["duration_s"] > 0
            # a road route is never shorter than the straight line
            assert r["distance_m"] >= geo.haversine_m(cams[r["from"]], cams[r["to"]]) * 0.98

    def test_routes_never_detour_past_a_camera_on_the_same_road(self, routes_doc):
        # Divided-road cameras are snapped per carriageway (road_bearing), so a hop
        # between neighbours on one corridor stays close to the straight line.
        for a, b in [("JG-01", "AN-01"), ("AN-01", "JG-01"), ("AN-01", "VP-01"), ("VP-01", "AN-01"),
                     ("VP-01", "SC-01"), ("SC-01", "VP-01"), ("DD-01", "SN-01"), ("SN-01", "DD-01")]:
            r = routes_doc["routes"][f"{a}>{b}"]
            cams = {c["code"]: (c["lat"], c["lng"]) for c in routes_doc["cameras"]}
            assert r["distance_m"] < 2.2 * geo.haversine_m(cams[a], cams[b]), (a, b, r["distance_m"])

    def test_snap_bearings(self):
        assert brr.snap_bearings({"camera_code": "X"}) == [None]
        assert brr.snap_bearings({"camera_code": "X", "road_bearing": 200}) == [200, 20]

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
        (tmp_path / "detections_VP-01.json").write_text(json.dumps([
            {"camera_code": "VP-01", "tracked_vehicle_id": "t1", "plate_text": "MH 02 AB 1234", "vehicle_type": "car"},
            {"camera_code": "VP-01", "tracked_vehicle_id": "t1", "plate_text": "MH 02 AB 1234", "vehicle_type": "car"},
            {"camera_code": "VP-01", "tracked_vehicle_id": "t2", "plate_text": "UNKNOWN", "vehicle_type": "bus"},
        ]))
        (tmp_path / "detections_SC-01.json").write_text(json.dumps([
            {"camera_code": "SC-01", "tracked_vehicle_id": "t9", "plate_text": "MH 02 AB 1234", "vehicle_type": "car"},
        ]))
        vs = sim.load_vehicles(tmp_path)
        assert [(v.plate_text, v.vehicle_type, v.source_cameras, v.plate_variant) for v in vs] == \
            [("MH 02 AB 1234", "car", ["SC-01", "VP-01"], "private")]

    def test_main_synthetic_fleet_writes_outputs_and_optional_rows(self, tmp_path):
        out = tmp_path / "out"
        assert sim.main(["--out-dir", str(out), "--seed", "9", "--vehicles", "300",
                         "--supabase-rows", str(tmp_path / "rows.json")]) == 0
        summary = json.loads((out / "summary.json").read_text())
        assert summary["stats"]["plates_from_detections"] == 0
        assert summary["stats"]["vehicles"] <= 300
        assert all(p.startswith("MH") for p in summary["demo"]["suggested_plates"][:6])

    def test_main_plates_from_detections(self, tmp_path):
        det = tmp_path / "det"
        det.mkdir()
        codes = [c["camera_code"] for c in json.loads(CONFIG_PATH.read_text())]
        rows = [{"camera_code": c, "tracked_vehicle_id": f"t{i}", "plate_text": f"MH 02 AB {1000 + i}",
                 "vehicle_type": "car"} for i, c in enumerate(codes * 3)]
        # A read from a camera that is not in the registry is ignored.
        rows.append({"camera_code": "ZZ-99", "tracked_vehicle_id": "x", "plate_text": "MH 02 ZZ 9999",
                     "vehicle_type": "car"})
        for code in {r["camera_code"] for r in rows}:
            (det / f"detections_{code}.json").write_text(json.dumps([r for r in rows if r["camera_code"] == code]))
        out = tmp_path / "out"
        assert sim.main(["--plates-from", str(det), "--out-dir", str(out), "--seed", "9", "--vehicles", "200",
                         "--supabase-rows", str(tmp_path / "rows.json")]) == 0
        jd = json.loads((out / "journeys.json").read_text())
        summary = json.loads((out / "summary.json").read_text())
        assert jd["sighting_fields"] == sim.SIGHTING_FIELDS
        assert summary["stats"]["sightings"] == sum(len(j["sightings"]) for j in jd["journeys"])
        assert all(s[1].endswith("+05:30") for j in jd["journeys"] for s in j["sightings"])
        db_rows = json.loads((tmp_path / "rows.json").read_text())
        assert len(db_rows) == summary["stats"]["sightings"]
        assert {r["camera_id"] for r in db_rows} <= {f"cam-00{i}" for i in range(1, 9)}
        assert summary["stats"]["plates_from_detections"] == len(codes) * 3
        plates = {j["plate_text"] for j in jd["journeys"]}
        assert "MH 02 ZZ 9999" not in plates
        # Real reads are in the fleet (some may be curated demo plates).
        assert len({f"MH 02 AB {1000 + i}" for i in range(len(codes) * 3)} & plates) >= len(codes) * 3 - 6
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


FLEET_CODES = ["JG-01", "AN-01", "VP-01", "SC-01", "DD-01", "SN-01", "KR-01", "BH-01"]


@pytest.fixture(scope="module")
def fleet():
    return sim.generate_fleet(3000, FLEET_CODES, seed=26127)


@pytest.fixture(scope="module")
def committed_summary():
    return json.loads((ROOT_DIR / "public" / "sim" / "summary.json").read_text())


class TestMumbaiFleet:
    """generate_fleet: realistic Mumbai plates (HSRP formats, RTO mix, plate colours)."""

    STANDARD = re.compile(r"^[A-Z]{2} \d{2} [A-HJ-NP-Z]{1,2} \d{4}$")
    BHARAT = re.compile(r"^2[1-5] BH \d{4} [A-HJ-NP-Z]{1,2}$")
    CODES = FLEET_CODES

    def test_plate_formats_and_uniqueness(self, fleet):
        plates = [v.plate_text for v in fleet]
        assert len(plates) == 3000 and len({sim.normalize_plate(p) for p in plates}) == 3000
        for p in plates:
            assert self.STANDARD.match(p) or self.BHARAT.match(p), p

    def test_mostly_mumbai_region_rtos(self, fleet):
        mmr = {"MH01", "MH02", "MH03", "MH04", "MH05", "MH43", "MH46", "MH47", "MH48"}
        rto = [v.plate_text.replace(" ", "")[:4] for v in fleet]
        share = sum(r in mmr for r in rto) / len(rto)
        assert 0.80 < share < 0.95
        out_of_state = {r[:2] for r in rto if not r.startswith("MH") and not r[:2].isdigit()}
        assert {"GJ", "KA", "DL", "RJ"} <= out_of_state
        assert any(self.BHARAT.match(v.plate_text) for v in fleet)

    def test_plate_colours_follow_vehicle_class(self, fleet):
        variants = {v.plate_variant for v in fleet}
        assert variants == {"private", "commercial", "ev"}
        for v in fleet:
            if v.vehicle_type in ("truck", "bus"):
                assert v.plate_variant in ("commercial", "ev")
            if self.BHARAT.match(v.plate_text):
                assert v.plate_variant != "commercial"
        # Taxis / app cabs are cars with yellow plates.
        assert any(v.vehicle_type == "car" and v.plate_variant == "commercial" for v in fleet)
        ev = sum(v.plate_variant == "ev" for v in fleet) / len(fleet)
        assert 0.03 < ev < 0.15

    def test_deterministic_and_spread_over_cameras(self):
        a = sim.generate_fleet(200, self.CODES, seed=1)
        b = sim.generate_fleet(200, self.CODES, seed=1)
        c = sim.generate_fleet(200, self.CODES, seed=2)
        assert [v.plate_text for v in a] == [v.plate_text for v in b]
        assert [v.plate_text for v in a] != [v.plate_text for v in c]
        assert {v.source_cameras[0] for v in sim.generate_fleet(500, self.CODES, seed=3)} == set(self.CODES)

    def test_taken_plates_are_not_reused(self):
        first = sim.generate_fleet(50, self.CODES, seed=4)
        again = sim.generate_fleet(50, self.CODES, seed=4, taken=[v.plate_text for v in first])
        assert not {v.plate_text for v in first} & {v.plate_text for v in again}


class TestCommittedDemo:
    """The committed Mumbai demo cases (public/sim/summary.json)."""

    def test_watchlist_and_anomalies(self, committed_summary):
        summary = committed_summary
        wl = summary["demo"]["watchlist"]
        assert [w["category"] for w in wl] == ["stolen", "wanted", "flagged", "missing"]
        for w in wl:
            assert w["plate_text"].startswith("MH") and len(w["cameras"]) >= 5
        kinds = {a["kind"]: a for a in summary["demo"]["anomalies"]}
        assert kinds["cloned_plate"]["implied_speed_kmph"] > 150
        assert max(kinds["circling"]["visits"].values()) >= 3
        assert summary["stats"]["plates_from_detections"] == 0
