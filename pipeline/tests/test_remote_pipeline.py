"""End-to-end: run_remote_detection -> real HTTP -> mock_model_server.

The first tests use conftest's cv2 stub (FakeVideoCapture) plus a stubbed
imencode, so they run everywhere. The last one uses real OpenCV to write and
read a tiny synthetic video, and is skipped when OpenCV isn't installed.
"""

import importlib.machinery
import json
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
    monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{port}/detect")
    monkeypatch.setenv("DETECTION_API_KEY", KEY)
    monkeypatch.delenv("DETECTION_API_AUTH_HEADER", raising=False)
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


def test_end_to_end_with_mock_server(tmp_path, fake_capture, stub_encode, mock_api, capsys):
    fake_capture.spec = {"fps": 10.0, "frames": 20, "shape": (720, 1280, 3), "opened": True}
    vids, cfg = _setup_videos(tmp_path, ("IG-01", "CP-01"))
    out_dir = tmp_path / "out"
    code = R.main([
        "--videos_dir", str(vids), "--output_dir", str(out_dir), "--config", str(cfg),
        "--sample_interval", "0.2", "--workers", "3", "--env_file", str(tmp_path / "none.env"),
    ])
    assert code == 0
    text = (out_dir / "detections_IG-01.json").read_text()
    assert "\n" not in text and ", " not in text  # compact JSON
    dets = json.loads(text)
    assert len(dets) == 10 * 3  # 10 sampled frames x 3 synthetic vehicles
    for d in dets:
        assert REQUIRED <= d.keys()
        assert d["engine"] == "yolov7-tiny-anpr" and d["model_version"] == "mock-1"
        assert 0 < d["plate_confidence"] <= 1 and d["plate_text"] != "UNKNOWN"
        assert set(d["bbox"]) == {"x", "y", "width", "height"}
        assert 0 <= d["bbox"]["x"] <= 640 and 0 <= d["bbox"]["y"] <= 360
    # Frames come back in order and the tracker keeps ids stable -> 3 tracks, one plate each.
    assert [d["frame_timestamp_sec"] for d in dets] == sorted(d["frame_timestamp_sec"] for d in dets)
    tracks = {}
    for d in dets:
        tracks.setdefault(d["tracked_vehicle_id"], set()).add(d["plate_text"])
    assert len(tracks) == 3 and all(len(p) == 1 for p in tracks.values())
    summary = json.loads((out_dir / "summary.json").read_text())
    assert [s["camera_code"] for s in summary] == ["IG-01", "CP-01"]
    assert KEY not in capsys.readouterr().out


def test_conf_threshold_filters(tmp_path, fake_capture, stub_encode, mock_api):
    fake_capture.spec = {"fps": 10.0, "frames": 4, "shape": (360, 640, 3), "opened": True}
    vids, cfg = _setup_videos(tmp_path)
    out_dir = tmp_path / "out"
    assert R.main(["--videos_dir", str(vids), "--output_dir", str(out_dir), "--config", str(cfg),
                   "--conf_threshold", "0.93", "--env_file", str(tmp_path / "none.env")]) == 0
    dets = json.loads((out_dir / "detections_IG-01.json").read_text())
    assert dets and all(d["confidence"] >= 0.93 for d in dets)


def test_missing_config_exits_2(tmp_path, monkeypatch):
    monkeypatch.delenv("DETECTION_API_URL", raising=False)
    monkeypatch.delenv("DETECTION_API_KEY", raising=False)
    assert R.main(["--output_dir", str(tmp_path), "--env_file", str(tmp_path / "none.env")]) == 2


def test_unreachable_api_exits_2_without_fallback(tmp_path, monkeypatch, fake_capture, stub_encode):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here now
    monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{port}/detect")
    monkeypatch.setenv("DETECTION_API_KEY", KEY)
    vids, cfg = _setup_videos(tmp_path)
    out_dir = tmp_path / "out"
    code = R.main(["--videos_dir", str(vids), "--output_dir", str(out_dir), "--config", str(cfg),
                   "--max_retries", "0", "--env_file", str(tmp_path / "none.env")])
    assert code == 2
    assert not (out_dir / "detections_IG-01.json").exists()


def test_wrong_key_aborts(tmp_path, monkeypatch, fake_capture, stub_encode, mock_api, capsys):
    monkeypatch.setenv("DETECTION_API_KEY", "wrong-key")
    vids, cfg = _setup_videos(tmp_path)
    code = R.main(["--videos_dir", str(vids), "--output_dir", str(tmp_path / "out"), "--config", str(cfg),
                   "--env_file", str(tmp_path / "none.env")])
    assert code == 2
    err = capsys.readouterr().err
    assert "401" in err and "wrong-key" not in err


def test_retries_through_transient_503(tmp_path, monkeypatch, fake_capture, stub_encode):
    server, _ = start_server(api_key=KEY, fail_first=2)
    try:
        monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{server.server_address[1]}/detect")
        monkeypatch.setenv("DETECTION_API_KEY", KEY)
        monkeypatch.setattr(R.RemoteDetectionClient, "__init__",
                            _patched_init(R.RemoteDetectionClient.__init__), raising=True)
        fake_capture.spec = {"fps": 10.0, "frames": 2, "shape": (360, 640, 3), "opened": True}
        vids, cfg = _setup_videos(tmp_path)
        assert R.main(["--videos_dir", str(vids), "--output_dir", str(tmp_path / "out"), "--config", str(cfg),
                       "--workers", "1", "--env_file", str(tmp_path / "none.env")]) == 0
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
    out_dir = tmp_path / "out"
    assert R.main(["--videos_dir", str(vids), "--output_dir", str(out_dir), "--config", str(tmp_path / "cams.json"),
                   "--env_file", str(tmp_path / "none.env")]) == 0
    dets = json.loads((out_dir / "detections_SY-01.json").read_text())
    assert dets and REQUIRED <= dets[0].keys()
