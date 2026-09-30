"""End-to-end: run_remote_detection -> real HTTP -> mock_model_server.

The first tests use conftest's cv2 stub (FakeVideoCapture) plus a stubbed
imencode, so they run everywhere. The last one uses real OpenCV to write and
read a tiny synthetic video, and is skipped when OpenCV isn't installed.
"""

import importlib.machinery
import json
import re
import socket
import sys

import numpy as np
import pytest
from detect import run_remote_detection as R
from detect.mock_model_server import start_server

KEY = "e2e-secret-key"
REQUIRED = {"camera_code", "tracked_vehicle_id", "plate_text", "vehicle_type", "confidence", "frame_timestamp_sec", "bbox"}


def _fake_jpeg(w, h):
    return bytes([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 0xFF, w >> 8, w & 0xFF, 0x03] + [0] * 24 + [0xFF, 0xD9])


@pytest.fixture
def stub_encode(monkeypatch):
    cv2 = sys.modules["cv2"]
    monkeypatch.setattr(cv2, "IMWRITE_JPEG_QUALITY", 1, raising=False)
    monkeypatch.setattr(cv2, "INTER_AREA", 3, raising=False)
    monkeypatch.setattr(cv2, "resize", lambda f, size, interpolation=None: np.zeros((size[1], size[0], 3), np.uint8), raising=False)
    monkeypatch.setattr(cv2, "imencode", lambda ext, f, params=None: (True, np.frombuffer(_fake_jpeg(f.shape[1], f.shape[0]), np.uint8)), raising=False)


@pytest.fixture
def mock_api(monkeypatch):
    server, _ = start_server(api_key=KEY)
    port = server.server_address[1]
    monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{port}/v1/frame")
    monkeypatch.setenv("DETECTION_API_KEY", KEY)
    monkeypatch.delenv("DETECTION_API_AUTH_HEADER", raising=False)
    monkeypatch.delenv("DETECTION_API_QUERY", raising=False)
    yield server
    server.shutdown()
    server.server_close()


def _setup_videos(tmp_path, codes=("IG-01",)):
    vids = tmp_path / "videos"
    vids.mkdir()
    cfg = []
    for c in codes:
        (vids / f"{c}.mp4").write_bytes(b"fake")
        cfg.append({"camera_code": c, "video_filename": f"{c}.mp4"})
    (tmp_path / "cams.json").write_text(json.dumps(cfg))
    return vids, tmp_path / "cams.json"


def _args(tmp_path, vids, cfg, *extra):
    return ["--videos_dir", str(vids), "--output_dir", str(tmp_path / "out"), "--config", str(cfg),
            "--cache_dir", str(tmp_path / "cache"), "--env_file", str(tmp_path / "none.env"), *extra]


