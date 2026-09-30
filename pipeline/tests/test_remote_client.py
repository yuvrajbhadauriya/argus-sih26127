"""RemoteDetectionClient: retries, timeouts, auth errors — with a mocked opener (no network)."""

import io
import json
import urllib.error

import pytest
from detect.adapter import ModelApiConfig
from detect.client import (
    DetectionAPIError,
    DetectionAPIRejected,
    DetectionAPIUnavailable,
    RemoteDetectionClient,
)

KEY = "super-secret-key"
CFG = ModelApiConfig(url="http://10.0.0.7:8765/v1/frame", api_key=KEY, timeout_ms=1234)
LEGACY_CFG = ModelApiConfig(url="http://10.0.0.7:8000/detect", api_key=KEY, timeout_ms=1234,
                            auth_header="Authorization", request_format="multipart", query="")
OK_BODY = {"version": "v9", "predictions": [{"class": "car", "confidence": 0.9, "xyxy": [0, 0, 10, 10], "plate": "DL01AB1234"}]}
LPU_BODY = {"image": {"width": 1920, "height": 1080}, "engine": "lpu_on_gpu", "model_version": "deim50k+raw35",
            "inference_ms": 300.0, "latency_ms": 700.0,
            "detections": [{"plate": "MH02EZ1785", "ocr_confidence": 93.4, "raw_ocr": "MH02EZ1785", "grammar_valid": True,
                            "plate_score": 0.8, "plate_box_xywh": [830, 935, 46, 12], "vehicle_class": "Car",
                            "vehicle_confidence": 0.57, "vehicle_box_xywh": [778, 809, 186, 189]}]}


