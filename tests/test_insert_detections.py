"""Tests for insert_detections.py — camera mapping, row shaping, batching, timestamps."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from conftest import ROOT_DIR


def write_dets(dirpath, code, n, **over):
    recs = [
        {
            "camera_code": code,
            "tracked_vehicle_id": f"trk_{i:04d}",
            "plate_text": "DL 01 AB 1234",
            "vehicle_type": "car",
            "confidence": 0.9,
            "frame_timestamp_sec": i * 0.2,
            "bbox": {"x": 1, "y": 2, "width": 3, "height": 4},
            **over,
        }
        for i in range(n)
    ]
    (dirpath / f"detections_{code}.json").write_text(json.dumps(recs))
    return recs


@pytest.fixture
def run_main(insert_detections, monkeypatch, tmp_path, fake_supabase_cls):
    """Run insert_detections.main() against a FakeSupabase; returns the fake."""

    def _run(*extra_args, cameras=None, insert_hook=None, config=None):
        fake = fake_supabase_cls(select_data={"cameras": cameras or []}, insert_hook=insert_hook)
        monkeypatch.setattr(insert_detections, "get_supabase_client", lambda: fake)
        cfg = tmp_path / "cfg.json"
        cfg.write_text(json.dumps(config or []))
        monkeypatch.setattr("sys.argv", ["insert_detections.py", "--detections_dir", str(tmp_path / "dets"), "--config", str(cfg), *extra_args])
        insert_detections.main()
        return fake

    (tmp_path / "dets").mkdir()
    return _run


CAMS = [{"id": "cam-001", "code": "IG-01", "lat": 28.1, "lng": 77.1, "name": "IG"}]


class TestFetchCameraMapping:
    def test_maps_code_and_aliases_and_normalises_coords(self, insert_detections, fake_supabase_cls):
        fake = fake_supabase_cls(select_data={"cameras": [
            {"id": "a", "code": "CAM-D", "latitude": 1.0, "longitude": 2.0},
            {"id": "b", "code": "IG-01", "lat": 0.0, "lng": 0.0},
        ]})
        m = insert_detections.fetch_camera_mapping(fake)
        assert m["CAM-D"]["id"] == "a"
        assert m["DW-01"]["id"] == "a"  # alias → pipeline code
        assert (m["DW-01"]["lat"], m["DW-01"]["lng"]) == (1.0, 2.0)
        assert (m["IG-01"]["lat"], m["IG-01"]["lng"]) == (0.0, 0.0)  # 0 preserved

    def test_returns_empty_on_error(self, insert_detections):
        class Boom:
            def table(self, _):
                raise RuntimeError("down")
        assert insert_detections.fetch_camera_mapping(Boom()) == {}


class TestLoadConfigFallback:
    def test_missing_file(self, insert_detections, tmp_path):
        assert insert_detections.load_config_fallback(str(tmp_path / "x.json")) == {}

    def test_keys_by_camera_code(self, insert_detections):
        m = insert_detections.load_config_fallback(str(ROOT_DIR / "camera_config.json"))
        assert "IG-01" in m and m["IG-01"]["video_filename"].endswith(".mp4")


class TestGetSupabaseClient:
    def test_exits_without_url(self, insert_detections, monkeypatch):
        for k in ("SUPABASE_URL", "VITE_SUPABASE_URL"):
            monkeypatch.delenv(k, raising=False)
        with pytest.raises(SystemExit):
            insert_detections.get_supabase_client()

    def test_exits_without_any_key(self, insert_detections, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
        monkeypatch.delenv("VITE_SUPABASE_ANON_KEY", raising=False)
        with pytest.raises(SystemExit):
            insert_detections.get_supabase_client()

    def test_prefers_service_role_key(self, insert_detections, monkeypatch):
        import supabase
        seen = {}
        monkeypatch.setattr(supabase, "create_client", lambda url, key: seen.update(url=url, key=key) or "client")
        monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
        monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "anon")
        assert insert_detections.get_supabase_client() == "client"
        assert seen == {"url": "https://abc.supabase.co", "key": "service"}


class TestMainIngestion:
    def test_row_shape_timestamps_and_plate_normalisation(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 3)
        fake = run_main("--start_time", "2026-09-27T12:00:00Z", cameras=CAMS)
        rows = [r for chunk in fake.inserted["detections"] for r in chunk]
        assert len(rows) == 3
        r = rows[2]
        assert r["camera_id"] == "cam-001"
        assert r["plate_text_raw"] == "DL 01 AB 1234"
        assert r["plate_text_normalized"] == "DL01AB1234"
        assert r["lat"] == 28.1 and r["lng"] == 77.1
        assert r["tracked_vehicle_id"] == "trk_0002"
        assert r["frame_timestamp_sec"] == pytest.approx(0.4)
        base = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
        assert datetime.fromisoformat(r["detected_at"]) == base + timedelta(seconds=0.4)

    def test_batches_by_batch_size(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 5)
        fake = run_main("--batch_size", "2", cameras=CAMS)
        assert [len(c) for c in fake.inserted["detections"]] == [2, 2, 1]

    def test_empty_file_is_skipped(self, run_main, tmp_path):
        (tmp_path / "dets" / "detections_IG-01.json").write_text("[]")
        fake = run_main(cameras=CAMS)
        assert "detections" not in fake.inserted

    def test_retries_without_pipeline_columns_on_schema_mismatch(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 2)
        calls = {"n": 0}

        def hook(table, rows):
            calls["n"] += 1
            if "tracked_vehicle_id" in rows[0]:
                raise RuntimeError("column tracked_vehicle_id does not exist")

        fake = run_main(cameras=CAMS, insert_hook=hook)
        assert calls["n"] == 2
        assert "tracked_vehicle_id" not in fake.inserted["detections"][-1][0]

    def test_invalid_start_time_falls_back_to_now(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 1)
        fake = run_main("--start_time", "yesterday", cameras=CAMS)
        ts = datetime.fromisoformat(fake.inserted["detections"][0][0]["detected_at"])
        assert abs((datetime.now(timezone.utc) - ts).total_seconds()) < 60

    def test_exits_when_dir_missing(self, insert_detections, monkeypatch, tmp_path):
        monkeypatch.setattr("sys.argv", ["x", "--detections_dir", str(tmp_path / "none")])
        with pytest.raises(SystemExit):
            insert_detections.main()

    @pytest.mark.xfail(strict=True, reason=(
        "BUG insert_detections.py:224-233 — `--start_time 2026-09-27T12:00:00` (no 'Z'/offset) "
        "yields a naive datetime and tz-less ISO strings; Postgres then interprets them in the "
        "server's timezone, silently shifting detected_at."))
    def test_naive_start_time_is_treated_as_utc(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 1)
        fake = run_main("--start_time", "2026-09-27T12:00:00", cameras=CAMS)
        assert datetime.fromisoformat(fake.inserted["detections"][0][0]["detected_at"]).tzinfo is not None

    @pytest.mark.xfail(strict=True, reason=(
        "BUG insert_detections.py:260 — event_id is uuid4() per run, so the 'independently "
        "re-runnable' ingestion duplicates every detection on each re-run (no upsert key)."))
    def test_reingestion_is_idempotent(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "IG-01", 2)
        a = run_main("--start_time", "2026-09-27T12:00:00Z", cameras=CAMS)
        b = run_main("--start_time", "2026-09-27T12:00:00Z", cameras=CAMS)
        ids = lambda f: sorted(r["event_id"] for c in f.inserted["detections"] for r in c)
        assert ids(a) == ids(b)

    @pytest.mark.xfail(strict=True, reason=(
        "BUG insert_detections.py:244 — for cameras missing from the DB the fallback id is "
        "f'cam-{code.lower()}' (e.g. 'cam-np-01') because camera_config.json has no camera_id; "
        "that id matches no cameras.id ('cam-006'), so every insert violates the FK."))
    def test_fallback_camera_id_matches_seeded_id_format(self, run_main, tmp_path):
        write_dets(tmp_path / "dets", "NP-01", 1)
        fake = run_main(cameras=[], config=json.loads((ROOT_DIR / "camera_config.json").read_text()))
        assert fake.inserted["detections"][0][0]["camera_id"] == "cam-006"


class TestSchemaContract:
    """Rows written by the pipeline must fit supabase/migrations."""

    @pytest.mark.xfail(strict=True, reason=(
        "BUG (schema drift) insert_detections.py:259-274 writes detected_at/latitude/longitude, "
        "which the migrations never create, and omits `timestamp` which is NOT NULL. Against a "
        "migration-built DB every chunk fails and is counted as skipped (the retry path only "
        "handles tracked_vehicle_id/frame_timestamp_sec errors)."))
    def test_inserted_detection_columns_exist(self, run_main, tmp_path, columns_of):
        write_dets(tmp_path / "dets", "IG-01", 1)
        fake = run_main(cameras=CAMS)
        row = fake.inserted["detections"][0][0]
        cols = columns_of("detections")
        assert set(row) - cols == set()
        assert "timestamp" in row

    def test_every_config_camera_is_seeded(self, columns_of, migrations_sql):
        cfg = json.loads((ROOT_DIR / "camera_config.json").read_text())
        missing = [c["camera_code"] for c in cfg if f"'{c['camera_code']}'" not in migrations_sql]
        if missing:
            pytest.xfail(
                "BUG supabase/migrations/20260925_init_schema.sql:101-107 seeds only 5 cameras; "
                f"pipeline cameras {missing} have no cameras row → FK failures on ingestion")
