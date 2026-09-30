"""
Model API adapter (Python twin of api/_lib/modelAdapter.ts).

THE ONE PLACE in the Python pipeline that knows the GPU model API contract.
When the real contract is known:

  1. REQUEST  -> edit ``build_upstream_request()`` (or set
                 DETECTION_API_REQUEST_FORMAT / DETECTION_API_IMAGE_FIELD).
  2. RESPONSE -> edit ``normalise_upstream_response()``. The helpers below
                 already accept the common YOLO-API shapes; for anything
                 else, map the real fields directly in that function.
  3. Mirror the change in api/_lib/modelAdapter.ts (Vercel proxy) and update
     pipeline/tests/test_remote_adapter.py +
     src/features/detections/remote/modelAdapter.test.ts.

Normalised detection (both twins):
    {"plate_text": str|None, "plate_confidence": float|None,
     "vehicle_type": "car"|"truck"|"bus"|"motorcycle"|"unknown",
     "confidence": float, "bbox": {"x","y","width","height"}}   # frame pixels
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

DEFAULT_ENGINE = "yolov7-tiny-anpr"
DEFAULT_TIMEOUT_MS = 15000


# ──────────────────────────────────────────────────────────────────────
# Config (server/pipeline env only — never VITE_ prefixed)
# ──────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ModelApiConfig:
    url: str
    api_key: str
    auth_header: str = "Authorization"
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    request_format: str = "multipart"  # multipart | json | raw
    image_field: str = "image"
    health_url: str | None = None

    def __repr__(self) -> str:  # never print the key
        return (
            f"ModelApiConfig(url=<set>, api_key=<redacted>, auth_header={self.auth_header!r}, "
            f"timeout_ms={self.timeout_ms}, request_format={self.request_format!r})"
        )


def read_model_api_config(env: Mapping[str, str] | None = None) -> ModelApiConfig | None:
    """Reads config from env. Returns None when URL or key is missing/invalid."""
    env = os.environ if env is None else env
    url = (env.get("DETECTION_API_URL") or "").strip()
    key = (env.get("DETECTION_API_KEY") or "").strip()
    if not url or not key or not re.match(r"^https?://", url):
        return None
    try:
        timeout = int(float(env.get("DETECTION_API_TIMEOUT_MS") or DEFAULT_TIMEOUT_MS))
    except ValueError:
        timeout = DEFAULT_TIMEOUT_MS
    fmt = (env.get("DETECTION_API_REQUEST_FORMAT") or "multipart").strip().lower()
    return ModelApiConfig(
        url=url,
        api_key=key,
        auth_header=(env.get("DETECTION_API_AUTH_HEADER") or "Authorization").strip() or "Authorization",
        timeout_ms=timeout if timeout > 0 else DEFAULT_TIMEOUT_MS,
        request_format=fmt if fmt in ("json", "raw") else "multipart",
        image_field=(env.get("DETECTION_API_IMAGE_FIELD") or "image").strip() or "image",
        health_url=(env.get("DETECTION_API_HEALTH_URL") or "").strip() or None,
    )


def build_auth_headers(cfg: ModelApiConfig) -> dict:
    """``Authorization: Bearer <key>`` by default; custom headers get the raw key."""
    if cfg.auth_header.lower() == "authorization":
        return {"Authorization": f"Bearer {cfg.api_key}"}
    return {cfg.auth_header: cfg.api_key}


def default_health_url(cfg: ModelApiConfig) -> str:
    if cfg.health_url:
        return cfg.health_url
    m = re.match(r"^(https?://[^/]+)", cfg.url)
    return f"{m.group(1)}/health" if m else cfg.url


# ──────────────────────────────────────────────────────────────────────
# REQUEST  <- change here once the real contract is known
# ──────────────────────────────────────────────────────────────────────
def build_upstream_request(
    cfg: ModelApiConfig,
    image_bytes: bytes,
    mime_type: str = "image/jpeg",
    camera_code: str | None = None,
    frame_timestamp_sec: float | None = None,
) -> tuple[dict, bytes]:
    """Returns (headers, body) for the POST to cfg.url."""
    headers = {"Accept": "application/json", **build_auth_headers(cfg)}
    ext = "png" if mime_type == "image/png" else "jpg"

    if cfg.request_format == "raw":
        headers["Content-Type"] = mime_type
        if camera_code:
            headers["X-Camera-Code"] = camera_code
        return headers, image_bytes

    if cfg.request_format == "json":
        payload: dict[str, Any] = {cfg.image_field: base64.b64encode(image_bytes).decode("ascii")}
        if camera_code:
            payload["camera_code"] = camera_code
        if frame_timestamp_sec is not None:
            payload["frame_timestamp_sec"] = frame_timestamp_sec
        headers["Content-Type"] = "application/json"
        return headers, json.dumps(payload).encode("utf-8")

    boundary = f"----nero{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    parts.append(
        (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{cfg.image_field}\"; "
            f"filename=\"frame.{ext}\"\r\nContent-Type: {mime_type}\r\n\r\n"
        ).encode()
        + image_bytes
        + b"\r\n"
    )
    if camera_code:
        field("camera_code", camera_code)
    if frame_timestamp_sec is not None:
        field("frame_timestamp_sec", str(frame_timestamp_sec))
    parts.append(f"--{boundary}--\r\n".encode())
    headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    return headers, b"".join(parts)


# ──────────────────────────────────────────────────────────────────────
# RESPONSE  <- change here once the real contract is known
# ──────────────────────────────────────────────────────────────────────
class UpstreamShapeError(ValueError):
    """The model API answered, but with no recognisable detection list."""


def normalise_upstream_response(raw: Any, image: tuple[int, int] | None = None) -> dict:
    """Maps the model API response to {engine, model_version, inference_ms, detections}.

    ``image`` is (width, height) of the frame that was sent; used to scale 0..1 boxes.
    """
    items = find_detection_array(raw)
    if items is None:
        raise UpstreamShapeError("Model API response contained no detection list")
    meta = raw if isinstance(raw, dict) else {}

    detections = []
    for entry in items:
        item = entry
        if isinstance(entry, (list, tuple)) and len(entry) >= 6 and all(_is_num(v) for v in entry):
            item = {"xyxy": list(entry[:4]), "confidence": entry[4], "class_id": entry[5]}
        if not isinstance(item, dict):
            continue
        bbox = read_box(item, image)
        if bbox is None:
            continue
        plate_text, plate_conf = read_plate(item)
        conf = _num(_pick(item, CONFIDENCE_KEYS))
        if conf is None:
            conf = plate_conf if plate_conf is not None else 0.0
        detections.append(
            {
                "plate_text": plate_text,
                "plate_confidence": plate_conf,
                "vehicle_type": read_vehicle_type(item),
                "confidence": round(_clamp01(conf), 4),
                "bbox": bbox,
            }
        )

    return {
        "engine": _str(_pick(meta, ["engine"])) or DEFAULT_ENGINE,
        "model_version": _str(_pick(meta, ["model_version", "version", "model", "model_name"])) or "unknown",
        "inference_ms": _read_inference_ms(meta),
        "detections": detections,
    }


# ── shape helpers ─────────────────────────────────────────────────────
LIST_KEYS = ["detections", "predictions", "results", "objects", "plates", "vehicles", "boxes", "output", "data"]
CONFIDENCE_KEYS = ["confidence", "conf", "score", "probability", "prob"]
CLASS_KEYS = ["vehicle_type", "vehicle_class", "class_name", "label", "name", "category", "class", "cls", "class_id"]
PLATE_KEYS = ["plate_text", "plate", "license_plate", "number_plate", "plate_number", "registration", "text", "ocr", "ocr_text"]
PLATE_CONF_KEYS = ["plate_confidence", "plate_conf", "ocr_confidence", "ocr_conf", "text_confidence", "text_score"]
COCO_VEHICLE_IDS = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
VEHICLE_ALIASES = {
    "car": "car", "suv": "car", "van": "car", "jeep": "car", "taxi": "car", "sedan": "car", "hatchback": "car",
    "truck": "truck", "lorry": "truck", "tempo": "truck", "pickup": "truck",
    "bus": "bus", "minibus": "bus",
    "motorcycle": "motorcycle", "motorbike": "motorcycle", "bike": "motorcycle", "scooter": "motorcycle",
    "two_wheeler": "motorcycle", "twowheeler": "motorcycle", "moped": "motorcycle",
}
_DETECTION_HINT_KEYS = ("bbox", "box", "xyxy", "xywh", "x1", "xmin", "bounding_box", "x")


def find_detection_array(raw: Any, depth: int = 0) -> list | None:
    if depth > 3:
        return None
    if isinstance(raw, list):
        if raw and all(isinstance(r, list) for r in raw):
            return raw if all(_is_num(v) for v in raw[0]) else raw[0]
        if len(raw) == 1 and isinstance(raw[0], dict) and not any(k in raw[0] for k in _DETECTION_HINT_KEYS):
            found = find_detection_array(raw[0], depth + 1)
            return found if found is not None else raw
        return raw
    if not isinstance(raw, dict):
        return None
    for key in LIST_KEYS:
        if key in raw:
            found = find_detection_array(raw[key], depth + 1)
            if found is not None:
                return found
    return None


def read_box(item: dict, image: tuple[int, int] | None) -> dict | None:
    """Box in frame pixels as {x, y, width, height} (top-left + size). See TS twin for shapes."""
    array_key = next(
        (
            k
            for k in ("xyxy", "xyxyn", "xywh", "xywhn", "tlwh", "ltwh", "bbox", "box", "bounding_box", "rect")
            if isinstance(item.get(k), (list, tuple)) and len(item[k]) >= 4
        ),
        None,
    )
    obj_key = next((k for k in ("bbox", "box", "bounding_box", "rect") if isinstance(item.get(k), dict)), None)
    normalised_hint = False

    if array_key:
        vals = [_num(v) for v in list(item[array_key])[:4]]
        if any(v is None for v in vals):
            return None
        a, b, c, d = vals  # type: ignore[misc]
        normalised_hint = array_key.endswith("n")
        if array_key.startswith("xywh"):
            x1, y1, x2, y2 = a - c / 2, b - d / 2, a + c / 2, b + d / 2
        elif array_key in ("tlwh", "ltwh"):
            x1, y1, x2, y2 = a, b, a + c, b + d
        elif array_key.startswith("xyxy") or (c > a and d > b):
            x1, y1, x2, y2 = a, b, c, d
        else:
            x1, y1, x2, y2 = a, b, a + c, b + d
    else:
        corners = _read_corners(item[obj_key] if obj_key else item)
        if corners is None:
            return None
        x1, y1, x2, y2 = corners

    all_unit = all(0 <= v <= 1.0001 for v in (x1, y1, x2, y2))
    if (normalised_hint or all_unit) and image and image[0] > 0 and image[1] > 0:
        x1, x2 = x1 * image[0], x2 * image[0]
        y1, y2 = y1 * image[1], y2 * image[1]
    w, h = x2 - x1, y2 - y1
    if not (w > 0 and h > 0):
        return None
    return {"x": round(x1, 1), "y": round(y1, 1), "width": round(w, 1), "height": round(h, 1)}


def _read_corners(o: dict) -> tuple | None:
    for keys in (("x1", "y1", "x2", "y2"), ("xmin", "ymin", "xmax", "ymax"), ("left", "top", "right", "bottom")):
        v = [_num(o.get(k)) for k in keys]
        if all(n is not None for n in v):
            return tuple(v)
    for keys in (("x", "y", "width", "height"), ("x", "y", "w", "h"), ("left", "top", "width", "height")):
        x, y, w, h = (_num(o.get(k)) for k in keys)
        if None not in (x, y, w, h):
            return (x, y, x + w, y + h)
    return None


def read_plate(item: dict) -> tuple[str | None, float | None]:
    text = None
    conf = _num(_pick(item, PLATE_CONF_KEYS))
    for key in PLATE_KEYS:
        v = item.get(key)
        if isinstance(v, str) and v.strip():
            text = v
            break
        if isinstance(v, dict):
            inner = _pick(v, ["text", "plate_text", "value", "number", "ocr"])
            if isinstance(inner, str) and inner.strip():
                text = inner
                if conf is None:
                    conf = _num(_pick(v, ["confidence", "conf", "score", *PLATE_CONF_KEYS]))
                break
    return (
        normalise_plate_text(text) if text else None,
        None if conf is None else round(_clamp01(conf), 4),
    )


def normalise_plate_text(text: str) -> str:
    """Upper-case, strip punctuation, collapse whitespace (keeps model spacing)."""
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]+", " ", text.upper())).strip()


def read_vehicle_type(item: dict) -> str:
    for key in CLASS_KEYS:
        v = item.get(key)
        if _is_num(v) and key != "vehicle_type":
            vt = COCO_VEHICLE_IDS.get(int(v))
            if vt:
                return vt
            continue
        if isinstance(v, str) and v.strip():
            k = re.sub(r"[\s-]+", "_", v.strip().lower())
            if k in VEHICLE_ALIASES:
                return VEHICLE_ALIASES[k]
    return "unknown"


def _read_inference_ms(meta: dict) -> float | None:
    direct = _num(_pick(meta, ["inference_ms", "inference_time_ms", "latency_ms", "time_ms"]))
    if direct is not None:
        return round(direct, 1)
    speed = meta.get("speed")
    if isinstance(speed, dict) and _num(speed.get("inference")) is not None:
        return round(_num(speed.get("inference")), 1)  # type: ignore[arg-type]
    secs = _num(_pick(meta, ["inference_time", "inference_s"]))
    return None if secs is None else round(secs * 1000, 1)


# ── tiny utils ────────────────────────────────────────────────────────
def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _num(v: Any) -> float | None:
    if isinstance(v, str) and v.strip():
        try:
            v = float(v)
        except ValueError:
            return None
    return float(v) if _is_num(v) else None


def _pick(o: dict, keys: list) -> Any:
    for k in keys:
        if o.get(k) is not None:
            return o[k]
    return None


def _str(v: Any) -> str | None:
    if isinstance(v, str) and v.strip():
        return v.strip()
    if _is_num(v):
        return str(v)
    return None


def _clamp01(n: float) -> float:
    v = n / 100 if 1 < n <= 100 else n
    return min(1.0, max(0.0, v))
