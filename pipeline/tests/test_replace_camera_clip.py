"""Tests for pipeline/tools/replace_camera_clip.py.

Hermetic: no GPU, no network, no ffmpeg and no OpenCV are needed. The video
reader is a fake cv2 and the encoder is a fake runner that writes small
stand-in mp4 files; the detection step talks to detect/mock_model_server.py.
Two last tests use real OpenCV + ffmpeg and skip themselves when absent.
"""

import ast
import importlib.machinery
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from detect.mock_model_server import start_server

TOOLS = Path(__file__).resolve().parents[1] / "tools"
OLD_PLATE = "MH 01 EB 7023"  # a read made on an OLD clip; must never show up for a new one
OTHER_SLUG = "mumbai_overhead-jam-6lane_pexels31046764"  # a camera that is not being swapped
#: The two swaps: the camera's name, the clip it showed, the clip it gets, the file on the maintainer's Mac,
#: its frames at 30 fps and how many seconds the default trim keeps (20.4 s whole / first 45 s of 57.2 s).
CAMS = {
    "KR-01": dict(name="Kurla Depot Junction", old="mumbai_flyover-roadside-approach-taxis_pexels31048404",
                  new="mumbai_kurla-depot-junction_pexels12974288", src="12974288_3840_2160_30fps.mp4",
                  frames=612, kept=20.4, other="AN-01"),
    "AN-01": dict(name="Andheri Flyover (Gundavali)", old="mumbai_overhead-flyover-receding_pexels31048580",
                  new="mumbai_andheri-flyover-gundavali_pexels13270133", src="13270133_3840_2160_30fps.mp4",
                  frames=1716, kept=45.0, other="KR-01"),
}
KEY = "replace-clip-key"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


sys.path.insert(0, str(TOOLS))
rcc = _load("replace_camera_clip")


# ── fixtures ─────────────────────────────────────────────────────────────


def _mp4_bytes(faststart=True):
    def box(kind, body=b""):
        return (8 + len(body)).to_bytes(4, "big") + kind + body

    parts = [box(b"ftyp", b"isom0000"), box(b"moov", b"x" * 8), box(b"mdat", b"y" * 64)]
    if not faststart:
        parts[1], parts[2] = parts[2], parts[1]
    return b"".join(parts)


class FakeCap:
    def __init__(self, spec):
        self.spec, self.pos = spec, 0

    def isOpened(self):
        return self.spec.get("opened", True)

    def get(self, prop):
        s = self.spec
        if prop == FakeCv2.CAP_PROP_FPS:
            return s["fps"]
        if prop == FakeCv2.CAP_PROP_FRAME_COUNT:
            return s["frames"]
        if prop == FakeCv2.CAP_PROP_FOURCC:
            return sum(ord(c) << (8 * i) for i, c in enumerate(s.get("fourcc", "avc1")))
        return 0

    def set(self, prop, value):
        self.pos = int(value)

    def read(self):
        if self.pos in self.spec.get("bad_frames", ()):
            return False, None
        h, w = self.spec["size"]
        return True, np.zeros((h, w, 3), np.uint8)

    def release(self):
        pass


class FakeCv2:
    """Reads the source as 3840x2160 and the renditions as what the encoder should have made (``out_frames``)."""

    CAP_PROP_FPS, CAP_PROP_FRAME_COUNT, CAP_PROP_FOURCC, CAP_PROP_POS_FRAMES, IMWRITE_JPEG_QUALITY = 5, 7, 6, 1, 1

    def __init__(self, source=None, out_frames=None):
        self.source = {"fps": 30.0, "frames": 612, "size": (2160, 3840), "fourcc": "avc1", **(source or {})}
        self.out_frames = out_frames if out_frames is not None else self.source["frames"]

    def VideoCapture(self, path):  # noqa: N802
        p = str(path)
        if "videos_720p" in p or "videos-local" in p:
            return FakeCap({"fps": 30.0, "frames": self.out_frames, "size": (720, 1280), "fourcc": "avc1"})
        if "videos_1080p" in p:
            return FakeCap({"fps": 30.0, "frames": self.out_frames, "size": (1080, 1920), "fourcc": "avc1"})
        return FakeCap(self.source)

    @staticmethod
    def imwrite(path, frame, params=None):
        Path(path).write_bytes(b"\xff\xd8jpeg")
        return True


class FakeRunner:
    """Stands in for the encoder: records the command and writes a stand-in mp4/jpg to its output."""

    def __init__(self, faststart=True):
        self.cmds, self.faststart = [], faststart

    def __call__(self, cmd):
        self.cmds.append(cmd)
        out = Path(cmd[cmd.index("--output") + 1] if "--output" in cmd else cmd[-1])
        out.write_bytes(_mp4_bytes(self.faststart) if out.suffix == ".mp4" else b"\xff\xd8jpeg")


def _write(p, doc, indent=None):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc, indent=indent))


def _events(slug, plates, code="KR-01"):
    return {"camera_code": code, "engine": "lpu_on_gpu", "model_version": "old",
            "clip": {"fps": 30.0, "frames": 1367, "width": 1920, "height": 1080, "file": f"{slug}.mp4"},
            "events": [{"plate_text": p, "plate_read": p, "plate_confidence": 0.9, "grammar_valid": True,
                        "good_read": True, "time_sec": 1.0 + i, "tracked_vehicle_id": f"trk_{i}"}
                       for i, p in enumerate(plates)]}


