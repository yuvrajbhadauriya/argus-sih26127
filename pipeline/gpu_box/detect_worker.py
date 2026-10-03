"""detect_worker.py — runs the hosted dashboard's live-frame jobs on this box's ANPR API.

Outbound only. The worker polls Supabase (public.detect_jobs, through the RPCs of
supabase/migrations/20261003000200_detect_jobs.sql) over HTTPS, posts each claimed JPEG to this
box's own ANPR API (POST /v1/frame, X-API-Key from .env) and writes the model's raw answer back
to the job row. It opens no port: the ANPR API stays on its Tailscale address, and its address
and key never come from the database.

Standard library only (release venv untouched). Everything stays in this folder.
  - claim:      rpc/claim_detect_jobs {"p_limit": 1}      oldest fresh frame first
  - finish:     PATCH detect_jobs?id=eq.<id>               status done|error, frame cleared
  - heartbeat:  rpc/detect_worker_beat every 10 s          the API refuses frames once it is >30 s old
  - purge:      rpc/purge_detect_jobs every 60 s
Started by ./run_api.sh start (and by cron @reboot / every minute via ./run_api.sh ensure).
Dev: `venv/bin/python detect_worker.py --once` drains the queue and exits.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import http.client
import json
import logging
import logging.handlers
import os
import random
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.0"

# Same default as DEFAULT_QUERY in api/_lib/modelAdapter.ts: wide city views need 2x3 tiling.
DEFAULT_QUERY = "tiles=2x3&roi_top=0.33&min_conf=60"
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_FRAME_B64_CHARS = (MAX_FRAME_BYTES + 2) // 3 * 4        # longest base64 text a legal frame can have
MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SB_RESPONSE_BYTES = 32 * 1024 * 1024
WARN_EVERY_S = 60.0
JOB_ID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

log = logging.getLogger("detect_worker")


# ── config ────────────────────────────────────────────────────────────────
def load_env(path):
    env = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class ConfigError(Exception):
    """A missing or unusable setting. The message names the setting, never its value."""


@dataclass
class Config:
    sb_url: str
    sb_key: str
    api_key: str
    api_host: str = "100.64.0.1"
    api_port: int = 8765
    frame_query: str = DEFAULT_QUERY
    worker_id: str = "gpu-primary"
    # timings in seconds (fields so tests can shrink them)
    poll_active_s: float = 0.12     # right after a job: more may be queued
    poll_idle_s: float = 1.0
    active_window_s: float = 20.0
    heartbeat_s: float = 10.0
    purge_s: float = 60.0
    retry_s: float = 2.0            # heartbeat retry after a failure
    model_timeout_s: float = 20.0
    sb_timeout_s: float = 10.0
    backoff_base_s: float = 1.0
    backoff_max_s: float = 30.0

    @property
    def model_url(self) -> str:
        return f"http://{self.api_host}:{self.api_port}/v1/frame"

    @classmethod
    def from_env(cls, env):
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANPR_API_KEY") if not (env.get(k) or "").strip()]
        if missing:
            raise ConfigError("missing in .env: " + ", ".join(missing))
        sb_url = env["SUPABASE_URL"].strip().rstrip("/")
        parts = urllib.parse.urlsplit(sb_url)
        loopback = parts.hostname in ("127.0.0.1", "localhost", "::1")
        if not parts.hostname or not (parts.scheme == "https" or (parts.scheme == "http" and loopback)):
            raise ConfigError("SUPABASE_URL must be an https:// URL")      # the service key must not travel in clear
        try:
            port = int((env.get("ANPR_API_PORT") or "8765").strip())
        except ValueError:
            raise ConfigError("ANPR_API_PORT must be a number") from None
        if not 1 <= port <= 65535:
            raise ConfigError("ANPR_API_PORT must be 1-65535")
        host = (env.get("ANPR_API_HOST") or "100.64.0.1").strip()
        if not re.fullmatch(r"[A-Za-z0-9.\-]+", host):
            raise ConfigError("ANPR_API_HOST must be a host name or IPv4 address")
        query = DEFAULT_QUERY
        if (env.get("ANPR_FRAME_QUERY") or "").strip():
            query = sanitise_query(env["ANPR_FRAME_QUERY"])
            if query is None:
                raise ConfigError("ANPR_FRAME_QUERY is not a supported /v1/frame query (tiles, roi_top, min_conf only)")
        return cls(sb_url=sb_url, sb_key=env["SUPABASE_SERVICE_ROLE_KEY"].strip(), api_key=env["ANPR_API_KEY"].strip(),
                   api_host=host, api_port=port, frame_query=query,
                   worker_id=(env.get("WORKER_ID") or "gpu-primary").strip()[:64] or "gpu-primary")


# ── what a job may ask for ────────────────────────────────────────────────
def _ok_tiles(v):
    m = re.fullmatch(r"([0-9]{1,2})x([0-9]{1,2})", v)
    return bool(m) and 1 <= int(m.group(1)) <= 8 and 1 <= int(m.group(2)) <= 8


def _ok_roi_top(v):
    return bool(re.fullmatch(r"[0-9](\.[0-9]{1,4})?", v)) and 0.0 <= float(v) <= 0.9


def _ok_min_conf(v):
    return bool(re.fullmatch(r"[0-9]{1,3}", v)) and 0 <= int(v) <= 100


_QUERY_CHECKS = {"tiles": _ok_tiles, "roi_top": _ok_roi_top, "min_conf": _ok_min_conf}


def sanitise_query(query):
    """The query as given if every parameter is on the whitelist (each at most once), else None."""
    if not isinstance(query, str):
        return None
    q = query.strip().removeprefix("?")
    if not q:
        return None
    seen = set()
    for part in q.split("&"):
        key, sep, value = part.partition("=")
        if not sep or key in seen or key not in _QUERY_CHECKS or not _QUERY_CHECKS[key](value):
            return None
        seen.add(key)
    return q


def decode_frame(b64):
    """The JPEG bytes of a job, or None when it is not a sane frame (never sent to the GPU then)."""
    if not isinstance(b64, str) or not b64 or len(b64) > MAX_FRAME_B64_CHARS:
        return None
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not 1 <= len(raw) <= MAX_FRAME_BYTES or raw[:3] != b"\xff\xd8\xff":
        return None
    return raw


def backoff_delay(failures, base, cap, rand=random.random):
    """Exponential 1 s → 30 s with ±25 % jitter, never above `cap`."""
    nominal = min(cap, base * 2 ** min(max(0, failures - 1), 20))       # the exponent is capped: a long outage must not overflow
    return min(cap, nominal * (0.75 + 0.5 * rand()))


# ── HTTP ──────────────────────────────────────────────────────────────────
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _request(opener, method, url, headers, data, timeout, max_bytes):
    """(status, body). Non-2xx answers are returned, network trouble raises OSError/HTTPException."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with opener.open(req, timeout=timeout) as r:
            status, body = r.status, r.read(max_bytes + 1)
    except urllib.error.HTTPError as e:
        try:
            status, body = e.code, e.read(max_bytes + 1)
        except OSError:
            status, body = e.code, b""
        finally:
            e.close()
    if len(body) > max_bytes:
        raise ValueError("response too large")
    return status, body


