# ANPR model accuracy report

Generated 2026-09-30T16:33:34Z by `pipeline/eval/evaluate.py`.

**Evaluated:** lpu_on_gpu · version deim50k+raw35 · API live · `POST /v1/frame` tiles=1x1 (crops) / 2x2 (scenes) crop_pad=1.5

**Deployed model:** DEIM (deim50k) — vehicle + plate detection; PARSeq (raw35) — plate text recognition. Model-team figures (not measured here): OCR accuracy, bench951 96.4%; OCR accuracy, golden v1 (1,419 plates) 98.9%; OCR accuracy, two-row plates 92.5%; End-to-end, deim50k + ocr_v9 (previous OCR) 81.8%; OCR latency per crop 17 ms.

**Target (BEL PS SIH26127):** plate recognition accuracy > 90% — **BELOW TARGET**

## Overall

| Metric | Value |
| --- | --- |
| Plate accuracy (exact, end-to-end) | 68.0% (1162/1709) |
| Lenient accuracy (O≡0, I≡1) | 68.5% |
| OCR accuracy on detected plates | 71.3% |
| Character accuracy (1 − CER) | 89.3% |
| Plate detection recall | 95.4% (1630/1709) |
| Plate detection miss rate | 4.6% |
| Read precision | 98.4% (27 false reads) |
| Latency p50 / p95 (round trip) | 278 ms / 547 ms |
| Model inference p50 | 50 ms |
| Images / API errors | 1704 / 0 |

## Per dataset

| Dataset | Licence | Images | Plates | Plate acc. | Char acc. | Recall | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [DataCluster Labs Indian number plates (sample)](https://huggingface.co/datasets/Dataclusterlabspvtltd/indian-number-plates-dataset) | CC BY-NC-ND 4.0 | 20 | 25 | 24.0% | 40.7% | 52.0% | 3188 ms |
| [Indian number plate crops (zenitsu09)](https://huggingface.co/datasets/zenitsu09/indian-number-plate) | not stated (evaluation only) | 1684 | 1684 | 68.7% | 90.0% | 96.0% | 521 ms |

## Per condition

Source `label` = tagged by the dataset; `heuristic` = estimated from the image (mean luma < 70 → night, Laplacian variance < 60 → blur, plate height < 20 px → low_res). Heuristic tags are approximate.

| Condition | Source | Plates | Plate acc. | Char acc. | Recall |
| --- | --- | ---: | ---: | ---: | ---: |
| day | heuristic | 1661 | 68.8% | 89.6% | 95.5% |
| night | heuristic | 48 | 41.7% | 78.1% | 89.6% |
| blur | heuristic | 47 | 38.3% | 69.8% | 74.5% |
| sharp | heuristic | 1662 | 68.8% | 89.8% | 96.0% |
| low_res | heuristic | 371 | 73.0% | 94.8% | 98.9% |

## Most common character errors

| Ground truth | Read as | Count |
| --- | --- | ---: |
| M | 1 | 74 |
| (extra) | 1 | 59 |
| M | H | 39 |
| (extra) | 0 | 24 |
| H | 1 | 23 |
| M | (dropped) | 21 |
| M | W | 20 |
| 0 | Q | 20 |
| T | (dropped) | 14 |
| 1 | L | 12 |
| B | 8 | 12 |
| 0 | D | 12 |
| (extra) | B | 11 |
| M | A | 11 |
| 6 | 8 | 11 |

## Datasets not evaluated

- `anpr-benchmark` — anpr-benchmark: /Users/yuvrajbhadauriya/Argus/pipeline/data/eval/anpr-benchmark does not exist — run `python pipeline/eval/datasets.py download anpr-benchmark`
- `saisirishan` — saisirishan: /Users/yuvrajbhadauriya/Argus/pipeline/data/eval/saisirishan missing — see `python pipeline/eval/datasets.py download saisirishan`

Matching: one-to-one greedy by edit distance among spatially compatible pairs (no box on either side, IoU >= 0.1 with the predicted plate box, or GT plate centre inside the predicted plate or vehicle box); unmatched GT = miss, unmatched read = false read