@pytest.fixture(params=list(CAMS))
def cam(request):
    """Each test that takes this runs once for KR-01 and once for AN-01."""
    return SimpleNamespace(code=request.param, **CAMS[request.param])


def fake(cam, **kw):
    """Fake OpenCV for this camera's source (3840x2160, 30 fps) whose renditions have the planned length."""
    return FakeCv2(source={"frames": cam.frames}, out_frames=round(cam.kept * 30), **kw)


@pytest.fixture
def repo(tmp_path):
    """A tiny repo: JG-01 (control), KR-01 and AN-01, the last two mapped to their NEW slug but still
    carrying detections made on their OLD clip (what the PR ships before the maintainer runs the tool)."""
    r = tmp_path / "repo"
    names = {"JG-01": ("Jogeshwari", OTHER_SLUG, OTHER_SLUG), **{c: (v["name"], v["new"], v["old"]) for c, v in CAMS.items()}}
    _write(r / "src/config/cameraClips.json", {c: mapped for c, (_, mapped, _o) in names.items()}, indent=2)
    base = "https://example.supabase.co/storage/v1/object/public/videos/mumbai/720p/"
    _write(r / "pipeline/camera_config.json", [
        {"camera_code": c, "camera_name": n, "video_slug": m, "video_filename": f"{m}.mp4",
         "video_url": f"{base}{m}.mp4", "poster_url": f"{base}{m}.jpg",
         "lat": 19.07447, "zone": "Eastern Suburbs", "direction": "Northbound", "road": "LBS Marg"}
        for c, (n, m, _o) in names.items()], indent=2)
    d = r / "public/detections"
    for c, (_, _m, recorded) in names.items():
        _write(d / f"events_{c}.json", _events(recorded, [OLD_PLATE], c))
        _write(d / f"detections_{c}.json", [{"camera_code": c, "plate_text": OLD_PLATE}])
    _write(d / "manifest.json", {"engine": "lpu_on_gpu", "model_version": "old", "cameras": sorted(names),
                                 "stats": [{"camera_code": c, "video_filename": f"{o}.mp4", "vehicles": 1}
                                           for c, (_, _m, o) in sorted(names.items())]})
    (r / "pipeline/data/videos_720p").mkdir(parents=True)
    (r / "pipeline/data/videos_1080p").mkdir(parents=True)
    for v in CAMS.values():  # the OLD clips' files, which must survive every run
        (r / "pipeline/data/videos_720p" / f"{v['old']}.mp4").write_bytes(b"old-clip")
        (r / "pipeline/data/videos_1080p" / f"{v['old']}.mp4").write_bytes(b"old-analysis")
    return rcc.Paths(repo=r)


@pytest.fixture
def source(tmp_path, cam):
    p = tmp_path / "dl" / cam.src
    p.parent.mkdir()
    p.write_bytes(b"not-a-real-video")
    return p


@pytest.fixture
def ffmpeg(monkeypatch):
    monkeypatch.setattr(rcc, "find_encoder", lambda *a, **k: ("ffmpeg", "/opt/ffmpeg"))


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(Path(root).rglob("*")) if p.is_file()}


# ── slug rules ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("slug", [c["new"] for c in CAMS.values()] + ["mumbai_a_pexels1", "mumbai_roadside-kurla-2_pexels12974288"])
def test_valid_slugs(slug):
    assert rcc.slug_problem(slug) is None
    assert rcc.SLUG_RE.match(slug)  # same pattern as test_simulation_registry.SLUG (pexels only)


@pytest.mark.parametrize("slug", ["", "kurla_pexels1", "mumbai_Kurla_pexels1", "mumbai_kurla_pixabay1",
                                  "mumbai_kurla_pexels", "mumbai_kurla traffic_pexels1", "mumbai_kurla_pexels1.mp4",
                                  "mumbai__pexels1", "mumbai_a_b_pexels1"])
def test_invalid_slugs(slug):
    assert "mumbai_<description>_pexels<id>" in rcc.slug_problem(slug)


@pytest.mark.parametrize("code", list(CAMS))
def test_default_slug_is_derived_from_the_camera_name_and_the_pexels_file(code):
    c = CAMS[code]
    assert rcc.default_slug(c["name"], Path("~/Downloads") / c["src"]) == c["new"]
    # no camera is special-cased: any name and any Pexels-style file works
    assert rcc.default_slug("Sion Circle", Path("77777_1920_1080_25fps.mp4")) == "mumbai_sion-circle_pexels77777"
    assert rcc.default_slug("Dadar TT Junction", Path("clip_pexels555.mp4")) == "mumbai_dadar-tt-junction_pexels555"
    with pytest.raises(rcc.StepError, match="--slug"):
        rcc.default_slug(c["name"], Path("holiday.mp4"))
    with pytest.raises(rcc.StepError, match="--slug"):
        rcc.default_slug("", Path("77777_1920_1080_25fps.mp4"))


def test_the_tool_has_no_per_camera_code():
    """Code and messages never name a camera: the same tool serves every camera in the registry."""
    tree = ast.parse((TOOLS / "replace_camera_clip.py").read_text())
    docstrings = {id(n.body[0].value) for n in ast.walk(tree)
                  if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef)) and n.body
                  and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    strings = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
               and id(n) not in docstrings]
    assert not [s for s in strings if re.search(r"\b[A-Z]{2}-\d{2}\b", s)]


