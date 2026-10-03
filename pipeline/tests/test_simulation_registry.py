"""The Mumbai camera registry must agree across frontend, pipeline, SQL and routes."""

import json
import re

import pytest

from conftest import PIPELINE_DIR, ROOT_DIR

CONFIG = json.loads((PIPELINE_DIR / "camera_config.json").read_text())
MOCK_TS = (ROOT_DIR / "src" / "mocks" / "fixtures" / "mockCameras.ts").read_text()
MIGRATIONS = ROOT_DIR / "supabase" / "migrations"
# The network seed plus the later clip swaps (video_url updates) that apply on top of it.
SQL = "\n".join((MIGRATIONS / f).read_text() for f in (
    "20261001000200_mumbai_camera_network.sql",
    "20261001000800_camera_clip_upgrade.sql",
    "20261003000100_kr01_an01_new_clips.sql",
))
CLIPS = json.loads((ROOT_DIR / "src" / "config" / "cameraClips.json").read_text())
SLUG = re.compile(r"^[a-z0-9]+_[a-z0-9-]+_(pexels|pixabay)\d+$")
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


def test_all_cameras_are_in_mumbai_and_distinct():
    assert len(CONFIG) == 8
    assert len({(c["lat"], c["lng"]) for c in CONFIG}) == len(CONFIG)
    assert len({c["camera_code"] for c in CONFIG}) == len(CONFIG)
    for c in CONFIG:
        # Mumbai city + suburban district (Colaba to Dahisar / Mulund)
        assert 18.89 < c["lat"] < 19.28 and 72.77 < c["lng"] < 72.99, c["camera_code"]
        assert c["direction"] in {"Northbound", "Southbound", "Eastbound", "Westbound"}
        assert c["zone"] in {"Island City", "Western Suburbs", "Eastern Suburbs"}


def test_every_camera_has_its_own_clip_in_both_sources():
    slugs = [c["video_slug"] for c in CONFIG]
    assert len(set(slugs)) == len(slugs), "two cameras share a clip"
    for c in CONFIG:
        slug = c["video_slug"]
        assert SLUG.match(slug), slug
        assert c["video_filename"] == f"{slug}.mp4"
        assert c["video_url"].endswith(f"/videos/mumbai/720p/{slug}.mp4")
        assert c["poster_url"].endswith(f"/videos/mumbai/720p/{slug}.jpg")
        # the dashboard names the clip in exactly one place
        assert CLIPS[c["camera_code"]] == slug
        assert slug not in MOCK_TS, "mockCameras must read the slug from src/config/cameraClips.json"
        # host = whichever Supabase project is deployed; the bucket path must match
        assert c["video_url"].split("/storage/", 1)[1] in SQL
        # The clip exists in the candidate set the network was built from.
        assert (ROOT_DIR / "pipeline" / "data" / "candidate_clips" / f"{slug}.jpg").exists() or \
            not (ROOT_DIR / "pipeline" / "data" / "candidate_clips").exists()


def test_routes_file_uses_the_same_registry():
    if not ROUTES.exists():
        pytest.skip("public/sim/road_routes.json not generated")
    doc = json.loads(ROUTES.read_text())
    by_code = {c["code"]: c for c in doc["cameras"]}
    for c in CONFIG:
        r = by_code[c["camera_code"]]
        assert (r["lat"], r["lng"]) == (c["lat"], c["lng"])