def test_end_to_end_with_mock_server(tmp_path, fake_capture, stub_encode, mock_api, capsys):
    fake_capture.spec = {"fps": 10.0, "frames": 20, "shape": (720, 1280, 3), "opened": True}
    vids, cfg = _setup_videos(tmp_path, ("IG-01", "CP-01"))
    out_dir = tmp_path / "out"
    assert R.main(_args(tmp_path, vids, cfg, "--sample_interval", "0.2")) == 0
    text = (out_dir / "detections_IG-01.json").read_text()
    assert "\n" not in text and ", " not in text  # compact JSON
    dets = json.loads(text)
    # 10 sampled frames x (3 plated vehicles + 1 vehicle without a readable plate)
    assert len(dets) == 10 * 4
    for d in dets:
        assert REQUIRED <= d.keys()
        assert d["engine"] == "lpu_on_gpu" and d["model_version"] == "mock+raw35"
        assert set(d["bbox"]) == {"x", "y", "width", "height"}
        assert 0 <= d["bbox"]["x"] <= 640 and 0 <= d["bbox"]["y"] <= 360
    assert [d["frame_timestamp_sec"] for d in dets] == sorted(d["frame_timestamp_sec"] for d in dets)
    tracks = {}
    for d in dets:
        tracks.setdefault(d["tracked_vehicle_id"], set()).add(d["plate_text"])
    assert len(tracks) == 4 and all(len(p) == 1 for p in tracks.values())
    plates = sorted(p for ps in tracks.values() for p in ps)
    assert plates[-1] == "UNKNOWN" and all(re.fullmatch(r"MH \d\d [A-Z]{2} \d{4}", p) for p in plates[:3])
    # 1280x720 -> 640x360: a 154 px wide (0.12*1280, rounded) car box becomes 77 px
    assert {d["bbox"]["width"] for d in dets if d["plate_text"] != "UNKNOWN"} == {77.0}

    events = json.loads((out_dir / "events_IG-01.json").read_text())
    assert events["engine"] == "lpu_on_gpu" and len(events["events"]) == 3
    assert all(e["good_read"] and e["tracked_vehicle_id"] in tracks for e in events["events"])
    assert {e["plate_text"] for e in events["events"]} == set(plates[:3])

    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["cameras"] == ["CP-01", "IG-01"]
    assert {s["camera_code"]: s["good_reads"] for s in manifest["stats"]} == {"CP-01": 3, "IG-01": 3}
    summary = json.loads((tmp_path / "cache" / "summary.json").read_text())
    assert [s["camera_code"] for s in summary] == ["IG-01", "CP-01"]
    assert KEY not in capsys.readouterr().out
    for f in out_dir.iterdir():
        assert KEY not in f.read_text()

    # Outputs can be rebuilt from the cached raw responses without the API.
    for f in out_dir.glob("detections_*.json"):
        f.unlink()
    assert R.main(_args(tmp_path, vids, cfg, "--from_cache")) == 0
    assert json.loads((out_dir / "detections_IG-01.json").read_text()) == dets


def test_cache_is_ignored_when_the_camera_clip_changes(tmp_path):
    class Client:
        calls = 0

        def detect_video(self, data, query):
            Client.calls += 1
            return {"events": [{"plate": f"MH01AB{Client.calls:04d}"}]}

    old, new = tmp_path / "old_clip.mp4", tmp_path / "new_clip.mp4"
    old.write_bytes(b"old")
    new.write_bytes(b"new")
    cache = str(tmp_path / "video_KR-01.json")
    first = R.fetch_video_events(Client(), str(old), "q", cache)
    assert first["video"] == "old_clip.mp4"
    assert R.fetch_video_events(Client(), str(old), "q", cache) == first  # same clip: cache hit
    fresh = R.fetch_video_events(Client(), str(new), "q", cache)  # camera now plays another clip
    assert Client.calls == 2 and fresh["video"] == "new_clip.mp4"
    # A cache written before clip names were recorded is still used.
    (tmp_path / "legacy.json").write_text(json.dumps({"events": []}))
    assert R.fetch_video_events(Client(), str(new), "q", str(tmp_path / "legacy.json")) == {"events": []}


def test_weak_reads_keep_boxes_but_not_text(tmp_path, fake_capture, stub_encode, mock_api):
    fake_capture.spec = {"fps": 10.0, "frames": 4, "shape": (720, 1280, 3), "opened": True}
    vids, cfg = _setup_videos(tmp_path)
    # Mock OCR confidences are 90-92: a 95 bar makes every read "weak".
    assert R.main(_args(tmp_path, vids, cfg, "--min_good_conf", "95")) == 0
    dets = json.loads((tmp_path / "out" / "detections_IG-01.json").read_text())
    assert dets and {d["plate_text"] for d in dets} == {"UNKNOWN"}
    events = json.loads((tmp_path / "out" / "events_IG-01.json").read_text())["events"]
    assert events and not any(e["good_read"] for e in events) and all(e["plate_text"] is None for e in events)
    assert all(e["plate_read"] for e in events)  # the raw read stays in the event log


