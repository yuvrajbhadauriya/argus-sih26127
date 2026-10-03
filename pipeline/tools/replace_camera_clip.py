#!/usr/bin/env python3
"""Give one camera a new video clip, end to end, on the maintainer's machine.

    python3 pipeline/tools/replace_camera_clip.py --camera KR-01 \\
        --source ~/Downloads/12974288_3840_2160_30fps.mp4

What it does (each step prints what it is doing; any failure aborts with a
message and leaves the dashboard config untouched):

  1. Validate the source with OpenCV (opens, size, fps, length, frames decode).
  2. Transcode to the same renditions the other clips use (H.264, yuv420p,
     +faststart, no audio), see pipeline/tools/prepare_videos.py:
       pipeline/data/videos_720p/<slug>.mp4 + .jpg   web rendition + poster
       pipeline/data/videos_1080p/<slug>.mp4          analysis rendition (detection input)
       public/videos-local/<slug>.mp4 + .jpg          what `npm run dev` plays
     ffmpeg is used when present (FFMPEG_BINARY, PATH, imageio-ffmpeg); on a
     Mac without it the built-in `avconvert` H.264 preset is the fallback;
     with neither, the script says `brew install ffmpeg`.
     Length: the whole clip up to 45 s (the other clips run 10-71 s, median
     ~44 s), so a 20 s clip stays whole and a 57 s clip keeps its first 45 s;
     use --start/--duration to pick another window.
     Default slug: mumbai_<camera name>_pexels<id from the file name>, e.g.
     12974288_3840_2160_30fps.mp4 for KR-01 -> mumbai_kurla-depot-junction_pexels12974288
     (--slug overrides). Nothing in the tool is specific to one camera.
  3. Run pipeline/detect/run_remote_detection.py on the analysis rendition with
     its default settings (same tiling and thresholds as every other camera;
     needs DETECTION_API_URL + DETECTION_API_KEY in the environment or .env).
     Output goes to a staging folder first. Only when the run succeeded are the
     old detections_/events_ files copied to pipeline/data/backups/, the new
     ones installed in public/detections/, manifest.json updated, and the
     camera -> clip mapping (src/config/cameraClips.json, which the dashboard
     reads, and pipeline/camera_config.json) switched to the new slug.
  4. With --upload only: upload the clip + poster to the private Supabase
     `videos` bucket (mumbai/720p/) the way upload_videos.py does, and PRINT
     the insert_detections.py command for the production database. Nothing
     writes to the database from here.
  5. Print a summary and the next commands.

Safe to re-run: finished steps are skipped (--force redoes them), and the old
clip, its renditions, detections and events are never deleted.

``--dry-run`` reads the source and prints the whole plan; it writes nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
PIPELINE = TOOLS.parent
REPO = PIPELINE.parent
for _p in (str(TOOLS), str(PIPELINE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import prepare_videos as pv  # noqa: E402  (sibling module: encode profile + command builders)

#: Default length cap. The other clips run 10-71 s (median ~44 s).
MAX_DEFAULT_DURATION_S = 45.0
MIN_SENSIBLE_DURATION_S = 5.0
#: Output length may differ from the plan by this much (keyframes, rounding).
DURATION_TOLERANCE_S = 0.6
SLUG_RE = re.compile(r"^[a-z0-9]+_[a-z0-9-]+_pexels\d+$")
H264_FOURCCS = {"avc1", "h264", "x264", "avc3"}
AVCONVERT_WEB_PRESET = "Preset1280x720"
AVCONVERT_ANALYSIS_PRESET = "Preset1920x1080"
UPLOAD_PREFIX = "mumbai/720p"
UPLOAD_BUCKET = "videos"


class StepError(Exception):
    """A step failed; the message is shown to the user and the run stops."""


@dataclass
class Paths:
    """Every file the tool reads or writes (tests point these at a temp copy)."""

    repo: Path = REPO

    @property
    def web_dir(self) -> Path:
        return self.repo / "pipeline" / "data" / "videos_720p"

    @property
    def analysis_dir(self) -> Path:
        return self.repo / "pipeline" / "data" / "videos_1080p"

    @property
    def local_dir(self) -> Path:
        return self.repo / "public" / "videos-local"

    @property
    def detections_dir(self) -> Path:
        return self.repo / "public" / "detections"

    @property
    def clips_json(self) -> Path:
        return self.repo / "src" / "config" / "cameraClips.json"

    @property
    def camera_config(self) -> Path:
        return self.repo / "pipeline" / "camera_config.json"

    @property
    def backups_dir(self) -> Path:
        return self.repo / "pipeline" / "data" / "backups"

    @property
    def work_dir(self) -> Path:
        return self.repo / "pipeline" / "data" / "replace_camera_clip"

    @property
    def cache_dir(self) -> Path:
        return self.repo / "pipeline" / "data" / "detect_cache"

    @property
    def env_file(self) -> Path:
        return self.repo / ".env"


def say(msg: str = "") -> None:
    print(msg, flush=True)


def step(n: int, title: str) -> None:
    say(f"\n== Step {n}: {title}")


def human(n: float) -> str:
    return pv.human(int(n))


# ── slug rules ───────────────────────────────────────────────────────────


def slug_problem(slug: str) -> str | None:
    """Why ``slug`` is not an acceptable clip slug (None when it is fine)."""
    if not SLUG_RE.match(slug or ""):
        return (f"slug '{slug}' must look like mumbai_<description>_pexels<id> "
                "(lower-case letters, digits and '-', e.g. mumbai_andheri-flyover_pexels13270133)")
    return None


def pexels_id_from_name(name: str) -> str | None:
    """Pexels id from 'pexels12974288' or Pexels' own '12974288_3840_2160_30fps.mp4'."""
    stem = Path(name).stem
    m = re.search(r"pexels(\d+)", stem) or re.match(r"^(\d{5,})(?:_\d+_\d+_\d+fps)?$", stem)
    return m.group(1) if m else None