# ── trim plan ────────────────────────────────────────────────────────────


def test_trim_default_keeps_a_short_clip_whole():
    plan = rcc.plan_trim(20.4, None, None)
    assert (plan["start"], plan["length"], plan["trimmed"]) == (0, 20.4, False)
    assert "whole clip" in plan["note"]


def test_trim_default_caps_long_clips():
    plan = rcc.plan_trim(120.0, None, None)
    assert (plan["length"], plan["trimmed"]) == (45.0, True) and "cap" in plan["note"]


def test_trim_start_and_duration():
    plan = rcc.plan_trim(60.0, 10, 12)
    assert (plan["start"], plan["length"], plan["trimmed"]) == (10.0, 12, True)
    assert rcc.plan_trim(30.0, 25, 20)["length"] == 5  # clamped to what is left
    assert "clamped" in rcc.plan_trim(30.0, 25, 20)["note"]


@pytest.mark.parametrize("args, msg", [((20.0, 25, None), "beyond the end"), ((20.0, -1, None), ">= 0"),
                                       ((20.0, 0, 0), "> 0"), ((20.0, 18, None), "at least 5"),
                                       ((3.0, None, None), "at least 5")])
def test_trim_refusals(args, msg):
    with pytest.raises(rcc.StepError, match=msg):
        rcc.plan_trim(*args)


# ── step 1: source validation ────────────────────────────────────────────


def test_probe_reads_size_fps_length(source):
    info = rcc.probe_clip(source, FakeCv2())
    assert (info["width"], info["height"], info["fps"], info["frames"]) == (3840, 2160, 30.0, 612)
    assert info["duration_s"] == pytest.approx(20.4) and info["fourcc"] == "avc1"


@pytest.mark.parametrize("source_spec, msg", [
    ({"opened": False}, "cannot open"),
    ({"bad_frames": {0}}, "first frame"),
    ({"bad_frames": {306}}, "truncated or corrupt"),
    ({"fps": 0}, "cannot size"),
    ({"frames": 0}, "cannot size"),
])
def test_probe_refuses_what_it_cannot_decode(source, source_spec, msg):
    with pytest.raises(rcc.StepError, match=msg):
        rcc.probe_clip(source, FakeCv2(source_spec))


def test_probe_refuses_missing_file(tmp_path):
    with pytest.raises(rcc.StepError, match="does not exist"):
        rcc.probe_clip(tmp_path / "nope.mp4", FakeCv2())


def test_probe_without_opencv_says_how_to_install(source, monkeypatch):
    monkeypatch.setitem(sys.modules, "cv2", None)
    with pytest.raises(rcc.StepError, match="opencv-python-headless"):
        rcc.probe_clip(source)


# ── step 2: encoder choice and commands ──────────────────────────────────


def test_find_encoder_prefers_env_then_path_then_mac_avconvert(monkeypatch):
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", None)  # not installed
    both = lambda n: {"ffmpeg": "/usr/bin/ffmpeg", "avconvert": "/usr/bin/avconvert"}.get(n)  # noqa: E731
    only_av = lambda n: {"avconvert": "/usr/bin/avconvert"}.get(n)  # noqa: E731
    assert rcc.find_encoder({"FFMPEG_BINARY": "/x/ff"}, which=lambda n: "/x/ff" if n == "/x/ff" else None) == ("ffmpeg", "/x/ff")
    assert rcc.find_encoder({}, which=both, platform="darwin") == ("ffmpeg", "/usr/bin/ffmpeg")
    assert rcc.find_encoder({}, which=only_av, platform="darwin") == ("avconvert", "/usr/bin/avconvert")
    with pytest.raises(rcc.StepError, match="brew install ffmpeg"):
        rcc.find_encoder({}, which=lambda n: None, platform="darwin")
    with pytest.raises(rcc.StepError, match="brew install ffmpeg"):  # avconvert only exists on macOS
        rcc.find_encoder({}, which=only_av, platform="linux")
    with pytest.raises(rcc.StepError, match="FFMPEG_BINARY"):
        rcc.find_encoder({"FFMPEG_BINARY": "/nope"}, which=lambda n: None)


def test_ffmpeg_commands_match_the_other_clips(tmp_path):
    plan = rcc.plan_trim(20.4, None, None)
    info = rcc.source_info({"width": 3840, "height": 2160, "fps": 30.0}, plan)
    cmds = rcc.ffmpeg_commands("ffmpeg", Path("in.mp4"), tmp_path / "w.mp4", tmp_path / "a.mp4", info, plan)
    web, ana = cmds["web"], cmds["analysis"]
    assert "-ss" not in web and web[web.index("-vf") + 1] == "scale=-2:720,format=yuv420p"
    for cmd in (web, ana):
        assert cmd[cmd.index("-c:v") + 1] == "libx264" and cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
        assert cmd[cmd.index("-movflags") + 1] == "+faststart" and "-an" in cmd
    assert web[web.index("-crf") + 1] == "24" and ana[ana.index("-crf") + 1] == "20"
    assert ana[ana.index("-vf") + 1] == "scale=-2:1080,format=yuv420p"


