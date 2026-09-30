"""Shape tests for pipeline/detect/adapter.py (mirror of modelAdapter.test.ts)."""

import base64
import json

import pytest
from detect import adapter as A

IMG = (640, 360)


class TestConfig:
    def test_missing_values(self):
        assert A.read_model_api_config({}) is None
        assert A.read_model_api_config({"DETECTION_API_URL": "http://gpu/detect"}) is None
        assert A.read_model_api_config({"DETECTION_API_KEY": "k"}) is None
        assert A.read_model_api_config({"DETECTION_API_URL": "gpu/detect", "DETECTION_API_KEY": "k"}) is None

    def test_defaults_and_overrides(self):
        cfg = A.read_model_api_config({"DETECTION_API_URL": "http://gpu:8000/detect", "DETECTION_API_KEY": " k "})
        assert (cfg.api_key, cfg.auth_header, cfg.timeout_ms, cfg.request_format, cfg.image_field) == (
            "k", "Authorization", 15000, "multipart", "image")
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
    cfg = A.ModelApiConfig(url="http://gpu/detect", api_key="sekret")

    def test_auth_headers(self):
        assert A.build_auth_headers(self.cfg) == {"Authorization": "Bearer sekret"}
        assert A.build_auth_headers(A.ModelApiConfig(url="u", api_key="s", auth_header="x-api-key")) == {"x-api-key": "s"}

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
        assert out["engine"] == "yolov7-tiny-anpr" and out["model_version"] == "1.2.0" and out["inference_ms"] == 12.3
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