class _Resp(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(json.dumps(body).encode() if not isinstance(body, bytes) else body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(code):
    return urllib.error.HTTPError("http://x", code, "err", {}, io.BytesIO(f"key={KEY}".encode()))


class Opener:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append((req, timeout))
        o = self.outcomes.pop(0)
        if isinstance(o, BaseException):
            raise o
        return o


def make(opener, retries=3, cfg=CFG):
    sleeps = []
    return RemoteDetectionClient(cfg, max_retries=retries, opener=opener, sleep=sleeps.append), sleeps


def test_success_sends_raw_jpeg_with_x_api_key():
    op = Opener(_Resp(LPU_BODY))
    client, sleeps = make(op)
    out = client.detect(b"\xff\xd8\xffjpeg", (1920, 1080), camera_code="VP-01", frame_timestamp_sec=2.0)
    assert out["engine"] == "lpu_on_gpu" and out["model_version"] == "deim50k+raw35"
    assert out["detections"][0]["plate_text"] == "MH02EZ1785" and out["detections"][0]["plate_confidence"] == 0.934
    assert "latency_ms" in out and sleeps == []
    req, timeout = op.requests[0]
    assert req.full_url == "http://10.0.0.7:8765/v1/frame?tiles=2x3&roi_top=0.33&min_conf=60"
    assert req.get_header("X-api-key") == KEY and req.get_header("Authorization") is None
    assert req.get_header("Content-type") == "image/jpeg" and req.data == b"\xff\xd8\xffjpeg"
    assert req.get_method() == "POST" and timeout == pytest.approx(1.234)


def test_query_override_and_raw_response():
    op = Opener(_Resp(LPU_BODY))
    client, _ = make(op)
    out = client.detect(b"x", (1920, 1080), query="tiles=1x1&min_conf=0", return_raw=True)
    assert op.requests[0][0].full_url.endswith("/v1/frame?tiles=1x1&min_conf=0")
    assert out["raw"] == LPU_BODY


def test_legacy_multipart_with_bearer():
    op = Opener(_Resp(OK_BODY))
    client, _ = make(op, cfg=LEGACY_CFG)
    out = client.detect(b"\xff\xd8\xffjpeg", (640, 360), camera_code="IG-01")
    assert out["model_version"] == "v9" and out["detections"][0]["plate_text"] == "DL01AB1234"
    req, _ = op.requests[0]
    assert req.full_url == "http://10.0.0.7:8000/detect"
    assert req.get_header("Authorization") == f"Bearer {KEY}"


def test_detect_video_posts_mp4_to_v1_video():
    events = {"engine": "lpu_on_gpu", "model_version": "deim50k+raw35", "inference_ms": 1.0, "latency_ms": 2.0,
              "events": [dict(LPU_BODY["detections"][0], time_sec=1.0, frame=30)]}
    op = Opener(_Resp(events))
    client, _ = make(op)
    raw = client.detect_video(b"mp4bytes", query="frame_step=1&tiles=2x3", timeout_s=99)
    req, timeout = op.requests[0]
    assert req.full_url == "http://10.0.0.7:8765/v1/video?frame_step=1&tiles=2x3" and timeout == 99
    assert req.get_header("Content-type") == "video/mp4" and req.get_header("X-api-key") == KEY
    assert raw["events"][0]["plate"] == "MH02EZ1785" and raw["latency_ms"] == 2.0 and "client_latency_ms" in raw
    client, _ = make(Opener(_Resp({"detections": []})))
    with pytest.raises(DetectionAPIError, match="no events"):
        client.detect_video(b"x")


def test_video_timeout_is_not_retried():
    client, sleeps = make(Opener(TimeoutError("timed out"), _Resp({})), retries=3)
    with pytest.raises(DetectionAPIUnavailable, match="timed out"):
        client.detect_video(b"x")
    assert sleeps == []


def test_health_json():
    client, _ = make(Opener(_Resp({"ok": True, "engine": "lpu_on_gpu", "model_loaded": True})))
    assert client.health()["engine"] == "lpu_on_gpu"
    client, _ = make(Opener(urllib.error.URLError(ConnectionRefusedError())))
    with pytest.raises(DetectionAPIUnavailable):
        client.health()


def test_retries_with_backoff_then_succeeds():
    op = Opener(urllib.error.URLError(ConnectionRefusedError()), _http_error(503), TimeoutError(), _Resp(OK_BODY))
    client, sleeps = make(op, retries=3)
    assert client.detect(b"x", (10, 10))["detections"]
    assert sleeps == [0.5, 1.0, 2.0]


def test_gives_up_loudly_without_leaking_secrets():
    op = Opener(*[TimeoutError("timed out")] * 3)
    client, sleeps = make(op, retries=2)
    with pytest.raises(DetectionAPIUnavailable) as e:
        client.detect(b"x", (10, 10))
    assert "3 attempt" in str(e.value) and "timed out" in str(e.value)
    assert KEY not in str(e.value) and "10.0.0.7" not in str(e.value)
    assert len(sleeps) == 2


def test_auth_error_is_not_retried():
    op = Opener(_http_error(401))
    client, sleeps = make(op)
    with pytest.raises(DetectionAPIRejected, match="401") as e:
        client.detect(b"x", (10, 10))
    assert KEY not in str(e.value) and sleeps == []


def test_bad_json_and_unknown_shape():
    client, _ = make(Opener(_Resp(b"<html>")))
    with pytest.raises(DetectionAPIError, match="non-JSON"):
        client.detect(b"x", (10, 10))
    client, _ = make(Opener(_Resp({"status": "ok"})))
    with pytest.raises(DetectionAPIError, match="no detection list"):
        client.detect(b"x", (10, 10))


def test_check_reachable():
    client, _ = make(Opener(_Resp({"status": "ok"})))
    assert client.check_reachable() == 200
    client, _ = make(Opener(_http_error(404)))
    assert client.check_reachable() == 404  # answered => reachable
    client, _ = make(Opener(*[urllib.error.URLError(ConnectionRefusedError())] * 2), retries=1)
    with pytest.raises(DetectionAPIUnavailable, match="connection refused"):
        client.check_reachable()