def _reject_constant(name):
    raise ValueError("NaN/Infinity is not JSON")


class ModelError(Exception):
    """The model API could not read a frame. The message is safe to store and show: no host, key or frame.

    `detail` (an exception class name, e.g. BrokenPipeError) is for worker.log only, never stored."""

    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


class SupabaseError(Exception):
    def __init__(self, status=None, cause=None):
        self.status = status
        self.cause = cause
        self.label = f"HTTP {status}" if status else (type(cause).__name__ if cause is not None else "error")
        super().__init__(self.label)


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── the worker ────────────────────────────────────────────────────────────
class Worker:
    def __init__(self, cfg, *, sb_opener=None, model_opener=None, clock=time.monotonic, sleep=time.sleep, rand=random.random):
        self.cfg = cfg
        self._sb_open = sb_opener or urllib.request.build_opener(_NoRedirect)
        # The local model API is never reached through an environment proxy.
        self._model_open = model_opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
        self._clock, self._sleep, self._rand = clock, sleep, rand
        self._stopped = threading.Event()
        self.jobs_done = 0
        self._fail = 0
        self._next_beat = 0.0
        self._next_purge = 0.0
        self._last_job = None
        self._warned = {}

    # -- Supabase ----------------------------------------------------------
    def _sb(self, method, path, payload=None, prefer=None):
        headers = {"apikey": self.cfg.sb_key, "Authorization": f"Bearer {self.cfg.sb_key}",
                   "Content-Type": "application/json", "Accept": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        try:
            status, body = _request(self._sb_open, method, self.cfg.sb_url + path, headers, data,
                                    self.cfg.sb_timeout_s, MAX_SB_RESPONSE_BYTES)
        except (OSError, http.client.HTTPException, ValueError) as e:
            raise SupabaseError(cause=e) from None
        if status >= 400:
            raise SupabaseError(status=status)
        if not body.strip():
            return None
        try:
            return json.loads(body)
        except ValueError as e:
            raise SupabaseError(cause=e) from None

    def claim(self):
        rows = self._sb("POST", "/rest/v1/rpc/claim_detect_jobs", {"p_limit": 1})
        return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []

    def finish(self, job_id, *, result=None, error=None):
        """Write the outcome (and clear the frame). Transient failures are retried briefly."""
        if not JOB_ID_RE.fullmatch(job_id):
            raise ValueError("unusable job id")
        if error is None:
            patch = {"status": "done", "result": result, "frame_b64": None, "done_at": _utc_now()}
        else:
            patch = {"status": "error", "error": error[:200], "frame_b64": None, "done_at": _utc_now()}
        last = None
        for pause in (0.0, 0.2, 0.6):
            if pause:
                self._sleep(pause)
            try:
                self._sb("PATCH", f"/rest/v1/detect_jobs?id=eq.{job_id}", patch, prefer="return=minimal")
                return
            except SupabaseError as e:
                last = e
                if e.status is not None and e.status < 500 and e.status != 429:
                    break
        raise last

    def heartbeat(self):
        self._sb("POST", "/rest/v1/rpc/detect_worker_beat",
                 {"p_id": self.cfg.worker_id, "p_version": VERSION, "p_jobs_done": self.jobs_done})

    def purge(self):
        gone = self._sb("POST", "/rest/v1/rpc/purge_detect_jobs", {})
        if isinstance(gone, int) and gone > 0:
            log.info("purged %d old jobs", gone)

    # -- the model ---------------------------------------------------------
    def call_model(self, jpeg, query):
        headers = {"X-API-Key": self.cfg.api_key, "Content-Type": "image/jpeg", "Accept": "application/json"}
        try:
            status, body = _request(self._model_open, "POST", f"{self.cfg.model_url}?{query}", headers, jpeg,
                                    self.cfg.model_timeout_s, MAX_MODEL_RESPONSE_BYTES)
        except TimeoutError:
            raise ModelError("Detection model API timed out") from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, (TimeoutError, socket.timeout)):
                raise ModelError("Detection model API timed out") from None
            # e.g. a rejected key on a big frame: the API answers 401 and hangs up mid-upload (BrokenPipeError)
            raise ModelError("Detection model API is unreachable", detail=type(e.reason).__name__) from None
        except (OSError, http.client.HTTPException) as e:
            raise ModelError("Detection model API is unreachable", detail=type(e).__name__) from None
        except ValueError:
            raise ModelError("Detection model API returned an invalid response") from None
        if status != 200:
            raise ModelError(f"Detection model API returned HTTP {status}")
        try:
            data = json.loads(body, parse_constant=_reject_constant)
        except ValueError:
            raise ModelError("Detection model API returned an invalid response") from None
        if not isinstance(data, dict):
            raise ModelError("Detection model API returned an invalid response")
        return data

    def process(self, job):
        """Run one claimed job and record the outcome: 'done', 'error' or 'skipped'. Model trouble never raises."""
        job_id = str(job.get("id") or "")
        short = job_id[:8]
        if not JOB_ID_RE.fullmatch(job_id):
            log.warning("claimed a job without a usable id; skipped")
            return "skipped"
        t0 = self._clock()
        frame = decode_frame(job.get("frame_b64"))
        if frame is None:
            self.finish(job_id, error="invalid frame")
            log.info("job %s error: invalid frame", short)
            return "error"
        query = sanitise_query(job.get("query")) or self.cfg.frame_query
        detail = None
        try:
            result = self.call_model(frame, query)
        except ModelError as e:
            message, detail = str(e), e.detail
        except Exception as e:  # noqa: BLE001 - a bug here must not leave the viewer waiting
            log.warning("job %s unexpected %s", short, type(e).__name__)
            message = "Detection worker error"
        else:
            self.finish(job_id, result=result)
            self.jobs_done += 1
            found = result.get("detections")
            log.info("job %s done in %d ms (%d detections)", short, (self._clock() - t0) * 1000,
                     len(found) if isinstance(found, list) else 0)
            return "done"
        self.finish(job_id, error=message)
        log.info("job %s error: %s%s (%d ms)", short, message, f" [{detail}]" if detail else "", (self._clock() - t0) * 1000)
        return "error"

    # -- the loop ----------------------------------------------------------
    def _warn(self, kind, label):
        now = self._clock()
        last = self._warned.get(kind)
        if last is None or now - last >= WARN_EVERY_S:
            self._warned[kind] = now
            log.warning("%s failed: %s", kind, label)

    def _poll_delay(self):
        recent = self._last_job is not None and self._clock() - self._last_job < self.cfg.active_window_s
        return self.cfg.poll_active_s if recent else self.cfg.poll_idle_s

    def _failed(self, kind, label):
        self._fail += 1
        self._warn(kind, label)
        return backoff_delay(self._fail, self.cfg.backoff_base_s, self.cfg.backoff_max_s, self._rand)

    def step(self):
        """One pass: heartbeat/purge when due, then claim and run what is queued. Returns seconds to wait."""
        now = self._clock()
        if now >= self._next_beat:
            try:
                self.heartbeat()
                self._next_beat = now + self.cfg.heartbeat_s
            except SupabaseError as e:
                self._next_beat = now + self.cfg.retry_s
                self._warn("heartbeat", e.label)
        if now >= self._next_purge:
            try:
                self.purge()
            except SupabaseError as e:
                self._warn("purge", e.label)
            self._next_purge = now + self.cfg.purge_s
        try:
            jobs = self.claim()
            for job in jobs:
                self.process(job)
        except SupabaseError as e:
            return self._failed("supabase", e.label)
        except Exception as e:  # noqa: BLE001 - never let a bug kill the daemon
            return self._failed("loop", type(e).__name__)
        if self._fail:
            log.info("supabase reachable again after %d failed attempts", self._fail)
            self._fail = 0
        if jobs:
            self._last_job = self._clock()
            return 0.0
        return self._poll_delay()

    def run_forever(self):
        log.info("worker %s started (version %s)", self.cfg.worker_id, VERSION)
        while not self._stopped.is_set():
            delay = self.step()
            if delay > 0 and self._stopped.wait(delay):
                break
        log.info("worker stopped")

    def run_once(self):
        """Dev/test: one heartbeat, then run queued jobs until none are left. Returns how many ran."""
        self.heartbeat()
        n = 0
        while not self._stopped.is_set():
            jobs = self.claim()
            if not jobs:
                break
            for job in jobs:
                self.process(job)
                n += 1
        return n

    def stop(self):
        self._stopped.set()


