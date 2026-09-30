"""End-to-end evaluation against the in-process mock model API (real HTTP, real adapter/client)."""

import json

from eval import evaluate, video_consistency
from eval.lpu_client import LpuClient, LpuConfig, normalise_frame, read_lpu_config
from eval.images import synthetic_plate_png
from eval.mock_eval_server import corrupt, start_oracle_server


def test_mock_run_writes_schema_v1_sample(tmp_path):
    out, report = tmp_path / "eval" / "results.json", tmp_path / "REPORT.md"
    rc = evaluate.main(["--mock", "--data_dir", str(tmp_path / "data"), "--out", str(out), "--report", str(report),
                        "--samples", "6", "--workers", "3"])
    assert rc == 0
    r = json.loads(out.read_text())
    assert r["schema_version"] == 1
    assert r["status"] == "sample" and "evaluate.py" in r["note"]
    assert r["model"]["api"] == "mock" and r["model"]["model_version"] == "mock-oracle-1"
    assert r["model_card"]["model_version"] == "deim50k+raw35" and r["config"]["endpoint"] == "POST /v1/frame"
    o = r["overall"]
    assert o["images"] == 48 and o["plates"] == 48 and o["api_errors"] == 0
    for k in ("plate_accuracy", "char_accuracy", "detection_recall", "lenient_accuracy"):
        assert 0 <= o[k] <= 1
    assert o["lenient_accuracy"] >= o["plate_accuracy"]
    assert o["char_accuracy"] >= o["plate_accuracy"] - 1e-9
    assert o["latency_ms"]["p95"] is not None
    assert [d["id"] for d in r["per_dataset"]] == ["synthetic"]
    conds = {c["condition"]: c for c in r["per_condition"]}
    assert conds["night"]["source"] == "label" and conds["night"]["plates"] == 16
    assert 0 < len(r["samples"]) <= 6 and any(not s["correct"] for s in r["samples"])
    thumbs = [s["thumb"] for s in r["samples"] if s["thumb"]]
    assert thumbs and all((out.parent / t.removeprefix("/eval/")).exists() for t in thumbs)
    text = report.read_text()
    assert "SAMPLE DATA" in text and "not measured" in text


def test_missing_config_exits_2(monkeypatch, tmp_path):
    _clean_env(monkeypatch)
    assert evaluate.main(["--env_file", str(tmp_path / "none.env"), "--out", str(tmp_path / "r.json")]) == 2


def _clean_env(monkeypatch):
    for k in ("ANPR_API_BASE", "DETECTION_API_URL", "DETECTION_API_KEY", "DETECTION_API_AUTH_HEADER", "DETECTION_API_REQUEST_FORMAT", "DETECTION_API_IMAGE_FIELD",
              "DETECTION_API_HEALTH_URL", "DETECTION_API_TIMEOUT_MS"):
        monkeypatch.delenv(k, raising=False)


def test_rejected_key_exits_2(monkeypatch, tmp_path):
    _clean_env(monkeypatch)
    server, _, _ = start_oracle_server({}, api_key="right")
    try:
        monkeypatch.setenv("ANPR_API_BASE", f"http://127.0.0.1:{server.server_address[1]}")
        monkeypatch.setenv("DETECTION_API_KEY", "wrong")
        rc = evaluate.main(["--datasets", "synthetic", "--data_dir", str(tmp_path), "--out", str(tmp_path / "r.json"),
                            "--report", "", "--max_retries", "0", "--env_file", str(tmp_path / "none.env")])
        assert rc == 2
        assert not (tmp_path / "r.json").exists()
    finally:
        server.shutdown()


def test_real_run_is_marked_measured(monkeypatch, tmp_path):
    """Against a non-mock URL the output is status=measured (here: the oracle server posing as the real API)."""
    _clean_env(monkeypatch)
    server, _, _ = start_oracle_server({}, api_key="k")
    try:
        monkeypatch.setenv("ANPR_API_BASE", f"http://127.0.0.1:{server.server_address[1]}")
        monkeypatch.setenv("DETECTION_API_KEY", "k")
        rc = evaluate.main(["--datasets", "synthetic", "--limit", "5", "--data_dir", str(tmp_path),
                            "--out", str(tmp_path / "r.json"), "--report", "", "--env_file", str(tmp_path / "none.env")])
        assert rc == 0
        r = json.loads((tmp_path / "r.json").read_text())
        assert r["status"] == "measured" and r["overall"]["images"] == 5
        # unregistered images -> the oracle answers with unrelated plates: nothing is exact
        assert r["overall"]["exact"] == 0
    finally:
        server.shutdown()


def test_corrupt_makes_one_realistic_error():
    import random

    from eval.metrics import edit_distance

    rng = random.Random(0)
    for _ in range(20):
        assert edit_distance("MH02AB1234", corrupt("MH02AB1234", rng)) == 1


