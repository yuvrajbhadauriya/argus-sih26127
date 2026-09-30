"""
Small stdlib client for the team's live ANPR API ("lpu_on_gpu": DEIM plate/vehicle
detector + PARSeq OCR), used only by the evaluation harness. The production
adapter/client live in pipeline/detect/ and are owned separately.

Contract (2026-09-30):
    GET  /health                       -> {ok, engine, model_version, model_loaded, gpu_busy}   (no key)
    POST /v1/frame?tiles=RxC&roi_top=F&min_conf=N    body: raw JPEG/PNG, header <auth>: <key>
         -> {image:{width,height}, engine, model_version, inference_ms, latency_ms,
             detections:[{plate, ocr_confidence (0-100, weakest char), raw_ocr, grammar_valid,
                          plate_score, plate_box_xywh, vehicle_class, vehicle_confidence, vehicle_box_xywh}]}
         plate == "Not Found" -> a vehicle without a read.
    POST /v1/video?frame_step=N&tiles=RxC&min_conf=N  body: raw mp4 -> {events:[...one per vehicle...], inference_ms}

Config (env / repo-root .env): ANPR_API_BASE (or the origin of DETECTION_API_URL),
DETECTION_API_KEY, DETECTION_API_AUTH_HEADER (default X-API-Key; "Authorization" -> Bearer).
The key never appears in errors or output.
"""

from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass

NOT_FOUND = {"NOT FOUND", "NOTFOUND", ""}


class LpuError(RuntimeError):
    """Safe-to-print API error."""


class LpuUnavailable(LpuError):
    """Network error / timeout / 5xx / 429 after retries."""


class LpuRejected(LpuError):
    """Non-retryable 4xx (bad key, bad request)."""


@dataclass(frozen=True)
class LpuConfig:
    base: str
    api_key: str
    auth_header: str = "X-API-Key"
    timeout_s: float = 60.0

    def __repr__(self) -> str:
        return f"LpuConfig(base=<set>, api_key=<redacted>, auth_header={self.auth_header!r})"

    def headers(self) -> dict:
        if self.auth_header.lower() == "authorization":
            return {"Authorization": f"Bearer {self.api_key}"}
        return {self.auth_header: self.api_key}


def read_lpu_config(env: Mapping[str, str] | None = None) -> LpuConfig | None:
    env = os.environ if env is None else env
    base = (env.get("ANPR_API_BASE") or "").strip()
    if not base:
        m = re.match(r"^(https?://[^/]+)", (env.get("DETECTION_API_URL") or "").strip())
        base = m.group(1) if m else ""
    key = (env.get("DETECTION_API_KEY") or "").strip()
    if not base or not key or not re.match(r"^https?://", base):
        return None
    try:
        timeout = float(env.get("DETECTION_API_TIMEOUT_MS") or 60000) / 1000
    except ValueError:
        timeout = 60.0
    return LpuConfig(base=base.rstrip("/"), api_key=key,
                     auth_header=(env.get("DETECTION_API_AUTH_HEADER") or "X-API-Key").strip() or "X-API-Key",
                     timeout_s=max(5.0, timeout))


def _xywh(v) -> list[float] | None:
    if isinstance(v, (list, tuple)) and len(v) >= 4 and all(isinstance(x, (int, float)) for x in v[:4]):
        x, y, w, h = (float(t) for t in v[:4])
        return [x, y, w, h] if w > 0 and h > 0 else None
    return None


def plate_or_none(text) -> str | None:
    if not isinstance(text, str):
        return None
    t = text.strip()
    return None if re.sub(r"[\s_-]+", "", t).upper() in NOT_FOUND else t


def normalise_frame(raw: dict) -> dict:
    """LPU /v1/frame response -> the harness's detection shape (confidences 0..1)."""
    dets = []
    for d in raw.get("detections") or []:
        if not isinstance(d, dict):
            continue
        ocr = d.get("ocr_confidence")
        dets.append({
            "plate_text": plate_or_none(d.get("plate")),
            "raw_ocr": d.get("raw_ocr"),
            "grammar_valid": d.get("grammar_valid"),
            "plate_confidence": None if not isinstance(ocr, (int, float)) else round(min(1.0, max(0.0, ocr / 100)), 4),
            "plate_score": d.get("plate_score"),
            "bbox": _xywh(d.get("plate_box_xywh")),               # plate box (matching)
            "vehicle_bbox": _xywh(d.get("vehicle_box_xywh")),     # vehicle box (tracking)
            "vehicle_type": str(d.get("vehicle_class") or "unknown").lower(),
            "confidence": float(d.get("vehicle_confidence") or d.get("plate_score") or 0.0),
        })
    return {
        "engine": raw.get("engine"),
        "model_version": raw.get("model_version"),
        "inference_ms": raw.get("inference_ms"),
        "server_latency_ms": raw.get("latency_ms"),
        "image": raw.get("image"),
        "detections": dets,
    }


