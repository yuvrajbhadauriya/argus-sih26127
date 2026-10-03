"""pipeline/gpu_box/detect_worker.py and run_api.sh — against real local HTTP servers.

A mock PostgREST (claim / patch / heartbeat / purge over an in-memory job list) stands in for
Supabase and a mock model API for the box's /v1/frame, both on 127.0.0.1. No network, no GPU.
"""

import base64
import copy
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GPU_BOX = ROOT / "pipeline" / "gpu_box"


def _load_worker():
    spec = importlib.util.spec_from_file_location("detect_worker", GPU_BOX / "detect_worker.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["detect_worker"] = module           # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


dw = _load_worker()

JPEG = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 12     # the worker only checks the magic bytes
B64 = base64.b64encode(JPEG).decode()
CANNED = {
    "image": {"width": 1280, "height": 720}, "engine": "lpu_on_gpu", "model_version": "deim50k+raw35",
    "inference_ms": 161.5, "latency_ms": 190.2,
    "detections": [{"plate": "MH02EZ1785", "ocr_confidence": 93.4, "raw_ocr": "MH02EZ1785", "grammar_valid": True,
                    "plate_score": 0.8, "plate_box_xywh": [830, 935, 46, 12], "vehicle_class": "Car",
                    "vehicle_confidence": 0.57, "vehicle_box_xywh": [778, 809, 186, 189]}],
}
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), dw._NoRedirect)


# ── mock servers ─────────────────────────────────────────────────────────
class _Server:
    def __init__(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self, method):
                n = int(self.headers.get("Content-Length") or 0)
                outer.dispatch(self, method, self.rfile.read(n) if n else b"")

            def do_POST(self):
                self._handle("POST")

            def do_PATCH(self):
                self._handle("PATCH")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.httpd.handle_error = lambda *args: None          # a client that gave up is not a test failure
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()   # quick shutdown

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    @staticmethod
    def reply(h, status, obj=None, raw=None):
        body = raw if raw is not None else (b"" if obj is None else json.dumps(obj).encode())
        h.send_response(status)
        if status != 204:
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", str(len(body)))
        h.end_headers()
        if status != 204:
            h.wfile.write(body)


class MockSupabase(_Server):
    KEY = "test-service-role-key-0001"

    def __init__(self):
        self.jobs = {}
        self.requests = []
        self.mode = None              # None | "http503" | "drop"
        self.patch_fail = []          # statuses to answer the next PATCHes with
        self.purge_result = 0
        self._lock = threading.Lock()
        super().__init__()

    def add_job(self, frame_b64=B64, query=None):
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {"id": job_id, "status": "pending", "camera_code": "SC-01", "query": query, "width": 1280,
                             "height": 720, "frame_b64": frame_b64, "result": None, "error": None, "done_at": None}
        return job_id

    def calls(self, method, path_prefix):
        return [r for r in self.requests if r["method"] == method and r["path"].startswith(path_prefix)]

    def dispatch(self, h, method, body):
        path, _, qs = h.path.partition("?")
        payload = json.loads(body) if body else None
        auth_ok = h.headers.get("apikey") == self.KEY and h.headers.get("Authorization") == f"Bearer {self.KEY}"
        with self._lock:
            self.requests.append({"method": method, "path": path, "qs": qs, "body": payload, "auth_ok": auth_ok,
                                  "prefer": h.headers.get("Prefer"), "ctype": h.headers.get("Content-Type")})
        if self.mode == "drop":
            h.connection.shutdown(socket.SHUT_RDWR)
            return
        if self.mode == "http503":
            return self.reply(h, 503, {"message": "unavailable"})
        if not auth_ok:
            return self.reply(h, 401, {"message": "Invalid API key"})
        if path == "/rest/v1/rpc/claim_detect_jobs":
            with self._lock:
                picked = [j for j in self.jobs.values() if j["status"] == "pending"][: int(payload.get("p_limit", 1))]
                for j in picked:
                    j["status"] = "processing"
            return self.reply(h, 200, [{k: j[k] for k in ("id", "camera_code", "query", "width", "height", "frame_b64")}
                                       for j in picked])
        if path == "/rest/v1/detect_jobs" and method == "PATCH":
            if self.patch_fail:
                return self.reply(h, self.patch_fail.pop(0), {"message": "nope"})
            with self._lock:
                self.jobs[qs.removeprefix("id=eq.")].update(payload)
            return self.reply(h, 204)
        if path == "/rest/v1/rpc/detect_worker_beat":
            return self.reply(h, 204)
        if path == "/rest/v1/rpc/purge_detect_jobs":
            return self.reply(h, 200, self.purge_result)
        return self.reply(h, 404, {"message": "no such route"})


