"""Tests for insert_detections.py — idempotent, timezone-aware, service-role-only ingestion."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from conftest import PIPELINE_DIR
from db.fake import FakeClient

IST = timezone(timedelta(hours=5, minutes=30))
CAMS = [{"id": "cam-001", "code": "JG-01", "lat": 19.1, "lng": 72.8, "name": "Jogeshwari"}]


def write_dets(dirpath, code, n, **over):
    recs = [
        {
            "camera_code": code,
            "tracked_vehicle_id": f"trk_{i:04d}",
            "plate_text": "MH 01 AB 1234",
            "plate_confidence": 0.8,
            "vehicle_type": "car",
            "confidence": 0.9,
            "frame_timestamp_sec": i * 0.2,
            "bbox": {"x": 1, "y": 2, "width": 3, "height": 4},
            "engine": "yolov7-tiny",
            "model_version": "anpr-2026.09",
            **over,
        }
        for i in range(n)
    ]
    (dirpath / f"detections_{code}.json").write_text(json.dumps(recs))
    return recs


@pytest.fixture
def dets_dir(tmp_path):
    d = tmp_path / "dets"
    d.mkdir()
    return d


@pytest.fixture
def run_main(insert_detections, monkeypatch, dets_dir, tmp_path):
    """Run insert_detections.main() against a FakeClient; returns (exit code, client)."""

    def _run(*extra, client=None, cameras=CAMS):
        client = client or FakeClient({"cameras": cameras})
        monkeypatch.setattr(insert_detections, "get_supabase_client", lambda: client)
        cfg = tmp_path / "cfg.json"
        cfg.write_text("[]")
        code = insert_detections.main([
            "--detections_dir", str(dets_dir), "--config", str(cfg),
            "--sim_summary", str(tmp_path / "no-sim.json"), "--retry_base_delay", "0", *extra,
        ])
        return code, client

    return _run


def rows_of(client):
    return [r for q in client.writes("detections") for r in q.payload]


# ── helpers ──────────────────────────────────────────────────────────────
class TestFetchCameraMapping:
    def test_keys_by_db_code_only_and_normalises_coords(self, insert_detections):
        fake = FakeClient({"cameras": [
            {"id": "a", "code": "CAM-D", "latitude": 1.0, "longitude": 2.0},
            {"id": "b", "code": "JG-01", "lat": 0.0, "lng": 0.0},
        ]})
        m = insert_detections.fetch_camera_mapping(fake)
        assert set(m) == {"CAM-D", "JG-01"}  # no alias table
        assert (m["CAM-D"]["lat"], m["CAM-D"]["lng"]) == (1.0, 2.0)
        assert (m["JG-01"]["lat"], m["JG-01"]["lng"]) == (0.0, 0.0)  # 0 preserved

    def test_raises_on_error_instead_of_returning_empty(self, insert_detections, monkeypatch):
        monkeypatch.setattr("time.sleep", lambda s: None)

        class Boom:
            def table(self, _):
                raise RuntimeError("down")

        with pytest.raises(RuntimeError):
            insert_detections.fetch_camera_mapping(Boom())


class TestLoadConfigFallback:
    def test_missing_file(self, insert_detections, tmp_path):
        assert insert_detections.load_config_fallback(str(tmp_path / "x.json")) == {}

    def test_keys_by_camera_code(self, insert_detections):
        m = insert_detections.load_config_fallback(str(PIPELINE_DIR / "camera_config.json"))
        assert m and all(v["video_filename"].endswith(".mp4") for v in m.values())


class TestGetSupabaseClient:
    def test_exits_2_without_url(self, insert_detections, monkeypatch):
        for k in ("SUPABASE_URL", "VITE_SUPABASE_URL"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
        with pytest.raises(SystemExit) as e:
            insert_detections.get_supabase_client()
        assert e.value.code == 2

    def test_exits_2_without_service_key_even_if_anon_key_present(self, insert_detections, monkeypatch):
        import supabase
        monkeypatch.setattr(supabase, "create_client", lambda *a: pytest.fail("must not connect"))
        monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
        monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "anon")
        with pytest.raises(SystemExit) as e:
            insert_detections.get_supabase_client()
        assert e.value.code == 2

    def test_placeholder_key_is_rejected(self, insert_detections, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "your-service-role-key")
        with pytest.raises(SystemExit):
            insert_detections.get_supabase_client()

    def test_uses_service_role_key(self, insert_detections, monkeypatch):
        import supabase
        seen = {}
        monkeypatch.setattr(supabase, "create_client", lambda url, key: seen.update(url=url, key=key) or "client")
        monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
        monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "anon")
        assert insert_detections.get_supabase_client() == "client"
        assert seen == {"url": "https://abc.supabase.co", "key": "service"}


class TestStartTime:
    def test_naive_start_time_is_read_in_asia_kolkata(self, insert_detections):
        dt = insert_detections.parse_start_time("2026-09-29T08:00:00")
        assert dt.utcoffset() == timedelta(hours=5, minutes=30)

    def test_explicit_offset_is_kept(self, insert_detections):
        dt = insert_detections.parse_start_time("2026-09-29T02:30:00Z")
        assert dt == datetime(2026, 9, 29, 8, 0, tzinfo=IST)

    def test_custom_tz(self, insert_detections):
        assert insert_detections.parse_start_time("2026-09-29T08:00:00", "UTC").utcoffset() == timedelta(0)

    def test_invalid_start_time_exits_2(self, insert_detections):
        with pytest.raises(SystemExit) as e:
            insert_detections.parse_start_time("yesterday")
        assert e.value.code == 2

    def test_derived_from_sim_summary(self, insert_detections, tmp_path):
        p = tmp_path / "summary.json"
        p.write_text(json.dumps({"date": "2026-09-29", "timezone": "+05:30"}))
        assert insert_detections.derive_start_time(str(p)) == datetime(2026, 9, 29, 8, 0, tzinfo=IST)

    def test_derived_none_without_summary(self, insert_detections, tmp_path):
        assert insert_detections.derive_start_time(str(tmp_path / "none.json")) is None


class TestEventId:
    def test_deterministic_and_sensitive_to_each_part(self, insert_detections):
        f = insert_detections.make_event_id
        base = f("JG-01", "clip.mp4", 1.2, "trk_0001")
        assert base == f("JG-01", "clip.mp4", 1.2000001, "trk_0001")
        assert len({base, f("AN-01", "clip.mp4", 1.2, "trk_0001"), f("JG-01", "other.mp4", 1.2, "trk_0001"),
                    f("JG-01", "clip.mp4", 1.4, "trk_0001"), f("JG-01", "clip.mp4", 1.2, "trk_0002")}) == 5
        assert len(base) <= 64


# ── main() ───────────────────────────────────────────────────────────────
class TestMainIngestion:
    def test_row_shape_timestamps_and_plate_normalisation(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 3)
        code, client = run_main("--start_time", "2026-09-29T08:00:00")
        assert code == 0
        rows = rows_of(client)
        assert len(rows) == 3
        r = rows[2]
        assert r["camera_id"] == "cam-001"
        assert r["plate_text_raw"] == "MH 01 AB 1234"
        assert r["plate_text_normalized"] == "MH01AB1234"
        assert (r["lat"], r["lng"]) == (19.1, 72.8)
        assert r["tracked_vehicle_id"] == "trk_0002"
        assert r["frame_timestamp_sec"] == pytest.approx(0.4)
        assert (r["engine"], r["model_version"], r["plate_confidence"]) == ("yolov7-tiny", "anpr-2026.09", 0.8)
        detected = datetime.fromisoformat(r["detected_at"])
        assert detected.utcoffset() == timedelta(hours=5, minutes=30)
        assert detected == datetime(2026, 9, 29, 8, 0, tzinfo=IST) + timedelta(seconds=0.4)
        assert r["timestamp"] == r["detected_at"]

    def test_upserts_on_event_id(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 2)
        _, client = run_main("--start_time", "2026-09-29T08:00:00")
        assert {q.kwargs.get("on_conflict") for q in client.writes("detections")} == {"event_id"}
        assert {q.op for q in client.writes("detections")} == {"upsert"}

    def test_reingestion_is_idempotent(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 4)
        client = FakeClient({"cameras": CAMS})
        run_main("--start_time", "2026-09-29T08:00:00", client=client)
        first = sorted(r["event_id"] for r in client.tables["detections"])
        run_main("--start_time", "2026-09-29T08:00:00", client=client)
        assert sorted(r["event_id"] for r in client.tables["detections"]) == first
        assert len(first) == 4

    def test_source_video_from_run_summary_is_part_of_event_id(self, run_main, dets_dir, insert_detections):
        write_dets(dets_dir, "JG-01", 1)
        (dets_dir / "summary.json").write_text(json.dumps([
            {"camera_code": "JG-01", "video_filename": "clip-a.mp4", "engine": "e", "model_version": "m"}]))
        _, client = run_main("--start_time", "2026-09-29T08:00:00")
        r = rows_of(client)[0]
        assert r["source_video"] == "clip-a.mp4"
        assert r["event_id"] == insert_detections.make_event_id("JG-01", "clip-a.mp4", 0.0, "trk_0000")

    def test_batches_by_batch_size(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 5)
        _, client = run_main("--start_time", "2026-09-29T08:00:00", "--batch_size", "2")
        assert [len(q.payload) for q in client.writes("detections")] == [2, 2, 1]

    def test_empty_file_is_skipped(self, run_main, dets_dir):
        (dets_dir / "detections_JG-01.json").write_text("[]")
        code, client = run_main("--start_time", "2026-09-29T08:00:00")
        assert code == 0 and client.writes("detections") == []

    def test_start_time_derived_when_omitted(self, run_main, dets_dir, tmp_path):
        write_dets(dets_dir, "JG-01", 1)
        sim = tmp_path / "sim.json"
        sim.write_text(json.dumps({"date": "2026-09-29", "timezone": "+05:30"}))
        code, client = run_main("--sim_summary", str(sim))
        assert code == 0
        assert datetime.fromisoformat(rows_of(client)[0]["detected_at"]) == datetime(2026, 9, 29, 8, 0, tzinfo=IST)

    def test_start_time_required_when_not_derivable(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 1)
        with pytest.raises(SystemExit) as e:
            run_main()
        assert e.value.code == 2

    def test_unknown_camera_code_aborts_before_writing(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 1)
        write_dets(dets_dir, "ZZ-99", 1)
        client = FakeClient({"cameras": CAMS})
        with pytest.raises(SystemExit) as e:
            run_main("--start_time", "2026-09-29T08:00:00", client=client)
        assert e.value.code == 2
        assert client.writes("detections") == []

    def test_transient_failure_is_retried_with_backoff(self, run_main, dets_dir, monkeypatch):
        write_dets(dets_dir, "JG-01", 2)
        sleeps = []
        monkeypatch.setattr("time.sleep", sleeps.append)
        attempts = {"n": 0}

        def flaky(q):
            attempts["n"] += 1
            return RuntimeError("502 Bad Gateway") if attempts["n"] <= 2 else None

        client = FakeClient({"cameras": CAMS}, fail=flaky)
        code, _ = run_main("--start_time", "2026-09-29T08:00:00", "--retry_base_delay", "0.5", client=client)
        assert code == 0
        assert attempts["n"] == 3
        assert sleeps == [0.5, 1.0]
        assert len(client.tables["detections"]) == 2

    def test_persistent_chunk_failure_exits_non_zero(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 4)
        client = FakeClient({"cameras": CAMS},
                            fail=lambda q: RuntimeError("boom") if q.payload[0]["tracked_vehicle_id"] == "trk_0000" else None)
        code, _ = run_main("--start_time", "2026-09-29T08:00:00", "--batch_size", "2", "--retries", "2", client=client)
        assert code == 3
        assert len(client.tables["detections"]) == 2  # the other chunk still landed

    def test_dry_run_needs_no_credentials(self, run_main, dets_dir, insert_detections, monkeypatch):
        write_dets(dets_dir, "JG-01", 2)
        monkeypatch.setattr(insert_detections, "get_supabase_client", lambda: pytest.fail("must not connect"))
        cfg = dets_dir / "cfg.json"
        cfg.write_text("[]")
        assert insert_detections.main(["--detections_dir", str(dets_dir), "--config", str(cfg),
                                       "--start_time", "2026-09-29T08:00:00", "--dry_run"]) == 0

    def test_missing_dir_exits_1(self, insert_detections, tmp_path):
        assert insert_detections.main(["--detections_dir", str(tmp_path / "none")]) == 1


class TestPrune:
    """--prune: the table mirrors each camera's file; nothing else is touched."""

    START = ("--start_time", "2026-09-29T08:00:00")

    @staticmethod
    def seeded_client(*extra_rows):
        return FakeClient({"cameras": CAMS, "detections": [
            {"event_id": "stale-jg", "camera_id": "cam-001"},   # a read the pipeline dropped
            {"event_id": "other-cam", "camera_id": "cam-002"},  # a camera without a file
            *extra_rows,
        ]})

    def test_deletes_only_this_cameras_rows_missing_from_its_file(self, run_main, dets_dir, insert_detections):
        write_dets(dets_dir, "JG-01", 2)
        client = self.seeded_client()
        code, _ = run_main(*self.START, "--prune", client=client)
        assert code == 0
        kept = sorted(r["event_id"] for r in client.tables["detections"])
        file_ids = [insert_detections.make_event_id("JG-01", "", t, f"trk_{i:04d}") for i, t in enumerate((0.0, 0.2))]
        assert kept == sorted(file_ids + ["other-cam"])
        assert [q.filters for q in client.deletes("detections")] == [[("in", "event_id", ["stale-jg"])]]

    def test_without_the_flag_nothing_is_deleted(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 1)
        client = self.seeded_client()
        run_main(*self.START, client=client)
        assert client.deletes("detections") == []
        assert "stale-jg" in {r["event_id"] for r in client.tables["detections"]}

    def test_a_camera_whose_upsert_failed_is_not_pruned(self, run_main, dets_dir):
        write_dets(dets_dir, "JG-01", 1)
        client = FakeClient({"cameras": CAMS, "detections": [{"event_id": "stale-jg", "camera_id": "cam-001"}]},
                            fail=lambda q: RuntimeError("boom") if q.op == "upsert" else None)
        code, _ = run_main(*self.START, "--prune", "--retries", "1", client=client)
        assert code == 3
        assert client.deletes("detections") == []

    def test_dry_run_prunes_nothing(self, run_main, dets_dir, insert_detections, monkeypatch):
        write_dets(dets_dir, "JG-01", 1)
        monkeypatch.setattr(insert_detections, "get_supabase_client", lambda: pytest.fail("must not connect"))
        cfg = dets_dir / "cfg.json"
        cfg.write_text("[]")
        assert insert_detections.main(["--detections_dir", str(dets_dir), "--config", str(cfg),
                                       *self.START, "--prune", "--dry_run"]) == 0

    def test_stale_ids_are_read_page_by_page(self, insert_detections):
        client = FakeClient({"detections": [{"event_id": f"e{i}", "camera_id": "cam-001"} for i in range(5)]
                             + [{"event_id": "x", "camera_id": "cam-002"}]})
        stale = insert_detections.stale_event_ids(client, "cam-001", {"e1", "e3"}, page_size=2)
        assert stale == ["e0", "e2", "e4"]
        assert len([q for q in client.calls if q.op == "select"]) == 3  # 2 + 2 + 1 rows


class TestSchemaContract:
    """Rows written by the pipeline must fit supabase/migrations."""

    def test_inserted_detection_columns_exist(self, run_main, dets_dir, columns_of):
        write_dets(dets_dir, "JG-01", 1)
        _, client = run_main("--start_time", "2026-09-29T08:00:00")
        row = rows_of(client)[0]
        assert set(row) - columns_of("detections") == set()

    def test_every_config_camera_is_seeded(self, columns_of, migrations_sql):
        cfg = json.loads((PIPELINE_DIR / "camera_config.json").read_text())
        missing = [c["camera_code"] for c in cfg if f"'{c['camera_code']}'" not in migrations_sql]
        assert not missing, f"pipeline cameras {missing} have no cameras row in supabase/migrations"