def test_trim_goes_before_the_input_in_both_renditions(tmp_path):
    plan = rcc.plan_trim(100.0, 10, 30)
    info = rcc.source_info({"width": 3840, "height": 2160, "fps": 60.0}, plan)
    cmds = rcc.ffmpeg_commands("ffmpeg", Path("in.mp4"), tmp_path / "w.mp4", tmp_path / "a.mp4", info, plan)
    for cmd in cmds.values():
        i = cmd.index("-i")
        assert cmd[i - 4:i] == ["-ss", "10", "-t", "30"]
    assert "fps=30" in cmds["web"][cmds["web"].index("-vf") + 1]  # 60 fps is capped for the web rendition


def test_no_analysis_rendition_below_1080p(tmp_path):
    plan = rcc.plan_trim(20.0, None, None)
    info = rcc.source_info({"width": 1280, "height": 720, "fps": 30.0}, plan)
    assert list(rcc.ffmpeg_commands("ffmpeg", Path("in.mp4"), tmp_path / "w.mp4", tmp_path / "a.mp4", info, plan)) == ["web"]


def test_avconvert_command():
    plan = rcc.plan_trim(100.0, 5, 20)
    cmd = rcc.avconvert_command("avconvert", Path("in.mp4"), Path("o.mp4"), "Preset1280x720", plan)
    assert cmd[:7] == ["avconvert", "--source", "in.mp4", "--preset", "Preset1280x720", "--output", "o.mp4"]
    assert cmd[-4:] == ["--start", "5", "--duration", "20"]
    whole = rcc.avconvert_command("avconvert", Path("in.mp4"), Path("o.mp4"), "P", rcc.plan_trim(20.0, None, None))
    assert "--start" not in whole


def test_is_faststart(tmp_path):
    good, bad, junk = tmp_path / "g.mp4", tmp_path / "b.mp4", tmp_path / "j.mp4"
    good.write_bytes(_mp4_bytes(True))
    bad.write_bytes(_mp4_bytes(False))
    junk.write_bytes(b"hello world, definitely not an mp4")
    assert rcc.is_faststart(good) and not rcc.is_faststart(bad) and not rcc.is_faststart(junk)


def test_verify_clip_rejects_wrong_codec_size_length_and_no_faststart(tmp_path):
    p = tmp_path / "c.mp4"
    p.write_bytes(_mp4_bytes())
    kw = dict(cv2=FakeCv2(source={"size": (720, 1280)}))
    assert rcc.verify_clip(p, max_short_side=720, expect_duration=20.4, **kw)["width"] == 1280
    with pytest.raises(rcc.StepError, match="not H.264"):
        rcc.verify_clip(p, cv2=FakeCv2(source={"size": (720, 1280), "fourcc": "mp4v"}))
    with pytest.raises(rcc.StepError, match="not the expected size"):
        rcc.verify_clip(p, max_short_side=480, **kw)
    with pytest.raises(rcc.StepError, match="ignored the trim"):
        rcc.verify_clip(p, expect_duration=9.0, **kw)
    with pytest.raises(rcc.StepError, match="fps exceeds"):
        rcc.verify_clip(p, max_fps=24, **kw)
    p.write_bytes(_mp4_bytes(False))
    with pytest.raises(rcc.StepError, match="faststart"):
        rcc.verify_clip(p, **kw)


# ── mapping + manifest on fixture copies ─────────────────────────────────


def test_update_mapping_switches_both_files_and_nothing_else(repo, cam):
    clips0, cfg0 = rcc.read_json(repo.clips_json), rcc.read_json(repo.camera_config)
    changes = rcc.update_mapping(repo, cam.code, "mumbai_other-view_pexels999")
    assert len(changes) == 2
    clips, cfg = rcc.read_json(repo.clips_json), rcc.read_json(repo.camera_config)
    assert clips == {**clips0, cam.code: "mumbai_other-view_pexels999"}
    kr = next(c for c in cfg if c["camera_code"] == cam.code)
    assert kr["video_slug"] == "mumbai_other-view_pexels999" and kr["video_filename"] == "mumbai_other-view_pexels999.mp4"
    assert kr["video_url"].endswith("/videos/mumbai/720p/mumbai_other-view_pexels999.mp4")
    assert kr["poster_url"].endswith("/videos/mumbai/720p/mumbai_other-view_pexels999.jpg")
    assert kr["video_url"].startswith("https://example.supabase.co/")  # host is kept, never invented
    old_kr = next(c for c in cfg0 if c["camera_code"] == cam.code)
    for k in ("camera_name", "lat", "zone", "direction"):
        assert kr[k] == old_kr[k]
    assert cfg[0] == cfg0[0]
    # idempotent
    assert rcc.update_mapping(repo, cam.code, "mumbai_other-view_pexels999") == []


def test_update_mapping_unknown_camera(repo, cam):
    with pytest.raises(rcc.StepError, match="not in"):
        rcc.update_mapping(repo, "ZZ-01", cam.new)