# ── entry point ───────────────────────────────────────────────────────────
def setup_logging(path, also_stderr=False):
    log.setLevel(logging.INFO)
    log.propagate = False
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handlers = [logging.handlers.RotatingFileHandler(path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")]
    if also_stderr:
        handlers.append(logging.StreamHandler(sys.stderr))
    for h in handlers:
        h.setFormatter(fmt)
        log.addHandler(h)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run the dashboard's live-frame jobs on this box's ANPR API.")
    ap.add_argument("--once", action="store_true", help="drain the queue, then exit (dev/test)")
    ap.add_argument("--env", default=os.path.join(HERE, ".env"), help="settings file (default: .env next to this script)")
    ap.add_argument("--log", default=os.path.join(HERE, "worker.log"), help="log file (default: worker.log next to this script)")
    args = ap.parse_args(argv)
    setup_logging(args.log, also_stderr=args.once)
    try:
        cfg = Config.from_env(load_env(args.env))
    except ConfigError as e:
        print(f"detect_worker: {e}", file=sys.stderr)
        return 2
    worker = Worker(cfg)
    previous = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, lambda *_: worker.stop())      # finishes the job in flight, then stops
    try:
        if args.once:
            try:
                n = worker.run_once()
            except SupabaseError as e:
                print(f"detect_worker: Supabase call failed ({e.label})", file=sys.stderr)
                return 1
            log.info("ran %d job(s)", n)
            return 0
        worker.run_forever()
        return 0
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    sys.exit(main())
