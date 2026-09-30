"""Shape tests for pipeline/detect/adapter.py (mirror of modelAdapter.test.ts)."""

import base64
import json
from pathlib import Path

import pytest
from detect import adapter as A

IMG = (640, 360)
# REAL responses of the team's LPU model API, shared with the TS twin's tests.
FIXTURES = Path(__file__).resolve().parents[2] / "src" / "features" / "detections" / "remote" / "fixtures"
LPU_FRAME = json.loads((FIXTURES / "lpu_frame_vp01.json").read_text())
LPU_VIDEO = json.loads((FIXTURES / "lpu_video_jg01.json").read_text())


class TestConfig:
    def test_missing_values(self):
        assert A.read_model_api_config({}) is None
        assert A.read_model_api_config({"DETECTION_API_URL": "http://gpu/detect"}) is None
        assert A.read_model_api_config({"DETECTION_API_KEY": "k"}) is None
        assert A.read_model_api_config({"DETECTION_API_URL": "gpu/detect", "DETECTION_API_KEY": "k"}) is None

    def test_defaults_and_overrides(self):
        cfg = A.read_model_api_config({"DETECTION_API_URL": "http://gpu:8765/v1/frame", "DETECTION_API_KEY": " k "})
        assert (cfg.api_key, cfg.auth_header, cfg.timeout_ms, cfg.request_format, cfg.image_field, cfg.query) == (
            "k", "X-API-Key", 15000, "raw", "image", "tiles=2x3&roi_top=0.33&min_conf=60")
        assert A.frame_request_url(cfg) == "http://gpu:8765/v1/frame?tiles=2x3&roi_top=0.33&min_conf=60"
        assert A.default_video_url(cfg) == "http://gpu:8765/v1/video"
        base = A.read_model_api_config({"ANPR_API_BASE": "http://gpu:8765/", "DETECTION_API_KEY": "k"})
        assert base.url == "http://gpu:8765/v1/frame"
        cfg2 = A.read_model_api_config({
            "DETECTION_API_URL": "https://gpu/detect", "DETECTION_API_KEY": "k",
            "DETECTION_API_AUTH_HEADER": "x-api-key", "DETECTION_API_TIMEOUT_MS": "2500",
            "DETECTION_API_REQUEST_FORMAT": "JSON",
        })
        assert (cfg2.auth_header, cfg2.timeout_ms, cfg2.request_format) == ("x-api-key", 2500, "json")

    def test_repr_hides_key(self):
        cfg = A.read_model_api_config({"DETECTION_API_URL": "http://gpu/detect", "DETECTION_API_KEY": "sekret"})
        assert "sekret" not in repr(cfg) and "gpu" not in repr(cfg)

    def test_health_url(self):
        cfg = A.read_model_api_config({"DETECTION_API_URL": "http://gpu:8000/v1/detect", "DETECTION_API_KEY": "k"})
        assert A.default_health_url(cfg) == "http://gpu:8000/health"


class TestRequest:
    cfg = A.ModelApiConfig(url="http://gpu/detect", api_key="sekret", auth_header="Authorization", request_format="multipart")

    def test_auth_headers(self):
        assert A.build_auth_headers(self.cfg) == {"Authorization": "Bearer sekret"}
        assert A.build_auth_headers(A.ModelApiConfig(url="u", api_key="s")) == {"X-API-Key": "s"}

    def test_real_api_raw_body(self):
        h, b = A.build_upstream_request(A.ModelApiConfig(url="u", api_key="s"), b"\xff\xd8\xff", "image/jpeg", "VP-01")
        assert h["Content-Type"] == "image/jpeg" and h["X-API-Key"] == "s" and b == b"\xff\xd8\xff"

    def test_with_query(self):
        assert A.with_query("http://g/v1/frame?tiles=1x1", "tiles=2x3&min_conf=75") == "http://g/v1/frame?tiles=1x1&min_conf=75"
        assert A.with_query("http://g/v1/frame", "") == "http://g/v1/frame"

    def test_multipart(self):
        headers, body = A.build_upstream_request(self.cfg, b"\xff\xd8\xffJPEG", "image/jpeg", "IG-01", 1.5)
        assert headers["Content-Type"].startswith("multipart/form-data; boundary=")
        assert b'name="image"; filename="frame.jpg"' in body and b"\xff\xd8\xffJPEG" in body
        assert b'name="camera_code"\r\n\r\nIG-01' in body and b"1.5" in body

    def test_json_and_raw(self):
        from dataclasses import replace

        h, b = A.build_upstream_request(replace(self.cfg, request_format="json"), b"abc", camera_code="X")
        assert json.loads(b) == {"image": base64.b64encode(b"abc").decode(), "camera_code": "X"}
        h, b = A.build_upstream_request(replace(self.cfg, request_format="raw"), b"abc", "image/png")
        assert h["Content-Type"] == "image/png" and b == b"abc"


