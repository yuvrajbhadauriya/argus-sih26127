"""Metrics for the ANPR accuracy evaluation: normalisation, CER, matching, aggregation."""

import numpy as np
import pytest

from eval.images import heuristic_conditions, laplacian_variance
from eval.metrics import (
    cer,
    confusion_pairs,
    edit_distance,
    edit_ops,
    iou,
    lenient_plate,
    match_image,
    normalise_plate,
    percentile,
    summarise,
)


@pytest.mark.parametrize(
    "raw, strict",
    [("MH 02 AB 1234", "MH02AB1234"), ("mh-02-ab-1234", "MH02AB1234"), (" dl.3c.cd 1210 ", "DL3CCD1210"),
     ("IND MH01", "INDMH01"), ("", ""), (None, "")],
)
def test_normalise_plate(raw, strict):
    assert normalise_plate(raw) == strict


def test_lenient_folds_only_o0_and_i1():
    assert lenient_plate("MH O2 AB I234") == "MH02AB1234"
    assert lenient_plate("B8S5") == "B8S5"  # other confusables stay strict


def test_edit_distance_and_cer():
    assert edit_distance("MH02AB1234", "MH02AB1234") == 0
    assert edit_distance("MH02AB1234", "MH02A81234") == 1
    assert edit_distance("MH02AB1234", "MH02AB124") == 1
    assert edit_distance("", "ABC") == 3
    assert cer("ABCD", "ABXD") == 0.25
    assert cer("ABCD", "") == 1.0
    assert cer("", "") == 0.0


def test_edit_ops_alignment():
    ops = edit_ops("MH02AB1234", "MH02A81234X")
    kinds = [k for k, _, _ in ops]
    assert kinds.count("sub") == 1 and kinds.count("ins") == 1
    assert ("sub", "B", "8") in ops and ("ins", "", "X") in ops
    assert ("del", "4", "") in edit_ops("1234", "123")


def test_iou():
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert iou([0, 0, 10, 10], [20, 20, 5, 5]) == 0.0
    assert iou([0, 0, 10, 10], [5, 0, 10, 10]) == pytest.approx(50 / 150)


def test_match_crop_without_boxes_picks_best_read():
    res, false_reads = match_image([{"text": "MH02AB1234"}], [
        {"plate_text": "KA01ZZ0000", "confidence": 0.99},
        {"plate_text": "MH 02 AB 1234", "confidence": 0.5},
    ])
    assert res[0].exact and res[0].detected
    assert false_reads == 1


def test_match_uses_space_when_boxes_exist():
    gt = [{"text": "MH02AB1234", "bbox": [100, 100, 60, 20]}, {"text": "DL3CCD1210", "bbox": [500, 300, 60, 20]}]
    preds = [
        # vehicle box containing the first plate's centre, read wrong by one char
        {"plate_text": "MH02A81234", "bbox": [80, 50, 200, 120], "confidence": 0.9},
        # correct text for plate 1 but far away -> must NOT be paired with it
        {"plate_text": "MH02AB1234", "bbox": [900, 600, 50, 20], "confidence": 0.9},
    ]
    res, false_reads = match_image(gt, preds)
    assert res[0].detected and not res[0].exact and res[0].pred == "MH02A81234" and res[0].edits == 1
    assert not res[1].detected and res[1].edits == len("DL3CCD1210")
    assert false_reads == 1


def test_match_lenient_and_miss():
    res, _ = match_image([{"text": "MH01AB0001"}, {"text": ""}], [{"plate_text": "MHO1AB0001"}])
    assert len(res) == 1  # GT without text is ignored
    assert not res[0].exact and res[0].lenient_exact
    res, fr = match_image([{"text": "MH01AB0001"}], [])
    assert not res[0].detected and fr == 0


def test_summarise_block():
    plates = []
    for gt, preds in [("MH02AB1234", ["MH02AB1234"]), ("MH02AB1235", ["MH02A81235"]), ("KA01AA0001", [])]:
        r, _ = match_image([{"text": gt}], [{"plate_text": p} for p in preds])
        plates += r
    s = summarise(plates, false_reads=1, images=3, latencies=[100, 200, 300, 400])
    assert s["plates"] == 3 and s["detected"] == 2 and s["exact"] == 1
    assert s["plate_accuracy"] == pytest.approx(1 / 3, abs=1e-4)
    assert s["ocr_accuracy"] == 0.5
    assert s["detection_recall"] == pytest.approx(2 / 3, abs=1e-4)
    assert s["read_precision"] == pytest.approx(2 / 3, abs=1e-4)
    # 1 substitution + 10 chars missed over 30 chars
    assert s["char_accuracy"] == pytest.approx(1 - 11 / 30, abs=1e-4)
    assert s["latency_ms"]["p50"] == 250 and s["latency_ms"]["p95"] == pytest.approx(385)


def test_summarise_empty_is_null_not_zero():
    s = summarise([])
    assert s["plate_accuracy"] is None and s["char_accuracy"] is None and s["latency_ms"]["p50"] is None


def test_confusions_exclude_misses():
    plates = []
    for gt, pred in [("MH02AB1234", "MH02A81234"), ("MH02AB1234", "MH02A81234"), ("KA01", None)]:
        r, _ = match_image([{"text": gt}], [{"plate_text": pred}] if pred else [])
        plates += r
    assert confusion_pairs(plates) == [{"gt": "B", "pred": "8", "count": 2}]


def test_percentile():
    assert percentile([], 50) is None
    assert percentile([5], 95) == 5
    assert percentile([1, 2, 3, 4, 5], 50) == 3


def test_heuristics_night_blur_low_res():
    rng = np.random.default_rng(0)
    sharp_day = (rng.random((60, 200)) * 255).astype(np.uint8)
    flat_night = np.full((60, 200), 20, np.uint8)
    tags, m = heuristic_conditions(sharp_day)
    assert "day" in tags and "sharp" in tags and m["laplacian_var"] > 60
    tags, _ = heuristic_conditions(flat_night, [10, 10, 40, 12])
    assert set(tags) >= {"night", "blur", "low_res"}
    assert laplacian_variance(flat_night) == 0.0
    assert heuristic_conditions(None) == ([], {})


def test_match_falls_back_to_vehicle_box():
    gt = [{"text": "KL07BX7197", "bbox": [650, 841, 218, 120]}]
    pred = {"plate_text": "KL07BX7197", "bbox": [866, 627, 287, 96], "vehicle_bbox": [1, 17, 1400, 1400]}
    res, fr = match_image(gt, [pred])
    assert res[0].exact and fr == 0
    res, fr = match_image(gt, [{**pred, "vehicle_bbox": None}])
    assert not res[0].detected and fr == 1