class MockModel(_Server):
    KEY = "test-anpr-api-key-0002"

    def __init__(self):
        self.requests = []
        self.status = 200
        self.delay = 0.0
        self.raw = None
        super().__init__()

    def dispatch(self, h, method, body):
        path, _, qs = h.path.partition("?")
        self.requests.append({"method": method, "path": path, "qs": qs, "key_ok": h.headers.get("X-API-Key") == self.KEY,
                              "ctype": h.headers.get("Content-Type"), "body": body})
        if self.delay:
            time.sleep(self.delay)
        if h.headers.get("X-API-Key") != self.KEY:
            return self.reply(h, 401, {"error": "bad key"})
        if self.status != 200:
            return self.reply(h, self.status, {"error": "boom"})
        return self.reply(h, 200, copy.deepcopy(CANNED), raw=self.raw)


@pytest.fixture
def sb():
    server = MockSupabase()
    yield server
    server.close()


@pytest.fixture
def model():
    server = MockModel()
    yield server
    server.close()


@pytest.fixture(autouse=True)
def _reset_logging():
    yield
    for h in list(dw.log.handlers):
        dw.log.removeHandler(h)
        h.close()


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_worker(sb, model, *, clock=None, rand=None, **over):
    fields = {"sb_url": sb.url, "sb_key": MockSupabase.KEY, "api_key": MockModel.KEY, "api_host": "127.0.0.1",
              "api_port": model.port, "model_timeout_s": 3.0, "sb_timeout_s": 3.0, **over}
    kwargs = {"sb_opener": NO_PROXY_OPENER, "model_opener": NO_PROXY_OPENER, "sleep": lambda s: None}
    if clock is not None:
        kwargs["clock"] = clock
    if rand is not None:
        kwargs["rand"] = rand
    return dw.Worker(dw.Config(**fields), **kwargs)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ── the happy path and the model failing ─────────────────────────────────
def test_claims_a_job_calls_the_model_and_stores_the_raw_answer(sb, model):
    job_id = sb.add_job()
    w = make_worker(sb, model)
    assert w.step() == 0.0                      # a job ran: ask for the next one at once

    assert len(model.requests) == 1
    req = model.requests[0]
    assert (req["method"], req["path"], req["qs"]) == ("POST", "/v1/frame", dw.DEFAULT_QUERY)
    assert req["key_ok"] and req["ctype"] == "image/jpeg" and req["body"] == JPEG

    claim = sb.calls("POST", "/rest/v1/rpc/claim_detect_jobs")[0]
    assert claim["body"] == {"p_limit": 1} and claim["ctype"] == "application/json"
    (patch,) = sb.calls("PATCH", "/rest/v1/detect_jobs")
    assert patch["qs"] == f"id=eq.{job_id}" and patch["prefer"] == "return=minimal"
    assert set(patch["body"]) == {"status", "result", "frame_b64", "done_at"}
    assert patch["body"]["status"] == "done" and patch["body"]["frame_b64"] is None
    assert patch["body"]["result"] == CANNED
    done_at = datetime.fromisoformat(patch["body"]["done_at"].replace("Z", "+00:00"))
    assert abs((datetime.now(timezone.utc) - done_at).total_seconds()) < 60
    assert sb.jobs[job_id]["status"] == "done" and sb.jobs[job_id]["frame_b64"] is None
    assert all(r["auth_ok"] for r in sb.requests)


def test_model_http_error_becomes_an_error_row(sb, model):
    model.status = 500
    job_id = sb.add_job()
    w = make_worker(sb, model)
    w.step()
    row = sb.jobs[job_id]
    assert (row["status"], row["error"], row["frame_b64"], row["result"]) == (
        "error", "Detection model API returned HTTP 500", None, None)
    (patch,) = sb.calls("PATCH", "/rest/v1/detect_jobs")
    assert set(patch["body"]) == {"status", "error", "frame_b64", "done_at"}
    assert w.step() == w.cfg.poll_active_s       # and it keeps going