def test_video_stability_metric():
    recs = [{"track": "t1", "plate": p} for p in ["MH02AB1234"] * 8 + ["MH02A81234", "MHO2AB1234"]]
    recs += [{"track": "t2", "plate": "KA01AA0001"}, {"track": "t2", "plate": None}]  # < min_reads
    s = video_consistency.track_stability(recs, min_reads=3)
    assert s["tracks_total"] == 2 and s["tracks_scored"] == 1
    assert s["mean_stability"] == 0.8 and s["read_weighted_stability"] == 0.8
    assert s["lenient_mean_stability"] == 0.9
    assert s["stable_track_share"] == 1.0
    assert s["tracks"][0]["majority_plate"] == "MH02AB1234" and s["tracks"][0]["distinct_reads"] == 3


def test_video_process_frames_against_mock():
    server, _, _ = start_oracle_server({}, api_key="k", video_noise=0.0)
    try:
        client = LpuClient(LpuConfig(base=f"http://127.0.0.1:{server.server_address[1]}", api_key="k"))
        frame = synthetic_plate_png("FRAME0000", scale=8)  # ~500x100 PNG; mock cars drift with the timestamp
        frames = [(i * 0.2, frame, 0, 0) for i in range(12)]
        records, meta = video_consistency.process_frames(frames, client, "JG-01", workers=3)
        assert meta["frames"] == 12 and meta["errors"] == 0 and meta["model_version"] == "mock-oracle-1"
        s = video_consistency.track_stability(records)
        assert s["tracks_scored"] >= 1 and s["mean_stability"] == 1.0  # no noise -> perfectly stable
    finally:
        server.shutdown()


def test_lpu_contract_normalisation():
    raw = {"engine": "lpu_on_gpu", "model_version": "deim50k+raw35", "inference_ms": 114.0, "latency_ms": 757.8,
           "image": {"width": 1920, "height": 1440},
           "detections": [
               {"plate": "KL49 8262", "ocr_confidence": 71.5, "raw_ocr": "KL498262", "grammar_valid": True, "plate_score": 0.46,
                "plate_box_xywh": [1123, 1144, 143, 40], "vehicle_class": "Bus", "vehicle_confidence": 0.85,
                "vehicle_box_xywh": [0, 1, 1919, 1284]},
               {"plate": "Not Found", "ocr_confidence": 0, "plate_box_xywh": None, "vehicle_class": "Car",
                "vehicle_confidence": 0.7, "vehicle_box_xywh": [5, 5, 100, 80]},
           ]}
    out = normalise_frame(raw)
    assert out["engine"] == "lpu_on_gpu" and out["model_version"] == "deim50k+raw35"
    a, b = out["detections"]
    assert a["plate_text"] == "KL49 8262" and a["plate_confidence"] == 0.715 and a["bbox"] == [1123, 1144, 143, 40]
    assert a["vehicle_type"] == "bus" and a["vehicle_bbox"] == [0, 1, 1919, 1284]
    assert b["plate_text"] is None and b["bbox"] is None


def test_lpu_config_from_env():
    assert read_lpu_config({}) is None
    cfg = read_lpu_config({"ANPR_API_BASE": "http://gpu:8765/", "DETECTION_API_KEY": "s3cret"})
    assert cfg.base == "http://gpu:8765" and cfg.headers() == {"X-API-Key": "s3cret"}
    assert "s3cret" not in repr(cfg)
    cfg = read_lpu_config({"DETECTION_API_URL": "https://h:1/v1/frame", "DETECTION_API_KEY": "k", "DETECTION_API_AUTH_HEADER": "Authorization"})
    assert cfg.base == "https://h:1" and cfg.headers() == {"Authorization": "Bearer k"}


def test_video_events_summary():
    s = video_consistency.summarise_events({"events": [
        {"plate": "MH02AB1234", "ocr_confidence": 90, "grammar_valid": True},
        {"plate": "MH02AB1234", "ocr_confidence": 70, "grammar_valid": False},
        {"plate": "Not Found"},
    ], "inference_ms": 900})
    assert s == {"events": 3, "events_with_plate": 2, "grammar_valid_share": 0.5, "mean_ocr_confidence": 0.8,
                 "unique_plates": 1, "inference_ms": 900}


def test_plate_tracker_keeps_neighbours_apart():
    t = video_consistency.PlateTracker(gate=1.5)
    a = {"bbox": [100, 100, 40, 12], "plate_text": "A"}
    b = {"bbox": [160, 100, 40, 12], "plate_text": "B"}
    ids1 = {d["plate_text"]: d["tracked_vehicle_id"] for d in t.update([a, b])}
    moved = [{**a, "bbox": [110, 104, 40, 12]}, {**b, "bbox": [170, 104, 40, 12]}]
    ids2 = {d["plate_text"]: d["tracked_vehicle_id"] for d in t.update(moved)}
    assert ids1 == ids2 and ids1["A"] != ids1["B"]
    for _ in range(3):
        t.update([])
    assert t.tracks == {}