def test_format_plate_and_overlay_transform():
    assert R.format_plate("MH02FG0919") == "MH 02 FG 0919"
    assert R.format_plate("24BH5283G") == "24 BH 5283 G"
    assert R.format_plate("MH2A123") == "MH 02 A 0123"
    assert R.overlay_transform(1920, 1080) == (1 / 3, 0.0, 0.0)
    s, ox, oy = R.overlay_transform(1080, 1920)  # portrait clip is pillar-boxed in the 16:9 tile
    assert s == 360 / 1920 and ox == (640 - 1080 * s) / 2 and oy == 0
    box = R.to_overlay_box({"x": 900, "y": 900, "width": 30, "height": 9}, (1 / 3, 0, 0), pad_to=26)
    assert box["width"] == 26 and box["height"] == 26


def test_missing_config_exits_2(tmp_path, monkeypatch):
    for k in ("DETECTION_API_URL", "DETECTION_API_KEY", "ANPR_API_BASE"):
        monkeypatch.delenv(k, raising=False)
    assert R.main(["--output_dir", str(tmp_path), "--cache_dir", str(tmp_path / "c"),
                   "--env_file", str(tmp_path / "none.env")]) == 2


def test_unreachable_api_exits_2_without_fallback(tmp_path, monkeypatch, fake_capture, stub_encode):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here now
    monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{port}/v1/frame")
    monkeypatch.setenv("DETECTION_API_KEY", KEY)
    vids, cfg = _setup_videos(tmp_path)
    assert R.main(_args(tmp_path, vids, cfg, "--max_retries", "0")) == 2
    assert not (tmp_path / "out" / "detections_IG-01.json").exists()


def test_wrong_key_aborts(tmp_path, monkeypatch, fake_capture, stub_encode, mock_api, capsys):
    monkeypatch.setenv("DETECTION_API_KEY", "wrong-key")
    vids, cfg = _setup_videos(tmp_path)
    assert R.main(_args(tmp_path, vids, cfg)) == 2
    err = capsys.readouterr().err
    assert "401" in err and "wrong-key" not in err


def test_retries_through_transient_503(tmp_path, monkeypatch, fake_capture, stub_encode):
    server, _ = start_server(api_key=KEY, fail_first=2)
    try:
        monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{server.server_address[1]}/v1/frame")
        monkeypatch.setenv("DETECTION_API_KEY", KEY)
        monkeypatch.setattr(R.RemoteDetectionClient, "__init__",
                            _patched_init(R.RemoteDetectionClient.__init__), raising=True)
        fake_capture.spec = {"fps": 10.0, "frames": 2, "shape": (360, 640, 3), "opened": True}
        vids, cfg = _setup_videos(tmp_path)
        assert R.main(_args(tmp_path, vids, cfg)) == 0
    finally:
        server.shutdown()
        server.server_close()


def _patched_init(orig):
    def init(self, cfg, max_retries=3, backoff_base=0.5, opener=None, sleep=None):
        orig(self, cfg, max_retries=max_retries, backoff_base=0.0, opener=opener, sleep=lambda s: None)
    return init


_REAL_CV2 = importlib.machinery.PathFinder.find_spec("cv2")


@pytest.mark.skipif(_REAL_CV2 is None, reason="OpenCV (cv2) not installed in this venv")
def test_real_video_end_to_end(tmp_path, monkeypatch, mock_api):
    monkeypatch.delitem(sys.modules, "cv2")
    import cv2  # real OpenCV

    vids = tmp_path / "videos"
    vids.mkdir()
    path = str(vids / "synthetic.mp4")
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 10, (320, 180))
    if not writer.isOpened():
        pytest.skip("OpenCV build cannot write mp4v")
    for i in range(10):
        frame = np.full((180, 320, 3), 40, np.uint8)
        cv2.rectangle(frame, (10 + i * 5, 60), (90 + i * 5, 120), (255, 255, 255), -1)
        writer.write(frame)
    writer.release()
    (tmp_path / "cams.json").write_text(json.dumps([{"camera_code": "SY-01", "video_filename": "synthetic.mp4"}]))
    assert R.main(_args(tmp_path, vids, tmp_path / "cams.json")) == 0
    dets = json.loads((tmp_path / "out" / "detections_SY-01.json").read_text())
    assert dets and REQUIRED <= dets[0].keys()
