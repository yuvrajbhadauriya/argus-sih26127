"""Unit tests for run_detection.py (plates, IoU, tracker, frame processing)."""

import json
import re

import pytest

PLATE_RE = re.compile(r"^[A-Z]{2} \d{2} [A-Z]{2} \d{4}$")


# ── get_deterministic_plate ───────────────────────────────────────────
class TestDeterministicPlate:
    def test_format(self, run_detection):
        for i in range(200):
            p = run_detection.get_deterministic_plate("IG-01", f"trk_{i:04d}")
            assert PLATE_RE.match(p), p
            assert p[:2] in run_detection.INDIAN_STATES
            assert p[3:5] != "00"

    def test_deterministic_across_calls(self, run_detection):
        a = run_detection.get_deterministic_plate("CP-01", "trk_0007")
        b = run_detection.get_deterministic_plate("CP-01", "trk_0007")
        assert a == b

    def test_depends_on_camera_and_track(self, run_detection):
        f = run_detection.get_deterministic_plate
        assert f("IG-01", "trk_0001") != f("CP-01", "trk_0001")
        assert f("IG-01", "trk_0001") != f("IG-01", "trk_0002")

    def test_low_collision_rate(self, run_detection):
        plates = {run_detection.get_deterministic_plate("IG-01", f"trk_{i:04d}") for i in range(2000)}
        assert len(plates) >= 1995


# ── compute_iou ───────────────────────────────────────────────────────
class TestIoU:
    def test_identical(self, run_detection):
        assert run_detection.compute_iou([0, 0, 10, 10], [0, 0, 10, 10]) == pytest.approx(1.0, abs=1e-6)

    def test_disjoint_and_touching(self, run_detection):
        assert run_detection.compute_iou([0, 0, 10, 10], [20, 20, 5, 5]) == 0
        assert run_detection.compute_iou([0, 0, 10, 10], [10, 0, 10, 10]) == 0

    def test_half_overlap(self, run_detection):
        # overlap 5x10=50, union 150
        assert run_detection.compute_iou([0, 0, 10, 10], [5, 0, 10, 10]) == pytest.approx(1 / 3, rel=1e-4)

    def test_contained(self, run_detection):
        assert run_detection.compute_iou([0, 0, 10, 10], [2, 2, 5, 5]) == pytest.approx(25 / 100, rel=1e-4)

    def test_symmetric(self, run_detection):
        a, b = [1, 2, 30, 40], [10, 5, 20, 20]
        assert run_detection.compute_iou(a, b) == pytest.approx(run_detection.compute_iou(b, a))

    def test_zero_area_boxes_do_not_divide_by_zero(self, run_detection):
        assert run_detection.compute_iou([0, 0, 0, 0], [0, 0, 0, 0]) == 0


# ── LightweightTracker ────────────────────────────────────────────────
def d(x, y=0, w=50, h=50, t="car", c=0.9):
    return {"bbox": [x, y, w, h], "vehicle_type": t, "confidence": c}


class TestTracker:
    def test_new_ids_are_sequential_and_formatted(self, run_detection):
        tr = run_detection.LightweightTracker()
        out = tr.update([d(0), d(200)])
        assert [o["tracked_vehicle_id"] for o in out] == ["trk_0001", "trk_0002"]

    def test_keeps_id_for_moving_vehicle(self, run_detection):
        tr = run_detection.LightweightTracker(iou_thresh=0.25)
        first = tr.update([d(0)])[0]["tracked_vehicle_id"]
        second = tr.update([d(10)])[0]["tracked_vehicle_id"]  # IoU = 40/60 ≈ 0.67
        assert first == second

    def test_input_not_mutated(self, run_detection):
        tr = run_detection.LightweightTracker()
        det = d(0)
        tr.update([det])
        assert "tracked_vehicle_id" not in det

    def test_different_type_gets_new_track(self, run_detection):
        tr = run_detection.LightweightTracker()
        a = tr.update([d(0, t="car")])[0]["tracked_vehicle_id"]
        b = tr.update([d(0, t="truck")])[0]["tracked_vehicle_id"]
        assert a != b

    def test_low_iou_creates_new_track(self, run_detection):
        tr = run_detection.LightweightTracker(iou_thresh=0.5)
        a = tr.update([d(0)])[0]["tracked_vehicle_id"]
        b = tr.update([d(30)])[0]["tracked_vehicle_id"]  # IoU = 20/80 = 0.25
        assert a != b

    def test_track_survives_max_missed_then_expires(self, run_detection):
        tr = run_detection.LightweightTracker(max_missed=2)
        tid = tr.update([d(0)])[0]["tracked_vehicle_id"]
        tr.update([])
        tr.update([])  # missed 2 == max_missed → still alive
        assert tr.update([d(0)])[0]["tracked_vehicle_id"] == tid
        for _ in range(3):
            tr.update([])  # missed 3 > 2 → deleted
        assert tr.update([d(0)])[0]["tracked_vehicle_id"] != tid
        assert len(tr.tracks) == 1

    def test_one_detection_cannot_be_claimed_by_two_tracks(self, run_detection):
        tr = run_detection.LightweightTracker()
        tr.update([d(0), d(5)])  # two overlapping tracks
        out = tr.update([d(2)])
        assert len(out) == 1

    def test_empty_frames(self, run_detection):
        tr = run_detection.LightweightTracker()
        assert tr.update([]) == []


