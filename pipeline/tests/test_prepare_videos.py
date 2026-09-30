"""Tests for pipeline/tools/prepare_videos.py and upload_videos.py (no ffmpeg needed)."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


pv = _load("prepare_videos")
up = _load("upload_videos")

LANDSCAPE_4K = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:20.53, start: 0.000000, bitrate: 27000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 3840x2160, 26000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 189 kb/s (default)
"""

PORTRAIT_59 = """  Duration: 00:00:15.47, start: 0.000000, bitrate: 10400 kb/s
  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1080x1920, 10395 kb/s, 59 fps, 59 tbr, 15104 tbn (default)
"""

ROTATED = """  Duration: 00:01:02.00, start: 0.000000, bitrate: 10400 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 29.97 fps, 29.97 tbr
      Side data:
        displaymatrix: rotation of -90.00 degrees
"""


def test_parse_probe_landscape():
    info = pv.parse_probe(LANDSCAPE_4K)
    assert (info.width, info.height, info.fps, info.codec) == (3840, 2160, 30.0, "h264")
    assert info.duration_s == pytest.approx(20.53)
    assert info.orientation == "landscape"
    assert info.short_side == 2160


def test_parse_probe_rotation_makes_portrait():
    info = pv.parse_probe(ROTATED)
    assert info.duration_s == pytest.approx(62.0)
    assert info.fps == pytest.approx(29.97)
    assert info.display_size == (1080, 1920)
    assert info.orientation == "portrait"


def test_parse_probe_rejects_garbage():
    with pytest.raises(ValueError):
        pv.parse_probe("not a video")


def test_slug_is_stem():
    assert pv.slug_for(Path("/x/mumbai_overhead-jam-6lane_pexels31046764.mp4")) == "mumbai_overhead-jam-6lane_pexels31046764"


def test_web_cmd_landscape():
    info = pv.parse_probe(LANDSCAPE_4K)
    cmd = pv.build_web_cmd("ffmpeg", Path("in.mp4"), Path("out.mp4"), info)
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("scale=-2:720")
    assert "fps=" not in vf
    for flag, val in [("-crf", "24"), ("-maxrate", "2500k"), ("-bufsize", "5000k"),
                      ("-profile:v", "high"), ("-pix_fmt", "yuv420p"), ("-g", "60"),
                      ("-movflags", "+faststart"), ("-c:v", "libx264")]:
        assert cmd[cmd.index(flag) + 1] == val
    assert "-an" in cmd
    assert cmd[-1] == "out.mp4"


def test_web_cmd_portrait_caps_fps():
    info = pv.parse_probe(PORTRAIT_59)
    cmd = pv.build_web_cmd("ffmpeg", Path("in.mp4"), Path("out.mp4"), info)
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("scale=720:-2")
    assert "fps=30" in vf
    assert cmd[cmd.index("-g") + 1] == "60"


def test_analysis_rules():
    four_k = pv.parse_probe(LANDSCAPE_4K)
    portrait = pv.parse_probe(PORTRAIT_59)
    assert pv.needs_analysis(four_k)
    assert pv.needs_analysis(portrait)
    assert not pv.needs_analysis(portrait, landscape_only=True)
    small = pv.ProbeInfo(1280, 720, 10.0, 30.0, codec="h264")
    assert not pv.needs_analysis(small)

    cmd = pv.build_analysis_cmd("ffmpeg", Path("in.mp4"), Path("out.mp4"), four_k)
    assert cmd[cmd.index("-crf") + 1] == "20"
    assert cmd[cmd.index("-vf") + 1].startswith("scale=-2:1080")
    assert "-an" in cmd

    # Already 1080p H.264: stream copy, no re-encode.
    remux = pv.build_analysis_cmd("ffmpeg", Path("in.mp4"), Path("out.mp4"), portrait)
    assert remux[remux.index("-c:v") + 1] == "copy"
    assert "-crf" not in remux


def test_poster_cmd_clamps_seek_for_short_clip():
    info = pv.ProbeInfo(1920, 1080, 1.0, 30.0)
    cmd = pv.build_poster_cmd("ffmpeg", Path("in.mp4"), Path("p.jpg"), info)
    assert cmd[cmd.index("-ss") + 1] == "0.50"
    assert cmd[cmd.index("-frames:v") + 1] == "1"


def test_main_builds_manifest_and_is_idempotent(tmp_path, monkeypatch):
    src = tmp_path / "src"
    src.mkdir()
    (src / "clip_a.mp4").write_bytes(b"x" * 1000)
    (src / "clip_b.mp4").write_bytes(b"y" * 2000)
    out, ana = tmp_path / "720", tmp_path / "1080"

    encodes = []

    def fake_run(cmd, capture_output=False, text=False, check=False):
        if capture_output:  # probe
            target = Path(cmd[-1])
            banner = LANDSCAPE_4K
            if target.parent == out:
                banner = LANDSCAPE_4K.replace("3840x2160", "1280x720")
            elif target.parent == ana:
                banner = LANDSCAPE_4K.replace("3840x2160", "1920x1080")
            return subprocess.CompletedProcess(cmd, 1, "", banner)
        encodes.append(cmd)
        Path(cmd[-1]).write_bytes(b"z" * 300)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pv.subprocess, "run", fake_run)
    monkeypatch.setattr(pv, "ffmpeg_exe", lambda: "ffmpeg")

    argv = ["--src", str(src), "--out", str(out), "--analysis-out", str(ana)]
    assert pv.main(argv) == 0
    assert len(encodes) == 6  # web + poster + analysis for 2 clips

    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["count"] == 2
    a = manifest["clips"][0]
    assert a["slug"] == "clip_a"
    assert (a["width"], a["height"], a["orientation"]) == (1280, 720, "landscape")
    assert a["bytes"] == 300 and a["poster"] == "clip_a.jpg"
    assert a["duration_s"] == pytest.approx(20.53) and a["fps"] == 30.0
    assert a["source"]["bytes"] == 1000
    assert a["analysis"]["height"] == 1080
    assert (out / "clip_a.mp4").exists() and not list(out.glob(".*partial*"))

    encodes.clear()
    assert pv.main(argv) == 0
    assert encodes == []  # everything up to date

    assert pv.main(argv + ["--only", "clip_b", "--force"]) == 0
    assert len(encodes) == 3
    assert all("clip_b" in c[-1] for c in encodes)
    assert json.loads((out / "manifest.json").read_text())["count"] == 2

    assert pv.main(argv + ["--only", "nope"]) == 2


def test_upload_helpers(tmp_path, capsys, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('VITE_SUPABASE_URL="https://abc.supabase.co/"\nSUPABASE_SERVICE_ROLE_KEY=secret\n')
    for k in ("SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(k, raising=False)
    assert up.credentials(env) == ("https://abc.supabase.co", "secret")
    assert up.content_type(Path("a.mp4")) == "video/mp4"
    assert up.content_type(Path("a.jpg")) == "image/jpeg"
    assert up.object_path(Path("/x/a.mp4")) == "mumbai/720p/a.mp4"

    d = tmp_path / "v"
    d.mkdir()
    (d / "a.mp4").write_bytes(b"1")
    (d / "a.jpg").write_bytes(b"2")
    (d / "manifest.json").write_text("{}")
    # Dry run is the default and must not touch the network.
    monkeypatch.setattr(up, "_request", lambda *a, **k: pytest.fail("network used in dry run"))
    assert up.main(["--dir", str(d), "--env-file", str(env)]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "mumbai/720p/a.mp4" in out and "would upload" in out
