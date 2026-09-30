#!/usr/bin/env python3
"""Transcode the candidate demo clips into web and analysis renditions.

For every ``pipeline/data/candidate_clips/<slug>.mp4`` this writes:

* ``pipeline/data/videos_720p/<slug>.mp4``   web rendition (720p, H.264 High,
  CRF 24, capped at 2.5 Mbit/s, no audio, faststart, 2 s GOP, max 30 fps)
* ``pipeline/data/videos_720p/<slug>.jpg``   poster frame taken ~1 s in
* ``pipeline/data/videos_1080p/<slug>.mp4``  analysis rendition for ANPR
  inference (1080p, CRF 20, native fps, no audio). Only made when the source
  is at least 1080 px on its short side; we never upscale.
* ``pipeline/data/videos_720p/manifest.json`` metadata for every clip.

``<slug>`` is the source filename without its extension, so names stay stable.

Portrait sources stay portrait: the 720 (or 1080) target applies to the short
side, i.e. the width.

Uses the ffmpeg binary bundled with ``imageio-ffmpeg`` (no system ffmpeg
needed). Set it up once with::

    python3 -m venv pipeline/.venv-tools
    pipeline/.venv-tools/bin/pip install imageio-ffmpeg

Usage::

    pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py
    pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py --only <slug>
    pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py --force

The script is idempotent: an output is skipped when it exists, is newer than
its source and was made with the current encode profile.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
DEFAULT_SRC = PIPELINE / "data" / "candidate_clips"
DEFAULT_WEB = PIPELINE / "data" / "videos_720p"
DEFAULT_ANALYSIS = PIPELINE / "data" / "videos_1080p"

# Bump when encode settings change so existing outputs are rebuilt.
PROFILE = "web720-crf24-v1+ana1080-crf20-v2"

WEB_HEIGHT = 720
WEB_CRF = 24
WEB_MAX_FPS = 30
ANALYSIS_HEIGHT = 1080
ANALYSIS_CRF = 20
GOP_SECONDS = 2
POSTER_AT_S = 1.0


@dataclass
class ProbeInfo:
    width: int
    height: int
    duration_s: float
    fps: float
    rotation: int = 0
    codec: str = ""

    @property
    def display_size(self) -> tuple[int, int]:
        """Width and height after applying rotation metadata."""
        if abs(self.rotation) % 180 == 90:
            return self.height, self.width
        return self.width, self.height

    @property
    def orientation(self) -> str:
        w, h = self.display_size
        return "portrait" if h > w else "landscape"

    @property
    def short_side(self) -> int:
        return min(self.display_size)


def slug_for(path: Path) -> str:
    """The slug is the source filename without extension."""
    return path.stem


def ffmpeg_exe() -> str:
    env = os.environ.get("FFMPEG_BINARY")
    if env:
        return env
    try:
        import imageio_ffmpeg
    except ImportError:
        sys.exit(
            "imageio-ffmpeg is not installed. Run:\n"
            "  python3 -m venv pipeline/.venv-tools && "
            "pipeline/.venv-tools/bin/pip install imageio-ffmpeg\n"
            "and use pipeline/.venv-tools/bin/python to run this script."
        )
    return imageio_ffmpeg.get_ffmpeg_exe()


# ── probing (ffmpeg -i stderr; imageio-ffmpeg ships no ffprobe) ──────────

_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VIDEO_RE = re.compile(r"Stream #\S+.*?: Video: .*?,\s*(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_TBR_RE = re.compile(r"(\d+(?:\.\d+)?)\s*tbr")
_ROT_RE = re.compile(r"rotat(?:e|ion)\D*?(-?\d+(?:\.\d+)?)")


def parse_probe(stderr: str) -> ProbeInfo:
    """Parse ``ffmpeg -i`` banner output into a ProbeInfo."""
    m = _DUR_RE.search(stderr)
    if not m:
        raise ValueError("no Duration line in ffmpeg output")
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

    video_line = next((ln for ln in stderr.splitlines() if " Video: " in ln), None)
    if video_line is None:
        raise ValueError("no video stream in ffmpeg output")
    vm = _VIDEO_RE.search(video_line)
    if not vm:
        raise ValueError(f"cannot parse video size from: {video_line.strip()}")
    width, height = int(vm.group(1)), int(vm.group(2))
    fm = _FPS_RE.search(video_line) or _TBR_RE.search(video_line)
    fps = float(fm.group(1)) if fm else 0.0

    rotation = 0
    rm = _ROT_RE.search(stderr)
    if rm:
        rotation = int(round(float(rm.group(1))))
    cm = re.search(r" Video: (\w+)", video_line)
    codec = cm.group(1) if cm else ""
    return ProbeInfo(width, height, round(duration, 3), fps, rotation, codec)


def probe(ffmpeg: str, path: Path) -> ProbeInfo:
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
    )
    # ffmpeg exits 1 when no output is given; the banner is still on stderr.
    return parse_probe(proc.stderr)


# ── command building ─────────────────────────────────────────────────────


def scale_filter(info: ProbeInfo, target: int) -> str:
    """Scale so the short side equals ``target`` (never upscale)."""
    target = min(target, info.short_side)
    if info.orientation == "portrait":
        return f"scale={target}:-2"
    return f"scale=-2:{target}"


def web_fps(info: ProbeInfo) -> float:
    if info.fps and info.fps > WEB_MAX_FPS + 0.5:
        return float(WEB_MAX_FPS)
    return info.fps or float(WEB_MAX_FPS)


def _fmt_fps(fps: float) -> str:
    return str(int(fps)) if float(fps).is_integer() else f"{fps:g}"


def build_web_cmd(ffmpeg: str, src: Path, dst: Path, info: ProbeInfo) -> list[str]:
    fps = web_fps(info)
    vf = [scale_filter(info, WEB_HEIGHT)]
    if fps != info.fps:
        vf.append(f"fps={_fmt_fps(fps)}")
    vf.append("format=yuv420p")
    gop = max(1, round(fps * GOP_SECONDS))
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-i", str(src),
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", ",".join(vf),
        "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
        "-pix_fmt", "yuv420p",
        "-crf", str(WEB_CRF), "-maxrate", "2500k", "-bufsize", "5000k",
        "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        str(dst),
    ]


def needs_analysis(info: ProbeInfo, landscape_only: bool = False) -> bool:
    if landscape_only and info.orientation != "landscape":
        return False
    return info.short_side >= ANALYSIS_HEIGHT


def analysis_is_remux(info: ProbeInfo) -> bool:
    """A source that is already 1080p H.264 is remuxed, not re-encoded.

    Re-encoding it would only lose plate detail and usually grow the file.
    """
    return info.short_side == ANALYSIS_HEIGHT and info.codec == "h264" and info.rotation == 0


def build_analysis_cmd(ffmpeg: str, src: Path, dst: Path, info: ProbeInfo) -> list[str]:
    if analysis_is_remux(info):
        return [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-map", "0:v:0", "-an", "-sn", "-dn",
            "-c:v", "copy",
            "-movflags", "+faststart",
            "-map_metadata", "-1",
            str(dst),
        ]
    fps = info.fps or 30.0
    gop = max(1, round(fps * GOP_SECONDS))
    vf = []
    if info.short_side != ANALYSIS_HEIGHT:
        vf.append(scale_filter(info, ANALYSIS_HEIGHT))
    vf.append("format=yuv420p")
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-i", str(src),
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", ",".join(vf),
        "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
        "-pix_fmt", "yuv420p",
        "-crf", str(ANALYSIS_CRF),
        "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        str(dst),
    ]


def build_poster_cmd(ffmpeg: str, src: Path, dst: Path, info: ProbeInfo) -> list[str]:
    at = min(POSTER_AT_S, max(0.0, info.duration_s / 2))
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{at:.2f}", "-i", str(src),
        "-frames:v", "1",
        "-vf", scale_filter(info, WEB_HEIGHT),
        "-q:v", "4",
        str(dst),
    ]


# ── orchestration ────────────────────────────────────────────────────────


def is_up_to_date(out: Path, src: Path, profile_ok: bool) -> bool:
    return (
        profile_ok
        and out.exists()
        and out.stat().st_size > 0
        and out.stat().st_mtime >= src.stat().st_mtime
    )


def run_to(cmd: list[str], dst: Path) -> None:
    """Run an ffmpeg command writing to a temp file, then atomically rename."""
    tmp = dst.with_name(f".{dst.stem}.partial{dst.suffix}")
    cmd = cmd[:-1] + [str(tmp)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(cmd, check=True)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()


def manifest_entry(
    slug: str,
    src: Path,
    src_info: ProbeInfo,
    web_path: Path,
    web_info: ProbeInfo,
    poster: Path,
    analysis_path: Path | None,
    analysis_info: ProbeInfo | None,
    root: Path,
) -> dict:
    def rel(p: Path) -> str:
        try:
            return str(p.resolve().relative_to(root.resolve()))
        except ValueError:
            return str(p)

    w, h = web_info.display_size
    entry = {
        "slug": slug,
        "file": web_path.name,
        "width": w,
        "height": h,
        "duration_s": round(web_info.duration_s, 2),
        "fps": web_info.fps,
        "bytes": web_path.stat().st_size,
        "orientation": web_info.orientation,
        "poster": poster.name,
        "source": {
            "file": rel(src),
            "width": src_info.display_size[0],
            "height": src_info.display_size[1],
            "fps": src_info.fps,
            "bytes": src.stat().st_size,
        },
        "analysis": None,
        "profile": PROFILE,
    }
    if analysis_path is not None and analysis_info is not None:
        aw, ah = analysis_info.display_size
        entry["analysis"] = {
            "file": rel(analysis_path),
            "width": aw,
            "height": ah,
            "fps": analysis_info.fps,
            "bytes": analysis_path.stat().st_size,
        }
    return entry


def load_manifest(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text())
            return {c["slug"]: c for c in data.get("clips", [])}
        except (ValueError, KeyError, TypeError):
            pass
    return {}


def write_manifest(path: Path, entries: dict) -> None:
    clips = [entries[k] for k in sorted(entries)]
    doc = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "profile": PROFILE,
        "count": len(clips),
        "total_bytes": sum(c["bytes"] for c in clips),
        "clips": clips,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n")
    os.replace(tmp, path)


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return str(n)


def process(
    src: Path,
    ffmpeg: str,
    web_dir: Path,
    analysis_dir: Path,
    old_entry: dict | None,
    force: bool,
    landscape_only: bool,
    skip_analysis: bool,
    root: Path,
    label: str,
) -> dict:
    slug = slug_for(src)
    profile_ok = (not force) and bool(old_entry) and old_entry.get("profile") == PROFILE
    info = probe(ffmpeg, src)
    print(
        f"{label} {slug}: source {info.display_size[0]}x{info.display_size[1]} "
        f"{info.fps:g} fps {info.duration_s:.1f}s {human(src.stat().st_size)} ({info.orientation})",
        flush=True,
    )

    web = web_dir / f"{slug}.mp4"
    poster = web_dir / f"{slug}.jpg"
    analysis = analysis_dir / f"{slug}.mp4"

    if is_up_to_date(web, src, profile_ok):
        print("    720p    up to date, skipped", flush=True)
    else:
        print("    720p    encoding...", flush=True)
        t = time.time()
        run_to(build_web_cmd(ffmpeg, src, web, info), web)
        print(f"\n    720p    done in {time.time() - t:.0f}s, {human(web.stat().st_size)}", flush=True)

    if is_up_to_date(poster, src, profile_ok):
        print("    poster  up to date, skipped", flush=True)
    else:
        run_to(build_poster_cmd(ffmpeg, src, poster, info), poster)
        print(f"    poster  written, {human(poster.stat().st_size)}", flush=True)

    analysis_info = None
    analysis_out = None
    if skip_analysis:
        print("    1080p   skipped (--skip-analysis)", flush=True)
        if analysis.exists():
            analysis_out = analysis
    elif not needs_analysis(info, landscape_only):
        print("    1080p   not applicable (source below 1080p or portrait with --analysis-landscape-only)", flush=True)
    elif is_up_to_date(analysis, src, profile_ok):
        print("    1080p   up to date, skipped", flush=True)
        analysis_out = analysis
    else:
        mode = "remuxing (source already 1080p H.264)" if analysis_is_remux(info) else "encoding"
        print(f"    1080p   {mode}...", flush=True)
        t = time.time()
        run_to(build_analysis_cmd(ffmpeg, src, analysis, info), analysis)
        print(f"\n    1080p   done in {time.time() - t:.0f}s, {human(analysis.stat().st_size)}", flush=True)
        analysis_out = analysis
    if analysis_out is not None:
        analysis_info = probe(ffmpeg, analysis_out)

    web_info = probe(ffmpeg, web)
    return manifest_entry(slug, src, info, web, web_info, poster, analysis_out, analysis_info, root)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="directory of source .mp4 clips")
    ap.add_argument("--out", type=Path, default=DEFAULT_WEB, help="720p output directory")
    ap.add_argument("--analysis-out", type=Path, default=DEFAULT_ANALYSIS, help="1080p output directory")
    ap.add_argument("--only", action="append", metavar="SLUG", help="process only this slug (repeatable)")
    ap.add_argument("--force", action="store_true", help="re-encode even if outputs are up to date")
    ap.add_argument("--skip-analysis", action="store_true", help="do not build 1080p analysis renditions")
    ap.add_argument(
        "--analysis-landscape-only",
        action="store_true",
        help="build 1080p analysis renditions for landscape sources only",
    )
    args = ap.parse_args(argv)

    sources = sorted(p for p in args.src.glob("*.mp4") if not p.name.startswith("."))
    if args.only:
        wanted = set(args.only)
        missing = wanted - {slug_for(p) for p in sources}
        if missing:
            print(f"unknown slug(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 2
        sources = [p for p in sources if slug_for(p) in wanted]
    if not sources:
        print(f"no .mp4 files in {args.src}", file=sys.stderr)
        return 1

    ffmpeg = ffmpeg_exe()
    manifest_path = args.out / "manifest.json"
    entries = load_manifest(manifest_path)
    # Drop entries whose source no longer exists.
    all_slugs = {slug_for(p) for p in args.src.glob("*.mp4")}
    entries = {k: v for k, v in entries.items() if k in all_slugs}

    root = PIPELINE.parent
    failures = []
    for i, src in enumerate(sources, 1):
        slug = slug_for(src)
        try:
            entries[slug] = process(
                src, ffmpeg, args.out, args.analysis_out, entries.get(slug),
                args.force, args.analysis_landscape_only, args.skip_analysis,
                root, f"[{i}/{len(sources)}]",
            )
        except (subprocess.CalledProcessError, ValueError) as exc:
            print(f"    FAILED: {exc}", file=sys.stderr, flush=True)
            failures.append(slug)
        write_manifest(manifest_path, entries)

    done = [entries[slug_for(s)] for s in sources if slug_for(s) in entries]
    src_total = sum(e["source"]["bytes"] for e in done)
    web_total = sum(e["bytes"] for e in done)
    ana_total = sum((e["analysis"] or {}).get("bytes", 0) for e in done)
    print(
        f"\n{len(done)} clip(s): source {human(src_total)} -> 720p {human(web_total)}"
        f" + 1080p {human(ana_total)}. Manifest: {manifest_path}"
    )
    if failures:
        print(f"failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
