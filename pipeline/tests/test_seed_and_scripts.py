"""Tests for seed_alerts_and_watchlist.py and the legacy_local_model/*.py helpers."""

import importlib
import json
import re
import sys
import types

import pytest
from conftest import ROOT_DIR
from db.fake import FakeClient

# ── seed_alerts_and_watchlist.py ──────────────────────────────────────
SIM_SUMMARY = {
    "date": "2026-09-29",
    "timezone": "+05:30",
    "demo": {
        "watchlist": [
            {"plate_text": "MH 04 RS 9598", "vehicle_type": "car", "category": "stolen", "priority": "critical",
             "reason": "Reported stolen (simulated FIR)", "cameras": ["JG-01", "AN-01"], "sightings": 2},
            {"plate_text": "MH 02 CD 1111", "category": "wanted", "cameras": ["AN-01"]},
        ],
        "anomalies": [
            {"kind": "cloned_plate", "plate_text": "MH 33 DV 8622", "description": "read 25 km apart in 3 min",
             "evidence": [{"camera_code": "JG-01", "timestamp": "2026-09-29T09:03:48+05:30"},
                          {"camera_code": "AN-01", "timestamp": "2026-09-29T09:06:52+05:30"}]},
            {"kind": "circling", "plate_text": "MH 98 CQ 5768", "description": "looped",
             "evidence": [{"camera_code": "AN-01", "timestamp": "2026-09-29T21:05:41+05:30"}]},
        ],
    },
}
JOURNEYS = {
    "sighting_fields": ["camera_code", "timestamp", "heading", "speed_kmph_from_prev", "distance_m_from_prev"],
    "journeys": [
        {"plate_text": "MH 04 RS 9598", "sightings": [["JG-01", "2026-09-29T10:00:00+05:30", "S", None, None],
                                                      ["AN-01", "2026-09-29T10:05:00+05:30", "S", 20, 2000]]},
        {"plate_text": "MH 01 ZZ 0001", "sightings": [["JG-01", "2026-09-29T10:00:00+05:30", "S", None, None]]},
    ],
}
SEED_CAMS = [
    {"id": "cam-001", "code": "JG-01", "name": "Jogeshwari", "lat": 19.1, "lng": 72.8},
    {"id": "cam-002", "code": "AN-01", "name": "Andheri", "lat": 19.2, "lng": 72.9},
]


@pytest.fixture
def seed_mod():
    return importlib.import_module("seed_alerts_and_watchlist")


@pytest.fixture
def sim_files(tmp_path):
    (tmp_path / "summary.json").write_text(json.dumps(SIM_SUMMARY))
    (tmp_path / "journeys.json").write_text(json.dumps(JOURNEYS))
    return tmp_path / "summary.json"


@pytest.fixture
def run_seed(seed_mod, sim_files, monkeypatch):
    def _run(*extra, client=None):
        client = client or FakeClient({"cameras": SEED_CAMS, "detections": [
            {"event_id": "e1", "camera_id": "cam-002", "plate_text_raw": "MH 02 CD 1111",
             "plate_text_normalized": "MH02CD1111", "tracked_vehicle_id": "trk_1", "detected_at": "2026-09-29T11:00:00+05:30"},
            {"event_id": "e2", "camera_id": "cam-002", "plate_text_raw": "MH 02 CD 1111",
             "plate_text_normalized": "MH02CD1111", "tracked_vehicle_id": "trk_1", "detected_at": "2026-09-29T11:00:01+05:30"},
        ]})
        monkeypatch.setattr(seed_mod, "get_service_client", lambda: client)
        return seed_mod.main(["--summary", str(sim_files), "--retry_base_delay", "0", *extra]), client

    return _run


def test_seed_creates_watchlist_and_alerts(run_seed):
    code, client = run_seed()
    assert code == 0
    wl = {r["plate_text_normalized"]: r for r in client.tables["blacklist_entries"]}
    assert set(wl) == {"MH04RS9598", "MH02CD1111"}
    assert wl["MH04RS9598"]["priority"] == "critical" and wl["MH04RS9598"]["notes"] == wl["MH04RS9598"]["reason"]
    alerts = client.tables["alerts"]
    kinds = sorted(a["alert_type"] for a in alerts)
    # 2 journey sightings + 1 fallback camera + 2 anomalies + 1 detection track
    assert kinds == ["circling", "cloned_plate", "watchlist", "watchlist", "watchlist", "watchlist"]
    sighting = next(a for a in alerts if a["source_key"].startswith("sim:watchlist:MH04RS9598:AN-01"))
    assert sighting["camera_id"] == "cam-002" and sighting["created_at"] == "2026-09-29T10:05:00+05:30"
    assert sighting["blacklist_entry_id"] == wl["MH04RS9598"]["id"]
    clone = next(a for a in alerts if a["alert_type"] == "cloned_plate")
    assert clone["camera_id"] == "cam-002" and clone["priority"] == "critical"
    det = next(a for a in alerts if a["source_key"].startswith("det:"))
    assert det["detection_id"] == "e1" and det["blacklist_entry_id"] == wl["MH02CD1111"]["id"]


