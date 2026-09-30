"""
Plate-recognition metrics (pure Python, no deps).

Normalisation
    strict   : upper-case, keep only A-Z / 0-9 (spaces, hyphens, dots, IND strip
               text all removed). This is what "exact plate accuracy" compares.
    lenient  : strict + fold the visually ambiguous pairs O->0 and I->1. Reported
               separately as "lenient accuracy"; never used for the headline.

Matching (per image)
    Ground-truth plates and predicted reads are paired one-to-one. A pair is
    *spatially compatible* when either side has no box (plate crops / text-only
    labels) or the GT plate box overlaps the predicted plate box (IoU >= 0.1, or
    the GT box centre lies inside it). If the prediction also carries a vehicle
    box (``vehicle_bbox``), a GT plate centred inside that vehicle is compatible
    too — the live API occasionally returns an offset plate box for two-row
    plates while reading the text correctly. Compatible pairs are assigned greedily by
    ascending edit distance, then descending prediction confidence. Unassigned
    GT plates are misses (count as wrong, full-length character errors);
    unassigned predictions with text are false reads (lower precision).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

LENIENT_FOLD = str.maketrans({"O": "0", "I": "1"})


def normalise_plate(text: str | None) -> str:
    """Strict normalisation: upper-case, keep only A-Z0-9."""
    if not text:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(text).upper())


def lenient_plate(text: str | None) -> str:
    """Strict normalisation, then O->0 and I->1 (reporting-only metric)."""
    return normalise_plate(text).translate(LENIENT_FOLD)


# ──────────────────────────────────────────────────────────────────────
# Edit distance with alignment (for CER + confusion pairs)
# ──────────────────────────────────────────────────────────────────────
def edit_ops(ref: str, hyp: str) -> list[tuple[str, str, str]]:
    """Levenshtein alignment. Returns ops as (kind, ref_char, hyp_char) where
    kind is 'eq' | 'sub' | 'del' (ref char missing in hyp) | 'ins' (extra hyp char)."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    ops: list[tuple[str, str, str]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", ref[i - 1], ""))
            i -= 1
        else:
            ops.append(("ins", "", hyp[j - 1]))
            j -= 1
    ops.reverse()
    return ops


def edit_distance(ref: str, hyp: str) -> int:
    n, m = len(ref), len(hyp)
    if n == 0:
        return m
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] != hyp[j - 1]))
        prev = cur
    return prev[m]


def cer(ref: str, hyp: str) -> float:
    """Character error rate of one read (edits / len(ref)); 1.0 for an empty ref with any hyp."""
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


# ──────────────────────────────────────────────────────────────────────
# Geometry
# ──────────────────────────────────────────────────────────────────────
def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """IoU of two [x, y, w, h] boxes."""
    xa, ya = max(a[0], b[0]), max(a[1], b[1])
    xb, yb = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, xb - xa) * max(0.0, yb - ya)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def centre_inside(inner: Sequence[float], outer: Sequence[float]) -> bool:
    cx, cy = inner[0] + inner[2] / 2, inner[1] + inner[3] / 2
    return outer[0] <= cx <= outer[0] + outer[2] and outer[1] <= cy <= outer[1] + outer[3]


def spatially_compatible(gt_box: Sequence[float] | None, pred_box: Sequence[float] | None, min_iou: float = 0.1) -> bool:
    if gt_box is None or pred_box is None:
        return True
    return iou(gt_box, pred_box) >= min_iou or centre_inside(gt_box, pred_box)


# ──────────────────────────────────────────────────────────────────────
# Per-image matching
# ──────────────────────────────────────────────────────────────────────
@dataclass
class PlateResult:
    gt: str                       # strict-normalised ground truth
    pred: str                     # strict-normalised matched read ("" = miss)
    detected: bool                # a read was paired with this GT plate
    exact: bool
    lenient_exact: bool
    edits: int                    # edit distance (len(gt) on a miss)
    confidence: float | None = None
    ops: list = field(default_factory=list)


