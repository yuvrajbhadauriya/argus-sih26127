"""make_read_crops: event keys, padding parity with plateCrop.ts, matching, resumable run (no GPU, no clips)."""

import argparse
import json
import os
import sys

import numpy as np
import pytest
from detect import make_read_crops as M

CLIP = (1920, 1080)


def _event(plate="MH 02 GB 4920", t=0.4, trk="trk_0008", bbox=None):
    return {"plate_text": plate, "good_read": True, "time_sec": t, "frame": 12, "tracked_vehicle_id": trk,
            "bbox": bbox or {"x": 100, "y": 100, "width": 200, "height": 100}}


def _det(plate, vbox, pbox, source="vehicle"):
    return {"plate_text": plate, "bbox": vbox, "plate_bbox": pbox, "bbox_source": source}


def test_event_key_rule_matches_the_typescript_one():
    # Same cases as readCrops.test.ts
    assert M.event_key("VP-01", "trk_0008", 0.4) == "VP-01_trk_0008_400"
    assert M.event_key("SC-01", "trk_0005", 12.67) == "SC-01_trk_0005_12670"
    assert M.event_key("AN-01", "a/b c", 0.07) == "AN-01_a-b-c_70"


def test_pad_box_matches_plate_crop_ts():
    # PLATE_PAD on a 100x20 plate at (500,300): w = 100*1.36 = 136, h = 20*1.9 = 38
    assert M.pad_box({"x": 500, "y": 300, "width": 100, "height": 20}, 1920, 1080, M.PLATE_PAD) == {"x": 482, "y": 291, "width": 136, "height": 38}
    # clamped inside the frame, minimum side enforced
    assert M.pad_box({"x": 0, "y": 0, "width": 4, "height": 4}, 100, 100, M.VEHICLE_PAD) == {"x": 0, "y": 0, "width": 24, "height": 24}
    assert M.pad_box({"x": 0, "y": 0, "width": 0, "height": 4}, 100, 100, M.VEHICLE_PAD) is None


def test_pick_detection_prefers_equal_plate_text_then_iou():
    ev = _event()
    box = ev["bbox"]
    same = _det("MH02GB4920", {"x": 900, "y": 10, "width": 50, "height": 50}, {"x": 900, "y": 40, "width": 20, "height": 8})
    near = _det("MH01XX0001", box, {"x": 120, "y": 160, "width": 40, "height": 10})
    assert M.pick_detection(ev, [near, same], box) is same


def test_pick_detection_fallback_needs_overlap_and_no_contradicting_text():
    ev = _event()
    box = ev["bbox"]
    pb = {"x": 120, "y": 160, "width": 40, "height": 10}
    assert M.pick_detection(ev, [_det("MH01XX0001", box, pb)], box) is None          # other plate
    assert M.pick_detection(ev, [_det(None, {"x": 1500, "y": 800, "width": 100, "height": 80}, pb)], box) is None  # far away
    assert M.pick_detection(ev, [_det(None, {"x": 100, "y": 100, "width": 200, "height": 100}, None)], box) is None  # no plate box
    unread = _det(None, {"x": 110, "y": 105, "width": 200, "height": 100}, pb)
    assert M.pick_detection(ev, [unread], box) is unread


class Writer:
    def __init__(self):
        self.files = {}

    def __call__(self, path, data):
        self.files[path] = data


@pytest.fixture
def fake_jpeg(monkeypatch):
    monkeypatch.setattr(M, "encode_thumb", lambda img, *a, **k: b"JPEG%dx%d" % (img.shape[1], img.shape[0]))


def test_process_event_scales_boxes_and_cuts_both_crops(fake_jpeg):
    frame = np.zeros((720, 1280, 3), np.uint8)  # a 720p clip; events and the model are in 1080p space
    ev = _event(bbox={"x": 300, "y": 300, "width": 300, "height": 150})
    # model answered for a 1280x720 frame sent as-is
    ans = {"image": {"width": 1280, "height": 720},
           "detections": [_det("MH 02 GB 4920", {"x": 200, "y": 200, "width": 200, "height": 100}, {"x": 260, "y": 260, "width": 60, "height": 15})]}
    w = Writer()
    res = M.process_event(ev, frame, 12, lambda f: ans, CLIP, "K", "/out/VP-01", w)
    assert res["status"] == "ok"
    e = res["entry"]
    assert e["plate"] == "VP-01/K_plate.jpg" and e["vehicle"] == "VP-01/K_vehicle.jpg"
    assert set(w.files) == {"/out/VP-01/K_plate.jpg", "/out/VP-01/K_vehicle.jpg"}
    assert e["plate_bbox"] == {"x": 390.0, "y": 390.0, "width": 90.0, "height": 22.5}  # back in 1080p space
    assert e["frame_time_sec"] == 0.4 and e["frame_index"] == 12