def test_seed_batches_writes(run_seed):
    _, client = run_seed()
    assert len(client.writes("blacklist_entries")) == 1
    assert len(client.writes("alerts")) == 1
    assert client.writes("alerts")[0].kwargs == {"on_conflict": "source_key", "ignore_duplicates": True}
    assert client.writes("blacklist_entries")[0].kwargs == {"on_conflict": "plate_text_normalized"}
    # PostgREST bulk writes need uniform keys
    assert len({tuple(sorted(r)) for r in client.writes("alerts")[0].payload}) == 1


def test_seed_is_idempotent_and_keeps_acknowledgements(run_seed):
    _, client = run_seed()
    client.tables["alerts"][0]["status"] = "acknowledged"
    before = len(client.tables["alerts"])
    code, _ = run_seed(client=client)
    assert code == 0
    assert len(client.tables["alerts"]) == before
    assert len(client.tables["blacklist_entries"]) == 2
    assert client.tables["alerts"][0]["status"] == "acknowledged"


def test_seed_rows_match_schema(run_seed, columns_of):
    _, client = run_seed()
    assert set(client.writes("blacklist_entries")[0].payload[0]) <= columns_of("blacklist_entries")
    assert set(client.writes("alerts")[0].payload[0]) <= columns_of("alerts")


def test_seed_unknown_camera_exits_2(run_seed):
    client = FakeClient({"cameras": SEED_CAMS[:1]})
    with pytest.raises(SystemExit) as e:
        run_seed(client=client)
    assert e.value.code == 2
    assert client.writes("blacklist_entries") == []


def test_seed_write_failure_exits_3(run_seed, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    client = FakeClient({"cameras": SEED_CAMS}, fail=lambda q: RuntimeError("down") if q.table == "alerts" else None)
    code, _ = run_seed("--retries", "2", client=client)
    assert code == 3


def test_seed_requires_service_key(seed_mod, sim_files, monkeypatch):
    import supabase
    monkeypatch.setattr(supabase, "create_client", lambda *a: pytest.fail("must not connect"))
    monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "anon")
    with pytest.raises(SystemExit) as e:
        seed_mod.main(["--summary", str(sim_files)])
    assert e.value.code == 2


def test_seed_has_no_hardcoded_project_url():
    src = (ROOT_DIR / "pipeline" / "seed_alerts_and_watchlist.py").read_text()
    assert ".supabase.co" not in src


def test_seed_dry_run_offline(seed_mod, sim_files, monkeypatch):
    monkeypatch.setattr(seed_mod, "get_service_client", lambda: pytest.fail("must not connect"))
    assert seed_mod.main(["--summary", str(sim_files), "--dry_run"]) == 0


def test_seed_against_committed_simulation_summary(seed_mod):
    """The real public/sim/summary.json must stay seedable (schema drift guard)."""
    watchlist, anomalies, _ = seed_mod.load_demo(str(ROOT_DIR / "public" / "sim" / "summary.json"))
    assert watchlist, "demo.watchlist is empty"
    rows = seed_mod.watchlist_rows(watchlist)
    assert all(r["plate_text_normalized"] for r in rows)
    for a in anomalies:
        assert a.get("evidence") and all(e.get("camera_code") for e in a["evidence"])


# ── legacy_local_model/yolov7_offline_inference.py ───────────────────────────────
def test_offline_inference_writes_consistent_records(tmp_path):
    mod = importlib.import_module("yolov7_offline_inference")
    out = tmp_path / "sub" / "o.json"
    mod.run_offline_inference("ignored.mp4", "cam-001", str(out))
    recs = json.loads(out.read_text())
    assert len(recs) == 8
    for r in recs:
        assert re.match(r"^\d{2}:\d{2}\.\d{3}$", r["timestamp"])
        assert r["plate_text_normalized"] == r["plate_text_raw"].replace("-", "")


