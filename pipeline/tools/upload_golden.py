#!/usr/bin/env python3
"""Publish the golden-set OCR run for the /accuracy page.

Two outputs:

1. The plate crops of every *scored* golden image (the human-readable ones)
   are uploaded to the PRIVATE Supabase Storage bucket ``golden`` under
   ``ocr_golden_v1/<key>.jpg`` with ``Cache-Control: max-age=31536000,
   immutable``. Crops of images the labellers marked unreadable are not
   needed by the page and stay local.
2. ``public/golden/results_golden_v1.json`` — the results file trimmed for
   the web (column-packed items, no model-internal fields) plus ``bucket``
   and ``prefix`` of the crops. The site shows them through short-lived
   signed URLs from ``/api/media/sign`` (api/media/sign.ts); the bucket is
   never public.

Dry run is the default: nothing is uploaded unless you pass ``--execute``.
Uploads are idempotent — objects already in the bucket are listed first and
skipped (``--force`` re-uploads them). The web JSON is (re)written in both
modes because it is a local, derived file.

Credentials come from the environment or the repo-root ``.env``:
``SUPABASE_URL`` (or ``VITE_SUPABASE_URL``) and ``SUPABASE_SERVICE_ROLE_KEY``.

Usage::

    python3 pipeline/tools/upload_golden.py              # dry run + write web JSON
    python3 pipeline/tools/upload_golden.py --execute    # create bucket if needed, upload missing crops

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
GOLDEN_DIR = PIPELINE / "data" / "golden"
RESULTS = GOLDEN_DIR / "results_golden_v1.json"
WEB_OUT = REPO / "public" / "golden" / "results_golden_v1.json"
BUCKET = "golden"
CACHE_CONTROL = "max-age=31536000, immutable"

# Order of the column-packed item arrays in the web JSON.
ITEM_FIELDS = [
    "key",
    "gt",
    "pred",
    "confidence",
    "correct",
    "grammar_valid",
    "row_count",
    "side",
    "state_code",
    "conditions",
    "labelers",
    "width",
    "height",
    "inference_ms",
    "roundtrip_ms",
]
# Top-level fields copied to the web JSON. Model/engine identifiers are left
# out on purpose: the public page never names model internals.
TOP_FIELDS = [
    "schema",
    "set",
    "set_hash",
    "status",
    "measured_at",
    "endpoint",
    "total_images",
    "scored",
    "skipped",
    "overall",
    "breakdown",
    "latency_ms",
    "wall_seconds",
]


def load_env(path: Path) -> dict:
    """Minimal .env parser (KEY=VALUE, optional quotes, # comments)."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        env[key] = value
    return env


def credentials(env_file: Path) -> tuple[str | None, str | None]:
    file_env = load_env(env_file)

    def get(name: str) -> str | None:
        return os.environ.get(name) or file_env.get(name)

    url = get("SUPABASE_URL") or get("VITE_SUPABASE_URL")
    key = get("SUPABASE_SERVICE_ROLE_KEY")
    return (url.rstrip("/") if url else None), key


def object_prefix(results: dict) -> str:
    return str(results.get("set") or "ocr_golden_v1")


def web_results(results: dict, bucket: str = BUCKET) -> dict:
    """The results trimmed for the web page (column-packed items, no URLs)."""
    out = {k: results[k] for k in TOP_FIELDS if k in results}
    out["bucket"] = bucket
    out["prefix"] = f"{object_prefix(results)}/"
    out["item_fields"] = ITEM_FIELDS
    rows = []
    for it in results.get("items", []):
        row = []
        for f in ITEM_FIELDS:
            v = it.get(f)
            if f == "conditions":
                # 'clear' is on every scored image (it means "not unreadable"), so it carries no information.
                v = [c for c in (v or []) if c != "clear"]
            elif isinstance(v, bool):
                v = 1 if v else 0
            row.append(v)
        rows.append(row)
    out["items"] = rows
    return out


def _request(method: str, url: str, key: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("apikey", key)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.status, resp.read()


def ensure_bucket(base: str, key: str, bucket: str, execute: bool) -> bool:
    """True when the bucket exists (or was created, private)."""
    try:
        _, raw = _request("GET", f"{base}/storage/v1/bucket/{bucket}", key)
        info = json.loads(raw or b"{}")
        if info.get("public"):
            print(f"WARNING: bucket '{bucket}' is PUBLIC — it must be private (Storage → {bucket} → edit → uncheck Public)", file=sys.stderr)
        else:
            print(f"bucket '{bucket}' exists (private)")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 404):
            raise
    if not execute:
        print(f"bucket '{bucket}' missing — would create it (private)")
        return False
    body = json.dumps({"id": bucket, "name": bucket, "public": False}).encode()
    _request("POST", f"{base}/storage/v1/bucket", key, body, {"Content-Type": "application/json"})
    print(f"created private bucket '{bucket}'")
    return True


def list_existing(base: str, key: str, bucket: str, prefix: str) -> set[str]:
    names: set[str] = set()
    offset = 0
    while True:
        body = json.dumps({"prefix": prefix, "limit": 1000, "offset": offset}).encode()
        _, raw = _request("POST", f"{base}/storage/v1/object/list/{bucket}", key, body, {"Content-Type": "application/json"})
        page = json.loads(raw or b"[]")
        names.update(o["name"] for o in page if o.get("id"))
        if len(page) < 1000:
            return names
        offset += 1000


def upload(base: str, key: str, bucket: str, obj: str, path: Path) -> None:
    headers = {"Content-Type": "image/jpeg", "Cache-Control": CACHE_CONTROL, "x-upsert": "true"}
    _request("POST", f"{base}/storage/v1/object/{bucket}/{obj}", key, path.read_bytes(), headers)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Upload scored golden-set crops and write the web results JSON.")
    ap.add_argument("--results", type=Path, default=RESULTS)
    ap.add_argument("--crops", type=Path, default=GOLDEN_DIR / "crops")
    ap.add_argument("--out", type=Path, default=WEB_OUT)
    ap.add_argument("--bucket", default=BUCKET)
    ap.add_argument("--env-file", type=Path, default=REPO / ".env")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--execute", action="store_true", help="actually upload (default is a dry run)")
    ap.add_argument("--force", action="store_true", help="re-upload objects that already exist")
    args = ap.parse_args(argv)

    if not args.results.exists():
        print(f"missing {args.results}", file=sys.stderr)
        return 1
    results = json.loads(args.results.read_text())
    prefix = object_prefix(results)
    keys = [it["key"] for it in results.get("items", [])]
    missing_local = [k for k in keys if not (args.crops / f"{k}.jpg").exists()]
    if missing_local:
        print(f"{len(missing_local)} scored crop(s) missing locally, e.g. {missing_local[0]}.jpg", file=sys.stderr)
        return 1

    # 1. web JSON (no credentials needed)
    web = web_results(results, args.bucket)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(web, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out} ({args.out.stat().st_size / 1e3:.0f} kB, {len(keys)} items)")

    # 2. crops
    base, key = credentials(args.env_file)
    total = sum((args.crops / f"{k}.jpg").stat().st_size for k in keys)
    mode = "UPLOAD" if args.execute else "DRY RUN"
    print(f"{mode}: {len(keys)} scored crop(s), {total / 1e6:.1f} MB -> bucket '{args.bucket}' / {prefix}/")
    if not (base and key):
        print("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — cannot check or upload", file=sys.stderr)
        return 0 if not args.execute else 2

    exists = ensure_bucket(base, key, args.bucket, args.execute)
    existing = list_existing(base, key, args.bucket, prefix) if exists else set()
    todo = keys if args.force else [k for k in keys if f"{k}.jpg" not in existing]
    print(f"{len(keys) - len(todo)} already in the bucket, {len(todo)} to upload")
    if not args.execute:
        for k in todo[:5]:
            print(f"  would upload {prefix}/{k}.jpg")
        if len(todo) > 5:
            print(f"  … and {len(todo) - 5} more")
        print("\nDry run only. Re-run with --execute to upload.")
        return 0

    failures = 0
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(upload, base, key, args.bucket, f"{prefix}/{k}.jpg", args.crops / f"{k}.jpg"): k for k in todo}
        for fut in as_completed(futs):
            k = futs[fut]
            try:
                fut.result()
                done += 1
                if done % 100 == 0 or done == len(todo):
                    print(f"  uploaded {done}/{len(todo)}")
            except urllib.error.HTTPError as exc:
                failures += 1
                print(f"  {k}.jpg FAILED {exc.code}: {exc.read().decode(errors='replace')[:200]}", file=sys.stderr)
            except (urllib.error.URLError, TimeoutError) as exc:
                failures += 1
                print(f"  {k}.jpg FAILED: {exc}", file=sys.stderr)

    print(f"\nObjects: {args.bucket}/{prefix}/<key>.jpg (private; served via /api/media/sign)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