def slugify(text: str) -> str:
    """'Andheri Flyover (Gundavali)' -> 'andheri-flyover-gundavali'."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def default_slug(camera_name: str, source: Path) -> str:
    """mumbai_<camera name>_pexels<id from the file name>; the name is the camera's, so no camera is special-cased."""
    pid = pexels_id_from_name(source.name)
    if not pid:
        raise StepError(f"cannot derive a Pexels id from '{source.name}'; pass --slug mumbai_<desc>_pexels<id>")
    desc = slugify(camera_name)
    if not desc:
        raise StepError("the camera has no name to build a slug from; pass --slug mumbai_<desc>_pexels<id>")
    return f"mumbai_{desc}_pexels{pid}"


# ── json helpers ─────────────────────────────────────────────────────────


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise StepError(f"missing {path}") from None
    except ValueError as exc:
        raise StepError(f"{path} is not valid JSON: {exc}") from None


def write_json(path: Path, doc, indent: int | None = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    text = json.dumps(doc, indent=indent, ensure_ascii=False)
    tmp.write_text(text + "\n", encoding="utf-8")
    os.replace(tmp, path)


# ── step 1: validate the source ──────────────────────────────────────────


def import_cv2():
    try:
        import cv2
    except ImportError:
        raise StepError("OpenCV is not installed. Run: python3 -m pip install opencv-python-headless") from None
    return cv2


def probe_clip(path: Path, cv2=None) -> dict:
    """Open ``path`` with OpenCV and read size, fps, frames; decode a first and a middle frame."""
    cv2 = cv2 or import_cv2()
    if not path.is_file():
        raise StepError(f"{path} does not exist or is not a file")
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise StepError(f"OpenCV cannot open {path} (not a readable video?)")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fourcc_raw = int(cap.get(getattr(cv2, "CAP_PROP_FOURCC", 6)) or 0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise StepError(f"{path} opens but its first frame cannot be decoded")
        height, width = frame.shape[:2]
        if fps <= 0 or frames <= 0:
            raise StepError(f"{path} reports fps={fps} frames={frames}; cannot size the clip")
        mid = max(0, frames // 2)
        cap.set(getattr(cv2, "CAP_PROP_POS_FRAMES", 1), mid)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise StepError(f"{path}: frame {mid} cannot be decoded; the file looks truncated or corrupt")
    finally:
        cap.release()
    fourcc = "".join(chr((fourcc_raw >> (8 * i)) & 0xFF) for i in range(4)).strip("\x00 ").lower() if fourcc_raw else ""
    return {"width": int(width), "height": int(height), "fps": fps, "frames": frames,
            "duration_s": frames / fps, "fourcc": fourcc, "bytes": path.stat().st_size}


def plan_trim(duration_s: float, start: float | None, length: float | None) -> dict:
    """The window of the source to keep: {start, length, trimmed, note}."""
    s = float(start or 0.0)
    if s < 0:
        raise StepError("--start must be >= 0")
    if length is not None and length <= 0:
        raise StepError("--duration must be > 0")
    if s >= duration_s:
        raise StepError(f"--start {s:g} s is beyond the end of the {duration_s:.1f} s source")
    avail = duration_s - s
    if length is None:
        keep = min(avail, MAX_DEFAULT_DURATION_S)
        why = (f"whole clip (default: up to {MAX_DEFAULT_DURATION_S:g} s; the other clips run 10-71 s)"
               if keep == avail else f"first {keep:g} s (default cap {MAX_DEFAULT_DURATION_S:g} s)")
    else:
        keep = min(length, avail)
        why = "--duration given" + (f" (clamped to the {avail:.1f} s left after --start)" if keep < length else "")
    if keep < MIN_SENSIBLE_DURATION_S:
        raise StepError(f"only {keep:.1f} s would be kept; need at least {MIN_SENSIBLE_DURATION_S:g} s of footage")
    trimmed = s > 0 or keep < duration_s - 0.05
    return {"start": s, "length": keep, "trimmed": trimmed, "note": why}


# ── step 2: transcode ────────────────────────────────────────────────────


def find_encoder(env: dict | None = None, which=None, platform: str | None = None) -> tuple[str, str]:
    """('ffmpeg', path) or ('avconvert', path); StepError (with the brew hint) when neither exists."""
    env = os.environ if env is None else env
    which = which or shutil.which
    platform = platform or sys.platform
    candidate = env.get("FFMPEG_BINARY")
    if candidate:
        if os.path.isfile(candidate) or which(candidate):
            return "ffmpeg", candidate
        raise StepError(f"FFMPEG_BINARY={candidate} does not exist")
    found = which("ffmpeg")
    if found:
        return "ffmpeg", found
    try:
        import imageio_ffmpeg

        return "ffmpeg", imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - not installed / no bundled binary
        pass
    if platform == "darwin" and which("avconvert"):
        return "avconvert", which("avconvert")  # type: ignore[return-value]
    raise StepError("no video encoder found (ffmpeg, or macOS avconvert). Install ffmpeg:\n    brew install ffmpeg")


def with_trim(cmd: list[str], plan: dict) -> list[str]:
    """Insert accurate input-side -ss/-t before the first -i of an ffmpeg command."""
    if not plan["trimmed"]:
        return cmd
    i = cmd.index("-i")
    return cmd[:i] + ["-ss", f"{plan['start']:g}", "-t", f"{plan['length']:g}"] + cmd[i:]


def source_info(probe: dict, plan: dict) -> "pv.ProbeInfo":
    # codec "" so a trimmed 1080p H.264 source is re-encoded, not stream-copied at keyframes.
    return pv.ProbeInfo(probe["width"], probe["height"], plan["length"], probe["fps"], 0, "")


def ffmpeg_commands(ffmpeg: str, src: Path, web: Path, analysis: Path, info: "pv.ProbeInfo", plan: dict) -> dict:
    cmds = {"web": with_trim(pv.build_web_cmd(ffmpeg, src, web, info), plan)}
    if pv.needs_analysis(info):
        cmds["analysis"] = with_trim(pv.build_analysis_cmd(ffmpeg, src, analysis, info), plan)
    return cmds


def avconvert_command(exe: str, src: Path, dst: Path, preset: str, plan: dict) -> list[str]:
    cmd = [exe, "--source", str(src), "--preset", preset, "--output", str(dst), "--replace"]
    if plan["trimmed"]:
        cmd += ["--start", f"{plan['start']:g}", "--duration", f"{plan['length']:g}"]
    return cmd


def run_command(cmd: list[str]) -> None:
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        raise StepError(f"command failed (exit {proc.returncode}): {shlex.join(cmd)}")


def encode_to(cmd: list[str], dst: Path, runner=None) -> None:
    """Run an encoder command that writes its last argument (ffmpeg) or --output (avconvert) to a temp file, then rename."""
    runner = runner or run_command
    tmp = dst.with_name(f".{dst.stem}.partial{dst.suffix}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if "--output" in cmd:
        cmd = list(cmd)
        cmd[cmd.index("--output") + 1] = str(tmp)
    else:
        cmd = cmd[:-1] + [str(tmp)]
    try:
        if tmp.exists():
            tmp.unlink()
        runner(cmd)
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise StepError(f"the encoder reported success but wrote no file for {dst.name}")
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()


def is_faststart(path: Path) -> bool:
    """True when the mp4's moov box comes before its mdat (streamable before it fully downloads)."""
    offsets: dict[str, int] = {}
    size_total = path.stat().st_size
    with path.open("rb") as f:
        pos = 0
        while pos + 8 <= size_total:
            f.seek(pos)
            head = f.read(16)
            size = int.from_bytes(head[:4], "big")
            kind = head[4:8].decode("latin-1")
            if size == 1:
                size = int.from_bytes(head[8:16], "big")
            elif size == 0:
                size = size_total - pos
            offsets.setdefault(kind, pos)
            if size < 8:
                break
            pos += size
    return "ftyp" in offsets and "moov" in offsets and "mdat" in offsets and offsets["moov"] < offsets["mdat"]


def verify_clip(path: Path, *, min_short_side: int | None = None, max_short_side: int | None = None,
                expect_duration: float | None = None, max_fps: float | None = None, cv2=None) -> dict:
    """Decode ``path`` and check it is what a browser can play. Returns its probe, raises StepError."""
    info = probe_clip(path, cv2)
    short = min(info["width"], info["height"])
    if info["fourcc"] and info["fourcc"] not in H264_FOURCCS:
        raise StepError(f"{path.name}: codec '{info['fourcc']}' is not H.264; browsers may not play it")
    if min_short_side and short < min_short_side or max_short_side and short > max_short_side:
        raise StepError(f"{path.name}: {info['width']}x{info['height']} is not the expected size")
    if max_fps and info["fps"] > max_fps + 0.5:
        raise StepError(f"{path.name}: {info['fps']:g} fps exceeds {max_fps:g}")
    if expect_duration is not None and abs(info["duration_s"] - expect_duration) > DURATION_TOLERANCE_S:
        raise StepError(f"{path.name}: is {info['duration_s']:.1f} s long, expected {expect_duration:.1f} s "
                        "(the encoder ignored the trim?)")
    if not is_faststart(path):
        raise StepError(f"{path.name}: moov atom is not at the start of the file (no +faststart)")
    return info


def poster_from_clip(web: Path, poster: Path, cv2) -> None:
    """Poster frame ~1 s in, taken with OpenCV (the avconvert path, which cannot make a jpg itself)."""
    cap = cv2.VideoCapture(str(web))
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps * pv.POSTER_AT_S))
        ok, frame = cap.read()
        if not ok:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = cap.read()
        if not ok:
            raise StepError("could not read a frame for the poster")
    finally:
        cap.release()
    tmp = poster.with_name(f".{poster.stem}.partial{poster.suffix}")
    if not cv2.imwrite(str(tmp), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85]):
        raise StepError("could not write the poster jpg")
    os.replace(tmp, poster)


def place_local(paths: Paths, slug: str) -> list[Path]:
    """Copy the web mp4 + poster into public/videos-local/ (replacing a stale link/copy of the same name)."""
    paths.local_dir.mkdir(parents=True, exist_ok=True)
    placed = []
    for ext in (".mp4", ".jpg"):
        src = paths.web_dir / f"{slug}{ext}"
        dst = paths.local_dir / f"{slug}{ext}"
        if dst.is_symlink() or dst.exists():
            dst.unlink()
        shutil.copy2(src, dst)
        placed.append(dst)
    return placed


def record_path(paths: Paths, slug: str) -> Path:
    return paths.work_dir / f"{slug}.json"


def transcode(paths: Paths, slug: str, source: Path, probe: dict, plan: dict, encoder: tuple[str, str],
              force: bool, cv2=None, runner=None) -> dict:
    """Make + verify the renditions. Returns the analysis/web facts used by later steps."""
    kind, exe = encoder
    web, poster, analysis = paths.web_dir / f"{slug}.mp4", paths.web_dir / f"{slug}.jpg", paths.analysis_dir / f"{slug}.mp4"
    stamp = {"source": source.name, "source_bytes": probe["bytes"], "start": plan["start"],
             "length": round(plan["length"], 3), "profile": pv.PROFILE, "encoder": kind}
    rec = record_path(paths, slug)
    done = None
    if not force and rec.exists() and web.exists() and poster.exists():
        try:
            done = json.loads(rec.read_text()) == stamp
        except ValueError:
            done = False
    needs_analysis = min(probe["width"], probe["height"]) >= pv.ANALYSIS_HEIGHT
    if done and (analysis.exists() or not needs_analysis):
        say("  already transcoded from this source with the same settings: skipped (use --force to redo)")
    else:
        info = source_info(probe, plan)
        if kind == "ffmpeg":
            say(f"  encoder: ffmpeg ({exe})")
            cmds = ffmpeg_commands(exe, source, web, analysis, info, plan)
            for name, dst in (("web", web), ("analysis", analysis)):
                if name in cmds:
                    say(f"  encoding {name} rendition -> {dst.name} ...")
                    t = time.time()
                    encode_to(cmds[name], dst, runner)
                    say(f"  done in {time.time() - t:.0f} s, {human(dst.stat().st_size)}")
            say("  poster ...")
            encode_to(pv.build_poster_cmd(exe, web, poster, _info_of(web, cv2)), poster, runner)
        else:
            say(f"  encoder: macOS avconvert ({exe}) -- ffmpeg not found; `brew install ffmpeg` gives more control")
            for name, preset, dst in (("web", AVCONVERT_WEB_PRESET, web), ("analysis", AVCONVERT_ANALYSIS_PRESET, analysis)):
                if name == "analysis" and not needs_analysis:
                    continue
                say(f"  encoding {name} rendition with {preset} -> {dst.name} ...")
                t = time.time()
                encode_to(avconvert_command(exe, source, dst, preset, plan), dst, runner)
                say(f"  done in {time.time() - t:.0f} s, {human(dst.stat().st_size)}")
            say("  poster (frame grab with OpenCV) ...")
            poster_from_clip(web, poster, cv2 or import_cv2())
        write_json(rec, stamp)

    web_probe = verify_clip(web, min_short_side=1, max_short_side=pv.WEB_HEIGHT, expect_duration=plan["length"],
                            max_fps=pv.WEB_MAX_FPS, cv2=cv2)
    if not poster.exists() or poster.stat().st_size == 0:
        raise StepError(f"poster {poster} was not written")
    analysis_probe = None
    if needs_analysis:
        analysis_probe = verify_clip(analysis, expect_duration=plan["length"], cv2=cv2)
    say(f"  web      {web_probe['width']}x{web_probe['height']} {web_probe['fps']:g} fps {web_probe['duration_s']:.1f} s "
        f"{human(web_probe['bytes'])}  H.264 faststart: OK")
    if analysis_probe:
        say(f"  analysis {analysis_probe['width']}x{analysis_probe['height']} {analysis_probe['fps']:g} fps "
            f"{analysis_probe['duration_s']:.1f} s {human(analysis_probe['bytes'])}  H.264 faststart: OK")
    else:
        say("  analysis: source is below 1080p, no analysis rendition made")
    update_prepare_manifest(paths, slug, source, probe, web_probe, analysis_probe, poster, analysis)
    placed = place_local(paths, slug)
    say("  dev copies: " + ", ".join(str(p.relative_to(paths.repo)) for p in placed))
    return {"web": web_probe, "analysis": analysis_probe}


def _info_of(path: Path, cv2) -> "pv.ProbeInfo":
    p = probe_clip(path, cv2)
    return pv.ProbeInfo(p["width"], p["height"], p["duration_s"], p["fps"], 0, "h264")


def update_prepare_manifest(paths: Paths, slug: str, source: Path, probe: dict, web_probe: dict,
                            analysis_probe: dict | None, poster: Path, analysis: Path) -> None:
    """Add/replace this clip in pipeline/data/videos_720p/manifest.json (the file link_local_videos.py serves)."""
    path = paths.web_dir / "manifest.json"
    entries = pv.load_manifest(path)
    mk = lambda p: pv.ProbeInfo(p["width"], p["height"], p["duration_s"], p["fps"], 0, "h264")  # noqa: E731
    src_info = pv.ProbeInfo(probe["width"], probe["height"], probe["duration_s"], probe["fps"])
    entries[slug] = pv.manifest_entry(
        slug, source, src_info, paths.web_dir / f"{slug}.mp4", mk(web_probe), poster,
        analysis if analysis_probe else None, mk(analysis_probe) if analysis_probe else None, paths.repo)
    pv.write_manifest(path, entries)
    local = paths.local_dir / "manifest.json"
    if paths.local_dir.exists() and not local.is_symlink():
        shutil.copy2(path, local)


# ── step 3: detection + switching the mapping ────────────────────────────


def camera_entry(paths: Paths, code: str) -> tuple[list, dict]:
    cfg = read_json(paths.camera_config)
    entry = next((c for c in cfg if c.get("camera_code") == code), None)
    if entry is None:
        raise StepError(f"camera {code} is not in {paths.camera_config}")
    return cfg, entry


def renamed_entry(entry: dict, new_slug: str) -> dict:
    """camera_config entry pointing at another clip (same host and folder as before)."""
    old = entry.get("video_slug", "")
    out = dict(entry)
    out["video_slug"] = new_slug
    out["video_filename"] = f"{new_slug}.mp4"
    for key in ("video_url", "poster_url"):
        if entry.get(key) and old:
            out[key] = entry[key].replace(old, new_slug)
    return out


def run_detection(paths: Paths, code: str, slug: str, entry: dict, from_cache: bool, detect_main=None) -> tuple[Path, list[dict]]:
    """Run run_remote_detection.py on the new clip into a staging folder; return (staged output dir, this camera's summaries)."""
    stage = Path(tempfile.mkdtemp(prefix=f"detect_{code}_", dir=str(_ensure(paths.work_dir))))
    cfg_path = stage / "camera_config.json"
    write_json(cfg_path, [renamed_entry(entry, slug)])
    out_dir = stage / "out"
    out_dir.mkdir()
    argv = ["--config", str(cfg_path), "--videos_dir", str(paths.analysis_dir), "--output_dir", str(out_dir),
            "--cache_dir", str(paths.cache_dir), "--cameras", code, "--env_file", str(paths.env_file)]
    if from_cache:
        argv.append("--from_cache")
    if detect_main is None:
        from detect import run_remote_detection as rrd

        detect_main = rrd.main
    say("  settings: run_remote_detection.py defaults (frame_step=1&tiles=2x3&roi_top=0.33&min_conf=0, overlay at 5 fps)")
    say(f"  running: run_remote_detection.py {shlex.join(argv)}")
    rc = detect_main(argv)
    if rc != 0:
        why = {1: "nothing was processed", 2: "the model API is not configured/reachable or rejected the request "
               "(set DETECTION_API_URL and DETECTION_API_KEY in .env, be on the team network/Tailscale)"}.get(rc, f"exit code {rc}")
        raise StepError(f"detection failed: {why}.\n  Nothing in public/ or the camera mapping was changed. "
                        "Re-run the same command to continue (finished GPU responses are cached).")
    for name in (f"detections_{code}.json", f"events_{code}.json"):
        if not (out_dir / name).is_file():
            raise StepError(f"detection finished but {name} was not written")
    events = read_json(out_dir / f"events_{code}.json")
    clip_file = (events.get("clip") or {}).get("file")
    if clip_file != f"{slug}.mp4":
        raise StepError(f"events_{code}.json was made on '{clip_file}', not '{slug}.mp4'; refusing to install it")
    summaries = [s for s in _read_summaries(paths.cache_dir) if s.get("camera_code") == code
                 and s.get("video_filename") == f"{slug}.mp4"]
    if not summaries:
        raise StepError(f"no run summary for {code}/{slug}.mp4 in {paths.cache_dir / 'summary.json'}")
    return out_dir, summaries


def _read_summaries(cache_dir: Path) -> list[dict]:
    p = cache_dir / "summary.json"
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return doc if isinstance(doc, list) else []


def _ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def recorded_clip(paths: Paths, code: str) -> str | None:
    """Slug of the clip the published events_<code>.json were made on (None when absent/unreadable)."""
    ev = paths.detections_dir / f"events_{code}.json"
    try:
        name = (json.loads(ev.read_text()).get("clip") or {}).get("file")
    except (OSError, ValueError, AttributeError):
        return None
    return Path(name).stem if name else None


def backup_old_outputs(paths: Paths, code: str, new_slug: str) -> Path | None:
    """Copy the camera's current detections/events/manifest aside (never deleted, never overwritten)."""
    old_name = recorded_clip(paths, code) or "unknown-clip"
    if old_name == new_slug:
        return None  # re-run: the current files are already this clip's output
    dest = paths.backups_dir / f"{code}_{old_name}"
    n = 2
    while dest.exists():
        dest = paths.backups_dir / f"{code}_{old_name}-{n}"
        n += 1
    dest.mkdir(parents=True)
    for name in (f"events_{code}.json", f"detections_{code}.json", "manifest.json"):
        if (paths.detections_dir / name).exists():
            shutil.copy2(paths.detections_dir / name, dest / name)
    return dest


def install_detections(paths: Paths, code: str, slug: str, stage_out: Path, summaries: list[dict], rrd=None) -> Path | None:
    backup = backup_old_outputs(paths, code, slug)
    paths.detections_dir.mkdir(parents=True, exist_ok=True)
    for name in (f"detections_{code}.json", f"events_{code}.json"):
        tmp = paths.detections_dir / f".{name}.tmp"
        shutil.copy2(stage_out / name, tmp)
        os.replace(tmp, paths.detections_dir / name)
    if rrd is None:
        from detect import run_remote_detection as rrd
    rrd.write_manifest(str(paths.detections_dir), summaries)
    return backup


def update_mapping(paths: Paths, code: str, slug: str) -> list[str]:
    """Point the camera at ``slug`` in src/config/cameraClips.json and pipeline/camera_config.json."""
    changes = []
    clips = read_json(paths.clips_json)
    if code not in clips:
        raise StepError(f"{code} is not in {paths.clips_json}")
    cfg, entry = camera_entry(paths, code)
    if clips[code] != slug:
        changes.append(f"{paths.clips_json.relative_to(paths.repo)}: {code} {clips[code]} -> {slug}")
        clips[code] = slug
        write_json(paths.clips_json, clips)
    new_entry = renamed_entry(entry, slug)
    if new_entry != entry:
        changes.append(f"{paths.camera_config.relative_to(paths.repo)}: {code} -> {slug}")
        write_json(paths.camera_config, [new_entry if c is entry else c for c in cfg], indent=2)
    return changes


def leftover_references(paths: Paths, old_slug: str) -> list[str]:
    """Tracked files that still mention the old slug (historic SQL migrations legitimately do)."""
    if old_slug == "" or not shutil.which("git"):
        return []
    proc = subprocess.run(["git", "-C", str(paths.repo), "grep", "-l", "-F", old_slug],
                          capture_output=True, text=True)
    return [ln for ln in proc.stdout.splitlines() if ln.strip()]


# ── step 4: upload (private bucket) ──────────────────────────────────────


def upload_clip(paths: Paths, slug: str, dry_run: bool, uploader=None, creds=None) -> list[str]:
    """Upload <slug>.mp4/.jpg to the private `videos` bucket like upload_videos.py. No bucket is created."""
    import upload_videos as uv

    files = [paths.web_dir / f"{slug}.mp4", paths.web_dir / f"{slug}.jpg"]
    missing = [f for f in files if not f.is_file()]
    if missing and not dry_run:
        raise StepError(f"cannot upload, missing {', '.join(str(m) for m in missing)}")
    base, key = (creds or uv.credentials)(paths.env_file)
    objs = [uv.object_path(f, UPLOAD_PREFIX) for f in files]
    if dry_run:
        for o in objs:
            say(f"  would upload {o} to bucket '{UPLOAD_BUCKET}'")
        return objs
    if not (base and key):
        raise StepError("--upload needs SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in the environment or .env")
    uploader = uploader or uv.upload
    for f, o in zip(files, objs):
        try:
            uploader(base, key, UPLOAD_BUCKET, o, f)
        except Exception as exc:  # urllib HTTPError/URLError
            raise StepError(f"upload of {o} failed: {exc}") from None
        say(f"  uploaded {o} ({human(f.stat().st_size)})")
    return objs


INSERT_CMD = "python3 pipeline/insert_detections.py --detections_dir ./public/detections --prune"


# ── step 5: summary ──────────────────────────────────────────────────────


def read_stats(paths: Paths, code: str) -> dict:
    doc = read_json(paths.detections_dir / f"events_{code}.json")
    events = doc.get("events", [])
    reads = [e for e in events if e.get("plate_read")]
    good = [e for e in events if e.get("good_read")]
    return {"clip": doc.get("clip", {}), "vehicles": len(events), "reads": len(reads), "good": len(good),
            "model": doc.get("model_version")}


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="replace_camera_clip.py",
        description="Replace a camera's clip: validate, transcode, run detection, switch the dashboard mapping.")
    ap.add_argument("--camera", required=True, help="camera code from src/config/cameraClips.json")
    ap.add_argument("--source", required=True, type=Path, help="the new video file (any codec OpenCV can read)")
    ap.add_argument("--slug", help="new clip slug mumbai_<desc>_pexels<id> (default derived from the file name)")
    ap.add_argument("--start", type=float, default=None, help="trim: start second in the source (default 0)")
    ap.add_argument("--duration", type=float, default=None,
                    help=f"trim: seconds to keep (default: whole clip, at most {MAX_DEFAULT_DURATION_S:g} s)")
    ap.add_argument("--dry-run", action="store_true", help="read the source and print the plan; write nothing")
    ap.add_argument("--upload", action="store_true", help="also upload the clip + poster to the private Supabase bucket")
    ap.add_argument("--force", action="store_true", help="redo the transcode even if it is up to date")
    ap.add_argument("--no-detect", action="store_true", help="stop after the transcode (no GPU run, mapping unchanged)")
    ap.add_argument("--from-cache", action="store_true", help="build detection output from cached GPU responses only")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None, paths: Paths | None = None, cv2=None, runner=None,
         detect_main=None, uploader=None, creds=None, rrd=None) -> int:
    args = parse_args(argv)
    paths = paths or Paths()
    try:
        return _run(args, paths, cv2, runner, detect_main, uploader, creds, rrd)
    except StepError as exc:
        print(f"\n[x] {exc}", file=sys.stderr)
        print("    Stopped. The old clip, its detections and the dashboard mapping were not touched "
              "beyond what is listed above.", file=sys.stderr)
        return 1


