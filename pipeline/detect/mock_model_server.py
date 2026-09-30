#!/usr/bin/env python3
"""
Mock of the team's LPU ANPR model API (stdlib only) — lets the proxy and the
pipeline be tested end-to-end without the GPU box.

    python pipeline/detect/mock_model_server.py --port 8766 --api_key dev-key
    # then: DETECTION_API_URL=http://127.0.0.1:8766/v1/frame DETECTION_API_KEY=dev-key

Endpoints (same contract as api_server.py on the GPU box, see pipeline/detect/README.md)
    GET  /health     -> {"ok": true, "engine": "lpu_on_gpu", "model_version": "mock+raw35", ...}  (no key)
    POST /v1/frame   raw JPEG/PNG body, key in X-API-Key (or Authorization: Bearer)
                     -> {"image", "engine", "model_version", "inference_ms", "latency_ms", "detections": [...]}
    POST /v1/video   raw mp4 body -> {"events": [one per vehicle]}
    POST /detect     legacy YOLO-style shape (multipart / JSON / raw), kept for the fallback path

Vehicles are synthetic: 3 plated vehicles at fixed positions plus one
vehicle without a readable plate ("Not Found").
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import struct
import threading
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATES = ["DL", "HR", "UP", "RJ", "MH", "KA", "TN", "WB", "GJ", "PB"]
LPU_CLASSES = ["Car", "Truck", "Bike"]
TYPES = ["car", "truck", "motorcycle"]


def image_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xFF:
                i += 1
                continue
            if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = (data[i + 2] << 8) | data[i + 3]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h = (data[i + 5] << 8) | data[i + 6]
                w = (data[i + 7] << 8) | data[i + 8]
                return (w, h)
            i += 2 + length
    return None


def mock_plate(i: int) -> str:
    rng = random.Random(1000 + i)
    return f"{rng.choice(STATES)} {rng.randint(1, 99):02d} {''.join(rng.choices('ABCDEFGHJKLMNPRSTUVWXYZ', k=2))} {rng.randint(1000, 9999)}"


def mock_predictions(size: tuple[int, int], t: float) -> list[dict]:
    w, h = size
    preds = []
    for i in range(3):
        bw, bh = w * 0.18, h * 0.2
        x1 = ((0.1 + 0.28 * i) * w + t * w * 0.02) % max(1.0, w - bw)
        y1 = h * (0.35 + 0.15 * (i % 2))
        preds.append(
            {
                "class": TYPES[i % len(TYPES)],
                "confidence": round(0.9 + 0.02 * i, 3),
                "xyxy": [round(x1, 1), round(y1, 1), round(x1 + bw, 1), round(y1 + bh, 1)],
                "plate": {"text": mock_plate(i), "confidence": round(0.97 + 0.01 * (i % 3), 3)},
            }
        )
    return preds


def lpu_plate(i: int) -> str:
    rng = random.Random(2000 + i)
    return f"MH{rng.randint(1, 48):02d}{''.join(rng.choices('ABCDEFGHJKLMNPRSTUVWXYZ', k=2))}{rng.randint(1000, 9999)}"


def lpu_detections(size: tuple[int, int]) -> list[dict]:
    """Real-contract detections: top-left [x, y, w, h] boxes in pixels of the submitted image."""
    w, h = size
    out = []
    for i in range(3):
        vx, vy, vw, vh = round((0.08 + 0.3 * i) * w), round(0.55 * h), round(0.12 * w), round(0.18 * h)
        px, py, pw, ph = vx + round(vw * 0.35), vy + round(vh * 0.7), max(4, round(vw * 0.3)), max(2, round(vh * 0.1))
        out.append({
            "plate": lpu_plate(i), "ocr_confidence": 90.0 + i, "raw_ocr": lpu_plate(i), "grammar_valid": True,
            "plate_score": 0.8, "plate_box_xywh": [px, py, pw, ph],
            "vehicle_class": LPU_CLASSES[i % len(LPU_CLASSES)], "vehicle_confidence": 0.9 + 0.02 * i,
            "vehicle_box_xywh": [vx, vy, vw, vh],
        })
    out.append({
        "plate": "Not Found", "ocr_confidence": None, "raw_ocr": None, "grammar_valid": None, "plate_score": None,
        "plate_box_xywh": None, "vehicle_class": "Bus", "vehicle_confidence": 0.88,
        "vehicle_box_xywh": [round(0.5 * w), round(0.4 * h), round(0.15 * w), round(0.12 * h)],
    })
    return out


class MockModelHandler(BaseHTTPRequestHandler):
    server_version = "MockANPR/1.0"
    api_key = "dev-key"
    auth_header = "X-API-Key"
    delay_ms = 0
    fail_first = 0  # respond 503 to the first N detect calls (to exercise retries)
    calls = 0
    lock = threading.Lock()

    def log_message(self, fmt, *args):  # quiet by default
        if os.environ.get("MOCK_MODEL_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        # Like api_server.py: the configured header or `Authorization: Bearer <key>`.
        if self.headers.get("Authorization", "") == f"Bearer {self.api_key}":
            return True
        return self.auth_header.lower() != "authorization" and self.headers.get(self.auth_header, "") == self.api_key

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") in ("/health", ""):
            return self._send(200, {"ok": True, "engine": "lpu_on_gpu", "model_version": "mock+raw35",
                                    "model_loaded": True, "gpu_busy": False})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        route = self.path.split("?")[0].rstrip("/")
        if route not in ("/detect", "/v1/frame", "/v1/video"):
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(401, {"error": "invalid or missing API key"})
        with self.lock:
            type(self).calls += 1
            n = type(self).calls
        if n <= self.fail_first:
            return self._send(503, {"error": "warming up"})
        if route == "/v1/frame":
            return self._lpu_frame()
        if route == "/v1/video":
            return self._lpu_video()

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        image, ts = None, 0.0
        try:
            if ctype.startswith("multipart/form-data"):
                msg = BytesParser(policy=HTTP).parsebytes(
                    f"Content-Type: {ctype}\r\n\r\n".encode() + body
                )
                for part in msg.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    payload = part.get_payload(decode=True) or b""
                    if name == "image":
                        image = payload
                    elif name == "frame_timestamp_sec":
                        ts = float(payload.decode() or 0)
            elif ctype.startswith("application/json"):
                j = json.loads(body.decode())
                b64 = j.get("image") or j.get("image_base64") or ""
                image = base64.b64decode(b64.split(",", 1)[-1])
                ts = float(j.get("frame_timestamp_sec") or 0)
            else:
                image = body
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "could not parse request"})

        size = image_size(image or b"")
        if not size:
            return self._send(400, {"error": "expected a JPEG or PNG image"})
        if self.delay_ms:
            time.sleep(self.delay_ms / 1000)
        seed = int(hashlib.md5(image).hexdigest()[:6], 16)
        return self._send(
            200,
            {
                "model": "legacy-yolo-anpr",
                "version": "mock-1",
                "inference_ms": round(5 + seed % 50 / 10, 1),
                "image": {"width": size[0], "height": size[1]},
                "predictions": mock_predictions(size, ts),
            },
        )


def _mock_lpu_frame(self):
    length = int(self.headers.get("Content-Length") or 0)
    body = self.rfile.read(length)
    size = image_size(body)
    if not size:
        return self._send(415 if not self.headers.get("Content-Type", "").startswith("image/") else 400,
                          {"error": "expected a raw JPEG or PNG body"})
    if self.delay_ms:
        time.sleep(self.delay_ms / 1000)
    return self._send(200, {"image": {"width": size[0], "height": size[1]}, "engine": "lpu_on_gpu",
                            "model_version": "mock+raw35", "inference_ms": 12.5, "latency_ms": 20.0,
                            "detections": lpu_detections(size)})


def _mock_lpu_video(self):
    length = int(self.headers.get("Content-Length") or 0)
    self.rfile.read(length)
    size = (1280, 720)  # the mock does not decode the clip
    events = []
    for i, d in enumerate(d for d in lpu_detections(size) if d["plate"] != "Not Found"):
        events.append({k: d[k] for k in ("plate", "ocr_confidence", "raw_ocr", "grammar_valid", "vehicle_class",
                                          "vehicle_confidence", "plate_box_xywh", "vehicle_box_xywh")}
                      | {"vehicle_track": i, "plate_track": i, "time_sec": 0.1, "frame": 1})
    return self._send(200, {"engine": "lpu_on_gpu", "model_version": "mock+raw35", "frame_step": 1, "tiles": "2x3",
                            "roi_top": 0.33, "inference_ms": 40.0, "latency_ms": 50.0, "events": events})


MockModelHandler._lpu_frame = _mock_lpu_frame
MockModelHandler._lpu_video = _mock_lpu_video


def start_server(
    host: str = "127.0.0.1",
    port: int = 0,
    api_key: str = "dev-key",
    auth_header: str = "X-API-Key",
    delay_ms: int = 0,
    fail_first: int = 0,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    """Starts the mock in a daemon thread. Port 0 picks a free port (server.server_address[1])."""
    handler = type(
        "BoundMockModelHandler",
        (MockModelHandler,),
        {"api_key": api_key, "auth_header": auth_header, "delay_ms": delay_ms, "fail_first": fail_first, "calls": 0},
    )
    server = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def main() -> None:
    p = argparse.ArgumentParser(description="Mock of the LPU ANPR model API")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--api_key", default=os.environ.get("DETECTION_API_KEY") or "dev-key")
    p.add_argument("--auth_header", default=os.environ.get("DETECTION_API_AUTH_HEADER") or "X-API-Key")
    p.add_argument("--delay_ms", type=int, default=0, help="Simulated inference delay")
    args = p.parse_args()
    server, thread = start_server(args.host, args.port, args.api_key, args.auth_header, args.delay_ms)
    host, port = server.server_address[:2]
    print(f"Mock model API on http://{host}:{port}  (POST /v1/frame, /v1/video, /detect; GET /health; "
          f"auth header: {args.auth_header})")
    try:
        thread.join()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
