#!/usr/bin/env python3
"""
Mock GPU model API (stdlib only) — lets the proxy and the pipeline be tested
end-to-end without the real YOLOv7-tiny ANPR server.

    python pipeline/detect/mock_model_server.py --port 8765 --api_key dev-key
    # then: DETECTION_API_URL=http://127.0.0.1:8765/detect DETECTION_API_KEY=dev-key

Endpoints
    GET  /health  -> {"status":"ok", ...}                      (no key needed)
    POST /detect  -> YOLO-style JSON; requires the key in
                     `Authorization: Bearer <key>` or the header given by --auth_header.
                     Accepts multipart (field `image`), JSON ({"image": base64}) or raw JPEG/PNG.

Response (a plausible real-world shape the adapters must handle):
    {"model": "yolov7-tiny-anpr", "version": "mock-1", "inference_ms": 7.3,
     "image": {"width": W, "height": H},
     "predictions": [{"class": "car", "confidence": 0.93, "xyxy": [x1,y1,x2,y2],
                      "plate": {"text": "DL 01 AB 1234", "confidence": 0.98}}]}

Vehicles are synthetic: 3 cars drift across the frame as `frame_timestamp_sec`
advances, so the tracker produces stable IDs and plates.
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


class MockModelHandler(BaseHTTPRequestHandler):
    server_version = "MockANPR/1.0"
    api_key = "dev-key"
    auth_header = "Authorization"
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
        if self.auth_header.lower() == "authorization":
            return self.headers.get("Authorization", "") == f"Bearer {self.api_key}"
        return self.headers.get(self.auth_header, "") == self.api_key

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            return self._send(200, {"status": "ok", "model": "yolov7-tiny-anpr", "version": "mock-1"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/detect":
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(401, {"error": "invalid or missing API key"})
        with self.lock:
            type(self).calls += 1
            n = type(self).calls
        if n <= self.fail_first:
            return self._send(503, {"error": "warming up"})

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
                "model": "yolov7-tiny-anpr",
                "version": "mock-1",
                "inference_ms": round(5 + seed % 50 / 10, 1),
                "image": {"width": size[0], "height": size[1]},
                "predictions": mock_predictions(size, ts),
            },
        )


def start_server(
    host: str = "127.0.0.1",
    port: int = 0,
    api_key: str = "dev-key",
    auth_header: str = "Authorization",
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
    p = argparse.ArgumentParser(description="Mock YOLOv7-tiny ANPR model API")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--api_key", default=os.environ.get("DETECTION_API_KEY") or "dev-key")
    p.add_argument("--auth_header", default=os.environ.get("DETECTION_API_AUTH_HEADER") or "Authorization")
    p.add_argument("--delay_ms", type=int, default=0, help="Simulated inference delay")
    args = p.parse_args()
    server, thread = start_server(args.host, args.port, args.api_key, args.auth_header, args.delay_ms)
    host, port = server.server_address[:2]
    print(f"Mock model API on http://{host}:{port}  (POST /detect, GET /health; auth header: {args.auth_header})")
    try:
        thread.join()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