def test_backup_copies_old_detections_and_never_overwrites(repo, cam):
    b1 = rcc.backup_old_outputs(repo, cam.code, cam.new)
    assert b1.name == f"{cam.code}_{cam.old}"
    assert json.loads((b1 / f"events_{cam.code}.json").read_text())["clip"]["file"] == f"{cam.old}.mp4"
    assert (b1 / f"detections_{cam.code}.json").exists() and (b1 / "manifest.json").exists()
    (b1 / f"events_{cam.code}.json").write_text("marker")
    b2 = rcc.backup_old_outputs(repo, cam.code, cam.new)
    assert b2 != b1 and b2.name.endswith("-2")
    assert (b1 / f"events_{cam.code}.json").read_text() == "marker"


def test_no_backup_when_published_files_are_already_the_new_clip(repo, cam):
    _write(repo.detections_dir / f"events_{cam.code}.json", _events(cam.new, [], cam.code))
    assert rcc.backup_old_outputs(repo, cam.code, cam.new) is None
    assert not repo.backups_dir.exists()


# ── the whole command with fakes ─────────────────────────────────────────


def test_dry_run_prints_the_plan_and_writes_nothing(repo, source, ffmpeg, capsys, cam):
    before = snapshot(repo.repo)
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--dry-run", "--upload"], paths=repo, cv2=fake(cam),
                  creds=lambda env: ("https://x.supabase.co", "k"))
    out = capsys.readouterr().out
    assert rc == 0 and snapshot(repo.repo) == before
    assert "[DRY RUN" in out and f"3840x2160 30 fps, {cam.frames} frames, {cam.frames / 30:.1f} s" in out
    assert (f"keep 0-{cam.kept:g} s" in out) and ("whole clip" in out if cam.kept < 45 else "first 45 s" in out) and f"would write public/videos-local/{cam.new}.mp4" in out
    assert "would run (web)" in out and "libx264" in out and "would run (analysis)" in out
    assert "run_remote_detection.py" in out and "would back up" in out and f"{cam.code}_{cam.old}" in out
    assert f"would upload mumbai/720p/{cam.new}.mp4" in out
    assert f"{cam.old}" in out


def test_dry_run_still_fails_without_an_encoder(repo, source, monkeypatch, capsys, cam):
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", None)
    monkeypatch.delenv("FFMPEG_BINARY", raising=False)
    monkeypatch.setattr(rcc.shutil, "which", lambda n: None)
    assert rcc.main(["--camera", cam.code, "--source", str(source), "--dry-run"], paths=repo, cv2=fake(cam)) == 1
    assert "brew install ffmpeg" in capsys.readouterr().err


@pytest.mark.parametrize("extra, msg", [
    (["--camera", "ZZ-01"], "unknown camera ZZ-01"),
    (["--slug", "Bad Slug"], "mumbai_<description>_pexels<id>"),
    (["--slug", OTHER_SLUG], "already used by JG-01"),
    (["--start", "99"], "beyond the end"),
])
def test_argument_errors_abort_before_touching_anything(repo, source, ffmpeg, capsys, extra, msg, cam):
    before = snapshot(repo.repo)
    argv = extra if "--camera" in extra else ["--camera", cam.code, *extra]
    assert rcc.main([*argv, "--source", str(source)], paths=repo, cv2=fake(cam)) == 1
    assert msg in capsys.readouterr().err and snapshot(repo.repo) == before


def test_missing_source_aborts(repo, tmp_path, capsys, cam):
    assert rcc.main(["--camera", cam.code, "--source", str(tmp_path / "gone.mp4")], paths=repo, cv2=fake(cam)) == 1
    assert "does not exist" in capsys.readouterr().err


def test_undecodable_source_is_refused_before_any_encode(repo, source, ffmpeg, capsys, cam):
    runner = FakeRunner()
    before = snapshot(repo.repo)
    rc = rcc.main(["--camera", cam.code, "--source", str(source)], paths=repo, cv2=FakeCv2({"opened": False}), runner=runner)
    assert rc == 1 and "cannot open" in capsys.readouterr().err
    assert runner.cmds == [] and snapshot(repo.repo) == before


def test_no_detect_transcodes_and_leaves_detections_and_mapping(repo, source, ffmpeg, capsys, cam):
    runner = FakeRunner()
    before = snapshot(repo.detections_dir)
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--no-detect"], paths=repo, cv2=fake(cam), runner=runner)
    assert rc == 0 and snapshot(repo.detections_dir) == before
    assert len(runner.cmds) == 3  # web, analysis, poster
    for p in (repo.web_dir / f"{cam.new}.mp4", repo.web_dir / f"{cam.new}.jpg", repo.analysis_dir / f"{cam.new}.mp4",
              repo.local_dir / f"{cam.new}.mp4", repo.local_dir / f"{cam.new}.jpg"):
        assert p.is_file(), p
    manifest = json.loads((repo.web_dir / "manifest.json").read_text())
    assert [c["slug"] for c in manifest["clips"]] == [cam.new]
    assert manifest["clips"][0]["analysis"]["height"] == 1080
    # the old clip is untouched
    assert (repo.web_dir / f"{cam.old}.mp4").read_bytes() == b"old-clip"
    assert (repo.analysis_dir / f"{cam.old}.mp4").read_bytes() == b"old-analysis"
    assert "stopping before detection" in capsys.readouterr().out