def test_model_api_down_becomes_an_error_row(sb, model, tmp_path):
    log_file = tmp_path / "worker.log"
    dw.setup_logging(str(log_file))
    job_id = sb.add_job()
    w = make_worker(sb, model, api_port=free_port())
    w.step()
    row = sb.jobs[job_id]
    assert (row["status"], row["error"]) == ("error", "Detection model API is unreachable")
    for secret in ("127.0.0.1", MockModel.KEY, "http", "Error"):
        assert secret not in row["error"]                  # the stored text stays generic...
    for h in dw.log.handlers:
        h.flush()
    assert "[ConnectionRefusedError]" in log_file.read_text(encoding="utf-8")     # ...the log says why


def test_model_timeout_becomes_an_error_row(sb, model):
    model.delay = 1.0
    job_id = sb.add_job()
    w = make_worker(sb, model, model_timeout_s=0.3)
    w.step()
    assert (sb.jobs[job_id]["status"], sb.jobs[job_id]["error"]) == ("error", "Detection model API timed out")


@pytest.mark.parametrize("raw", [b"<html>nope</html>", b"[1, 2]", b'{"detections": [NaN]}', b""])
def test_model_answer_that_is_not_json_becomes_an_error_row(sb, model, raw):
    model.raw = raw
    job_id = sb.add_job()
    make_worker(sb, model).step()
    assert (sb.jobs[job_id]["status"], sb.jobs[job_id]["error"]) == (
        "error", "Detection model API returned an invalid response")


def test_a_rejected_key_is_reported_without_naming_it(sb, model):
    job_id = sb.add_job()
    make_worker(sb, model, api_key="the-wrong-key").step()
    row = sb.jobs[job_id]
    assert row["error"] == "Detection model API returned HTTP 401"
    assert "the-wrong-key" not in row["error"]


# ── frames that must never reach the GPU ─────────────────────────────────
JUST_OVER = base64.b64encode(b"\xff\xd8\xff" + b"\0" * (dw.MAX_FRAME_BYTES - 2)).decode()     # 4 MiB + 1 byte
WAY_OVER = base64.b64encode(b"\xff\xd8\xff" + b"\0" * (dw.MAX_FRAME_BYTES + 100)).decode()


@pytest.mark.parametrize("frame", [
    None, "", "@@@@ not base64 @@@@", "abc",
    base64.b64encode(b"GIF89a" + b"\0" * 50).decode(),          # not a JPEG
    base64.b64encode(b"\xff\xd8").decode(),                     # truncated magic bytes
    base64.b64encode(b"\xff\xd8\xff" + JPEG).decode() + "\n",    # whitespace is not base64
    JUST_OVER, WAY_OVER,
], ids=["none", "empty", "garbage", "short", "gif", "truncated-magic", "newline", "just-over-4mb", "way-over-4mb"])
def test_unusable_frames_never_reach_the_gpu(sb, model, frame):
    job_id = sb.add_job(frame_b64=frame)
    w = make_worker(sb, model)
    w.step()
    row = sb.jobs[job_id]
    assert (row["status"], row["error"], row["frame_b64"]) == ("error", "invalid frame", None)
    assert model.requests == []


def test_a_frame_of_exactly_the_maximum_size_is_accepted():
    exact = b"\xff\xd8\xff" + b"\0" * (dw.MAX_FRAME_BYTES - 3)
    assert dw.decode_frame(base64.b64encode(exact).decode()) == exact
    assert dw.decode_frame(JUST_OVER) is None


def test_job_with_an_unusable_id_is_skipped(sb, model):
    w = make_worker(sb, model)
    assert w.process({"id": "../../rest/v1/other?select=*", "frame_b64": B64}) == "skipped"
    assert sb.calls("PATCH", "") == [] and model.requests == []


def test_the_model_address_never_comes_from_the_job(sb, model):
    w = make_worker(sb, model)
    job = {"id": str(uuid.uuid4()), "frame_b64": B64, "url": "http://127.0.0.1:1/steal", "api_host": "evil.example",
           "api_url": "http://evil.example/v1/frame", "api_key": "chosen-by-the-job"}
    sb.jobs[job["id"]] = {"status": "processing", "frame_b64": B64}
    assert w.process(job) == "done"
    assert len(model.requests) == 1 and model.requests[0]["key_ok"]


