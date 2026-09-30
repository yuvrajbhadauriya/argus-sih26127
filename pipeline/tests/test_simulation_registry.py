"""The Delhi camera registry must agree across frontend, pipeline, SQL and routes."""

import json
import re

import pytest

from conftest import PIPELINE_DIR, ROOT_DIR

CONFIG = json.loads((PIPELINE_DIR / "camera_config.json").read_text())
MOCK_TS = (ROOT_DIR / "src" / "mocks" / "fixtures" / "mockCameras.ts").read_text()
SQL = (ROOT_DIR / "supabase" / "migrations" / "20260930_delhi_camera_network.sql").read_text()
ROUTES = ROOT_DIR / "public" / "sim" / "road_routes.json"


def mock_cameras():
    out = {}
    for block in re.findall(r"\{\s*id: 'cam-\d+'.*?\n  \}", MOCK_TS, re.S):
        def get(k, block=block):
            quoted, number = re.search(rf"{k}: (?:'([^']*)'|([\d.]+)),", block).groups()
            return quoted if quoted is not None else number

        out[get("code")] = {
            "id": get("id"), "name": get("name"), "lat": float(get("lat")), "lng": float(get("lng")),
            "zone": get("zone"), "direction": get("direction"), "road": get("road"),
        }
    return out


def sql_cameras():
    out = {}
    for m in re.finditer(r"\('(cam-\d+)', '([^']+)', '([A-Z]{2}-\d{2})', ([\d.]+), ([\d.]+), '([^']+)', "
                         r"'([^']+)', '((?:[^']|'')+)', '\w+', '[^']+'\)", SQL):
        out[m.group(3)] = {"id": m.group(1), "name": m.group(2), "lat": float(m.group(4)),
                           "lng": float(m.group(5)), "zone": m.group(6), "direction": m.group(7),
                           "road": m.group(8).replace("''", "'")}
    return out


@pytest.mark.parametrize("cam", CONFIG, ids=lambda c: c["camera_code"])
def test_camera_registry_is_consistent(cam):
    code = cam["camera_code"]
    mock, sql = mock_cameras()[code], sql_cameras()[code]
    for other in (mock, sql):
        assert other["name"] == cam["camera_name"]
        assert other["lat"] == pytest.approx(cam["lat"], abs=1e-6)
        assert other["lng"] == pytest.approx(cam["lng"], abs=1e-6)
        assert other["zone"] == cam["zone"]
        assert other["direction"] == cam["direction"]
        assert other["road"] == cam["road"]
    assert mock["id"] == sql["id"]


def test_all_cameras_are_in_delhi_and_distinct():
    assert len(CONFIG) == 9
    pts = {(c["lat"], c["lng"]) for c in CONFIG}
    assert len(pts) == 9
    for c in CONFIG:
        # NCT of Delhi bounding box
        assert 28.40 < c["lat"] < 28.88 and 76.84 < c["lng"] < 77.35, c["camera_code"]
        assert c["direction"] in {"Northbound", "Southbound", "Eastbound", "Westbound"}


def test_routes_file_uses_the_same_registry():
    if not ROUTES.exists():
        pytest.skip("public/sim/road_routes.json not generated")
    doc = json.loads(ROUTES.read_text())
    by_code = {c["code"]: c for c in doc["cameras"]}
    for c in CONFIG:
        r = by_code[c["camera_code"]]
        assert (r["lat"], r["lng"]) == (c["lat"], c["lng"])