def test_second_run_skips_the_transcode(repo, source, ffmpeg, capsys, cam):
    args = ["--camera", cam.code, "--source", str(source), "--no-detect"]
    first = FakeRunner()
    assert rcc.main(args, paths=repo, cv2=fake(cam), runner=first) == 0
    second = FakeRunner()
    assert rcc.main(args, paths=repo, cv2=fake(cam), runner=second) == 0
    assert second.cmds == [] and "skipped" in capsys.readouterr().out
    third = FakeRunner()
    assert rcc.main([*args, "--force"], paths=repo, cv2=fake(cam), runner=third) == 0 and len(third.cmds) == 3


def test_encoder_output_that_is_not_faststart_aborts(repo, source, ffmpeg, capsys, cam):
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--no-detect"], paths=repo, cv2=fake(cam),
                  runner=FakeRunner(faststart=False))
    assert rc == 1 and "faststart" in capsys.readouterr().err
    assert not (repo.local_dir / f"{cam.new}.mp4").exists()


def test_trim_shortens_the_expected_length(repo, source, ffmpeg, cam):
    runner = FakeRunner()
    cv2 = FakeCv2(source={"frames": 3000})  # 100 s source
    # encoder "wrote" a 100 s file although we asked for 20 s: that must be caught
    assert rcc.main(["--camera", cam.code, "--source", str(source), "--start", "10", "--duration", "20", "--no-detect"],
                    paths=repo, cv2=cv2, runner=runner) == 1
    assert all(cmd[cmd.index("-i") - 4:cmd.index("-i")] == ["-ss", "10", "-t", "20"] for cmd in runner.cmds[:2])


def test_avconvert_fallback_says_so_and_makes_the_poster_with_opencv(repo, source, monkeypatch, capsys, cam):
    monkeypatch.setattr(rcc, "find_encoder", lambda *a, **k: ("avconvert", "/usr/bin/avconvert"))
    runner = FakeRunner()
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--no-detect"], paths=repo, cv2=fake(cam), runner=runner)
    out = capsys.readouterr().out
    assert rc == 0 and "macOS avconvert" in out and "brew install ffmpeg" in out
    assert [c[c.index("--preset") + 1] for c in runner.cmds] == ["Preset1280x720", "Preset1920x1080"]
    assert (repo.web_dir / f"{cam.new}.jpg").read_bytes().startswith(b"\xff\xd8")


# ── detection step against the mock model server ─────────────────────────


@pytest.fixture
def mock_api(monkeypatch):
    server, _ = start_server(api_key=KEY)
    monkeypatch.setenv("DETECTION_API_URL", f"http://127.0.0.1:{server.server_address[1]}/v1/frame")
    monkeypatch.setenv("DETECTION_API_KEY", KEY)
    monkeypatch.delenv("DETECTION_API_AUTH_HEADER", raising=False)
    monkeypatch.delenv("DETECTION_API_QUERY", raising=False)
    yield server
    server.shutdown()
    server.server_close()


@pytest.fixture
def stub_detect_cv2(monkeypatch, fake_capture):
    """conftest's cv2 stub, completed so run_remote_detection can read 'frames' and encode them."""
    cv2 = sys.modules["cv2"]
    jpeg = bytes([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03] + [0] * 24 + [0xFF, 0xD9])
    monkeypatch.setattr(cv2, "IMWRITE_JPEG_QUALITY", 1, raising=False)
    monkeypatch.setattr(cv2, "INTER_AREA", 3, raising=False)
    monkeypatch.setattr(cv2, "resize", lambda f, size, interpolation=None: np.zeros((size[1], size[0], 3), np.uint8), raising=False)
    monkeypatch.setattr(cv2, "imencode", lambda ext, f, params=None: (True, np.frombuffer(jpeg, np.uint8)), raising=False)
    fake_capture.spec = {"fps": 10.0, "frames": 20, "shape": (1080, 1920, 3), "opened": True}


def test_full_run_with_mock_model(repo, source, ffmpeg, mock_api, stub_detect_cv2, capsys, cam):
    old_events = (repo.detections_dir / f"events_{cam.code}.json").read_bytes()
    other = {p.name: p.read_bytes() for p in repo.detections_dir.glob("*JG-01.json")}
    rc = rcc.main(["--camera", cam.code, "--source", str(source)], paths=repo, cv2=fake(cam), runner=FakeRunner())
    out = capsys.readouterr().out
    assert rc == 0, out
    # new files come from the model run on the new clip, never from the old reads
    events = json.loads((repo.detections_dir / f"events_{cam.code}.json").read_text())
    assert events["clip"]["file"] == f"{cam.new}.mp4" and events["model_version"] == "mock+raw35"
    assert len(events["events"]) == 3 and OLD_PLATE not in json.dumps(events)
    dets = json.loads((repo.detections_dir / f"detections_{cam.code}.json").read_text())
    assert dets and all(d["camera_code"] == cam.code and d["plate_text"] != OLD_PLATE for d in dets)
    # manifest: new clip recorded for the camera, other cameras kept
    manifest = json.loads((repo.detections_dir / "manifest.json").read_text())
    assert manifest["cameras"] == sorted(["JG-01", *CAMS])
    stats = {s["camera_code"]: s for s in manifest["stats"]}
    assert stats[cam.code]["video_filename"] == f"{cam.new}.mp4" and stats[cam.code]["good_reads"] == 3
    assert stats["JG-01"]["video_filename"] == f"{OTHER_SLUG}.mp4"
    # the other swap is untouched: still its old clip, so the dashboard keeps hiding its stale files until it is run
    assert stats[cam.other]["video_filename"] == f"{CAMS[cam.other]['old']}.mp4"
    assert {p.name: p.read_bytes() for p in repo.detections_dir.glob("*JG-01.json")} == other
    # old output backed up byte for byte, old clip files kept
    backup = repo.backups_dir / f"{cam.code}_{cam.old}"
    assert (backup / f"events_{cam.code}.json").read_bytes() == old_events
    assert (repo.web_dir / f"{cam.old}.mp4").exists() and (repo.analysis_dir / f"{cam.old}.mp4").exists()
    # the detection ran on the 1080p analysis rendition with the documented defaults
    assert "frame_step=1&tiles=2x3&roi_top=0.33&min_conf=0" in out
    assert f"{cam.new}.mp4" in out and "3 vehicles, 3 plate reads, 3 good reads" in out
    assert "Step 4: upload (skipped" in out
    assert not list(repo.work_dir.glob("detect_*")), "staging folder is cleaned up"