# ── which query a job may ask for ────────────────────────────────────────
@pytest.mark.parametrize("given,expected", [
    ("tiles=2x3&roi_top=0.33&min_conf=60", "tiles=2x3&roi_top=0.33&min_conf=60"),
    ("tiles=3x3&roi_top=0.2&min_conf=50", "tiles=3x3&roi_top=0.2&min_conf=50"),
    ("tiles=2x2", "tiles=2x2"), ("min_conf=0", "min_conf=0"), ("min_conf=100", "min_conf=100"),
    ("roi_top=0", "roi_top=0"), ("roi_top=0.9", "roi_top=0.9"), ("tiles=8x8", "tiles=8x8"),
    ("?tiles=2x3", "tiles=2x3"), (" tiles=1x1 ", "tiles=1x1"),
])
def test_whitelisted_queries_pass_through(given, expected):
    assert dw.sanitise_query(given) == expected


@pytest.mark.parametrize("given", [
    None, 5, "", "   ", "?", "tiles", "tiles=", "tiles=2x", "tiles=x3", "tiles=2x3&", "&tiles=2x3", "tiles=2x3&&min_conf=60",
    "tiles=0x3", "tiles=2x0", "tiles=9x2", "tiles=100x2", "tiles=2×3", "tiles=٢x٣",
    "roi_top=0.95", "roi_top=1", "roi_top=-0.1", "roi_top=1e-1", "roi_top=.5", "roi_top=abc", "roi_top=nan", "roi_top=0.12345",
    "min_conf=101", "min_conf=-1", "min_conf=1e2", "min_conf=60.5", "min_conf=٦٠", "min_conf=",
    "tiles=2x3&tiles=3x3", "tiles=2x3&evil=1", "evil=1", "tiles=2x3;min_conf=1", "tiles=2x3&url=http://x",
    "tiles=2x3%26evil=1", "frame_step=2", "TILES=2x3",
])
def test_anything_else_is_not_whitelisted(given):
    assert dw.sanitise_query(given) is None


@pytest.mark.parametrize("asked,sent", [
    (None, dw.DEFAULT_QUERY),
    ("tiles=3x3&roi_top=0.2&min_conf=50", "tiles=3x3&roi_top=0.2&min_conf=50"),
    ("tiles=2x3&evil=1", dw.DEFAULT_QUERY),
    ("tiles=2x3&roi_top=0.95&min_conf=60", dw.DEFAULT_QUERY),
    ("tiles=2x3&min_conf=60&url=http://evil.example", dw.DEFAULT_QUERY),
])
def test_the_model_gets_the_whitelisted_query_or_the_default(sb, model, asked, sent):
    sb.add_job(query=asked)
    make_worker(sb, model).step()
    assert [r["qs"] for r in model.requests] == [sent]


def test_a_bad_job_query_falls_back_to_the_configured_default(sb, model):
    sb.add_job(query="tiles=2x3&evil=1")
    make_worker(sb, model, frame_query="tiles=1x1&min_conf=70").step()
    assert [r["qs"] for r in model.requests] == ["tiles=1x1&min_conf=70"]


def test_the_default_query_matches_the_api_adapter():
    adapter = (ROOT / "api" / "_lib" / "modelAdapter.ts").read_text(encoding="utf-8")
    assert re.search(r"DEFAULT_QUERY = '([^']+)'", adapter).group(1) == dw.DEFAULT_QUERY


# ── heartbeat, purge, cadence, outages ───────────────────────────────────
def test_heartbeat_and_purge_are_sent_on_schedule(sb, model):
    clock = FakeClock()
    w = make_worker(sb, model, clock=clock)
    beats = lambda: [r["body"] for r in sb.calls("POST", "/rest/v1/rpc/detect_worker_beat")]
    purges = lambda: [r["body"] for r in sb.calls("POST", "/rest/v1/rpc/purge_detect_jobs")]

    w.step()                                     # first pass: one of each straight away
    assert beats() == [{"p_id": "gpu-primary", "p_version": dw.VERSION, "p_jobs_done": 0}]
    assert purges() == [{}]
    clock.t += 9.9
    w.step()
    assert (len(beats()), len(purges())) == (1, 1)
    sb.add_job()
    clock.t += 0.2                               # 10.1 s: the heartbeat is due, the purge is not
    w.step()
    assert (len(beats()), len(purges())) == (2, 1)
    clock.t += 10.1                              # the job has been counted by now
    w.step()
    assert beats()[-1]["p_jobs_done"] == 1
    clock.t += 40.0                              # 60.3 s since the start: purge again
    w.step()
    assert len(purges()) == 2 and all(r["auth_ok"] for r in sb.requests)


