#!/usr/bin/env python3
"""Upload the 720p web renditions and posters to Supabase Storage.

Uploads ``pipeline/data/videos_720p/*.mp4``, ``*.jpg`` and ``manifest.json``
to the bucket ``videos`` under ``mumbai/720p/``. Every object is upserted with
``Cache-Control: max-age=31536000`` (the manifest gets a short cache instead,
because it changes when clips are re-encoded) and the right Content-Type.

``--hd`` uploads the 1080p renditions instead (``pipeline/data/videos_1080p/<slug>.mp4`` to
``mumbai/1080p/<slug>.mp4``): the HD files the selected feed plays. No poster, no manifest.

Dry run is the default: nothing is sent unless you pass ``--execute``.

Credentials come from the environment or the repo-root ``.env``:
``SUPABASE_URL`` (or ``VITE_SUPABASE_URL``) and ``SUPABASE_SERVICE_ROLE_KEY``.

Usage::

    python3 pipeline/tools/upload_videos.py                  # dry run
    python3 pipeline/tools/upload_videos.py --execute        # upload
    python3 pipeline/tools/upload_videos.py --execute --create-bucket
    python3 pipeline/tools/upload_videos.py --execute --only <slug>
    python3 pipeline/tools/upload_videos.py --hd --execute   # the 1080p HD renditions

Standard library only, so any Python 3.9+ works.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
DEFAULT_DIR = PIPELINE / "data" / "videos_720p"
BUCKET = "videos"
PREFIX = "mumbai/720p"
DEFAULT_HD_DIR = PIPELINE / "data" / "videos_1080p"
HD_PREFIX = "mumbai/1080p"
LONG_CACHE = 31536000
MANIFEST_CACHE = 300

CONTENT_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json"}


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


def content_type(path: Path) -> str:
    return CONTENT_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def collect(src_dir: Path, only: list[str] | None) -> list[Path]:
    files = sorted(src_dir.glob("*.mp4")) + sorted(src_dir.glob("*.jpg"))
    files = [f for f in files if not f.name.startswith(".")]
    if only:
        files = [f for f in files if f.stem in set(only)]
    manifest = src_dir / "manifest.json"
    if manifest.exists():
        files.append(manifest)
    return files


def collect_hd(src_dir: Path, only: list[str] | None) -> list[Path]:
    """The 1080p mp4 files only (HD renditions have no poster or manifest)."""
    files = [f for f in sorted(src_dir.glob("*.mp4")) if not f.name.startswith(".")]
    if only:
        files = [f for f in files if f.stem in set(only)]
    return files


def object_path(path: Path, prefix: str = PREFIX) -> str:
    return f"{prefix.strip('/')}/{path.name}"


def public_url(base: str, obj: str, bucket: str = BUCKET) -> str:
    return f"{base}/storage/v1/object/public/{bucket}/{obj}"


def _request(method: str, url: str, key: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("apikey", key)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=600) as resp:
        return resp.status, resp.read()


def ensure_bucket(base: str, key: str, bucket: str) -> None:
    try:
        _request("GET", f"{base}/storage/v1/bucket/{bucket}", key)
        print(f"bucket '{bucket}' exists")
        return
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 404):
            raise
    body = json.dumps({"id": bucket, "name": bucket, "public": True}).encode()
    _request("POST", f"{base}/storage/v1/bucket", key, body, {"Content-Type": "application/json"})
    print(f"created public bucket '{bucket}'")


def upload(base: str, key: str, bucket: str, obj: str, path: Path) -> None:
    cache = MANIFEST_CACHE if path.suffix == ".json" else LONG_CACHE
    headers = {
        "Content-Type": content_type(path),
        "Cache-Control": f"max-age={cache}",
        "x-upsert": "true",
    }
    _request("POST", f"{base}/storage/v1/object/{bucket}/{obj}", key, path.read_bytes(), headers)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Upload 720p videos and posters to Supabase Storage.")
    ap.add_argument("--dir", type=Path, default=None, help="default pipeline/data/videos_720p (videos_1080p with --hd)")
    ap.add_argument("--hd", action="store_true", help="upload the 1080p HD renditions to mumbai/1080p/ instead")
    ap.add_argument("--bucket", default=BUCKET)
    ap.add_argument("--prefix", default=None, help="default mumbai/720p (mumbai/1080p with --hd)")
    ap.add_argument("--env-file", type=Path, default=REPO / ".env")
    ap.add_argument("--only", action="append", metavar="SLUG")
    ap.add_argument("--execute", action="store_true", help="actually upload (default is a dry run)")
    ap.add_argument("--create-bucket", action="store_true", help="create the bucket as public if missing")
    args = ap.parse_args(argv)

    args.dir = args.dir or (DEFAULT_HD_DIR if args.hd else DEFAULT_DIR)
    args.prefix = args.prefix or (HD_PREFIX if args.hd else PREFIX)
    files = collect_hd(args.dir, args.only) if args.hd else collect(args.dir, args.only)
    if not files:
        print(f"nothing to upload in {args.dir}; run prepare_videos.py first", file=sys.stderr)
        return 1

    base, key = credentials(args.env_file)
    total = sum(f.stat().st_size for f in files)
    mode = "UPLOAD" if args.execute else "DRY RUN"
    print(f"{mode}: {len(files)} file(s), {total / 1e6:.1f} MB -> bucket '{args.bucket}' / {args.prefix}/")

    if args.execute and not (base and key):
        print("missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2
    if args.execute and args.create_bucket:
        ensure_bucket(base, key, args.bucket)

    failures = 0
    for i, f in enumerate(files, 1):
        obj = object_path(f, args.prefix)
        line = f"[{i}/{len(files)}] {obj}  ({content_type(f)}, {f.stat().st_size / 1e6:.2f} MB)"
        if not args.execute:
            print(f"{line}  would upload")
            continue
        try:
            upload(base, key, args.bucket, obj, f)
            print(f"{line}  ok")
        except urllib.error.HTTPError as exc:
            failures += 1
            print(f"{line}  FAILED {exc.code}: {exc.read().decode(errors='replace')[:300]}", file=sys.stderr)
        except urllib.error.URLError as exc:
            failures += 1
            print(f"{line}  FAILED: {exc.reason}", file=sys.stderr)

    if base:
        print(f"\nPublic URL pattern: {public_url(base, args.prefix.strip('/') + '/<slug>.mp4', args.bucket)}")
    if not args.execute:
        print("\nDry run only. Re-run with --execute to upload.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
