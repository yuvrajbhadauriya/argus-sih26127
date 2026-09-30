"""Tests for seed_alerts_and_watchlist.py and the legacy_local_model/*.py helpers."""

import importlib
import json
import re
import sys
import types

import pytest

from conftest import ROOT_DIR


# ── seed_alerts_and_watchlist.py ──────────────────────────────────────
@pytest.fixture
def seed(monkeypatch, fake_supabase_cls):
    mod = importlib.import_module("seed_alerts_and_watchlist")
    fake = fake_supabase_cls(select_data={
        "blacklist_entries": [{"id": "b1", "plate_text_normalized": "DL88RC5992"}],
        "detections": [{"event_id": "e1", "plate_text_normalized": "DL88RC5992"}],
    })
    monkeypatch.setattr(mod, "create_client", lambda url, key: fake)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    return mod, fake


def test_seed_creates_watchlist_and_alerts(seed):
    mod, fake = seed
    mod.main()
    assert len(fake.inserted["blacklist_entries"]) == 4
    alert = fake.inserted["alerts"][0]
    assert alert["detection_id"] == "e1" and alert["blacklist_entry_id"] == "b1"


def test_seed_without_key_does_nothing(monkeypatch):
    mod = importlib.import_module("seed_alerts_and_watchlist")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("VITE_SUPABASE_ANON_KEY", raising=False)
    monkeypatch.setattr(mod, "create_client", lambda *a: pytest.fail("must not connect"))
    mod.main()


@pytest.mark.xfail(strict=True, reason=(
    "BUG (schema drift) seed_alerts_and_watchlist.py:19-86 writes blacklist_entries."
    "plate_text_normalized/notes and alerts.detection_id/status/created_at, none of which exist "
    "in supabase/migrations; required NOT NULL columns (plate_text, reason, camera_id, "
    "camera_name, category, lat, lng) are never supplied."))
def test_seed_rows_match_schema(seed, columns_of):
    mod, fake = seed
    mod.main()
    assert set(fake.inserted["blacklist_entries"][0]) <= columns_of("blacklist_entries")
    assert set(fake.inserted["alerts"][0]) <= columns_of("alerts")


@pytest.mark.xfail(strict=True, reason=(
    "BUG seed_alerts_and_watchlist.py:63-86 — no dedupe: every run inserts new alerts for the "
    "same detections (uuid4 ids), so re-seeding multiplies alerts."))
def test_seed_is_idempotent(seed):
    mod, fake = seed
    mod.main()
    mod.main()
    ids = {a["detection_id"] for a in fake.inserted["alerts"]}
    assert len(fake.inserted["alerts"]) == len(ids)


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
    assert len(files) == 9
    for code, dets in files:
        assert dets, code
        for r in dets[:200]:
            assert r["camera_code"] == code
            assert set(r["bbox"]) == {"x", "y", "width", "height"}
            assert 0 <= r["confidence"] <= 1


@pytest.mark.xfail(strict=True, reason=(
    "BUG legacy_local_model/run_detection.py:432-476 — every committed public/detections/*.json starts with a "
    "full-frame 640x360 'bus' box (MOG2's first frame is all foreground) and confidences span "
    "only 0.76–0.98 (the heuristic formula), i.e. the shipped data came from the background-"
    "subtraction fallback, not YOLOv7. The frontend papers over this with hard-coded filters."))
def test_public_detections_have_no_full_frame_boxes():
    for code, dets in _load_public_dets():
        full = [r for r in dets if r["bbox"]["width"] >= 630 and r["bbox"]["height"] >= 350]
        assert not full, f"{code}: {len(full)} full-frame boxes"