class LpuClient:
    def __init__(self, cfg: LpuConfig, max_retries: int = 3, backoff_base: float = 1.0,
                 opener: Callable | None = None, sleep: Callable[[float], None] = time.sleep):
        self.cfg = cfg
        self.max_retries = max(0, int(max_retries))
        self.backoff_base = backoff_base
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep

    def health(self) -> dict:
        """GET /health. Raises LpuUnavailable if nothing answers."""
        req = urllib.request.Request(f"{self.cfg.base}/health", headers={"Accept": "application/json"})
        last = None
        for attempt in range(self.max_retries + 1):
            try:
                with self._open(req, timeout=10) as resp:
                    body = json.loads(resp.read().decode("utf-8") or "{}")
                    return {k: v for k, v in body.items() if isinstance(v, (str, int, float, bool)) and "key" not in k.lower()}
            except urllib.error.HTTPError as e:
                return {"ok": False, "http_status": int(e.code)}
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
                last = _describe(e)
            if attempt < self.max_retries:
                self._sleep(self.backoff_base * (2**attempt))
        raise LpuUnavailable(f"ANPR API health probe failed ({last})")

    def frame(self, image: bytes, mime: str = "image/jpeg", tiles: str = "1x1", roi_top: float | None = None,
              min_conf: float | None = None) -> dict:
        """POST /v1/frame. Returns normalise_frame(...) + latency_ms (client round trip)."""
        q = {"tiles": tiles}
        if roi_top is not None:
            q["roi_top"] = roi_top
        if min_conf is not None:
            q["min_conf"] = min_conf
        raw, ms = self._post(f"/v1/frame?{urllib.parse.urlencode(q)}", image, mime)
        out = normalise_frame(raw)
        out["latency_ms"] = ms
        return out

    def video(self, mp4: bytes, frame_step: int = 5, tiles: str = "2x3", min_conf: float | None = None) -> dict:
        q = {"frame_step": frame_step, "tiles": tiles}
        if min_conf is not None:
            q["min_conf"] = min_conf
        raw, ms = self._post(f"/v1/video?{urllib.parse.urlencode(q)}", mp4, "video/mp4", timeout=max(300.0, self.cfg.timeout_s))
        raw["latency_ms"] = ms
        return raw

    def _post(self, path: str, body: bytes, mime: str, timeout: float | None = None) -> tuple[dict, float]:
        headers = {"Accept": "application/json", "Content-Type": mime, **self.cfg.headers()}
        last = None
        for attempt in range(self.max_retries + 1):
            req = urllib.request.Request(self.cfg.base + path, data=body, headers=headers, method="POST")
            started = time.perf_counter()
            try:
                with self._open(req, timeout=timeout or self.cfg.timeout_s) as resp:
                    payload = resp.read()
                ms = round((time.perf_counter() - started) * 1000, 1)
                try:
                    return json.loads(payload.decode("utf-8")), ms
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise LpuError("ANPR API returned a non-JSON response") from None
            except urllib.error.HTTPError as e:
                code = int(e.code)
                if code == 429 or code >= 500:
                    last = f"HTTP {code}"
                else:
                    hint = " (API key rejected — check DETECTION_API_KEY / DETECTION_API_AUTH_HEADER)" if code in (401, 403) else ""
                    raise LpuRejected(f"ANPR API returned HTTP {code}{hint}") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = _describe(e)
            if attempt < self.max_retries:
                self._sleep(self.backoff_base * (2**attempt))
        raise LpuUnavailable(f"ANPR API failed after {self.max_retries + 1} attempt(s) ({last})")


def _describe(e: BaseException) -> str:
    reason = getattr(e, "reason", e)
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
        return "timed out"
    if isinstance(reason, ConnectionRefusedError):
        return "connection refused"
    return type(reason).__name__