def test_a_failing_heartbeat_does_not_stop_the_jobs(sb, model):
    sb.add_job()
    w = make_worker(sb, model)
    original = w.heartbeat

    def broken():
        raise dw.SupabaseError(status=500)

    w.heartbeat = broken
    assert w.step() == 0.0 and len(model.requests) == 1
    w.heartbeat = original


def test_poll_cadence_is_fast_after_a_job_and_slow_when_idle(sb, model):
    clock = FakeClock()
    w = make_worker(sb, model, clock=clock)
    assert w.step() == w.cfg.poll_idle_s == 1.0
    sb.add_job()
    assert w.step() == 0.0                       # ran a job: ask again at once
    assert w.step() == w.cfg.poll_active_s == 0.12
    clock.t += 19.9
    assert w.step() == 0.12
    clock.t += 0.2
    assert w.step() == 1.0


def test_supabase_outage_backs_off_without_crashing(sb, model):
    clock = FakeClock()
    sb.mode = "http503"
    w = make_worker(sb, model, clock=clock, rand=lambda: 0.5)         # jitter factor 1.0 -> the nominal delays
    assert [w.step() for _ in range(8)] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]
    sb.mode = "drop"                                                  # a dropped connection is survived too
    assert [w.step() for _ in range(2)] == [30.0, 30.0]
    sb.mode = None
    job_id = sb.add_job()
    assert w.step() == 0.0                                            # recovered: the queued job ran
    assert sb.jobs[job_id]["status"] == "done"
    assert w.step() == w.cfg.poll_active_s                            # and the failure count is back to zero
    sb.mode = "http503"
    assert w.step() == 1.0


def test_backoff_delay_is_jittered_and_capped():
    assert [dw.backoff_delay(n, 1.0, 30.0, rand=lambda: 0.5) for n in (1, 2, 3, 4, 5, 6, 7)] == [1, 2, 4, 8, 16, 30, 30]
    assert dw.backoff_delay(3, 1.0, 30.0, rand=lambda: 0.0) == 3.0           # -25 %
    assert dw.backoff_delay(3, 1.0, 30.0, rand=lambda: 1.0) == 5.0           # +25 %
    assert dw.backoff_delay(6, 1.0, 30.0, rand=lambda: 1.0) == 30.0          # never above the cap
    assert dw.backoff_delay(5000, 1.0, 30.0) <= 30.0                         # a very long outage cannot overflow


def test_finish_retries_a_transient_failure(sb, model):
    sb.patch_fail = [503]
    job_id = sb.add_job()
    w = make_worker(sb, model)
    assert w.step() == 0.0
    assert len(sb.calls("PATCH", "/rest/v1/detect_jobs")) == 2
    assert sb.jobs[job_id]["status"] == "done"


def test_finish_does_not_retry_a_rejected_write(sb, model):
    sb.patch_fail = [400, 400, 400]
    sb.add_job()
    w = make_worker(sb, model, rand=lambda: 0.5)
    assert w.step() == 1.0                                           # backs off; the viewer's request times out
    assert len(sb.calls("PATCH", "/rest/v1/detect_jobs")) == 1


# ── secrets ──────────────────────────────────────────────────────────────
def test_logs_never_contain_secrets_frames_or_plates(sb, model, tmp_path):
    log_file = tmp_path / "worker.log"
    dw.setup_logging(str(log_file))
    clock = FakeClock()
    w = make_worker(sb, model, clock=clock)
    ids = [sb.add_job(), sb.add_job(frame_b64="@@@@ not base64 @@@@"), sb.add_job(query="tiles=2x3&evil=1")]
    for _ in range(4):
        w.step()
    model.status = 500
    ids.append(sb.add_job())
    w.step()
    model.status = 200
    sb.mode = "http503"
    clock.t += 100
    w.step()
    sb.mode = None
    clock.t += 100
    w.step()
    for h in dw.log.handlers:
        h.flush()

    text = log_file.read_text(encoding="utf-8")
    assert all(job_id[:8] in text for job_id in ids)                # it does log what it did
    assert "invalid frame" in text and "HTTP 500" in text and "failed" in text
    forbidden = [MockSupabase.KEY, MockModel.KEY, B64, B64[:40], JPEG.hex()[:32], "MH02EZ1785", "127.0.0.1",
                 str(model.port), "http://", "https://", "Bearer", "apikey"]
    for secret in forbidden:
        assert secret not in text


