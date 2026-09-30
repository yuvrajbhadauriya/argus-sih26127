#!/usr/bin/env python3
"""
Accuracy evaluation of the remote ANPR model API on labelled Indian plate sets.

    # live ANPR API (ANPR_API_BASE / DETECTION_API_KEY / DETECTION_API_AUTH_HEADER from env or repo-root .env)
    python pipeline/eval/evaluate.py --datasets datacluster hf-plate-crops

    # offline plumbing test (in-process noisy-oracle mock; output marked status=sample)
    python pipeline/eval/evaluate.py --mock

Writes public/eval/results.json (schema_version 1, read by the Model Performance
page) and pipeline/eval/REPORT.md. See pipeline/eval/README.md for the metric
definitions.

Exit codes: 0 ok · 1 no data evaluated · 2 API not configured / unreachable / key rejected
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_PIPELINE)
if _PIPELINE not in sys.path:
    sys.path.insert(0, _PIPELINE)

from eval import datasets as ds  # noqa: E402
from eval.images import decode_gray, downscale_jpeg, heuristic_conditions, image_size, pad_image, thumbnail_jpeg  # noqa: E402
from eval.lpu_client import LpuClient, LpuConfig, LpuError, LpuRejected, LpuUnavailable, read_lpu_config  # noqa: E402
from eval.metrics import PlateResult, confusion_pairs, match_image, summarise  # noqa: E402

SCHEMA_VERSION = 1
TARGET_PLATE_ACCURACY = 0.90
DEFAULT_OUT = os.path.join(_ROOT, "public", "eval", "results.json")
DEFAULT_REPORT = os.path.join(_HERE, "REPORT.md")
SAMPLE_NOTE = "replace by running evaluate.py against the trained model"
MAX_LIVE_WORKERS = 2  # the GPU is shared: at most 2 requests in flight against the live API

# The deployed model, as described by the model team. The "reported" figures are
# THEIR measurements on their own benchmarks — shown as context, never as this
# harness's result.
MODEL_CARD = {
    "engine": "lpu_on_gpu",
    "model_version": "deim50k+raw35",
    "detector": "DEIM (deim50k) — vehicle + plate detection",
    "ocr": "PARSeq (raw35) — plate text recognition",
    "hardware": "RTX 5090 (shared GPU)",
    "reported": [
        {"metric": "OCR accuracy, bench951", "value": 0.964, "scope": "ocr"},
        {"metric": "OCR accuracy, golden v1 (1,419 plates)", "value": 0.989, "scope": "ocr"},
        {"metric": "OCR accuracy, two-row plates", "value": 0.925, "scope": "ocr"},
        {"metric": "End-to-end, deim50k + ocr_v9 (previous OCR)", "value": 0.818, "scope": "end_to_end"},
        {"metric": "OCR latency per crop", "value_ms": 17, "scope": "latency"},
    ],
    "reported_note": "Reported by the model team on their own benchmarks; not measured by this harness. "
                     "deim50k+raw35 end-to-end accuracy is what evaluate.py measures.",
}


# ──────────────────────────────────────────────────────────────────────
# Per-image evaluation
# ──────────────────────────────────────────────────────────────────────
@dataclass
class ImageOutcome:
    sample: ds.Sample
    plates: list[PlateResult] = field(default_factory=list)
    false_reads: int = 0
    latency_ms: float | None = None
    inference_ms: float | None = None
    error: str | None = None
    tags: dict[str, str] = field(default_factory=dict)
    measures: dict = field(default_factory=dict)
    payload: bytes | None = None
    boxes: list = field(default_factory=list)
    engine: str | None = None
    model_version: str | None = None


def prepare(sample: ds.Sample, max_side: int, heuristics: bool = True, pad: float = 0.0) -> tuple[bytes, str, tuple[int, int] | None, list[dict], dict, dict]:
    """Reads, downscales and (for tight plate crops) pads the image.

    Returns (payload, mime, size, scaled plates, tags, measurements). When a crop
    is padded, its GT plate box becomes the original crop area, so the plate
    detector's box can be matched spatially.
    """
    with open(sample.path, "rb") as f:
        raw = f.read()
    payload, scale = downscale_jpeg(raw, max_side)
    plates = [
        {"text": p["text"], "bbox": [v * scale for v in p["bbox"]] if p.get("bbox") else None}
        for p in sample.plates
    ]
    # Conditions are judged on the image as captured (before any padding).
    tags = dict(sample.tags)
    measures: dict = {}
    if heuristics:
        box = next((p["bbox"] for p in plates if p.get("bbox")), None)
        htags, measures = heuristic_conditions(decode_gray(payload), box)
        for t in htags:
            # A label always wins; heuristics only fill conditions the label set says nothing about.
            if t in ("day", "night") and ({"day", "night"} & set(tags)):
                continue
            if t in ("blur", "sharp") and ({"blur", "sharp"} & set(tags)):
                continue
            tags.setdefault(t, "heuristic")
    if pad > 0:
        padded, offset = pad_image(payload, pad)
        if offset is not None:
            size0 = image_size(payload)
            payload = padded
            plates = [{"text": p["text"], "bbox": p["bbox"] and [p["bbox"][0] + offset[0], p["bbox"][1] + offset[1], *p["bbox"][2:]]
                       or [offset[0], offset[1], size0[0], size0[1]]} for p in plates]
    mime = "image/png" if payload[:4] == b"\x89PNG" else "image/jpeg"
    return payload, mime, image_size(payload), plates, tags, measures


def evaluate_sample(sample: ds.Sample, client: LpuClient, max_side: int, min_conf: float | None,
                    oracle: dict | None = None, pad: float = 0.0, tiles: str = "1x1") -> ImageOutcome:
    """Sends one image to /v1/frame and matches the reads to the ground truth."""
    payload, mime, size, plates, tags, measures = prepare(sample, max_side, pad=pad)
    if oracle is not None:
        oracle[hashlib.sha1(payload).hexdigest()] = plates
    out = ImageOutcome(sample=sample, tags=tags, measures=measures, payload=payload,
                       boxes=[p.get("bbox") for p in plates])
    try:
        res = client.frame(payload, mime, tiles=tiles, min_conf=min_conf)
    except LpuRejected:
        raise
    except LpuError as e:
        out.error = str(e)
        out.plates, _ = match_image(plates, [])
        return out
    # Matching uses the PLATE box; vehicles without a read ("Not Found") are not reads.
    preds = [d for d in res.get("detections", []) if d.get("plate_text")]
    out.plates, out.false_reads = match_image(plates, preds)
    out.latency_ms = res.get("latency_ms")
    out.inference_ms = res.get("inference_ms")
    out.engine, out.model_version = res.get("engine"), res.get("model_version")
    return out


# ──────────────────────────────────────────────────────────────────────
# Aggregation
# ──────────────────────────────────────────────────────────────────────
def block(outcomes: list[ImageOutcome]) -> dict:
    return summarise(
        [p for o in outcomes for p in o.plates],
        false_reads=sum(o.false_reads for o in outcomes),
        images=len(outcomes),
        api_errors=sum(1 for o in outcomes if o.error),
        latencies=[o.latency_ms for o in outcomes if o.latency_ms is not None],
        inference=[o.inference_ms for o in outcomes if o.inference_ms is not None],
    )


def per_condition(outcomes: list[ImageOutcome]) -> list[dict]:
    groups: dict[str, list[ImageOutcome]] = {}
    sources: dict[str, set] = {}
    for o in outcomes:
        for t, src in o.tags.items():
            groups.setdefault(t, []).append(o)
            sources.setdefault(t, set()).add(src)
    order = {c: i for i, c in enumerate(ds.CONDITIONS)}
    rows = []
    for t in sorted(groups, key=lambda c: (order.get(c, 99), c)):
        src = sources[t]
        rows.append({"condition": t, "source": next(iter(src)) if len(src) == 1 else "mixed", **block(groups[t])})
    return rows


def pick_samples(outcomes: list[ImageOutcome], n: int) -> list[ImageOutcome]:
    """Gallery: errors first (they are the informative ones), then correct reads, spread across datasets."""
    if n <= 0:
        return []
    wrong = [o for o in outcomes if o.plates and not all(p.exact for p in o.plates)]
    right = [o for o in outcomes if o.plates and all(p.exact for p in o.plates)]
    half = n // 2
    chosen = _spread(wrong, min(len(wrong), max(half, n - len(right))))
    chosen += _spread(right, n - len(chosen))
    return chosen


def _spread(items: list[ImageOutcome], k: int) -> list[ImageOutcome]:
    if k <= 0 or not items:
        return []
    step = max(1, len(items) // k)
    return items[::step][:k]


def write_samples(chosen: list[ImageOutcome], specs: dict[str, ds.DatasetSpec], samples_dir: str) -> list[dict]:
    if os.path.isdir(samples_dir):
        shutil.rmtree(samples_dir)
    out = []
    for i, o in enumerate(chosen):
        spec = specs[o.sample.dataset]
        thumb = None
        if spec.redistributable and o.payload:
            box = next((b for b in o.boxes if b), None)
            data = thumbnail_jpeg(o.payload, box)
            ext = "jpg"
            if data is None and o.payload[:4] == b"\x89PNG" and len(o.payload) < 20_000:
                data, ext = o.payload, "png"  # synthetic plates are already tiny PNGs
            if data:
                os.makedirs(samples_dir, exist_ok=True)
                name = f"{i:02d}_{_slug(o.sample.id)}.{ext}"
                with open(os.path.join(samples_dir, name), "wb") as f:
                    f.write(data)
                thumb = f"/eval/samples/{name}"
        for p in o.plates[:2]:  # at most two plates per image keep the gallery varied
            out.append({
                "id": o.sample.id, "dataset": o.sample.dataset, "gt": p.gt, "pred": p.pred or None,
                "correct": p.exact, "lenient_correct": p.lenient_exact, "edits": p.edits,
                "confidence": p.confidence, "conditions": sorted(o.tags), "thumb": thumb,
            })
    return out


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s)[:40]


# ──────────────────────────────────────────────────────────────────────
# Health / model card
# ──────────────────────────────────────────────────────────────────────
# ──────────────────────────────────────────────────────────────────────
# Report
# ──────────────────────────────────────────────────────────────────────
def pct(v: float | None) -> str:
    return "—" if v is None else f"{v * 100:.1f}%"


def ms(v: float | None) -> str:
    return "—" if v is None else f"{v:.0f} ms"


def render_report(res: dict) -> str:
    o = res["overall"]
    lines = [
        "# ANPR model accuracy report",
        "",
        f"Generated {res['generated_at']} by `pipeline/eval/evaluate.py`.",
        "",
    ]
    if res["status"] != "measured":
        lines += [f"> **{res['status'].upper()} DATA — {res.get('note', '')}.** "
                  "These numbers come from the offline noisy-oracle mock and say nothing about the real model.", ""]
    acc = o["plate_accuracy"]
    verdict = "not measured" if res["status"] != "measured" or acc is None else ("PASS" if acc >= res["target"]["plate_accuracy"] else "BELOW TARGET")
    m = res["model"]
    lines += [
        f"**Evaluated:** {m.get('engine') or '—'} · version {m.get('model_version') or '—'} · API {m.get('api')} · "
        f"`{res['config'].get('endpoint')}` tiles={res['config'].get('tiles')} (crops) / {res['config'].get('scene_tiles')} (scenes) crop_pad={res['config'].get('crop_pad')}",
        "",
        f"**Deployed model:** {res['model_card']['detector']}; {res['model_card']['ocr']}. "
        + "Model-team figures (not measured here): "
        + "; ".join(f"{b['metric']} {b['value'] * 100:.1f}%" if 'value' in b else f"{b['metric']} {b['value_ms']} ms" for b in res['model_card']['reported']) + ".",
        "",
        f"**Target (BEL PS SIH26127):** plate recognition accuracy > {res['target']['plate_accuracy'] * 100:.0f}% — **{verdict}**",
        "",
        "## Overall",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Plate accuracy (exact, end-to-end) | {pct(o['plate_accuracy'])} ({o['exact']}/{o['plates']}) |",
        f"| Lenient accuracy (O≡0, I≡1) | {pct(o['lenient_accuracy'])} |",
        f"| OCR accuracy on detected plates | {pct(o['ocr_accuracy'])} |",
        f"| Character accuracy (1 − CER) | {pct(o['char_accuracy'])} |",
        f"| Plate detection recall | {pct(o['detection_recall'])} ({o['detected']}/{o['plates']}) |",
        f"| Plate detection miss rate | {pct(o['plate_miss_rate'])} |",
        f"| Read precision | {pct(o['read_precision'])} ({o['false_reads']} false reads) |",
        f"| Latency p50 / p95 (round trip) | {ms(o['latency_ms']['p50'])} / {ms(o['latency_ms']['p95'])} |",
        f"| Model inference p50 | {ms(o['inference_ms']['p50'])} |",
        f"| Images / API errors | {o['images']} / {o['api_errors']} |",
        "",
        "## Per dataset",
        "",
        "| Dataset | Licence | Images | Plates | Plate acc. | Char acc. | Recall | p95 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for d in res["per_dataset"]:
        lines.append(f"| [{d['name']}]({d['source_url']}) | {d['license']} | {d['images']} | {d['plates']} | "
                     f"{pct(d['plate_accuracy'])} | {pct(d['char_accuracy'])} | {pct(d['detection_recall'])} | {ms(d['latency_ms']['p95'])} |")
    lines += ["", "## Per condition", "",
              "Source `label` = tagged by the dataset; `heuristic` = estimated from the image "
              "(mean luma < 70 → night, Laplacian variance < 60 → blur, plate height < 20 px → low_res). "
              "Heuristic tags are approximate.", "",
              "| Condition | Source | Plates | Plate acc. | Char acc. | Recall |", "| --- | --- | ---: | ---: | ---: | ---: |"]
    for c in res["per_condition"]:
        lines.append(f"| {c['condition']} | {c['source']} | {c['plates']} | {pct(c['plate_accuracy'])} | "
                     f"{pct(c['char_accuracy'])} | {pct(c['detection_recall'])} |")
    lines += ["", "## Most common character errors", "", "| Ground truth | Read as | Count |", "| --- | --- | ---: |"]
    for e in res["confusions"][:15]:
        lines.append(f"| {e['gt'] or '(extra)'} | {e['pred'] or '(dropped)'} | {e['count']} |")
    if res.get("skipped"):
        lines += ["", "## Datasets not evaluated", ""] + [f"- `{s['id']}` — {s['reason']}" for s in res["skipped"]]
    lines += ["", "Matching: " + res["config"]["matching"], ""]
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Evaluate the ANPR model API on labelled plate datasets")
    p.add_argument("--datasets", nargs="*", default=None,
                   help="Dataset ids (datacluster, hf-plate-crops, anpr-benchmark, saisirishan, synthetic, folder:<path>). "
                        "Default: every downloaded set; with --mock: synthetic")
    p.add_argument("--download", action="store_true", help="Download missing datasets first")
    p.add_argument("--data_dir", default=ds.DATA_ROOT)
    p.add_argument("--limit", type=int, default=0, help="Max images per dataset (0 = all)")
    p.add_argument("--workers", type=int, default=1, help=f"Requests in flight (live API capped at {MAX_LIVE_WORKERS}; GPU is shared)")
    p.add_argument("--max_retries", type=int, default=3)
    p.add_argument("--timeout_ms", type=int, default=None)
    p.add_argument("--max_side", type=int, default=1920, help="Downscale images whose longest side exceeds this")
    p.add_argument("--min_conf", type=float, default=None, help="Passed to the API as min_conf (default: server default)")
    p.add_argument("--tiles", default="1x1", help="Detector tiling for plate-crop datasets (default 1x1)")
    p.add_argument("--scene_tiles", default="2x2", help="Detector tiling for full-scene datasets (default 2x2: small plates in phone photos)")
    p.add_argument("--crop_pad", type=float, default=1.5,
                   help="Grey border around plate-crop images, as a fraction of the crop size per side (default 1.5: the "
                        "detector expects a plate to be a small part of a frame; 0.3 found only ~10%% of crop plates)")
    p.add_argument("--samples", type=int, default=12, help="Predictions to include in the gallery")
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--report", default=DEFAULT_REPORT)
    p.add_argument("--env_file", default=None)
    p.add_argument("--mock", action="store_true", help="Run against the in-process noisy-oracle mock (status=sample)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from detect.run_remote_detection import load_env  # noqa: PLC0415

    oracle: dict | None = None
    server = None
    if args.mock:
        from eval.mock_eval_server import start_oracle_server  # noqa: PLC0415

        oracle = {}
        server, _, _ = start_oracle_server(oracle, api_key="eval-mock-key")
        cfg = LpuConfig(base=f"http://127.0.0.1:{server.server_address[1]}", api_key="eval-mock-key")
        api_label = "mock"
    else:
        load_env(args.env_file)
        cfg = read_lpu_config()
        if cfg is None:
            print("[x] ANPR_API_BASE (or DETECTION_API_URL) and DETECTION_API_KEY must be set (env or .env). "
                  "Use --mock for an offline run.", file=sys.stderr)
            return 2
        api_label = "live"
        if args.workers > MAX_LIVE_WORKERS:
            print(f"[!] --workers capped at {MAX_LIVE_WORKERS}: the GPU is shared")
            args.workers = MAX_LIVE_WORKERS
    if args.timeout_ms:
        cfg = replace(cfg, timeout_s=args.timeout_ms / 1000)
    client = LpuClient(cfg, max_retries=args.max_retries)

    try:
        return _run(args, client, oracle, api_label)
    finally:
        if server is not None:
            server.shutdown()


def _run(args, client, oracle, api_label) -> int:
    try:
        health = client.health()
    except LpuUnavailable as e:
        print(f"[x] {e}", file=sys.stderr)
        return 2

    ids = args.datasets or (["synthetic"] if args.mock else [k for k in ds.DATASETS if k != "synthetic"])
    specs: dict[str, ds.DatasetSpec] = {}
    samples: list[ds.Sample] = []
    skipped = []
    for ds_id in ids:
        try:
            spec, items = ds.load(ds_id, args.data_dir, download=args.download)
        except (ds.DatasetUnavailable, KeyError) as e:
            reason = str(e).splitlines()[0]
            print(f"[!] {ds_id}: {reason}")
            skipped.append({"id": ds_id, "reason": reason})
            continue
        if args.limit:
            items = items[: args.limit]
        specs[spec.id] = spec
        samples += items
        print(f"[*] {spec.id}: {len(items)} images, {sum(len(s.plates) for s in items)} plates")
    if not samples:
        print("[x] No labelled images to evaluate. Download a dataset first: python pipeline/eval/datasets.py download datacluster", file=sys.stderr)
        return 1

    t0 = time.time()
    outcomes: list[ImageOutcome] = []
    try:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [pool.submit(evaluate_sample, s, client, args.max_side, args.min_conf, oracle,
                                   args.crop_pad if specs[s.dataset].kind == "crop" else 0.0,
                                   args.tiles if specs[s.dataset].kind == "crop" else args.scene_tiles) for s in samples]
            for i, f in enumerate(futures, 1):
                outcomes.append(f.result())
                if i % 50 == 0 or i == len(futures):
                    print(f"    {i}/{len(futures)} images")
    except LpuRejected as e:
        print(f"[x] {e}", file=sys.stderr)
        return 2

    engine = next((o.engine for o in outcomes if o.engine), None) or (health or {}).get("engine")
    version = next((o.model_version for o in outcomes if o.model_version), None) or (health or {}).get("model_version")
    status = "sample" if args.mock else "measured"
    all_plates = [p for o in outcomes for p in o.plates]
    result = {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "note": SAMPLE_NOTE if status == "sample" else "measured against the configured model API",
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "duration_s": round(time.time() - t0, 1),
        "target": {"plate_accuracy": TARGET_PLATE_ACCURACY, "metric": "plate_accuracy",
                   "source": "BEL PS SIH26127 — OCR module > 90% recognition accuracy"},
        "model": {"engine": engine, "model_version": version, "api": api_label,
                  "health": health, "source": "mock-oracle (noisy ground truth)" if args.mock else "live ANPR API (/v1/frame)"},
        "model_card": MODEL_CARD,
        "config": {
            "endpoint": "POST /v1/frame", "tiles": args.tiles, "scene_tiles": args.scene_tiles, "min_conf": args.min_conf if args.min_conf is not None else "server default",
            "crop_pad": args.crop_pad, "max_side": args.max_side, "workers": args.workers,
            "normalisation": "upper-case, keep A-Z0-9 only",
            "lenient": "strict + O->0, I->1",
            "matching": "one-to-one greedy by edit distance among spatially compatible pairs "
                        "(no box on either side, IoU >= 0.1 with the predicted plate box, or GT plate centre inside the "
                        "predicted plate or vehicle box); "
                        "unmatched GT = miss, unmatched read = false read",
        },
        "overall": block(outcomes),
        "per_dataset": [{**specs[sid].info(), **block([o for o in outcomes if o.sample.dataset == sid])} for sid in specs],
        "per_condition": per_condition(outcomes),
        "confusions": confusion_pairs(all_plates),
        "samples": write_samples(pick_samples(outcomes, args.samples), specs, os.path.join(os.path.dirname(args.out), "samples")),
        "skipped": skipped,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(render_report(result))
    o = result["overall"]
    print(f"[OK] {o['images']} images, {o['plates']} plates in {result['duration_s']}s  "
          f"plate acc {pct(o['plate_accuracy'])} · char acc {pct(o['char_accuracy'])} · recall {pct(o['detection_recall'])} · "
          f"p95 {ms(o['latency_ms']['p95'])}  [{status}]")
    print(f"     -> {os.path.relpath(args.out, _ROOT)}" + (f", {os.path.relpath(args.report, _ROOT)}" if args.report else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