# ── process_single_video ──────────────────────────────────────────────
class FakeModel:
    """Mimics the torch.hub YOLOv7 autoshape output: results.pred[0] rows of [x1,y1,x2,y2,conf,cls]."""

    def __init__(self, rows_per_call, fail_on_call=None):
        self.rows = rows_per_call
        self.calls = 0
        self.fail_on_call = fail_on_call

    def __call__(self, frame):
        self.calls += 1
        if self.fail_on_call and self.calls >= self.fail_on_call:
            raise RuntimeError("CUDA OOM")
        r = type("R", (), {})()
        r.pred = [self.rows(self.calls) if callable(self.rows) else self.rows]
        return r


class TestProcessSingleVideo:
    def test_missing_file_returns_none(self, run_detection, fake_capture, tmp_path):
        assert run_detection.process_single_video(str(tmp_path / "nope.mp4"), "IG-01", None) == (None, None)
        assert fake_capture.opened_paths == []

    def test_unopenable_video(self, run_detection, fake_capture, tmp_path):
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        fake_capture.spec["opened"] = False
        assert run_detection.process_single_video(str(p), "IG-01", None) == (None, None)

    def test_sampling_timestamps_bbox_normalisation_and_filtering(self, run_detection, fake_capture, tmp_path):
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        fake_capture.spec.update(fps=10.0, frames=10, shape=(720, 1280, 3))
        rows = [
            [128.0, 72.0, 256.0, 144.0, 0.9, 2],   # car → kept
            [0.0, 0.0, 10.0, 10.0, 0.95, 0],       # person (cls 0) → dropped
            [500.0, 300.0, 600.0, 400.0, 0.3, 7],  # truck below threshold → dropped
        ]
        model = FakeModel(rows)
        dets, summary = run_detection.process_single_video(str(p), "IG-01", model, sample_interval=0.2, conf_threshold=0.4)

        # frame_step = round(10*0.2) = 2 → frames 1,3,5,7,9 → 5 samples at t=0,0.2,..,0.8
        assert model.calls == 5
        assert [x["frame_timestamp_sec"] for x in dets] == [0.0, 0.2, 0.4, 0.6, 0.8]
        first = dets[0]
        assert first["bbox"] == {"x": 64.0, "y": 36.0, "width": 64.0, "height": 36.0}
        assert first["vehicle_type"] == "car"
        assert first["camera_code"] == "IG-01"
        assert re.match(r"^[A-Z]{2} \d{2} [A-Z]{2} \d{4}$", first["plate_text"])
        # stationary box → one tracked vehicle, one plate
        assert {x["tracked_vehicle_id"] for x in dets} == {"trk_0001"}
        assert len({x["plate_text"] for x in dets}) == 1
        assert summary == {
            "camera_code": "IG-01",
            "video_filename": "v.mp4",
            "total_frames_sampled": 5,
            "total_detections": 5,
            "unique_tracked_vehicles": 1,
            "video_duration_sec": 1.0,
            "average_confidence": 0.9,
        }

    def test_output_schema_matches_frontend_loader(self, run_detection, fake_capture, tmp_path):
        """useCameraDetections reads plate_text, confidence, frame_timestamp_sec, tracked_vehicle_id, bbox.{x,y,width,height}."""
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        dets, _ = run_detection.process_single_video(str(p), "IG-01", FakeModel([[0, 0, 100, 100, 0.8, 3]]))
        for rec in dets:
            assert set(rec) >= {"plate_text", "confidence", "frame_timestamp_sec", "tracked_vehicle_id", "vehicle_type", "bbox"}
            assert set(rec["bbox"]) == {"x", "y", "width", "height"}
            json.dumps(rec)  # serialisable

    def test_zero_fps_defaults_to_30(self, run_detection, fake_capture, tmp_path):
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        fake_capture.spec.update(fps=0, frames=12)
        _, summary = run_detection.process_single_video(str(p), "X", FakeModel([]), sample_interval=0.2)
        assert summary["total_frames_sampled"] == 2  # step 6 → frames 1, 7

    def test_early_inference_error_switches_to_heuristic(self, run_detection, fake_capture, tmp_path, capsys):
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        model = FakeModel([], fail_on_call=1)
        dets, summary = run_detection.process_single_video(str(p), "X", model)
        assert model.calls == 1  # model dropped after first failure
        assert "Switching to heuristic fallback" in capsys.readouterr().out
        assert summary["total_detections"] == 0

    # Regression (was a strict xfail): mid-video inference errors used to be swallowed silently.
    def test_late_inference_error_is_reported(self, run_detection, fake_capture, tmp_path, capsys):
        p = tmp_path / "v.mp4"
        p.write_bytes(b"x")
        fake_capture.spec.update(fps=10.0, frames=20)
        model = FakeModel([[0, 0, 100, 100, 0.9, 2]], fail_on_call=4)
        run_detection.process_single_video(str(p), "X", model)
        assert "error" in capsys.readouterr().out.lower()

    # Regression (was a strict xfail): http(s) video URLs were rejected by os.path.exists().
    def test_url_video_paths_are_opened(self, run_detection, fake_capture):
        url = "https://example.supabase.co/storage/v1/object/public/videos/a.mp4"
        run_detection.process_single_video(url, "IG-01", FakeModel([]))
        assert fake_capture.opened_paths == [url]