# ── run-once, main, run_forever ──────────────────────────────────────────
def test_run_once_drains_the_queue_and_returns(sb, model):
    ids = [sb.add_job() for _ in range(3)]
    w = make_worker(sb, model)
    assert w.run_once() == 3
    assert all(sb.jobs[i]["status"] == "done" for i in ids) and len(model.requests) == 3
    assert len(sb.calls("POST", "/rest/v1/rpc/claim_detect_jobs")) == 4        # three jobs, then the empty claim
    assert len(sb.calls("POST", "/rest/v1/rpc/detect_worker_beat")) == 1
    assert w.run_once() == 0


def _env_file(tmp_path, sb, model, extra=""):
    env = tmp_path / ".env"
    env.write_text(f"SUPABASE_URL={sb.url}\nSUPABASE_SERVICE_ROLE_KEY={MockSupabase.KEY}\nANPR_API_KEY={MockModel.KEY}\n"
                   f"ANPR_API_HOST=127.0.0.1\nANPR_API_PORT={model.port}\n{extra}", encoding="utf-8")
    return env


def test_main_once_exits_zero_when_the_queue_is_empty(sb, model, tmp_path, monkeypatch, capsys):
    for var in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    sigint, sigterm = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
    env = _env_file(tmp_path, sb, model)
    ids = [sb.add_job(), sb.add_job()]
    rc = dw.main(["--once", "--env", str(env), "--log", str(tmp_path / "w.log")])
    assert rc == 0 and all(sb.jobs[i]["status"] == "done" for i in ids)
    assert dw.main(["--once", "--env", str(env), "--log", str(tmp_path / "w.log")]) == 0      # nothing left: still exits 0
    assert signal.getsignal(signal.SIGINT) is sigint and signal.getsignal(signal.SIGTERM) is sigterm   # restored
    out = capsys.readouterr()
    for secret in (MockSupabase.KEY, MockModel.KEY):
        assert secret not in out.out + out.err


def test_main_once_reports_a_supabase_failure(sb, model, tmp_path, monkeypatch, capsys):
    for var in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    sb.mode = "http503"
    rc = dw.main(["--once", "--env", str(_env_file(tmp_path, sb, model)), "--log", str(tmp_path / "w.log")])
    err = capsys.readouterr().err
    assert rc == 1 and "HTTP 503" in err and MockSupabase.KEY not in err


def test_main_refuses_to_start_without_settings(tmp_path, capsys):
    env = tmp_path / ".env"
    env.write_text("SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=service-secret-xyz\n", encoding="utf-8")
    rc = dw.main(["--env", str(env), "--log", str(tmp_path / "w.log")])
    out = capsys.readouterr()
    assert rc == 2 and "ANPR_API_KEY" in out.err
    assert "service-secret-xyz" not in out.out + out.err
    assert dw.main(["--env", str(tmp_path / "missing.env"), "--log", str(tmp_path / "w.log")]) == 2


def test_run_forever_stops_when_asked(sb, model):
    w = make_worker(sb, model, poll_idle_s=0.02, poll_active_s=0.01)
    thread = threading.Thread(target=w.run_forever, daemon=True)
    thread.start()
    job_id = sb.add_job()
    deadline = time.time() + 5
    while sb.jobs[job_id]["status"] != "done" and time.time() < deadline:
        time.sleep(0.02)
    assert sb.jobs[job_id]["status"] == "done"
    w.stop()
    thread.join(timeout=3)
    assert not thread.is_alive()


def test_the_script_finishes_the_job_in_flight_and_exits_cleanly_on_sigterm(sb, model, tmp_path):
    model.delay = 0.8
    job_id = sb.add_job()
    env_file = _env_file(tmp_path, sb, model)
    env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    env["no_proxy"] = env["NO_PROXY"] = "127.0.0.1,localhost"
    log_file = tmp_path / "w.log"
    proc = subprocess.Popen([sys.executable, str(GPU_BOX / "detect_worker.py"), "--env", str(env_file), "--log", str(log_file)],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.time() + 10
        while not model.requests and time.time() < deadline:                # the frame is now with the "GPU"
            time.sleep(0.02)
        assert len(model.requests) == 1 and sb.jobs[job_id]["status"] == "processing"
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=15)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 0
    assert sb.jobs[job_id]["status"] == "done"                               # the in-flight job was finished first
    assert MockSupabase.KEY not in out + err and MockModel.KEY not in out + err
    text = log_file.read_text(encoding="utf-8")
    assert "worker gpu-primary started" in text and "worker stopped" in text
    assert len(sb.calls("POST", "/rest/v1/rpc/detect_worker_beat")) >= 1


