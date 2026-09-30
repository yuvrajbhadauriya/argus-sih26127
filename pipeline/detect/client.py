"""
HTTP client for the remote GPU ANPR model API (stdlib only: urllib).

- Auth header from adapter.build_auth_headers (key from env / .env only)
- Per-request timeout, retries with exponential backoff on network errors,
  timeouts, HTTP 429 and 5xx
- No retry on other 4xx (bad key, bad request) — those fail immediately
- Never includes the key or the full URL in exception messages
"""

from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from collections.abc import Callable

from .adapter import (
    ModelApiConfig,
    UpstreamShapeError,
    build_auth_headers,
    build_upstream_request,
    default_health_url,
    normalise_upstream_response,
)


class DetectionAPIError(RuntimeError):
    """Base error for the remote detection API (message is safe to print)."""


class DetectionAPIUnavailable(DetectionAPIError):
    """Network error / timeout / 5xx after all retries."""


class DetectionAPIRejected(DetectionAPIError):
    """Non-retryable 4xx (e.g. 401 bad key, 400 bad frame)."""


class RemoteDetectionClient:
    def __init__(
        self,
        cfg: ModelApiConfig,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        opener: Callable | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.cfg = cfg
        self.max_retries = max(0, int(max_retries))
        self.backoff_base = backoff_base
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep

    @property
    def timeout_s(self) -> float:
        return self.cfg.timeout_ms / 1000.0

    # ── health ────────────────────────────────────────────────────────
    def check_reachable(self) -> int:
        """Returns the HTTP status of the health probe. Any HTTP answer counts as reachable.

        Raises DetectionAPIUnavailable if nothing answers (after retries).
        """
        url = default_health_url(self.cfg)
        req = urllib.request.Request(url, headers={"Accept": "application/json", **build_auth_headers(self.cfg)})
        last: str | None = None
        for attempt in range(self.max_retries + 1):
            try:
                with self._open(req, timeout=min(self.timeout_s, 10.0)) as resp:
                    return int(resp.status)
            except urllib.error.HTTPError as e:
                return int(e.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = _describe(e)
            if attempt < self.max_retries:
                self._sleep(self.backoff_base * (2**attempt))
        raise DetectionAPIUnavailable(f"Detection model API is unreachable ({last})")

    # ── detect ────────────────────────────────────────────────────────
    def detect(
        self,
        image_bytes: bytes,
        image_size: tuple[int, int] | None = None,
        camera_code: str | None = None,
        frame_timestamp_sec: float | None = None,
        mime_type: str = "image/jpeg",
    ) -> dict:
        """POSTs one frame; returns the normalised dict (+ latency_ms)."""
        headers, body = build_upstream_request(self.cfg, image_bytes, mime_type, camera_code, frame_timestamp_sec)
        last: str | None = None
        for attempt in range(self.max_retries + 1):
            started = time.perf_counter()
            req = urllib.request.Request(self.cfg.url, data=body, headers=headers, method="POST")
            try:
                with self._open(req, timeout=self.timeout_s) as resp:
                    payload = resp.read()
                latency_ms = round((time.perf_counter() - started) * 1000)
                try:
                    raw = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise DetectionAPIError("Detection model API returned a non-JSON response") from None
                try:
                    out = normalise_upstream_response(raw, image_size)
                except UpstreamShapeError as e:
                    raise DetectionAPIError(str(e)) from None
                out["latency_ms"] = latency_ms
                return out
            except urllib.error.HTTPError as e:
                code = int(e.code)
                if code == 429 or code >= 500:
                    last = f"HTTP {code}"
                else:
                    hint = " (API key rejected — check DETECTION_API_KEY / DETECTION_API_AUTH_HEADER)" if code in (401, 403) else ""
                    raise DetectionAPIRejected(f"Detection model API returned HTTP {code}{hint}") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = _describe(e)
            if attempt < self.max_retries:
                self._sleep(self.backoff_base * (2**attempt))
        raise DetectionAPIUnavailable(
            f"Detection model API failed after {self.max_retries + 1} attempt(s) ({last})"
        )


def _describe(e: BaseException) -> str:
    """Short, secret-free description of a network error."""
    reason = getattr(e, "reason", e)
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
        return "timed out"
    if isinstance(reason, ConnectionRefusedError):
        return "connection refused"
    return type(reason).__name__
