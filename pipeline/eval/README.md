# ANPR accuracy evaluation

Measures the deployed ANPR model (live API: DEIM `deim50k` detector + PARSeq `raw35` OCR,
engine `lpu_on_gpu`) against the BEL PS SIH26127 requirement: **> 90% plate recognition
accuracy** in multi-lane traffic under varied lighting, weather, angles, blur and damaged plates.

```
labelled plate sets ──► evaluate.py ──POST /v1/frame──► live ANPR API
                              │
                              ├─► public/eval/results.json   (schema_version 1 → Model Performance page, /model)
                              ├─► public/eval/samples/*.jpg  (thumbnails, redistributable sets only)
                              └─► pipeline/eval/REPORT.md

Mumbai camera clips ──► video_consistency.py ──POST /v1/frame?tiles=2x3──► public/eval/video_consistency.json
```

| File | Purpose |
| --- | --- |
| `datasets.py` | Dataset registry, downloaders and loaders (`list` / `download` / `check` CLI) |
| `evaluate.py` | Labelled-set evaluation → `results.json` + `REPORT.md` |
| `video_consistency.py` | Label-free per-track read stability on the camera clips |
| `metrics.py` | Normalisation, edit distance / CER, matching, aggregation |
| `images.py` | Resize / pad / thumbnail, condition heuristics, synthetic plate renderer |
| `lpu_client.py` | Small stdlib client for the live API contract (`/health`, `/v1/frame`, `/v1/video`) |
| `mock_eval_server.py` | Offline noisy-oracle mock of the same contract (for `--mock` and tests) |

## 0. Setup

Python 3.10+ with `opencv-python` and `numpy` (already in `pipeline/requirements.txt`; Pillow
works as a fallback decoder). The API settings come from the environment or the repo-root `.env`
(never commit it, never print the key):

```
ANPR_API_BASE=http://100.64.0.1:8765        # Tailscale only; or DETECTION_API_URL=<base>/v1/frame
DETECTION_API_KEY=<key>
DETECTION_API_AUTH_HEADER=X-API-Key
```

Check the API is up: `curl http://100.64.0.1:8765/health` →
`{"ok": true, "engine": "lpu_on_gpu", "model_version": "deim50k+raw35", ...}`.

## 1. Download the datasets

Data goes to `pipeline/data/eval/<id>/` (gitignored — **never commit it**; several sets are
non-commercial / no-derivatives).

```bash
python pipeline/eval/datasets.py list
python pipeline/eval/datasets.py download datacluster hf-plate-crops
python pipeline/eval/datasets.py check
```

