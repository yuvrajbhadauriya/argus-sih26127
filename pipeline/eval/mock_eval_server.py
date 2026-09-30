#!/usr/bin/env python3
"""
Noisy-oracle mock of the GPU model API, for testing the evaluation flow offline.

Speaks the live ANPR API contract used by the harness (``GET /health``,
``POST /v1/frame`` with raw image bytes and an ``X-API-Key`` header — see
pipeline/eval/lpu_client.py) and, for completeness, the adapter-style
``POST /detect`` of pipeline/detect/mock_model_server.py. Instead of three
fixed cars it answers:

- for an image registered in ``oracle`` (sha1 of the exact bytes sent) — the
  ground-truth plates with deterministic, seeded noise: some plates missed,
  some with one confusable-character error (O/0, I/1, B/8, S/5, Z/2, D/0, G/6)
  or a dropped character;
- for any other image (video frames) — the stock drifting cars, with the plate
  text occasionally corrupted per frame, so the video consistency metric has
  something to measure.

THE NUMBERS IT PRODUCES ARE MEANINGLESS AS ACCURACY — they only prove the
pipeline works end to end. Results from a mock run are written with
``"status": "sample"``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import sys
import threading
from email.parser import BytesParser
from email.policy import HTTP
from http.server import ThreadingHTTPServer
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
if _PIPELINE not in sys.path:
    sys.path.insert(0, _PIPELINE)

from detect.mock_model_server import MockModelHandler, image_size, mock_predictions  # noqa: E402

CONFUSABLE = {"O": "0", "0": "O", "I": "1", "1": "I", "B": "8", "8": "B", "S": "5", "5": "S",
              "Z": "2", "2": "Z", "D": "0", "G": "6", "6": "G"}
MODEL_VERSION = "mock-oracle-1"
ENGINE = "mock-oracle"


def _lpu_detection(p: dict) -> dict:
    """Adapter-style prediction -> LPU /v1/frame detection (plate box = lower-middle of the vehicle box)."""
    x1, y1, x2, y2 = p["xyxy"]
    w, h = x2 - x1, y2 - y1
    plate = p.get("plate") or {}
    return {
        "plate": plate.get("text") or "Not Found", "raw_ocr": plate.get("text") or "",
        "ocr_confidence": round((plate.get("confidence") or 0) * 100, 1), "grammar_valid": True, "plate_score": 0.9,
        "plate_box_xywh": p.get("plate_xywh") or [round(x1 + w * 0.35, 1), round(y1 + h * 0.7, 1), round(w * 0.3, 1), round(h * 0.15, 1)],
        "vehicle_class": str(p.get("class", "car")).title(), "vehicle_confidence": p.get("confidence", 0.9),
        "vehicle_box_xywh": [round(x1, 1), round(y1, 1), round(w, 1), round(h, 1)],
    }


def corrupt(text: str, rng: random.Random) -> str:
    """One realistic OCR error: a confusable substitution if possible, else a dropped character."""
    chars = [c for c in text]
    idx = [i for i, c in enumerate(chars) if c in CONFUSABLE]
    if idx and rng.random() < 0.8:
        i = rng.choice(idx)
        chars[i] = CONFUSABLE[chars[i]]
    elif chars:
        chars.pop(rng.randrange(len(chars)))
    return "".join(chars)


class OracleHandler(MockModelHandler):
    oracle: dict = {}          # sha1 -> [{"text", "bbox": [x,y,w,h] | None}]
    miss_rate = 0.06
    error_rate = 0.12
    video_noise = 0.15
    seed = 11

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0].rstrip("/") in ("/health", ""):
            return self._send(200, {"ok": True, "engine": ENGINE, "model_version": MODEL_VERSION,
                                    "model_loaded": True, "gpu_busy": False})
        return self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler API
        route = self.path.split("?")[0].rstrip("/")
        if route not in ("/detect", "/v1/frame"):
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(401, {"error": "invalid or missing API key"})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        image, ts = None, 0.0
        try:
            if ctype.startswith("multipart/form-data"):
                msg = BytesParser(policy=HTTP).parsebytes(f"Content-Type: {ctype}\r\n\r\n".encode() + body)
                for part in msg.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    payload = part.get_payload(decode=True) or b""
                    if name == "image":
                        image = payload
                    elif name == "frame_timestamp_sec":
                        ts = float(payload.decode() or 0)
            elif ctype.startswith("application/json"):
                j = json.loads(body.decode())
                image = base64.b64decode((j.get("image") or j.get("image_base64") or "").split(",", 1)[-1])
                ts = float(j.get("frame_timestamp_sec") or 0)
            else:
                image = body
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "could not parse request"})
        size = image_size(image or b"")
        if not size:
            return self._send(400, {"error": "expected a JPEG or PNG image"})

        digest = hashlib.sha1(image).hexdigest()
        rng = random.Random(f"{self.seed}:{digest}")
        truth = self.oracle.get(digest)
        preds = self._oracle_preds(truth, size, rng) if truth is not None else self._video_preds(size, ts, rng)
        if route == "/v1/frame":
            return self._send(200, {
                "image": {"width": size[0], "height": size[1]}, "engine": ENGINE, "model_version": MODEL_VERSION,
                "inference_ms": round(6 + rng.random() * 6, 1), "latency_ms": round(8 + rng.random() * 8, 1),
                "detections": [_lpu_detection(p) for p in preds],
            })
        return self._send(200, {
            "model": ENGINE, "version": MODEL_VERSION,
            "inference_ms": round(6 + rng.random() * 6, 1),
            "image": {"width": size[0], "height": size[1]},
            "predictions": preds,
        })

    def _oracle_preds(self, truth, size, rng):
        w, h = size
        preds = []
        for i, p in enumerate(truth):
            if rng.random() < self.miss_rate:
                continue
            text = p["text"]
            if rng.random() < self.error_rate:
                text = corrupt(text, rng)
            box = p.get("bbox") or [w * 0.02, h * 0.02, w * 0.96, h * 0.96]
            x, y, bw, bh = box
            preds.append({
                "class": "car", "confidence": round(0.85 + rng.random() * 0.14, 3),
                "xyxy": [round(x, 1), round(y, 1), round(x + bw, 1), round(y + bh, 1)],
                "plate": {"text": text, "confidence": round(0.7 + rng.random() * 0.29, 3)},
                "plate_xywh": [round(v, 1) for v in box],
            })
        return preds

    def _video_preds(self, size, ts, rng):
        # Video frames carry no timestamp on /v1/frame: derive one from the call order.
        if not ts:
            with self.lock:
                type(self).frame_no = getattr(type(self), "frame_no", 0) + 1
                ts = type(self).frame_no * 0.2
        preds = mock_predictions(size, ts)
        for p in preds:
            if rng.random() < self.video_noise:
                p["plate"]["text"] = corrupt(p["plate"]["text"].replace(" ", ""), rng)
        return preds


def start_oracle_server(oracle: dict | None = None, api_key: str = "dev-key", host: str = "127.0.0.1", port: int = 0,
                        auth_header: str = "X-API-Key", **rates) -> tuple[ThreadingHTTPServer, threading.Thread, type]:
    """Starts the oracle mock in a daemon thread. Returns (server, thread, handler_class);
    register images with ``handler_class.oracle[sha1] = plates`` before sending them."""
    handler = type("BoundOracleHandler", (OracleHandler,), {"api_key": api_key, "auth_header": auth_header,
                                                             "oracle": oracle if oracle is not None else {},
                                                             "calls": 0, "frame_no": 0, **rates})
    server = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, handler
