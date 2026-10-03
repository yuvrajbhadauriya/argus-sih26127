"""HD (1080p) renditions for the selected feed: link_local_videos.py --hd and upload_videos.py --hd.

Hermetic: temp folders only, no ffmpeg, no network.
"""

import importlib.util
import json
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


llv = _load("link_local_videos")
uv = _load("upload_videos")

A, B, OLD = "mumbai_a-view_pexels1", "mumbai_b-view_pexels2", "mumbai_old-clip_pexels3"


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """720p folder (A, B, OLD), 1080p folder (A, OLD; B has no HD yet) and a registry of cameras A and B."""
    sd, hd, dest = tmp_path / "720", tmp_path / "1080", tmp_path / "public" / "videos-local"
    sd.mkdir()
    hd.mkdir()
    for slug in (A, B, OLD):
        (sd / f"{slug}.mp4").write_bytes(b"sd-" + slug.encode())
        (sd / f"{slug}.jpg").write_bytes(b"jpg")
    (sd / "manifest.json").write_text("{}")
    for slug in (A, OLD):
        (hd / f"{slug}.mp4").write_bytes(b"hd-" + slug.encode())
    (hd / ".hidden.mp4").write_bytes(b"x")
    reg = tmp_path / "cameraClips.json"
    reg.write_text(json.dumps({"AA-01": A, "BB-01": B}))
    monkeypatch.setattr(llv, "CLIPS_JSON", reg)
    return sd, hd, dest


def run(tree, *extra):
    sd, hd, dest = tree
    return llv.main(["--src", str(sd), "--hd-src", str(hd), "--dest", str(dest), *extra])


def test_hd_name_is_what_the_dashboard_looks_for():
    assert llv.hd_name("mumbai_x_pexels9") == "mumbai_x_pexels9.hd.mp4"
    constants = (Path(__file__).resolve().parents[2] / "src" / "config" / "constants.ts").read_text()
    assert f"LOCAL_HD_SUFFIX = '{llv.HD_SUFFIX}'" in constants


def test_plain_run_does_not_expose_hd(tree):
    assert run(tree) == 0
    assert not list(tree[2].glob("*.hd.mp4"))


def test_hd_links_the_existing_1080p_renditions_of_the_cameras_that_have_one(tree, capsys):
    assert run(tree, "--hd") == 0
    dest = tree[2]
    assert (dest / f"{A}.hd.mp4").is_symlink() and (dest / f"{A}.hd.mp4").read_bytes() == b"hd-" + A.encode()
    assert (dest / f"{A}.mp4").read_bytes() == b"sd-" + A.encode()  # 720p stays beside it
    assert not (dest / f"{B}.hd.mp4").exists()  # no 1080p file yet: the player uses 720p
    assert not (dest / f"{OLD}.hd.mp4").exists()  # not a clip any camera plays
    out = capsys.readouterr().out
    assert "1 HD file(s)" in out and f"BB-01: no {B}.mp4" in out and "720p" in out


def test_hd_copy_mode_makes_real_files(tree):
    assert run(tree, "--hd", "--copy") == 0
    f = tree[2] / f"{A}.hd.mp4"
    assert f.is_file() and not f.is_symlink() and f.read_bytes() == b"hd-" + A.encode()


def test_without_a_registry_every_1080p_file_is_exposed(tree, monkeypatch, tmp_path):
    monkeypatch.setattr(llv, "CLIPS_JSON", tmp_path / "missing.json")
    assert run(tree, "--hd") == 0
    assert sorted(p.name for p in tree[2].glob("*.hd.mp4")) == [f"{A}.hd.mp4", f"{OLD}.hd.mp4"]


def test_a_plain_run_keeps_hd_files_made_by_replace_camera_clip(tree):
    dest = tree[2]
    dest.mkdir(parents=True)
    (dest / f"{B}.hd.mp4").write_bytes(b"real copy")
    (dest / "stale.mp4").write_bytes(b"x")
    assert run(tree) == 0
    assert (dest / f"{B}.hd.mp4").read_bytes() == b"real copy" and not (dest / "stale.mp4").exists()
    assert run(tree, "--hd") == 0  # --hd only removes stale links, never a real copy
    assert (dest / f"{B}.hd.mp4").read_bytes() == b"real copy"


def test_hd_removes_only_stale_hd_links(tree):
    dest = tree[2]
    assert run(tree, "--hd") == 0
    (tree[1] / f"{A}.mp4").unlink()
    (tree[1] / f"{A}.mp4").write_bytes(b"")  # now unusable (empty)
    assert run(tree, "--hd") == 0
    assert not (dest / f"{A}.hd.mp4").exists()


def test_hd_works_without_the_720p_folder(tree):
    sd, hd, dest = tree
    for f in sd.iterdir():
        f.unlink()
    assert run(tree, "--hd") == 0
    assert (dest / f"{A}.hd.mp4").exists()


def test_nothing_at_all_is_an_error(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(llv, "CLIPS_JSON", tmp_path / "missing.json")
    rc = llv.main(["--src", str(tmp_path / "no"), "--hd-src", str(tmp_path / "none"), "--dest", str(tmp_path / "d"), "--hd"])
    assert rc == 1 and "nothing in" in capsys.readouterr().err


# ── upload_videos.py --hd ────────────────────────────────────────────────


def test_collect_hd_takes_only_mp4_files(tree):
    assert [f.name for f in uv.collect_hd(tree[1], None)] == [f"{A}.mp4", f"{OLD}.mp4"]
    assert [f.name for f in uv.collect_hd(tree[1], [A])] == [f"{A}.mp4"]


def test_upload_hd_dry_run_names_the_1080p_objects(tree, capsys):
    rc = uv.main(["--hd", "--dir", str(tree[1]), "--env-file", str(tree[1] / "none.env")])
    out = capsys.readouterr().out
    assert rc == 0 and f"mumbai/1080p/{A}.mp4" in out and "mumbai/720p" not in out and ".jpg" not in out
    assert "Dry run only" in out


def test_upload_hd_executes_only_to_the_1080p_prefix(tree, monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(uv, "credentials", lambda env: ("https://x.supabase.co", "svc"))
    monkeypatch.setattr(uv, "upload", lambda base, key, bucket, obj, path: sent.append((bucket, obj)))
    rc = uv.main(["--hd", "--dir", str(tree[1]), "--only", A, "--execute"])
    assert rc == 0 and sent == [("videos", f"mumbai/1080p/{A}.mp4")]
    assert "svc" not in capsys.readouterr().out


def test_upload_default_is_still_the_720p_set(tree, capsys):
    rc = uv.main(["--dir", str(tree[0]), "--env-file", str(tree[0] / "none.env")])
    out = capsys.readouterr().out
    assert rc == 0 and f"mumbai/720p/{A}.mp4" in out and f"mumbai/720p/{A}.jpg" in out and "1080p" not in out
