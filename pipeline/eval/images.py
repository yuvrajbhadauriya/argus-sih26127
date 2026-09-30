"""
Image helpers for the evaluation: decode / resize / crop / thumbnail, the
condition heuristics used for untagged datasets, and a tiny synthetic plate
renderer (stdlib PNG writer + 5x7 bitmap font) for the offline mock run.

Decoding uses OpenCV when the real module is installed, then Pillow, else
returns None (heuristic tags are then simply "unknown" — never guessed).
"""

from __future__ import annotations

import struct
import zlib

try:  # numpy is in both the pipeline and the test requirements
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]


# ──────────────────────────────────────────────────────────────────────
# Decoding / encoding (optional backends)
# ──────────────────────────────────────────────────────────────────────
def _cv2():
    try:
        import cv2  # noqa: PLC0415
    except ImportError:
        return None
    return cv2 if hasattr(cv2, "imdecode") and hasattr(cv2, "imencode") else None  # test stub lacks these


def _pil():
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return None
    return Image


def decode_gray(data: bytes):
    """Bytes -> 2-D uint8 numpy array (grayscale), or None if no decoder is available."""
    if np is None:
        return None
    cv2 = _cv2()
    if cv2 is not None:
        arr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
        return arr
    Image = _pil()
    if Image is not None:
        import io

        try:
            return np.asarray(Image.open(io.BytesIO(data)).convert("L"))
        except Exception:  # noqa: BLE001
            return None
    return None


def image_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) from PNG/JPEG headers without decoding."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return int(w), int(h)
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
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = (data[i + 2] << 8) | data[i + 3]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return (data[i + 7] << 8) | data[i + 8], (data[i + 5] << 8) | data[i + 6]
            i += 2 + length
    return None