def _run(args, paths: Paths, cv2, runner, detect_main, uploader, creds, rrd) -> int:
    code = args.camera.strip().upper()
    source = args.source.expanduser().resolve()
    dry = args.dry_run
    say(f"replace_camera_clip: {code} <- {source}" + ("   [DRY RUN: nothing will be written]" if dry else ""))

    if not source.is_file():
        raise StepError(f"{source} does not exist or is not a file")
    clips = read_json(paths.clips_json)
    if code not in clips:
        raise StepError(f"unknown camera {code}; known: {', '.join(sorted(clips))}")
    cfg, entry = camera_entry(paths, code)
    mapped_slug = clips[code]
    slug = args.slug or default_slug(entry.get("camera_name", ""), source)
    problem = slug_problem(slug)
    if problem:
        raise StepError(problem)
    recorded = recorded_clip(paths, code)
    # The clip the camera showed before this swap: what its published detections were made on.
    old_slug = recorded if recorded and recorded != slug else mapped_slug
    say(f"  camera {code} ({entry.get('camera_name')}): mapped clip {mapped_slug}; published detections are for {recorded or 'none'}")
    say(f"  new slug {slug}" + ("   (same as the previous clip: re-run)" if slug == old_slug else ""))
    others = [c for c, s in clips.items() if s == slug and c != code]
    if others:
        raise StepError(f"slug {slug} is already used by {', '.join(others)}")

    step(1, "validate the source")
    probe = probe_clip(source, cv2)
    plan = plan_trim(probe["duration_s"], args.start, args.duration)
    say(f"  {probe['width']}x{probe['height']} {probe['fps']:g} fps, {probe['frames']} frames, "
        f"{probe['duration_s']:.1f} s, {human(probe['bytes'])}: decodes OK")
    say(f"  keep {plan['start']:g}-{plan['start'] + plan['length']:g} s ({plan['length']:.1f} s): {plan['note']}")

    step(2, "transcode (H.264, yuv420p, +faststart, no audio)")
    encoder = find_encoder()
    if dry:
        say(f"  encoder: {encoder[0]} ({encoder[1]})")
        info = source_info(probe, plan)
        if encoder[0] == "ffmpeg":
            for name, cmd in ffmpeg_commands(encoder[1], source, paths.web_dir / f"{slug}.mp4",
                                             paths.analysis_dir / f"{slug}.mp4", info, plan).items():
                say(f"  would run ({name}): {shlex.join(cmd)}")
        else:
            for preset, dst in ((AVCONVERT_WEB_PRESET, paths.web_dir / f"{slug}.mp4"),
                                (AVCONVERT_ANALYSIS_PRESET, paths.analysis_dir / f"{slug}.mp4")):
                say(f"  would run: {shlex.join(avconvert_command(encoder[1], source, dst, preset, plan))}")
        for p in (paths.web_dir / f"{slug}.mp4", paths.web_dir / f"{slug}.jpg", paths.analysis_dir / f"{slug}.mp4",
                  paths.local_dir / f"{slug}.mp4", paths.local_dir / f"{slug}.jpg"):
            say(f"  would write {p.relative_to(paths.repo)}")
    else:
        facts = transcode(paths, slug, source, probe, plan, encoder, args.force, cv2, runner)  # noqa: F841

    if args.no_detect:
        say("\n--no-detect: stopping before detection; the mapping still points at " + mapped_slug)
        return 0

    step(3, "ANPR detection on the new clip + switch the mapping")
    if dry:
        say("  would run pipeline/detect/run_remote_detection.py on "
            f"{(paths.analysis_dir / (slug + '.mp4')).relative_to(paths.repo)} (defaults), into a staging folder")
        if recorded and recorded != slug:
            say(f"  would back up events_{code}.json / detections_{code}.json to "
                f"{paths.backups_dir.relative_to(paths.repo)}/{code}_{recorded}/ (never deleted)")
        say(f"  would install the new files in {paths.detections_dir.relative_to(paths.repo)}/ and update manifest.json")
        if slug != mapped_slug:
            say(f"  would set {code} -> {slug} in {paths.clips_json.relative_to(paths.repo)} and {paths.camera_config.relative_to(paths.repo)}")
    else:
        stage_out, summaries = run_detection(paths, code, slug, entry, args.from_cache, detect_main)
        backup = install_detections(paths, code, slug, stage_out, summaries, rrd)
        shutil.rmtree(stage_out.parent, ignore_errors=True)  # staging copy only; the GPU cache stays
        if backup:
            say(f"  old detections kept in {backup.relative_to(paths.repo)}")
        for ch in update_mapping(paths, code, slug) or [f"mapping already points at {slug}"]:
            say(f"  {ch}")
        stats = read_stats(paths, code)
        say(f"  installed: {stats['vehicles']} vehicles, {stats['reads']} plate reads, {stats['good']} good reads (model {stats['model']})")
        left = [f for f in leftover_references(paths, old_slug) if not f.startswith("supabase/migrations/")]
        if left and old_slug != slug:
            say(f"  [!] still mention the old slug {old_slug}: {', '.join(left)}")
            if any(f.startswith("public/eval/") for f in left):
                say("      public/eval/*.json are model measurements on the old clip (labelled with its file name); "
                    "refresh them with: python3 pipeline/eval/video_consistency.py --events")

    step(4, "upload to the private Supabase bucket" if args.upload else "upload (skipped, pass --upload)")
    if args.upload:
        upload_clip(paths, slug, dry, uploader, creds)
        say("  production database is NOT touched. To ingest the new reads run these yourself")
        say("  (needs SUPABASE_SERVICE_ROLE_KEY; --prune mirrors the files, so this camera's old-clip rows are removed):")
        say(f"    {INSERT_CMD} --dry_run     # look first")
        say(f"    {INSERT_CMD}               # PRODUCTION write")
    else:
        say("  not requested")

    step(5, "summary")
    say(f"  slug      {old_slug}  ->  {slug}")
    say(f"  clip      {plan['length']:.1f} s ({round(plan['length'] * probe['fps'])} frames at {probe['fps']:g} fps) of {probe['width']}x{probe['height']} source")
    if dry:
        say("  detection (not run in a dry run)")
    else:
        stats = read_stats(paths, code)
        say(f"  detection {stats['vehicles']} vehicles, {stats['reads']} plate reads found, {stats['good']} good reads (OCR >= 75 and grammar-valid)")
    say("\nNext commands:")
    say(f"  npm run dev      # open http://localhost:5173/cameras and pick {code} (needs VITE_VIDEO_SOURCE=local, the dev default)")
    say("  python3 pipeline/simulation/simulate_city_network.py --plates-from public/detections && "
        "python3 pipeline/simulation/export_demo_fixtures.py   # re-seed the demo data so the camera shows only new reads")
    say("  git add src/config/cameraClips.json pipeline/camera_config.json public/detections && git commit")
    if not args.upload:
        say(f"  python3 pipeline/tools/replace_camera_clip.py --camera {code} --source {source} --upload   # when happy with the dev result")
    return 0


if __name__ == "__main__":
    sys.exit(main())
