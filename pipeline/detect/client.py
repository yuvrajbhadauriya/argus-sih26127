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
    default_video_url,
    frame_request_url,
    is_lpu_response,
    normalise_upstream_response,
    parse_tiles,
    with_query,
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

    # ── detect (one frame) ────────────────────────────────────────────
    def detect(
        self,
        image_bytes: bytes,
        image_size: tuple[int, int] | None = None,
        camera_code: str | None = None,
        frame_timestamp_sec: float | None = None,
        mime_type: str = "image/jpeg",
        query: str | None = None,
        return_raw: bool = False,
    ) -> dict:
        """POSTs one frame to /v1/frame; returns the normalised dict (+ latency_ms, + raw if asked).

        ``query`` overrides cfg.query (e.g. ``tiles=2x3&roi_top=0.33&min_conf=0``).
        """
        q = self.cfg.query if query is None else query
        url = with_query(self.cfg.url, q) if query is not None else frame_request_url(self.cfg)
        headers, body = build_upstream_request(self.cfg, image_bytes, mime_type, camera_code, frame_timestamp_sec)
        raw, latency_ms = self._post_json(url, headers, body, self.timeout_s)
        try:
            out = normalise_upstream_response(raw, image_size, parse_tiles(q))
        except UpstreamShapeError as e:
            raise DetectionAPIError(str(e)) from None
        out["latency_ms"] = latency_ms
        if return_raw:
            out["raw"] = raw
        return out

    # ── detect (whole clip) ───────────────────────────────────────────
    def detect_video(self, video_bytes: bytes, query: str = "frame_step=1&tiles=2x3", timeout_s: float = 3600.0) -> dict:
        """POSTs a whole mp4 to /v1/video; returns the RAW response ({events: [...], ...}) + client_latency_ms.

        One event per vehicle (the server runs detection + tracking + OCR voting).
        No retries on timeouts: a clip can take minutes of shared GPU time.
        """
        headers = {"Accept": "application/json", "Content-Type": "video/mp4", **build_auth_headers(self.cfg)}
        raw, latency_ms = self._post_json(with_query(default_video_url(self.cfg), query), headers, video_bytes,
                                          timeout_s, retry_timeouts=False)
        if not is_lpu_response(raw) or not isinstance(raw.get("events"), list):
            raise DetectionAPIError("Model API /v1/video response contained no events list")
        raw["client_latency_ms"] = latency_ms
        return raw

    def health(self) -> dict:
        """GET /health as JSON (no key needed). Raises DetectionAPIUnavailable when nothing answers."""
        req = urllib.request.Request(default_health_url(self.cfg), headers={"Accept": "application/json"})
        try:
            with self._open(req, timeout=min(self.timeout_s, 10.0)) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return {"ok": False, "status": int(e.code)}
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
            raise DetectionAPIUnavailable(f"Detection model API is unreachable ({_describe(e)})") from None

    # ── transport ─────────────────────────────────────────────────────
    def _post_json(self, url: str, headers: dict, body: bytes, timeout_s: float, retry_timeouts: bool = True):
        last: str | None = None
        for attempt in range(self.max_retries + 1):
            started = time.perf_counter()
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            try:
                with self._open(req, timeout=timeout_s) as resp:
                    payload = resp.read()
                latency_ms = round((time.perf_counter() - started) * 1000)
                try:
                    return json.loads(payload.decode("utf-8")), latency_ms
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise DetectionAPIError("Detection model API returned a non-JSON response") from None
            except urllib.error.HTTPError as e:
                code = int(e.code)
                if code == 429 or code >= 500:
                    last = f"HTTP {code}"
                else:
                    hint = " (API key rejected — check DETECTION_API_KEY / DETECTION_API_AUTH_HEADER)" if code in (401, 403) else ""
                    raise DetectionAPIRejected(f"Detection model API returned HTTP {code}{hint}") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = _describe(e)
                if not retry_timeouts and last == "timed out":
                    break
            if attempt < self.max_retries:
                self._sleep(self.backoff_base * (2**attempt))
        raise DetectionAPIUnavailable(
            f"Detection model API failed after {attempt + 1} attempt(s) ({last})"
        )


def _describe(e: BaseException) -> str:
    """Short, secret-free description of a network error."""
    reason = getattr(e, "reason", e)
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
        return "timed out"
    if isinstance(reason, ConnectionRefusedError):
        return "connection refused"
    return type(reason).__name__