| id | Source | Licence | Status (checked 2026-09-30) |
| --- | --- | --- | --- |
| `datacluster` | [HF Dataclusterlabspvtltd/indian-number-plates-dataset](https://huggingface.co/datasets/Dataclusterlabspvtltd/indian-number-plates-dataset) — phone photos across India | CC BY-NC-ND 4.0 | Downloads without login. Pascal VOC; 47 images, of which **20 carry the `number_plate_text` attribute (25 plates)** — only those are scored. ~65 MB. `rotation ≥ 10°` → `angle` tag, `occluded/truncated` → `occluded`. |
| `hf-plate-crops` | [HF zenitsu09/indian-number-plate](https://huggingface.co/datasets/zenitsu09/indian-number-plate) — plate crops with `plate_text` | not stated (use for evaluation only) | Downloads without login via the HF datasets-server (no pyarrow needed). 1,709 Roboflow rows = ~3 augmented copies per source; de-duplicated to one per source by default (`--keep-augmented` to keep all) → 1,684 crops of 965 distinct plates (several sources are consecutive video frames of one vehicle). |
| `anpr-benchmark` | [HF thundarstrom/indian-anpr-ocr-benchmark](https://huggingface.co/datasets/thundarstrom/indian-anpr-ocr-benchmark) — 3,034 dashcam crops (blur, glare, rain) | CC BY 4.0 | **Card only — the repo has no data files yet** (HF reports 0 bytes). `download` says so. When the files appear (or the maintainer shares the archive — unpack into `pipeline/data/eval/anpr-benchmark/`), the loader auto-detects `labels.csv` / JSON / JSONL / parquet (needs `pyarrow`) / VOC and folder-name conditions. |
| `saisirishan` | [Kaggle saisirishan/indian-vehicle-dataset](https://www.kaggle.com/datasets/saisirishan/indian-vehicle-dataset) — VOC, plate text in `<name>` | CC BY-NC-ND 4.0 | **Kaggle login required** (the unauthenticated API returns 404). Either `pip install kaggle`, put a token in `~/.kaggle/kaggle.json`, then `datasets.py download saisirishan`; or download the zip (~187 MB) in the browser and unzip into `pipeline/data/eval/saisirishan/`. |
| `folder:<path>` | Your own frames (e.g. night / rain clips from the Mumbai cameras) | team-owned | See below. |
| `synthetic` | Rendered plates | generated | Plumbing test for `--mock` only — not a benchmark. |

### Your own labelled frames (`folder:<path>`)

The best evidence for the PS conditions is frames from our own clips. Put images anywhere under a
folder and add `labels.csv`:

```csv
filename,plate_text,conditions,x,y,w,h
night/cam_jg01_000123.jpg,MH 02 AB 1234,night;rain,812,540,96,28
cam_an01_000045.jpg,MH01CS0126|MH04EX9921,angle,,,,
```

- `plate_text`: one or more plates, `|`-separated. Spaces/hyphens do not matter.
- `conditions` (optional): `;`-separated — `day night rain fog blur angle occluded damaged dirty low_res`
  (aliases like `low light`, `motion blur`, `tilted` are understood). Folder names that are
  conditions (`night/`, `rain/`) are tags too.
- `x,y,w,h` (optional, pixels, top-left + size; `xmin,ymin,xmax,ymax` also accepted): the plate box.
  Without boxes, any read in the image may match the plate.

Run it with `--datasets folder:/path/to/frames`. Thumbnails of team-owned frames are published.

## 2. Evaluate against the live API

```bash
# labelled sets (≈1 s per image; keep it modest — the GPU is shared, max 2 in flight)
python pipeline/eval/evaluate.py --datasets datacluster hf-plate-crops --workers 2

# add your frames / cap the size of a quick run
python pipeline/eval/evaluate.py --datasets folder:pipeline/data/eval/mumbai-night --limit 50

# video read stability on the Mumbai clips (tiles=2x3, sequential)
python pipeline/eval/video_consistency.py --sample_interval 0.2 --max_frames 40
python pipeline/eval/video_consistency.py --events        # + one POST /v1/video per clip
```

Both commands regenerate the files the dashboard reads (`public/eval/…`); commit them to publish.
The page is **Intelligence → Model Performance** (`/model`).

Useful flags (`evaluate.py`): `--tiles 1x1` (plate-crop sets; default), `--scene_tiles 2x2`
(full-scene sets: small plates in phone photos are found far more often with 2x2 tiling),
`--crop_pad 1.5` (grey border around plate crops, as a fraction of the crop size per side: the
detector is trained on scenes and expects a plate to be a small part of the frame — with a 30% border
it found only ~10% of the crop plates, with 100–250% it finds ~98%; 1.5 was picked on the first 250
crops of `hf-plate-crops`, so treat that set as slightly tuned-on),
`--max_side 1920`, `--min_conf`, `--samples 12`, `--limit`, `--download`.
Exit codes: `0` ok · `1` nothing evaluated · `2` API not configured / unreachable / key rejected.

### Offline (no GPU)

```bash
python pipeline/eval/evaluate.py --mock                 # synthetic plates, in-process noisy-oracle mock
python pipeline/eval/video_consistency.py --mock --max_frames 40
```

Mock output is written with `"status": "sample"` and the page shows a *Sample data* banner with
**no pass/fail verdict**. The mock's numbers are meaningless — they only prove the flow works.
Tests: `npm run test:py` (pytest: `pipeline/tests/test_eval_*.py`) and `npm test`
(`src/features/model-performance/**`).

## 3. What the numbers mean

Plate text is normalised before comparison: upper-case, only `A-Z0-9` kept (spaces, hyphens, dots
dropped). The API's `"Not Found"` means a vehicle without a read and is not a read.

| Metric | Definition |
| --- | --- |
| **Plate accuracy** (headline, vs the 90% target) | exact normalised matches ÷ all labelled plates. **End-to-end**: a plate the detector misses counts as wrong. |
| Lenient accuracy | same, but `O≡0` and `I≡1`. Reporting only — never the headline. |
| OCR accuracy on found plates | exact matches ÷ plates the detector found. Separates OCR quality from detection misses. |
| Character accuracy | 1 − CER = 1 − (Levenshtein edits ÷ ground-truth characters); a missed plate counts as all characters wrong. |
| Plate detection recall / miss rate | labelled plates that got a spatially matching read ÷ all labelled plates / its complement. Reported separately from OCR accuracy. |
| Read precision | matched reads ÷ all reads (extra reads on unlabelled plates lower it — expected in scenes where not every plate is labelled). |
| Latency p50 / p95 | client round trip per image (upload + queue + inference); `inference_ms` from the API is shown separately. Over Tailscale this is dominated by upload time. |
| Character errors | most frequent substitutions / drops / insertions among found plates. |
| Per condition | the same metrics per tag. `label` = from the dataset; `heuristic` = estimated: mean luma < 70 → night, variance of the Laplacian < 60 → blur, plate height < 20 px → low_res. Heuristic tags are approximate and marked as such. |
| Video read stability | reads are associated across frames by plate-box centre (`--track_on plate`, default — vehicle boxes overlap too much in dense overhead jams; `--track_on vehicle` uses the production IoU tracker). Per track with ≥ 3 reads: share of its frames that agree with its majority plate. A **label-free proxy**: a reader that is consistently wrong also scores 1.0, and tracker ID switches lower it. Read next to the labelled accuracy, never instead of it. |

**Matching.** Per image, labelled plates and reads are paired one-to-one, greedily by edit
distance. A pair is allowed when either side has no box, the boxes overlap (IoU ≥ 0.1), or the
labelled plate's centre is inside the predicted plate box **or the predicted vehicle box** (the API
has been seen returning an offset plate box for a two-row plate while reading its text correctly).

**Model-team figures** (raw35 OCR 96.4% on bench951, 98.9% on golden v1, 92.5% on two-row plates,
17 ms/crop; deim50k + ocr_v9 81.8% end to end) are shown on the model card as *reported*, never as
this harness's measurement. `deim50k+raw35` end-to-end accuracy is what `evaluate.py` measures.

**Caveats.** The downloadable Indian sets are small (DataCluster: 25 labelled plates) and are
phone photos or crops, not overhead multi-lane CCTV. Treat per-condition rows with a handful of
plates as anecdotal, and add labelled frames from our own night/rain clips (`folder:`) before
quoting a number against the 90% target.