# ── config ───────────────────────────────────────────────────────────────
BASE_ENV = {"SUPABASE_URL": "https://abc.supabase.co/", "SUPABASE_SERVICE_ROLE_KEY": "svc", "ANPR_API_KEY": "api"}


def test_config_defaults_and_overrides():
    cfg = dw.Config.from_env(BASE_ENV)
    assert (cfg.sb_url, cfg.api_host, cfg.api_port, cfg.frame_query, cfg.worker_id) == (
        "https://abc.supabase.co", "100.64.0.1", 8765, dw.DEFAULT_QUERY, "gpu-primary")
    assert cfg.model_url == "http://100.64.0.1:8765/v1/frame"
    custom = dw.Config.from_env({**BASE_ENV, "ANPR_API_HOST": "10.1.2.3", "ANPR_API_PORT": "9000",
                                 "ANPR_FRAME_QUERY": "tiles=3x3&min_conf=70", "WORKER_ID": "box2"})
    assert (custom.model_url, custom.frame_query, custom.worker_id) == (
        "http://10.1.2.3:9000/v1/frame", "tiles=3x3&min_conf=70", "box2")


def test_config_names_what_is_missing_but_never_a_value():
    with pytest.raises(dw.ConfigError) as err:
        dw.Config.from_env({"SUPABASE_URL": "https://abc.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "secret-value"})
    assert "ANPR_API_KEY" in str(err.value) and "secret-value" not in str(err.value)
    with pytest.raises(dw.ConfigError) as err:
        dw.Config.from_env({})
    assert all(name in str(err.value) for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANPR_API_KEY"))


@pytest.mark.parametrize("patch", [
    {"SUPABASE_URL": "http://abc.supabase.co"},              # the service key must not travel in clear
    {"SUPABASE_URL": "ftp://abc.supabase.co"}, {"SUPABASE_URL": "not a url"},
    {"ANPR_API_PORT": "eighty"}, {"ANPR_API_PORT": "0"}, {"ANPR_API_PORT": "70000"},
    {"ANPR_API_HOST": "host/with/path"}, {"ANPR_API_HOST": "a b"},
    {"ANPR_FRAME_QUERY": "tiles=2x3&evil=1"},
])
def test_config_rejects_unusable_settings(patch):
    with pytest.raises(dw.ConfigError):
        dw.Config.from_env({**BASE_ENV, **patch})


def test_config_allows_plain_http_only_on_loopback():
    for url in ("http://127.0.0.1:54321", "http://localhost:54321"):
        assert dw.Config.from_env({**BASE_ENV, "SUPABASE_URL": url}).sb_url == url


# ── run_api.sh ───────────────────────────────────────────────────────────
BASH = shutil.which("bash")


def _release(tmp_path, *, worker_file=True, worker_fails=False):
    """A stand-in release folder: the real run_api.sh, a fake venv python that idles, instant sleeps."""
    rel = tmp_path / "release"
    (rel / "venv" / "bin").mkdir(parents=True)
    shutil.copy(GPU_BOX / "run_api.sh", rel / "run_api.sh")
    (rel / ".env").write_text("ANPR_API_KEY=x\n")
    (rel / "watchdog.py").write_text("# stand-in\n")
    if worker_file:
        (rel / "detect_worker.py").write_text("# stand-in\n")
    fail = 'case "$1" in detect_worker.py) echo "detect_worker: missing in .env" >&2; exit 2;; esac\n' if worker_fails else ""
    py = rel / "venv" / "bin" / "python"
    py.write_text(f'#!/bin/sh\nif [ "$1" = "-c" ]; then exec "$REAL_PY" "$@"; fi\n{fail}exec /bin/sleep 300\n')
    py.chmod(0o755)
    shim = tmp_path / "bin"
    shim.mkdir()
    # run_api.sh waits 2 s after starting the worker: give the stand-in a full second to exit (CI boxes can be busy)
    (shim / "sleep").write_text('#!/bin/sh\ncase "$1" in 2) exec /bin/sleep 1;; *) exec /bin/sleep 0.05;; esac\n')
    (shim / "sleep").chmod(0o755)
    return rel, {**os.environ, "PATH": f"{shim}:{os.environ['PATH']}", "REAL_PY": sys.executable}


def _run(rel, env, *args):
    p = subprocess.run([BASH, "run_api.sh", *args], cwd=rel, env=env, capture_output=True, text=True, timeout=60, check=False)
    return p.returncode, p.stdout


def _pid(rel, name):
    return int((rel / name).read_text())


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill_and_wait(pid):
    os.kill(pid, signal.SIGKILL)
    for _ in range(100):
        if not _alive(pid):
            return
        time.sleep(0.02)
    raise AssertionError("process did not die")


def _cleanup(rel):
    for name in ("worker.pid", "watchdog.pid"):
        try:
            os.kill(_pid(rel, name), signal.SIGKILL)
        except (OSError, ValueError):
            pass


@pytest.mark.skipif(BASH is None, reason="bash is not available")
def test_run_api_manages_the_worker_next_to_the_watchdog(tmp_path):
    rel, env = _release(tmp_path)
    try:
        rc, out = _run(rel, env, "status")
        assert rc == 0 and "watchdog not running" in out and "api not running" in out and "worker not running" in out

        rc, out = _run(rel, env, "start")
        assert rc == 0 and "watchdog started" in out and "worker started" in out
        wd, wk = _pid(rel, "watchdog.pid"), _pid(rel, "worker.pid")
        assert _alive(wd) and _alive(wk)
        rc, out = _run(rel, env, "start")
        assert rc == 0 and "watchdog already running" in out and "worker already running" in out

        rc, out = _run(rel, env, "ensure")                       # everything is up: silent, nothing disturbed
        assert (rc, out) == (0, "") and (_pid(rel, "watchdog.pid"), _pid(rel, "worker.pid")) == (wd, wk)

        _kill_and_wait(wk)                                       # a dead worker is restarted on its own...
        rc, out = _run(rel, env, "ensure")
        assert rc == 0 and "worker started" in out and "watchdog" not in out
        wk2 = _pid(rel, "worker.pid")
        assert wk2 != wk and _alive(wk2) and _pid(rel, "watchdog.pid") == wd and _alive(wd)      # ...the watchdog untouched

        _kill_and_wait(wd)                                       # and the other way round
        rc, out = _run(rel, env, "ensure")
        assert rc == 0 and "watchdog started" in out and "worker" not in out
        assert _pid(rel, "worker.pid") == wk2 and _alive(wk2) and _pid(rel, "watchdog.pid") != wd

        rc, out = _run(rel, env, "status")
        assert "watchdog running" in out and "worker running" in out

        wd3, wk3 = _pid(rel, "watchdog.pid"), _pid(rel, "worker.pid")
        rc, out = _run(rel, env, "stop")
        assert rc == 0 and "stopped" in out
        assert not _alive(wd3) and not _alive(wk3)
        assert not (rel / "watchdog.pid").exists() and not (rel / "worker.pid").exists()
        rc, out = _run(rel, env, "usage-error")
        assert rc == 2 and "usage:" in out
    finally:
        _cleanup(rel)


@pytest.mark.skipif(BASH is None, reason="bash is not available")
def test_run_api_works_on_a_box_without_the_worker_file(tmp_path):
    rel, env = _release(tmp_path, worker_file=False)
    try:
        rc, out = _run(rel, env, "start")
        assert rc == 0 and "watchdog started" in out and "worker" not in out and not (rel / "worker.pid").exists()
        assert "worker not installed" in _run(rel, env, "status")[1]
        assert _run(rel, env, "ensure") == (0, "")
        assert _run(rel, env, "stop")[0] == 0
    finally:
        _cleanup(rel)


@pytest.mark.skipif(BASH is None, reason="bash is not available")
def test_a_worker_that_cannot_start_never_fails_the_api_start(tmp_path):
    rel, env = _release(tmp_path, worker_fails=True)
    try:
        rc, out = _run(rel, env, "start")
        assert rc == 0 and "watchdog started" in out and "worker failed" in out and not (rel / "worker.pid").exists()
        assert "missing in .env" in (rel / "worker.stdout.log").read_text()
        wd = _pid(rel, "watchdog.pid")
        rc, out = _run(rel, env, "ensure")                       # cron retries it every minute without touching the rest
        assert rc == 0 and "worker failed" in out and _pid(rel, "watchdog.pid") == wd
    finally:
        _cleanup(rel)