def test_detection_failure_changes_nothing_in_public_or_the_mapping(repo, source, ffmpeg, monkeypatch, capsys, cam):
    monkeypatch.delenv("DETECTION_API_URL", raising=False)
    monkeypatch.delenv("ANPR_API_BASE", raising=False)
    monkeypatch.delenv("DETECTION_API_KEY", raising=False)
    _write(repo.clips_json, {"JG-01": OTHER_SLUG, cam.code: cam.old}, indent=2)
    pub, cfg, clips = snapshot(repo.detections_dir), repo.camera_config.read_bytes(), repo.clips_json.read_bytes()
    rc = rcc.main(["--camera", cam.code, "--source", str(source)], paths=repo, cv2=fake(cam), runner=FakeRunner())
    err = capsys.readouterr().err
    assert rc == 1 and "detection failed" in err and "DETECTION_API_KEY" in err and "Re-run the same command" in err
    assert snapshot(repo.detections_dir) == pub
    assert repo.camera_config.read_bytes() == cfg and repo.clips_json.read_bytes() == clips
    assert not repo.backups_dir.exists()


def test_detection_switches_the_mapping_when_the_slug_changes(repo, source, ffmpeg, mock_api, stub_detect_cv2, cam):
    _write(repo.clips_json, {"JG-01": OTHER_SLUG, cam.code: cam.old}, indent=2)
    cfg = rcc.read_json(repo.camera_config)
    cfg[1] = rcc.renamed_entry(cfg[1], cam.old)
    _write(repo.camera_config, cfg, indent=2)
    assert rcc.main(["--camera", cam.code, "--source", str(source)], paths=repo, cv2=fake(cam), runner=FakeRunner()) == 0
    assert rcc.read_json(repo.clips_json)[cam.code] == cam.new
    assert next(c for c in rcc.read_json(repo.camera_config) if c["camera_code"] == cam.code)["video_slug"] == cam.new


def test_events_made_on_another_clip_are_refused(repo, ffmpeg, source, capsys, cam):
    def wrong_clip(argv):
        out = Path(argv[argv.index("--output_dir") + 1])
        _write(out / f"events_{cam.code}.json", _events(cam.old, [], cam.code))
        _write(out / f"detections_{cam.code}.json", [])
        return 0

    rc = rcc.main(["--camera", cam.code, "--source", str(source)], paths=repo, cv2=fake(cam), runner=FakeRunner(),
                  detect_main=wrong_clip)
    assert rc == 1 and "refusing to install" in capsys.readouterr().err
    assert json.loads((repo.detections_dir / f"events_{cam.code}.json").read_text())["clip"]["file"] == f"{cam.old}.mp4"


def test_both_swaps_one_after_the_other_with_the_same_tool(repo, tmp_path, ffmpeg):
    cams = [SimpleNamespace(code=c, **v) for c, v in CAMS.items()]
    for cam in cams:
        src = tmp_path / f"dl_{cam.code}" / cam.src
        src.parent.mkdir()
        src.write_bytes(b"x")
        assert rcc.main(["--camera", cam.code, "--source", str(src)], paths=repo, cv2=fake(cam), runner=FakeRunner(),
                        detect_main=fake_detect(cam)) == 0
    clips = rcc.read_json(repo.clips_json)
    manifest = rcc.read_json(repo.detections_dir / "manifest.json")
    stats = {s["camera_code"]: s["video_filename"] for s in manifest["stats"]}
    for cam in cams:
        assert clips[cam.code] == cam.new
        assert stats[cam.code] == f"{cam.new}.mp4"
        assert rcc.read_json(repo.detections_dir / f"events_{cam.code}.json")["clip"]["file"] == f"{cam.new}.mp4"
        assert (repo.backups_dir / f"{cam.code}_{cam.old}" / f"events_{cam.code}.json").exists()
        assert (repo.web_dir / f"{cam.old}.mp4").exists()  # old clips stay
        assert (repo.local_dir / f"{cam.new}.mp4").exists() and (repo.local_dir / f"{cam.new}.jpg").exists()
    assert clips["JG-01"] == OTHER_SLUG and stats["JG-01"] == f"{OTHER_SLUG}.mp4"
    assert [c["slug"] for c in rcc.read_json(repo.web_dir / "manifest.json")["clips"]] == sorted(c.new for c in cams)


# ── step 4: upload ───────────────────────────────────────────────────────