def downscale_jpeg(data: bytes, max_side: int, quality: int = 90) -> tuple[bytes, float]:
    """Re-encodes to JPEG with the longest side <= max_side. Returns (bytes, scale).

    Returns the original bytes and scale 1.0 when no resize is needed or no
    backend is available.
    """
    size = image_size(data)
    if not size or max(size) <= max_side or max_side <= 0:
        return data, 1.0
    scale = max_side / max(size)
    new = (max(1, round(size[0] * scale)), max(1, round(size[1] * scale)))
    cv2 = _cv2()
    if cv2 is not None and np is not None:
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is not None:
            img = cv2.resize(img, new, interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            if ok:
                return bytes(buf), scale
    Image = _pil()
    if Image is not None:
        import io

        try:
            im = Image.open(io.BytesIO(data)).convert("RGB").resize(new)
            out = io.BytesIO()
            im.save(out, "JPEG", quality=quality)
            return out.getvalue(), scale
        except Exception:  # noqa: BLE001
            pass
    return data, 1.0


def pad_image(data: bytes, frac: float, value: int = 114) -> tuple[bytes, tuple[int, int] | None]:
    """Adds a uniform grey border of ``frac`` × width/height on every side (tight plate crops
    give the plate detector no context). Returns (bytes, (dx, dy)) or (data, None) without a backend."""
    size = image_size(data)
    if not size or frac <= 0:
        return data, None
    dx, dy = max(1, round(size[0] * frac)), max(1, round(size[1] * frac))
    cv2 = _cv2()
    if cv2 is not None and np is not None:
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is not None:
            img = cv2.copyMakeBorder(img, dy, dy, dx, dx, cv2.BORDER_CONSTANT, value=(value, value, value))
            ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            if ok:
                return bytes(buf), (dx, dy)
    Image = _pil()
    if Image is not None:
        import io

        try:
            im = Image.open(io.BytesIO(data)).convert("RGB")
            canvas = Image.new("RGB", (im.width + 2 * dx, im.height + 2 * dy), (value, value, value))
            canvas.paste(im, (dx, dy))
            out = io.BytesIO()
            canvas.save(out, "JPEG", quality=92)
            return out.getvalue(), (dx, dy)
        except Exception:  # noqa: BLE001
            pass
    return data, None


def thumbnail_jpeg(data: bytes, box: list[float] | None, max_w: int = 160, pad: float = 0.15) -> bytes | None:
    """Small JPEG of the plate region (or the whole image). None if no backend."""
    Image = _pil()
    cv2 = _cv2()
    if cv2 is not None and np is not None:
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        img = _crop_arr(img, box, pad)
        h, w = img.shape[:2]
        if w > max_w:
            img = cv2.resize(img, (max_w, max(1, round(h * max_w / w))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return bytes(buf) if ok else None
    if Image is not None and np is not None:
        import io

        try:
            arr = _crop_arr(np.asarray(Image.open(io.BytesIO(data)).convert("RGB")), box, pad)
            im = Image.fromarray(arr)
            if im.width > max_w:
                im = im.resize((max_w, max(1, round(im.height * max_w / im.width))))
            out = io.BytesIO()
            im.save(out, "JPEG", quality=80)
            return out.getvalue()
        except Exception:  # noqa: BLE001
            return None
    return None


def _crop_arr(img, box, pad):
    if not box:
        return img
    h, w = img.shape[:2]
    x, y, bw, bh = box
    x0, y0 = int(max(0, x - bw * pad)), int(max(0, y - bh * pad))
    x1, y1 = int(min(w, x + bw * (1 + pad))), int(min(h, y + bh * (1 + pad)))
    return img[y0:y1, x0:x1] if x1 > x0 and y1 > y0 else img


# ──────────────────────────────────────────────────────────────────────
# Condition heuristics (for datasets without condition labels)
# ──────────────────────────────────────────────────────────────────────
NIGHT_MEAN_MAX = 70.0        # mean luma of the plate region / frame below this -> "night / low light"
BLUR_LAPVAR_MAX = 60.0       # variance of the Laplacian below this -> "blur"
LOW_RES_HEIGHT_MAX = 20      # plate height in pixels below this -> "low_res"


def laplacian_variance(gray) -> float:
    """Variance of the 4-neighbour Laplacian (the classic focus / blur measure)."""
    g = gray.astype(np.float64)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1] - 4 * g[1:-1, 1:-1]
    return float(lap.var())


def heuristic_conditions(gray, plate_box: list[float] | None = None) -> tuple[list[str], dict]:
    """Returns (tags, measurements). Tags ⊂ {day, night, blur, sharp, low_res}.

    Night/day uses the whole frame's mean luma (a lit plate in a dark scene is
    still a night shot); blur uses the plate region when a box is given.
    """
    if gray is None or np is None or gray.size == 0:
        return [], {}
    mean = float(gray.mean())
    region = _crop_arr(gray, plate_box, 0.0) if plate_box else gray
    lv = laplacian_variance(region)
    tags = ["night" if mean < NIGHT_MEAN_MAX else "day", "blur" if lv < BLUR_LAPVAR_MAX else "sharp"]
    plate_h = plate_box[3] if plate_box else gray.shape[0]
    if plate_h < LOW_RES_HEIGHT_MAX:
        tags.append("low_res")
    return tags, {"mean_luma": round(mean, 1), "laplacian_var": round(lv, 1), "plate_height_px": round(float(plate_h), 1)}


# ──────────────────────────────────────────────────────────────────────
# Synthetic plates (offline mock run only) — stdlib PNG + 5x7 font
# ──────────────────────────────────────────────────────────────────────
_FONT = {
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11100 10010 10001 10001 10001 10010 11100",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 10001 11001 10101 10011 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    " ": "00000 00000 00000 00000 00000 00000 00000",
}


def render_plate_gray(text: str, scale: int = 3, bg: int = 235, fg: int = 20) -> list[list[int]]:
    """Rows of grayscale pixels for a white plate with dark characters and a border."""
    glyphs = [_FONT.get(c, _FONT[" "]).split() for c in text.upper()]
    pad = 2 * scale
    w = pad * 2 + len(glyphs) * 6 * scale
    h = pad * 2 + 7 * scale
    rows = [[bg] * w for _ in range(h)]
    for x in range(w):
        rows[0][x] = rows[h - 1][x] = fg
    for y in range(h):
        rows[y][0] = rows[y][w - 1] = fg
    for gi, g in enumerate(glyphs):
        ox = pad + gi * 6 * scale
        for gy, line in enumerate(g):
            for gx, bit in enumerate(line):
                if bit == "1":
                    for dy in range(scale):
                        for dx in range(scale):
                            rows[pad + gy * scale + dy][ox + gx * scale + dx] = fg
    return rows


def png_gray(rows: list[list[int]]) -> bytes:
    """Encodes 8-bit grayscale rows as PNG (stdlib only)."""
    h, w = len(rows), len(rows[0])
    raw = b"".join(b"\x00" + bytes(max(0, min(255, int(v))) for v in r) for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def synthetic_plate_png(text: str, brightness: float = 1.0, scale: int = 3) -> bytes:
    """A synthetic plate image; brightness < 1 darkens it (night-like)."""
    rows = render_plate_gray(text, scale=scale)
    if brightness != 1.0:
        rows = [[v * brightness for v in r] for r in rows]
    return png_gray(rows)