def test_process_event_plate_only_detection_gives_no_vehicle_crop(fake_jpeg):
    frame = np.zeros((1080, 1920, 3), np.uint8)
    ev = _event(bbox={"x": 100, "y": 100, "width": 60, "height": 30})
    ans = {"image": {"width": 1920, "height": 1080},
           "detections": [_det("MH 02 GB 4920", {"x": 100, "y": 100, "width": 60, "height": 30}, {"x": 100, "y": 100, "width": 60, "height": 30}, "plate")]}
    w = Writer()
    res = M.process_event(ev, frame, 1, lambda f: ans, CLIP, "K", "/o/C", w)
    assert res["entry"]["vehicle"] is None and list(w.files) == ["/o/C/K_plate.jpg"]


def test_process_event_without_match_is_skipped_and_writes_nothing(fake_jpeg):
    frame = np.zeros((1080, 1920, 3), np.uint8)
    w = Writer()
    res = M.process_event(_event(), frame, 1, lambda f: {"image": {"width": 1920, "height": 1080}, "detections": []}, CLIP, "K", "/o/C", w)
    assert res["status"] == "skipped" and not w.files


def test_encode_thumb_downscales_but_never_upscales(monkeypatch):
    cv2 = sys.modules["cv2"]
    seen = {}
    monkeypatch.setattr(cv2, "IMWRITE_JPEG_QUALITY", 1, raising=False)
    monkeypatch.setattr(cv2, "INTER_AREA", 3, raising=False)
    monkeypatch.setattr(cv2, "resize", lambda f, size, interpolation=None: np.zeros((size[1], size[0], 3), np.uint8), raising=False)

    def imencode(ext, f, params=None):
        seen["shape"], seen["q"] = f.shape, params
        return True, np.frombuffer(b"x", np.uint8)

    monkeypatch.setattr(cv2, "imencode", imencode, raising=False)
    M.encode_thumb(np.zeros((300, 400, 3), np.uint8))
    assert seen["shape"][1] == M.CROP_MAX_WIDTH and seen["q"] == [1, M.CROP_JPEG_QUALITY]
    M.encode_thumb(np.zeros((30, 40, 3), np.uint8))
    assert seen["shape"][:2] == (30, 40)


# ── run() ────────────────────────────────────────────────────────────
class Clip:
    size = (1920, 1080)

    def __init__(self, path):
        self.closed = False
        self.path = path
        self.width, self.height = Clip.size

    def frame_at(self, t):
        return np.zeros((1080, 1920, 3), np.uint8), int(round(t * 30))

    def close(self):
        self.closed = True


def _setup(tmp_path):
    ev_dir, vid_dir, out = tmp_path / "det", tmp_path / "videos_1080p", tmp_path / "out"
    ev_dir.mkdir(), vid_dir.mkdir()
    (vid_dir / "clip.mp4").write_bytes(b"x")
    good = _event(t=1.0, trk="trk_1")
    other = _event(plate="MH 01 AB 1234", t=2.0, trk="trk_2")
    weak = dict(_event(t=3.0, trk="trk_3"), good_read=False)
    doc = {"clip": {"file": "clip.mp4", "width": 1920, "height": 1080}, "events": [good, other, weak]}
    (ev_dir / "events_VP-01.json").write_text(json.dumps(doc))
    (ev_dir / "events_SC-01.json").write_text(json.dumps(doc))
    ns = argparse.Namespace(events_dir=str(ev_dir), video_dir=str(vid_dir), video=None, out_dir=str(out), camera=None,
                            dry_run=False, force=False, retry_skipped=False, save_every=10)
    return ns, out


def _detector(calls):
    def make():
        def detect(frame):
            calls.append(1)
            return {"image": {"width": 1920, "height": 1080}, "detections": [
                _det("MH 02 GB 4920", {"x": 100, "y": 100, "width": 200, "height": 100}, {"x": 120, "y": 160, "width": 40, "height": 10})]}
        return detect
    return make