# ── main() orchestration ─────────────────────────────────────────────
class TestMain:
    def test_writes_per_camera_json_and_summaries(self, run_detection, tmp_path, monkeypatch):
        vids = tmp_path / "videos"
        vids.mkdir()
        (vids / "a.mp4").write_bytes(b"x")
        cfg = tmp_path / "cfg.json"
        cfg.write_text(json.dumps([
            {"camera_code": "IG-01", "video_filename": "a.mp4"},
            {"camera_code": "CP-01", "video_filename": "missing.mp4"},
        ]))
        out = tmp_path / "out"
        monkeypatch.setattr(run_detection, "load_yolov7_model", lambda *a: None)
        monkeypatch.setattr(run_detection, "process_single_video", lambda **kw: (
            [{"x": 1}], {"camera_code": kw["camera_code"], "total_detections": 1, "unique_tracked_vehicles": 1}))
        monkeypatch.setattr("sys.argv", ["run_detection.py", "--videos_dir", str(vids), "--output_dir", str(out), "--config", str(cfg)])
        run_detection.main()
        assert json.loads((out / "detections_IG-01.json").read_text()) == [{"x": 1}]
        assert not (out / "detections_CP-01.json").exists()
        assert json.loads((out / "summary.json").read_text())[0]["camera_code"] == "IG-01"
        assert (out / "summary.csv").read_text().splitlines()[0] == "camera_code,total_detections,unique_tracked_vehicles"

    def test_exits_when_no_configs(self, run_detection, tmp_path, monkeypatch):
        monkeypatch.setattr(run_detection, "load_yolov7_model", lambda *a: None)
        monkeypatch.setattr(run_detection, "ensure_videos_downloaded", lambda *a: None)
        monkeypatch.setattr("sys.argv", ["x", "--videos_dir", str(tmp_path / "none"), "--output_dir", str(tmp_path / "o"), "--config", str(tmp_path / "nope.json")])
        with pytest.raises(SystemExit):
            run_detection.main()


class TestDownloadWeights:
    def test_existing_file_short_circuits(self, run_detection, tmp_path):
        w = tmp_path / "w.pt"
        w.write_bytes(b"x")
        assert run_detection._download_weights(str(w)) is True

    def test_no_requests_returns_false(self, run_detection, tmp_path, monkeypatch):
        monkeypatch.setattr(run_detection, "requests", None)
        assert run_detection._download_weights(str(tmp_path / "w.pt")) is False