def fake_detect(cam):
    return lambda argv: _fake_detect(argv, cam)


def _fake_detect(argv, cam):
    out, cache = Path(argv[argv.index("--output_dir") + 1]), Path(argv[argv.index("--cache_dir") + 1])
    _write(out / f"events_{cam.code}.json", _events(cam.new, ["MH 03 XY 0001", "MH 03 XY 0002"], cam.code))
    _write(out / f"detections_{cam.code}.json", [{"camera_code": cam.code}])
    _write(cache / "summary.json", [{"camera_code": cam.code, "video_filename": f"{cam.new}.mp4", "vehicles": 2,
                                     "good_reads": 2, "plates": 2, "overlay_tracks": 2, "gpu_seconds": 1.0,
                                     "engine": "lpu_on_gpu", "model_version": "t"}])
    return 0


def test_upload_sends_only_clip_and_poster_and_prints_the_insert_command(repo, source, ffmpeg, capsys, cam):
    sent = []
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--upload"], paths=repo, cv2=fake(cam), runner=FakeRunner(),
                  detect_main=fake_detect(cam), creds=lambda env: ("https://x.supabase.co", "svc-key"),
                  uploader=lambda base, key, bucket, obj, path: sent.append((base, bucket, obj, path.name)))
    out = capsys.readouterr().out
    assert rc == 0
    assert sent == [("https://x.supabase.co", "videos", f"mumbai/720p/{cam.new}.mp4", f"{cam.new}.mp4"),
                    ("https://x.supabase.co", "videos", f"mumbai/720p/{cam.new}.jpg", f"{cam.new}.jpg")]
    assert "python3 pipeline/insert_detections.py --detections_dir ./public/detections --prune" in out
    assert "PRODUCTION write" in out and "NOT touched" in out
    assert "svc-key" not in out
    assert "2 vehicles, 2 plate reads, 2 good reads" in out


def test_upload_without_credentials_aborts_with_a_clear_message(repo, source, ffmpeg, capsys, cam):
    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--upload"], paths=repo, cv2=fake(cam), runner=FakeRunner(),
                  detect_main=fake_detect(cam), creds=lambda env: (None, None))
    assert rc == 1 and "SUPABASE_SERVICE_ROLE_KEY" in capsys.readouterr().err


def test_upload_failure_is_reported(repo, source, ffmpeg, capsys, cam):
    def boom(*a):
        raise OSError("connection reset")

    rc = rcc.main(["--camera", cam.code, "--source", str(source), "--upload"], paths=repo, cv2=fake(cam), runner=FakeRunner(),
                  detect_main=fake_detect(cam), creds=lambda env: ("https://x", "k"), uploader=boom)
    assert rc == 1 and "upload of" in capsys.readouterr().err


def test_the_script_never_imports_the_database_writer():
    text = (TOOLS / "replace_camera_clip.py").read_text()
    assert "import insert_detections" not in text and "from insert_detections" not in text
    assert "create_client" not in text


# ── real OpenCV + ffmpeg (skipped when not installed) ────────────────────


def _real_cv2(monkeypatch):
    if importlib.machinery.PathFinder.find_spec("cv2") is None:
        pytest.skip("OpenCV (cv2) not installed in this venv")
    monkeypatch.delitem(sys.modules, "cv2")  # conftest installs a stub; use the real module
    return pytest.importorskip("cv2")


def _synthetic(cv2, path, size=(1920, 1080), fps=10, seconds=5):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    if not writer.isOpened():
        pytest.skip("OpenCV build cannot write mp4v")
    for i in range(fps * seconds):
        frame = np.full((size[1], size[0], 3), 40, np.uint8)
        cv2.rectangle(frame, (10 + i * 5, 60), (400 + i * 5, 300), (255, 255, 255), -1)
        writer.write(frame)
    writer.release()


def test_real_opencv_probe(tmp_path, monkeypatch):
    cv2 = _real_cv2(monkeypatch)
    p = tmp_path / "s.mp4"
    _synthetic(cv2, p, size=(640, 360), seconds=2)
    info = rcc.probe_clip(p)
    assert (info["width"], info["height"], info["frames"]) == (640, 360, 20) and info["fps"] == pytest.approx(10)
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"this is not a video at all" * 100)
    with pytest.raises(rcc.StepError):
        rcc.probe_clip(junk)


def test_real_ffmpeg_transcode(repo, tmp_path, monkeypatch, capsys, cam):
    cv2 = _real_cv2(monkeypatch)
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    src = tmp_path / cam.src
    _synthetic(cv2, src)
    rc = rcc.main(["--camera", cam.code, "--source", str(src), "--no-detect", "--duration", "5"], paths=repo)
    out = capsys.readouterr().out
    assert rc == 0, out
    web = rcc.probe_clip(repo.web_dir / f"{cam.new}.mp4")
    assert (web["width"], web["height"]) == (1280, 720) and web["fourcc"] in ("avc1", "h264") and web["duration_s"] == pytest.approx(5, abs=0.2)
    ana = rcc.probe_clip(repo.analysis_dir / f"{cam.new}.mp4")
    assert (ana["width"], ana["height"]) == (1920, 1080)
    assert rcc.is_faststart(repo.web_dir / f"{cam.new}.mp4") and (repo.local_dir / f"{cam.new}.jpg").stat().st_size > 0
