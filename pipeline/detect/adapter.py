"""
Model API adapter (Python twin of api/_lib/modelAdapter.ts).

THE ONE PLACE in the Python pipeline that knows the GPU model API contract.

Primary contract — the team's LPU ANPR server (``api_server.py`` on the GPU
box, Tailscale/LAN only; detector DEIM ``deim50k`` + PARSeq OCR ``raw35``):

    POST <base>/v1/frame?tiles=2x3&roi_top=0.33&min_conf=60
         body = raw JPEG/PNG, header ``X-API-Key: <key>``
      -> {"image": {"width", "height"}, "engine": "lpu_on_gpu",
          "model_version": "deim50k+raw35", "inference_ms", "latency_ms",
          "detections": [{"plate": "MH02FG0919" | "Not Found", "ocr_confidence": 0-100,
                          "raw_ocr", "grammar_valid", "plate_score",
                          "plate_box_xywh": [x, y, w, h], "vehicle_class": "Car"|"Bike"|...,
                          "vehicle_confidence", "vehicle_box_xywh": [x, y, w, h]}]}
    POST <base>/v1/video?frame_step=1&tiles=2x3  (raw mp4) -> {"events": [one per vehicle]}
    GET  <base>/health  (no key)

Boxes are TOP-LEFT x/y + width/height in pixels of the submitted image.
``normalise_upstream_response()`` maps that natively; the older tolerant
YOLO-style shape readers stay as a fallback for other/legacy servers.

Normalised detection (both twins):
    {"plate_text": str|None, "plate_confidence": 0..1|None,
     "vehicle_type": "car"|"truck"|"bus"|"motorcycle"|"unknown",
     "confidence": float, "bbox": {"x","y","width","height"},   # frame pixels
     # real-contract extras (None/absent for legacy servers):
     "vehicle_class": "Car"|..., "grammar_valid": bool|None, "raw_ocr": str|None,
     "plate_bbox": {...}|None, "bbox_source": "vehicle"|"plate"}
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
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

DEFAULT_ENGINE = "lpu_on_gpu"
DEFAULT_TIMEOUT_MS = 15000
DEFAULT_AUTH_HEADER = "X-API-Key"
#: Default query for /v1/frame — wide overhead city views need 2x3 tiling.
DEFAULT_FRAME_QUERY = "tiles=2x3&roi_top=0.33&min_conf=60"
#: A plate read counts as "good" (shown as text) at/above this OCR confidence (0-100) + valid grammar.
GOOD_READ_MIN_CONF = 75.0
NOT_FOUND = "not found"


# ──────────────────────────────────────────────────────────────────────
# Config (server/pipeline env only — never VITE_ prefixed)
# ──────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ModelApiConfig:
    url: str
    api_key: str
    auth_header: str = DEFAULT_AUTH_HEADER
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    request_format: str = "raw"  # raw (real API) | multipart | json (legacy servers)
    image_field: str = "image"
    health_url: str | None = None
    query: str = DEFAULT_FRAME_QUERY
    video_url: str | None = None

    def __repr__(self) -> str:  # never print the key or the URL
        return (
            f"ModelApiConfig(url=<set>, api_key=<redacted>, auth_header={self.auth_header!r}, "
            f"timeout_ms={self.timeout_ms}, request_format={self.request_format!r}, query={self.query!r})"
        )


def read_model_api_config(env: Mapping[str, str] | None = None) -> ModelApiConfig | None:
    """Reads config from env. Returns None when URL or key is missing/invalid.

    ``DETECTION_API_URL`` is the frame endpoint (…/v1/frame); when only
    ``ANPR_API_BASE`` is set, ``<base>/v1/frame`` is used.
    """
    env = os.environ if env is None else env
    base = (env.get("ANPR_API_BASE") or "").strip().rstrip("/")
    url = (env.get("DETECTION_API_URL") or "").strip() or (f"{base}/v1/frame" if base else "")
    key = (env.get("DETECTION_API_KEY") or "").strip()
    if not url or not key or not re.match(r"^https?://", url):
        return None
    try:
        timeout = int(float(env.get("DETECTION_API_TIMEOUT_MS") or DEFAULT_TIMEOUT_MS))
    except ValueError:
        timeout = DEFAULT_TIMEOUT_MS
    fmt = (env.get("DETECTION_API_REQUEST_FORMAT") or "raw").strip().lower()
    query = env.get("DETECTION_API_QUERY")
    video = (env.get("DETECTION_API_VIDEO_URL") or "").strip() or None
    return ModelApiConfig(
        url=url,
        api_key=key,
        auth_header=(env.get("DETECTION_API_AUTH_HEADER") or DEFAULT_AUTH_HEADER).strip() or DEFAULT_AUTH_HEADER,
        timeout_ms=timeout if timeout > 0 else DEFAULT_TIMEOUT_MS,
        request_format=fmt if fmt in ("json", "multipart") else "raw",
        image_field=(env.get("DETECTION_API_IMAGE_FIELD") or "image").strip() or "image",
        health_url=(env.get("DETECTION_API_HEALTH_URL") or "").strip() or None,
        query=DEFAULT_FRAME_QUERY if query is None else query.strip().lstrip("?"),
        video_url=video,
    )


def build_auth_headers(cfg: ModelApiConfig) -> dict:
    """``Authorization: Bearer <key>`` for the Authorization header; any other header gets the raw key."""
    if cfg.auth_header.lower() == "authorization":
        return {"Authorization": f"Bearer {cfg.api_key}"}
    return {cfg.auth_header: cfg.api_key}


def _origin(url: str) -> str:
    m = re.match(r"^(https?://[^/?#]+)", url)
    return m.group(1) if m else url


def default_health_url(cfg: ModelApiConfig) -> str:
    return cfg.health_url or f"{_origin(cfg.url)}/health"


def default_video_url(cfg: ModelApiConfig) -> str:
    return cfg.video_url or f"{_origin(cfg.url)}/v1/video"


def with_query(url: str, query: str | Mapping[str, Any] | None) -> str:
    """Adds ``query`` params to ``url``; params already in the URL win."""
    extra = parse_qsl(query, keep_blank_values=True) if isinstance(query, str) else list((query or {}).items())
    if not extra:
        return url
    parts = urlsplit(url)
    have = parse_qsl(parts.query, keep_blank_values=True)
    names = {k for k, _ in have}
    merged = have + [(k, str(v)) for k, v in extra if k not in names]
    return urlunsplit(parts._replace(query=urlencode(merged)))


def frame_request_url(cfg: ModelApiConfig) -> str:
    return with_query(cfg.url, cfg.query)


def parse_tiles(query: str | None) -> tuple[int, int, float]:
    """(rows, cols, roi_top) from a /v1/frame query string (server defaults: 1x1, roi_top 0.33 when tiled)."""
    q = dict(parse_qsl(query or ""))
    rows, cols = 1, 1
    m = re.match(r"^(\d+)x(\d+)$", (q.get("tiles") or "").strip())
    if m:
        rows, cols = max(1, int(m.group(1))), max(1, int(m.group(2)))
    tiled = rows * cols > 1
    try:
        roi = float(q["roi_top"]) if "roi_top" in q else (0.33 if tiled else 0.0)
    except ValueError:
        roi = 0.33 if tiled else 0.0
    return rows, cols, min(max(roi, 0.0), 0.9)


# ──────────────────────────────────────────────────────────────────────
# REQUEST
# ──────────────────────────────────────────────────────────────────────
def build_upstream_request(
    cfg: ModelApiConfig,
    image_bytes: bytes,
    mime_type: str = "image/jpeg",
    camera_code: str | None = None,
    frame_timestamp_sec: float | None = None,
) -> tuple[dict, bytes]:
    """Returns (headers, body) for the POST to ``frame_request_url(cfg)``.

    The real API takes the raw image bytes (``request_format="raw"``, the
    default); multipart/json are kept for legacy servers.
    """
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
# RESPONSE
# ──────────────────────────────────────────────────────────────────────
class UpstreamShapeError(ValueError):
    """The model API answered, but with no recognisable detection list."""


#: Real-contract vehicle classes -> dashboard VehicleType (raw class is kept in ``vehicle_class``).
LPU_VEHICLE_CLASSES = {
    "car": "car", "auto": "car",
    "bike": "motorcycle",
    "bus": "bus",
    "truck": "truck", "lcv": "truck", "mini-lcv": "truck", "mini_lcv": "truck", "tractor": "truck",
}
_LPU_KEYS = ("vehicle_box_xywh", "plate_box_xywh", "ocr_confidence", "grammar_valid")


def is_lpu_response(raw: Any) -> bool:
    """True for the real LPU API shape (a ``detections``/``events`` list of plate+vehicle records)."""
    if not isinstance(raw, dict):
        return False
    items = raw.get("detections", raw.get("events"))
    if not isinstance(items, list):
        return False
    if not items:
        return str(raw.get("engine") or "").startswith("lpu") or "model_version" in raw
    return isinstance(items[0], dict) and any(k in items[0] for k in _LPU_KEYS)


def xywh_box(v: Any) -> dict | None:
    """``[x, y, w, h]`` (top-left + size, pixels) -> {x, y, width, height}; None when absent/invalid."""
    if not isinstance(v, (list, tuple)) or len(v) < 4:
        return None
    vals = [_num(x) for x in v[:4]]
    if any(x is None for x in vals) or not (vals[2] > 0 and vals[3] > 0):  # type: ignore[operator]
        return None
    x, y, w, h = vals
    return {"x": round(x, 1), "y": round(y, 1), "width": round(w, 1), "height": round(h, 1)}  # type: ignore[arg-type]


def is_tile_artifact(box: dict, image: tuple[int, int] | None, tiles: tuple[int, int, float] | None) -> bool:
    """True for a vehicle box that spans (almost) a whole detector tile.

    With tiling the vehicle detector often answers "the whole tile is one
    truck/bus" — boxes of exactly tile size at tile offsets. Real vehicles in
    these views are far smaller than a tile, so such boxes are dropped (a plate
    inside one is kept, drawn at its plate box instead).
    """
    if not image or not tiles or image[0] <= 0 or image[1] <= 0:
        return False
    rows, cols, roi = tiles
    tile_w = image[0] / cols
    tile_h = image[1] * (1 - roi) / rows
    return box["width"] >= 0.75 * tile_w and box["height"] >= 0.75 * tile_h


def vehicle_type_from_class(cls: Any) -> str:
    if isinstance(cls, str) and cls.strip():
        k = cls.strip().lower()
        return LPU_VEHICLE_CLASSES.get(k) or VEHICLE_ALIASES.get(re.sub(r"[\s-]+", "_", k), "unknown")
    return "unknown"


def normalise_lpu_detection(
    item: dict, image: tuple[int, int] | None = None, tiles: tuple[int, int, float] | None = None
) -> dict | None:
    """One real-contract detection/event -> normalised detection (None when it has no usable box)."""
    plate = item.get("plate")
    has_plate = isinstance(plate, str) and plate.strip() and plate.strip().lower() != NOT_FOUND
    ocr = _num(item.get("ocr_confidence"))
    vbox = xywh_box(item.get("vehicle_box_xywh"))
    pbox = xywh_box(item.get("plate_box_xywh"))
    if vbox and is_tile_artifact(vbox, image, tiles):
        vbox = None
    bbox, source = (vbox, "vehicle") if vbox else (pbox, "plate")
    if bbox is None or (source == "plate" and not has_plate):
        return None
    vconf = _num(item.get("vehicle_confidence"))
    pscore = _num(item.get("plate_score"))
    conf = vconf if vconf is not None else (pscore if pscore is not None else (ocr / 100 if ocr is not None else 0.0))
    gv = item.get("grammar_valid")
    raw_ocr = item.get("raw_ocr")
    return {
        "plate_text": normalise_plate_text(plate) if has_plate else None,
        "plate_confidence": None if (ocr is None or not has_plate) else round(_clamp01(ocr / 100), 4),
        "vehicle_type": vehicle_type_from_class(item.get("vehicle_class")),
        "confidence": round(_clamp01(conf), 4),
        "bbox": bbox,
        "vehicle_class": item.get("vehicle_class") if isinstance(item.get("vehicle_class"), str) else None,
        "grammar_valid": gv if isinstance(gv, bool) else None,
        "raw_ocr": raw_ocr if isinstance(raw_ocr, str) and raw_ocr else None,
        "plate_bbox": pbox,
        "bbox_source": source,
    }


def is_good_read(det: Mapping[str, Any], min_conf: float = GOOD_READ_MIN_CONF) -> bool:
    """A plate text worth showing: OCR confidence >= min_conf (0-100) and valid Indian plate grammar."""
    pc = det.get("plate_confidence")
    return bool(det.get("plate_text")) and det.get("grammar_valid") is True and pc is not None and pc * 100 >= min_conf - 1e-9


def normalise_upstream_response(
    raw: Any, image: tuple[int, int] | None = None, tiles: tuple[int, int, float] | None = None
) -> dict:
    """Maps the model API response to {engine, model_version, inference_ms, image, detections}.

    ``image`` is (width, height) of the frame that was sent (the real API also
    reports it); ``tiles`` is ``parse_tiles(query)`` of the request, used to
    drop tile-sized vehicle-box artefacts.
    """
    if is_lpu_response(raw):
        img = raw.get("image") if isinstance(raw.get("image"), dict) else None
        size = (int(img["width"]), int(img["height"])) if img and _num(img.get("width")) and _num(img.get("height")) else image
        items = raw.get("detections", raw.get("events")) or []
        dets = [d for d in (normalise_lpu_detection(i, size, tiles) for i in items if isinstance(i, dict)) if d]
        return {
            "engine": _str(raw.get("engine")) or DEFAULT_ENGINE,
            "model_version": _str(raw.get("model_version")) or "unknown",
            "inference_ms": _read_inference_ms(raw),
            "image": {"width": size[0], "height": size[1]} if size else None,
            "detections": dets,
        }

    # ── fallback: tolerant reader for other / legacy YOLO-style servers ──
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
        "engine": _str(_pick(meta, ["engine"])) or "unknown",
        "model_version": _str(_pick(meta, ["model_version", "version", "model", "model_name"])) or "unknown",
        "inference_ms": _read_inference_ms(meta),
        "image": {"width": image[0], "height": image[1]} if image else None,
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
