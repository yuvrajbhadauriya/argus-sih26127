"""Tests for pipeline/tools/upload_golden.py (web JSON packing; no network)."""

import importlib.util
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
spec = importlib.util.spec_from_file_location("upload_golden", TOOLS / "upload_golden.py")
ug = importlib.util.module_from_spec(spec)
sys.modules["upload_golden"] = ug
spec.loader.exec_module(ug)


def _results():
    item = {
        "key": "k1", "gt": "MH01AB1234", "pred": "MH01AB1234", "raw": "MH01AB1234", "confidence": 97.5,
        "grammar_valid": True, "correct": True, "row_count": 1, "side": "rear", "state_code": "MH",
        "conditions": ["clear", "day", "hsrp-standard"], "adjudicated": False, "labelers": 2,
        "width": 200, "height": 48, "inference_ms": 24.1, "roundtrip_ms": 26.0,
    }
    return {
        "schema": 1, "set": "ocr_golden_v1", "set_hash": "abc", "model_version": "internal-name",
        "engine": "internal-engine", "overall": {"n": 1, "correct": 1, "accuracy": 1.0}, "items": [item],
    }


def test_web_results_packs_items_and_drops_internals():
    web = ug.web_results(_results())
    assert "model_version" not in web and "engine" not in web
    assert web["bucket"] == "golden" and web["prefix"] == "ocr_golden_v1/"
    assert "image_base" not in web and "http" not in json.dumps(web)
    assert web["item_fields"] == ug.ITEM_FIELDS
    row = dict(zip(web["item_fields"], web["items"][0]))
    assert row["correct"] == 1 and row["grammar_valid"] == 1
    assert row["conditions"] == ["day", "hsrp-standard"]
    assert "raw" not in row
    assert "internal" not in json.dumps(web)


def test_object_prefix():
    assert ug.object_prefix({"set": "s1"}) == "s1"
    assert ug.object_prefix({}) == "ocr_golden_v1"


def test_dry_run_without_credentials_writes_web_json(tmp_path, monkeypatch):
    for name in ("SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(name, raising=False)
    results = tmp_path / "r.json"
    results.write_text(json.dumps(_results()))
    crops = tmp_path / "crops"
    crops.mkdir()
    (crops / "k1.jpg").write_bytes(b"\xff\xd8\xff")
    env = tmp_path / ".env"
    env.write_text("SUPABASE_URL=https://p.supabase.co\n")
    out = tmp_path / "web" / "g.json"
    rc = ug.main(["--results", str(results), "--crops", str(crops), "--out", str(out), "--env-file", str(env)])
    assert rc == 0
    web = json.loads(out.read_text())
    assert web["prefix"] == "ocr_golden_v1/"
    assert len(web["items"]) == 1
