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
CFG = ModelApiConfig(url="http://10.0.0.7:8000/detect", api_key=KEY, timeout_ms=1234)
OK_BODY = {"version": "v9", "predictions": [{"class": "car", "confidence": 0.9, "xyxy": [0, 0, 10, 10], "plate": "DL01AB1234"}]}


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


def make(opener, retries=3):
    sleeps = []
    return RemoteDetectionClient(CFG, max_retries=retries, opener=opener, sleep=sleeps.append), sleeps


def test_success_sends_key_and_normalises():
    op = Opener(_Resp(OK_BODY))
    client, sleeps = make(op)
    out = client.detect(b"\xff\xd8\xffjpeg", (640, 360), camera_code="IG-01", frame_timestamp_sec=2.0)
    assert out["model_version"] == "v9" and out["detections"][0]["plate_text"] == "DL01AB1234"
    assert "latency_ms" in out and sleeps == []
    req, timeout = op.requests[0]
    assert req.get_header("Authorization") == f"Bearer {KEY}"
    assert req.get_method() == "POST" and timeout == pytest.approx(1.234)


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