@pytest.mark.xfail(strict=True, raises=FileNotFoundError, reason=(
    "BUG legacy_local_model/yolov7_offline_inference.py:59 and legacy_local_model/run_yolov7_on_videos.py:147 — "
    "os.makedirs(os.path.dirname(output_path)) raises FileNotFoundError when --output is a "
    "bare filename (dirname == '')."))
def test_offline_inference_accepts_bare_output_filename(chdir_tmp):
    mod = importlib.import_module("yolov7_offline_inference")
    mod.run_offline_inference("v.mp4", "cam-001", "out.json")


def test_plate_formats_are_inconsistent_between_generators(run_detection):
    """Documented inconsistency: legacy scripts emit 'DL-01-AB-1234', the main pipeline 'DL 01 AB 1234'."""
    legacy = importlib.import_module("run_yolov7_on_videos").generate_mock_plate()
    assert re.match(r"^[A-Z]{2}-\d{2}-[A-Z]{2}-\d{4}$", legacy)
    assert " " in run_detection.get_deterministic_plate("IG-01", "trk_0001")


# ── legacy_local_model/run_yolov7_on_videos.py ───────────────────────────────────
class _Pred:
    def __init__(self, rows):
        self.pred = [rows]


class _HubModel:
    # Real YOLOv7 hub models expose `names` as a *list* of class names.
    names = ["person", "bicycle", "car"]
    conf = 0.25

    def __call__(self, frame):
        return _Pred([[0.0, 0.0, 128.0, 72.0, 0.9, 2]])


@pytest.fixture
def fake_torch(monkeypatch):
    torch = types.ModuleType("torch")
    torch.hub = types.SimpleNamespace(load=lambda *a, **k: _HubModel())
    monkeypatch.setitem(sys.modules, "torch", torch)
    return torch


def test_run_yolov7_simulation_mode(tmp_path, fake_capture):
    mod = importlib.import_module("run_yolov7_on_videos")
    v = tmp_path / "v.mp4"
    v.write_bytes(b"x")
    fake_capture.spec.update(fps=30.0, frames=60)
    out = tmp_path / "o" / "d.json"
    mod.process_video_with_custom_yolov7("missing.pt", str(v), "cam-001", str(out))
    recs = json.loads(out.read_text())
    assert len(recs) == 4  # every 15th frame of 60
    assert [r["timestamp"] for r in recs] == ["00:00.500", "00:01.000", "00:01.500", "00:02.000"]


@pytest.mark.xfail(strict=True, raises=AttributeError, reason=(
    "BUG legacy_local_model/run_yolov7_on_videos.py:92 — `class_names.get(cls_id, 'car')` assumes a dict, "
    "but YOLOv7 torch.hub models expose model.names as a list → AttributeError on the first "
    "detection with real weights."))
def test_run_yolov7_with_real_style_model_names(tmp_path, fake_capture, fake_torch):
    mod = importlib.import_module("run_yolov7_on_videos")
    v = tmp_path / "v.mp4"
    v.write_bytes(b"x")
    w = tmp_path / "best.pt"
    w.write_bytes(b"w")
    fake_capture.spec.update(fps=30.0, frames=15)
    out = tmp_path / "o" / "d.json"
    mod.process_video_with_custom_yolov7(str(w), str(v), "cam-001", str(out))
    assert json.loads(out.read_text())[0]["vehicle_type"] == "car"


# ── Committed detection data quality ─────────────────────────────────
def _load_public_dets():
    for p in sorted((ROOT_DIR / "public" / "detections").glob("detections_*.json")):
        yield p.stem.replace("detections_", ""), json.loads(p.read_text())


def test_public_detection_files_are_well_formed():
    files = list(_load_public_dets())
    manifest = ROOT_DIR / "public" / "detections" / "manifest.json"
    if manifest.exists():
        # Only cameras whose current clip has real pipeline output ship a file.
        listed = set(json.loads(manifest.read_text()).get("cameras") or [])
        assert {code for code, _ in files} == listed
    else:
        assert files
    for code, dets in files:
        assert dets, code
        for r in dets[:200]:
            assert r["camera_code"] == code
            assert set(r["bbox"]) == {"x", "y", "width", "height"}
            assert 0 <= r["confidence"] <= 1


# Guards against re-shipping the MOG2 heuristic's full-frame 640x360 boxes
# (scripts/perf/compact_detections.mjs strips them; the remote-model pipeline never emits them).
def test_public_detections_have_no_full_frame_boxes():
    for code, dets in _load_public_dets():
        full = [r for r in dets if r["bbox"]["width"] >= 630 and r["bbox"]["height"] >= 350]
        assert not full, f"{code}: {len(full)} full-frame boxes"
