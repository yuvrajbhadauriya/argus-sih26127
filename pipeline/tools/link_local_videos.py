#!/usr/bin/env python3
"""Expose the 720p renditions to the Vite dev server without Supabase.

Symlinks (or with ``--copy``, copies) ``pipeline/data/videos_720p/*.mp4``,
``*.jpg`` and ``manifest.json`` into ``public/videos-local/``. Vite then
serves them at ``/videos-local/<slug>.mp4`` during ``npm run dev``.

``public/videos-local/`` is gitignored and is never copied into ``dist/``:
``npm run build`` skips it (``localVideosPlugin`` in ``vite.config.ts``), and
``vite preview`` serves it straight from ``public/``.

``--hd`` also exposes the 1080p analysis renditions (``pipeline/data/videos_1080p/<slug>.mp4``)
as the HD files the main (selected) feed plays: ``/videos-local/<slug>.hd.mp4``, next to the 720p
file the video-wall tiles use. The renditions already exist (prepare_videos.py /
replace_camera_clip.py made them), so no transcode and no detection run is needed. Only the
clips the dashboard plays (``src/config/cameraClips.json``) are exposed, and the 720p folder is not required.
The player falls back to 720p for any clip without an HD file.

Usage::

    python3 pipeline/tools/link_local_videos.py          # symlink
    python3 pipeline/tools/link_local_videos.py --copy   # real copies
    python3 pipeline/tools/link_local_videos.py --hd     # + <slug>.hd.mp4 from videos_1080p
    python3 pipeline/tools/link_local_videos.py --clean  # remove the folder
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
DEFAULT_SRC = PIPELINE / "data" / "videos_720p"
DEFAULT_HD_SRC = PIPELINE / "data" / "videos_1080p"
DEFAULT_DEST = REPO / "public" / "videos-local"
CLIPS_JSON = REPO / "src" / "config" / "cameraClips.json"
#: HD file next to <slug>.mp4; the dashboard (src/config/constants.ts LOCAL_HD_SUFFIX) looks for exactly this.
HD_SUFFIX = ".hd.mp4"


def hd_name(slug: str) -> str:
    return f"{slug}{HD_SUFFIX}"


def registry_slugs(path: Path | None = None) -> dict[str, str]:
    """camera code -> clip slug from src/config/cameraClips.json ({} when unreadable)."""
    try:
        doc = json.loads((path or CLIPS_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in doc.items()} if isinstance(doc, dict) else {}


def hd_sources(hd_src: Path, registry: dict[str, str]) -> tuple[list[tuple[Path, str]], list[str]]:
    """([(1080p file, <slug>.hd.mp4)], [messages about cameras without one]).

    With a registry only the clips the cameras play are exposed, otherwise every mp4 in ``hd_src``.
    """
    if not hd_src.is_dir():
        return [], [f"no HD folder {hd_src}"]
    if not registry:
        return [(f, hd_name(f.stem)) for f in sorted(hd_src.glob("*.mp4")) if not f.name.startswith(".")], []
    found, missing = [], []
    for code, slug in sorted(registry.items()):
        f = hd_src / f"{slug}.mp4"
        if f.is_file() and f.stat().st_size > 0:
            found.append((f, hd_name(slug)))
        else:
            missing.append(f"{code}: no {f.name} in {hd_src} (the player will use 720p; run replace_camera_clip.py or prepare_videos.py)")
    return found, missing


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Link 720p videos into public/videos-local/ for local dev.")
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--hd", action="store_true", help="also expose the 1080p renditions as <slug>.hd.mp4 (HD for the selected feed)")
    ap.add_argument("--hd-src", type=Path, default=DEFAULT_HD_SRC, help="folder of the 1080p renditions (default pipeline/data/videos_1080p)")
    ap.add_argument("--copy", action="store_true", help="copy files instead of symlinking")
    ap.add_argument("--clean", action="store_true", help="remove the destination folder and exit")
    args = ap.parse_args(argv)

    if args.clean:
        if args.dest.exists():
            shutil.rmtree(args.dest)
            print(f"removed {args.dest}")
        return 0

    files = [
        (f, f.name) for f in sorted(args.src.iterdir())
        if f.is_file() and not f.name.startswith(".") and f.suffix in (".mp4", ".jpg", ".json")
    ] if args.src.exists() else []
    hd_files, hd_notes = hd_sources(args.hd_src, registry_slugs()) if args.hd else ([], [])
    if not files and not hd_files:
        print(f"nothing in {args.src}; run prepare_videos.py first", file=sys.stderr)
        for note in hd_notes:
            print(f"  hd: {note}", file=sys.stderr)
        return 1

    args.dest.mkdir(parents=True, exist_ok=True)
    wanted = {name for _, name in files} | {name for _, name in hd_files}
    for stale in args.dest.iterdir():
        if stale.name in wanted or not (stale.is_symlink() or stale.is_file()):
            continue
        # HD files are managed by --hd (replace_camera_clip.py writes real copies): a plain run never removes them,
        # and --hd only cleans up stale links.
        if stale.name.endswith(HD_SUFFIX) and not (args.hd and stale.is_symlink()):
            continue
        stale.unlink()

    for f, name in files + hd_files:
        target = args.dest / name
        if target.is_symlink() or target.exists():
            target.unlink()
        if args.copy:
            shutil.copy2(f, target)
        else:
            os.symlink(os.path.relpath(f.resolve(), args.dest.resolve()), target)
    verb = "copied" if args.copy else "linked"
    print(f"{verb} {len(files)} file(s) into {args.dest}")
    if args.hd:
        print(f"{verb} {len(hd_files)} HD file(s) (<slug>{HD_SUFFIX}) from {args.hd_src}")
        for note in hd_notes:
            print(f"  hd: {note}")
    print("served by `npm run dev` at /videos-local/<slug>.mp4 (and <slug>.hd.mp4) and /videos-local/manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