class TestLpuContract:
    tiles = A.parse_tiles(A.DEFAULT_FRAME_QUERY)

    def test_parse_tiles(self):
        assert self.tiles == (2, 3, 0.33)
        assert A.parse_tiles("") == (1, 1, 0.0)
        assert A.parse_tiles("tiles=3x4&roi_top=0.5") == (3, 4, 0.5)

    def test_real_frame_response(self):
        assert A.is_lpu_response(LPU_FRAME)
        out = A.normalise_upstream_response(LPU_FRAME, None, self.tiles)
        assert (out["engine"], out["model_version"], out["inference_ms"]) == ("lpu_on_gpu", "deim50k+raw35", 330.2)
        assert out["image"] == {"width": 1920, "height": 1080}
        car = next(d for d in out["detections"] if d["plate_text"] == "MH02EZ1785")
        assert car == {
            "plate_text": "MH02EZ1785", "plate_confidence": 0.934, "vehicle_type": "car", "confidence": 0.5731,
            "bbox": {"x": 778, "y": 809, "width": 186, "height": 189},
            "vehicle_class": "Car", "grammar_valid": True, "raw_ocr": "MH02EZ1785",
            "plate_bbox": {"x": 830, "y": 935, "width": 46, "height": 12}, "bbox_source": "vehicle",
        }
        bus = next(d for d in out["detections"] if d["plate_text"] == "MH02FX5860")
        assert bus["bbox_source"] == "plate" and bus["bbox"] == {"x": 155, "y": 914, "width": 42, "height": 11}
        plateless = [d for d in out["detections"] if d["plate_text"] is None]
        assert len(plateless) == 1 and plateless[0]["bbox"] == {"x": 114, "y": 830, "width": 147, "height": 137}
        assert len(out["detections"]) == 4

    def test_real_video_events(self):
        out = A.normalise_upstream_response(LPU_VIDEO, (1920, 1080), self.tiles)
        assert out["detections"] and all(0 < d["plate_confidence"] <= 1 for d in out["detections"])

    def test_good_read_rule(self):
        det = {"plate_text": "MH02EZ1785", "plate_confidence": 0.75, "grammar_valid": True}
        assert A.is_good_read(det)
        assert not A.is_good_read(dict(det, plate_confidence=0.749))
        assert not A.is_good_read(dict(det, grammar_valid=False))
        assert not A.is_good_read(dict(det, plate_text=None))

    def test_tile_artifacts_and_classes(self):
        assert A.is_tile_artifact({"x": 0, "y": 313, "width": 715, "height": 447}, (1920, 1080), self.tiles)
        assert not A.is_tile_artifact({"x": 778, "y": 809, "width": 186, "height": 189}, (1920, 1080), self.tiles)
        assert [A.vehicle_type_from_class(c) for c in ("Car", "Bike", "Bus", "Truck", "LCV", "Auto", "Tractor", "Mini-LCV", "Unknown", None)] == [
            "car", "motorcycle", "bus", "truck", "truck", "car", "truck", "truck", "unknown", "unknown"]