def test_run_writes_manifest_is_resumable_and_remembers_skips(tmp_path, fake_jpeg):
    ns, out = _setup(tmp_path)
    ns.camera = ["VP-01"]
    calls, w, logs = [], Writer(), []
    assert M.run(ns, _detector(calls), Clip, w, logs.append) == 0
    man = json.loads((out / "manifest.json").read_text())
    assert list(man["crops"]) == ["VP-01_trk_1_1000"]            # only the good read that matched
    assert list(man["skipped"]) == ["VP-01_trk_2_2000"]          # plate text of the other read did not match
    assert len(calls) == 2
    # files are only written through `write` here; create them so the second run sees them as done
    for rel in (man["crops"]["VP-01_trk_1_1000"]["plate"], man["crops"]["VP-01_trk_1_1000"]["vehicle"]):
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        (out / rel).write_bytes(b"j")
    calls.clear()
    assert M.run(ns, _detector(calls), Clip, w, logs.append) == 0
    assert calls == []                                            # nothing re-sent
    ns.retry_skipped = True
    M.run(ns, _detector(calls), Clip, w, logs.append)
    assert len(calls) == 1                                        # only the skipped one is asked again


def test_run_redoes_entries_whose_files_are_gone(tmp_path, fake_jpeg):
    ns, out = _setup(tmp_path)
    ns.camera = ["VP-01"]
    M.run(ns, _detector([]), Clip, Writer(), lambda s: None)      # manifest written, files never created
    calls = []
    M.run(ns, _detector(calls), Clip, Writer(), lambda s: None)
    assert len(calls) == 1


def test_dry_run_touches_nothing_and_needs_no_api(tmp_path):
    ns, out = _setup(tmp_path)
    ns.dry_run = True
    logs = []

    def boom():
        raise AssertionError("no API in --dry-run")

    assert M.run(ns, boom, lambda p: pytest.fail("no clip"), lambda p, d: pytest.fail("no write"), logs.append) == 0
    assert not out.exists() and any("to do: 2" in line for line in logs) and "would be sent" in logs[-1]


def test_missing_clip_and_unconfigured_api(tmp_path, fake_jpeg):
    ns, out = _setup(tmp_path)
    assert M.run(ns, lambda: None, Clip, Writer(), lambda s: None) == 2
    os.remove(os.path.join(ns.video_dir, "clip.mp4"))
    logs = []
    assert M.run(ns, _detector([]), Clip, Writer(), logs.append) == 1
    assert any("not found" in line for line in logs)


def test_camera_filter(tmp_path):
    ns, _ = _setup(tmp_path)
    assert [c for c, _ in M.find_events_files(ns.events_dir, ["SC-01"])] == ["SC-01"]
    ns.camera = ["ZZ-99"]
    assert M.run(ns, None, Clip, Writer(), lambda s: None) == 1


def test_video_resolution_never_falls_back_to_web_renditions(tmp_path):
    assert M.is_web_rendition("/x/public/videos-local/a.mp4") and M.is_web_rendition("/x/pipeline/data/videos_720p/a.mp4")
    assert not M.is_web_rendition("/x/pipeline/data/videos_1080p/a.mp4")
    path, why = M.resolve_video("VP-01", "a.mp4", str(tmp_path / "public" / "videos-local"), {})
    assert path is None and "720p" in why
    path, why = M.resolve_video("VP-01", "a.mp4", str(tmp_path), {})
    assert path is None and "not found" in why
    big = tmp_path / "kurla4k.mp4"
    big.write_bytes(b"x")
    assert M.resolve_video("KR-01", "a.mp4", str(tmp_path), {"KR-01": str(big)}) == (str(big), None)
    assert M.parse_video_overrides(["KR-01=/a/b.mp4"]) == {"KR-01": "/a/b.mp4"}
    with pytest.raises(SystemExit):
        M.parse_video_overrides(["nonsense"])


def test_run_refuses_a_rendition_smaller_than_the_analysis_one(tmp_path, fake_jpeg, monkeypatch):
    ns, out = _setup(tmp_path)
    ns.camera = ["VP-01"]
    monkeypatch.setattr(Clip, "size", (1280, 720))
    logs, calls = [], []
    assert M.run(ns, _detector(calls), Clip, Writer(), logs.append) == 1
    assert calls == [] and any("refused" in line for line in logs)
    monkeypatch.setattr(Clip, "size", (3840, 2160))  # a 4K source is fine (boxes are rescaled)
    assert M.run(ns, _detector(calls), Clip, Writer(), logs.append) == 0 and calls


def test_run_refuses_a_web_rendition_directory(tmp_path, fake_jpeg):
    ns, _ = _setup(tmp_path)
    web = tmp_path / "videos-local"
    web.mkdir()
    (web / "clip.mp4").write_bytes(b"x")
    ns.video_dir = str(web)
    logs = []
    assert M.run(ns, _detector([]), Clip, Writer(), logs.append) == 1
    assert any("web (720p) rendition" in line for line in logs)