def match_image(gt_plates: Sequence[dict], preds: Sequence[dict]) -> tuple[list[PlateResult], int]:
    """gt_plates: [{"text", "bbox"?: [x,y,w,h]}]; preds: [{"plate_text", "bbox"?: [x,y,w,h], "plate_confidence"?, "confidence"?}].

    Returns (one PlateResult per GT plate with text, number of false reads).
    """
    gts = [(normalise_plate(g.get("text")), g.get("bbox")) for g in gt_plates]
    gts = [(t, b) for t, b in gts if t]
    reads = []
    for p in preds:
        t = normalise_plate(p.get("plate_text"))
        if t:
            conf = p.get("plate_confidence")
            if conf is None:
                conf = p.get("confidence")
            reads.append((t, [b for b in (p.get("bbox"), p.get("vehicle_bbox")) if b] or None, conf))

    pairs = []
    for gi, (gt, gbox) in enumerate(gts):
        for pi, (txt, pboxes, conf) in enumerate(reads):
            if pboxes is None or any(spatially_compatible(gbox, b) for b in pboxes):
                pairs.append((edit_distance(gt, txt), -(conf or 0.0), gi, pi))
    pairs.sort()
    used_g: dict[int, int] = {}
    used_p: set[int] = set()
    for _, _, gi, pi in pairs:
        if gi in used_g or pi in used_p:
            continue
        used_g[gi] = pi
        used_p.add(pi)

    results = []
    for gi, (gt, _) in enumerate(gts):
        if gi in used_g:
            txt, _, conf = reads[used_g[gi]]
            results.append(
                PlateResult(
                    gt=gt, pred=txt, detected=True, exact=gt == txt,
                    lenient_exact=gt.translate(LENIENT_FOLD) == txt.translate(LENIENT_FOLD),
                    edits=edit_distance(gt, txt), confidence=conf, ops=edit_ops(gt, txt),
                )
            )
        else:
            results.append(
                PlateResult(gt=gt, pred="", detected=False, exact=False, lenient_exact=False,
                            edits=len(gt), ops=[("del", c, "") for c in gt])
            )
    return results, len(reads) - len(used_p)


# ──────────────────────────────────────────────────────────────────────
# Aggregation
# ──────────────────────────────────────────────────────────────────────
def percentile(values: Sequence[float], q: float) -> float | None:
    """Linear-interpolated percentile (q in 0..100); None for no data."""
    xs = sorted(v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v)))
    if not xs:
        return None
    if len(xs) == 1:
        return float(xs[0])
    k = (len(xs) - 1) * q / 100
    f, c = math.floor(k), math.ceil(k)
    return float(xs[f] + (xs[c] - xs[f]) * (k - f))


def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def summarise(plates: Iterable[PlateResult], false_reads: int = 0, images: int = 0, api_errors: int = 0,
              latencies: Sequence[float] = (), inference: Sequence[float] = ()) -> dict:
    """Aggregate metrics block (the shape used for overall / per-dataset / per-condition)."""
    ps = list(plates)
    n = len(ps)
    detected = sum(p.detected for p in ps)
    exact = sum(p.exact for p in ps)
    lenient = sum(p.lenient_exact for p in ps)
    chars = sum(len(p.gt) for p in ps)
    edits = sum(p.edits for p in ps)
    reads = detected + false_reads
    lat = [v for v in latencies if v is not None]
    inf = [v for v in inference if v is not None]
    return {
        "images": images,
        "plates": n,
        "detected": detected,
        "exact": exact,
        "lenient_exact": lenient,
        "false_reads": false_reads,
        "api_errors": api_errors,
        "plate_accuracy": _rate(exact, n),
        "lenient_accuracy": _rate(lenient, n),
        "ocr_accuracy": _rate(exact, detected),
        "char_accuracy": round(max(0.0, 1 - edits / chars), 4) if chars else None,
        "detection_recall": _rate(detected, n),
        "plate_miss_rate": _rate(n - detected, n),
        "read_precision": _rate(detected, reads),
        "latency_ms": _lat(lat),
        "inference_ms": _lat(inf),
    }


def _lat(xs: Sequence[float]) -> dict:
    return {
        "n": len(xs),
        "p50": _r1(percentile(xs, 50)),
        "p95": _r1(percentile(xs, 95)),
        "mean": _r1(sum(xs) / len(xs)) if xs else None,
    }


def _r1(v: float | None) -> float | None:
    return None if v is None else round(v, 1)


def confusion_pairs(plates: Iterable[PlateResult], top: int = 20) -> list[dict]:
    """Most common character errors: substitutions (gt->pred), deletions (pred ""), insertions (gt "").

    Misses (no read at all) are excluded — they are detection failures, not OCR confusions.
    """
    c: Counter = Counter()
    for p in plates:
        if not p.detected:
            continue
        for kind, a, b in p.ops:
            if kind != "eq":
                c[(a, b)] += 1
    return [{"gt": a, "pred": b, "count": n} for (a, b), n in c.most_common(top)]