class TestShapes:
    @pytest.mark.parametrize("raw", [
        {"detections": [{"a": 1}]}, {"predictions": [{"a": 1}]}, {"results": [{"a": 1}]},
        {"data": {"objects": [{"a": 1}]}}, [{"a": 1}], [[{"a": 1}]], [{"detections": [{"a": 1}]}],
    ])
    def test_find_array(self, raw):
        assert A.find_detection_array(raw) == [{"a": 1}]

    def test_find_array_none(self):
        assert A.find_detection_array({"status": "ok"}) is None

    @pytest.mark.parametrize("item,expected", [
        ({"xyxy": [10, 20, 110, 70]}, (10, 20, 100, 50)),
        ({"xywh": [60, 45, 100, 50]}, (10, 20, 100, 50)),
        ({"xyxyn": [0.5, 0.5, 1, 1]}, (320, 180, 320, 180)),
        ({"bbox": [300, 200, 50, 40]}, (300, 200, 50, 40)),
        ({"bbox": {"x1": 1, "y1": 2, "x2": 11, "y2": 12}}, (1, 2, 10, 10)),
        ({"box": {"xmin": 1, "ymin": 2, "xmax": 11, "ymax": 12}}, (1, 2, 10, 10)),
        ({"bbox": {"x": 5, "y": 6, "width": 7, "height": 8}}, (5, 6, 7, 8)),
        ({"xmin": 1, "ymin": 2, "xmax": 11, "ymax": 12}, (1, 2, 10, 10)),
    ])
    def test_boxes(self, item, expected):
        b = A.read_box(item, IMG)
        assert (b["x"], b["y"], b["width"], b["height"]) == expected

    def test_bad_boxes(self):
        assert A.read_box({}, IMG) is None
        assert A.read_box({"xyxy": [10, 10, 5, 5]}, IMG) is None

    def test_plates_and_classes(self):
        assert A.read_plate({"plate": "dl 01-ab 1234", "plate_confidence": 0.97}) == ("DL 01 AB 1234", 0.97)
        assert A.read_plate({"ocr": {"text": "MH12DE1433", "conf": 0.99}}) == ("MH12DE1433", 0.99)
        assert A.read_plate({"text": "KA 05 MN 7777", "text_score": 91}) == ("KA 05 MN 7777", 0.91)
        assert A.read_plate({"label": "car"}) == (None, None)
        assert A.read_vehicle_type({"class": "Car"}) == "car"
        assert A.read_vehicle_type({"label": "lorry"}) == "truck"
        assert A.read_vehicle_type({"name": "two-wheeler"}) == "motorcycle"
        assert A.read_vehicle_type({"class": 5}) == "bus"
        assert A.read_vehicle_type({"class": "number_plate"}) == "unknown"

    def test_normalise_full_response(self):
        out = A.normalise_upstream_response({
            "model": "yolov7-tiny-anpr", "version": "1.2.0", "inference_ms": 12.34,
            "predictions": [
                {"class": "car", "confidence": 0.93, "bbox": [10, 20, 110, 70], "plate": {"text": "DL 3C AB 1234", "confidence": 0.985}},
                {"class": "number_plate", "score": 0.9, "xywhn": [0.5, 0.5, 0.1, 0.05], "ocr": "UP16BT5678"},
                {"class": "car", "confidence": 0.5},
            ],
        }, IMG)
        assert out["engine"] == "unknown" and out["model_version"] == "1.2.0" and out["inference_ms"] == 12.3
        assert out["detections"][0] == {
            "plate_text": "DL 3C AB 1234", "plate_confidence": 0.985, "vehicle_type": "car", "confidence": 0.93,
            "bbox": {"x": 10, "y": 20, "width": 100, "height": 50},
        }
        assert out["detections"][1]["bbox"] == {"x": 288, "y": 171, "width": 64, "height": 18}
        assert len(out["detections"]) == 2

    def test_raw_rows(self):
        out = A.normalise_upstream_response({"detections": [[0, 0, 10, 10, 0.8, 7]], "speed": {"inference": 4.2}}, IMG)
        assert out["detections"][0]["vehicle_type"] == "truck" and out["inference_ms"] == 4.2

    def test_no_list(self):
        with pytest.raises(A.UpstreamShapeError):
            A.normalise_upstream_response({"message": "ok"}, IMG)
