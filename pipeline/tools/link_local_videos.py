#!/usr/bin/env python3
"""Expose the 720p renditions to the Vite dev server without Supabase.

Symlinks (or with ``--copy``, copies) ``pipeline/data/videos_720p/*.mp4``,
``*.jpg`` and ``manifest.json`` into ``public/videos-local/``. Vite then
serves them at ``/videos-local/<slug>.mp4`` during ``npm run dev``.

``public/videos-local/`` is gitignored. Note that ``npm run build`` copies
``public/`` into ``dist/``; with symlinks Vite follows them, so remove the
folder (``--clean``) before a production build if you do not want the clips
bundled.

Usage::

    python3 pipeline/tools/link_local_videos.py          # symlink
    python3 pipeline/tools/link_local_videos.py --copy   # real copies
    python3 pipeline/tools/link_local_videos.py --clean  # remove the folder
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
DEFAULT_SRC = PIPELINE / "data" / "videos_720p"
DEFAULT_DEST = REPO / "public" / "videos-local"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Link 720p videos into public/videos-local/ for local dev.")
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--copy", action="store_true", help="copy files instead of symlinking")
    ap.add_argument("--clean", action="store_true", help="remove the destination folder and exit")
    args = ap.parse_args(argv)

    if args.clean:
        if args.dest.exists():
            shutil.rmtree(args.dest)
            print(f"removed {args.dest}")
        return 0

    files = [
        f for f in sorted(args.src.iterdir())
        if f.is_file() and not f.name.startswith(".") and f.suffix in (".mp4", ".jpg", ".json")
    ] if args.src.exists() else []
    if not files:
        print(f"nothing in {args.src}; run prepare_videos.py first", file=sys.stderr)
        return 1

    args.dest.mkdir(parents=True, exist_ok=True)
    wanted = {f.name for f in files}
    for stale in args.dest.iterdir():
        if stale.name not in wanted and (stale.is_symlink() or stale.is_file()):
            stale.unlink()

    for f in files:
        target = args.dest / f.name
        if target.is_symlink() or target.exists():
            target.unlink()
        if args.copy:
            shutil.copy2(f, target)
        else:
            os.symlink(os.path.relpath(f.resolve(), args.dest.resolve()), target)
    verb = "copied" if args.copy else "linked"
    print(f"{verb} {len(files)} file(s) into {args.dest}")
    print("served by `npm run dev` at /videos-local/<slug>.mp4 and /videos-local/manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
