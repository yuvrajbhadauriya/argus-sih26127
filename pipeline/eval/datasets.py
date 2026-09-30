#!/usr/bin/env python3
"""
Labelled Indian number-plate evaluation sets.

Data is downloaded on demand into ``pipeline/data/eval/<dataset>/`` (gitignored
— never commit it; several sets are non-commercial / no-derivatives).

    python pipeline/eval/datasets.py list
    python pipeline/eval/datasets.py download datacluster hf-plate-crops
    python pipeline/eval/datasets.py check            # what is on disk + sample counts

Every loader returns ``Sample`` objects:
    id, dataset, path (local image), plates=[{"text", "bbox": [x,y,w,h] | None}],
    tags={condition: "label" | "heuristic"}, meta={...}

Registry (status verified 2026-09-30 against the live hosts):

  id                 source                                          status
  ─────────────────  ──────────────────────────────────────────────  ─────────────────────────────
  anpr-benchmark     HF thundarstrom/indian-anpr-ocr-benchmark       card only — NO data files are
                     (CC BY 4.0, 3,034 dashcam crops per the card)    published yet; loader auto-
                                                                      detects the format once they are
  datacluster        HF Dataclusterlabspvtltd/indian-number-plates-   downloadable, no login. 47 VOC
                     dataset (CC BY-NC-ND 4.0)                        images; 20 carry the
                                                                      `number_plate_text` attribute
                                                                      (25 plates) -> those are used
  hf-plate-crops     HF zenitsu09/indian-number-plate (no licence     downloadable, no login. 1,709
                     stated — evaluation use only)                    Roboflow crops with plate_text;
                                                                      augmented copies de-duplicated
  saisirishan        Kaggle saisirishan/indian-vehicle-dataset        Kaggle login required (API
                     (CC BY-NC-ND 4.0, VOC, plate text in <name>)     token) — see download()
  folder:<path>      your own frames + labels.csv                     local
  synthetic          rendered plates (mock / plumbing tests only)     generated
"""

from __future__ import annotations

import csv
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
if _PIPELINE not in sys.path:
    sys.path.insert(0, _PIPELINE)

from eval.images import synthetic_plate_png  # noqa: E402
from eval.metrics import normalise_plate  # noqa: E402

DATA_ROOT = os.environ.get("ARGUS_EVAL_DATA") or os.path.join(_PIPELINE, "data", "eval")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp", ".jfif")
UA = "argus-eval/1.0 (+SIH26127 prototype)"

# Condition vocabulary shown in the UI (anything else is passed through).
CONDITIONS = ["day", "night", "rain", "fog", "blur", "sharp", "angle", "occluded", "damaged", "dirty", "low_res"]
_CONDITION_ALIASES = {
    "low_light": "night", "lowlight": "night", "dark": "night", "dusk": "night", "evening": "night",
    "daylight": "day", "sunny": "day", "sunlight": "day", "glare": "day",
    "rainy": "rain", "wet": "rain", "weather": "rain", "foggy": "fog", "haze": "fog", "mist": "fog",
    "motion_blur": "blur", "blurry": "blur", "blurred": "blur",
    "angled": "angle", "tilted": "angle", "skew": "angle", "skewed": "angle", "oblique": "angle",
    "broken": "damaged", "bent": "damaged", "faded": "damaged", "dirty_plate": "dirty", "muddy": "dirty",
    "occlusion": "occluded", "partial": "occluded", "lowres": "low_res", "low_resolution": "low_res", "small": "low_res",
}


class DatasetUnavailable(RuntimeError):
    """The dataset cannot be fetched automatically (message says what to do)."""


@dataclass
class Sample:
    id: str
    dataset: str
    path: str
    plates: list[dict]
    tags: dict[str, str] = field(default_factory=dict)
    meta: dict = field(default_factory=dict)


@dataclass
class DatasetSpec:
    id: str
    name: str
    source_url: str
    license: str
    kind: str                     # "scene" (full frames, plate boxes) | "crop" (plate crops)
    redistributable: bool         # may tiny thumbnails be committed to public/eval/samples?
    notes: str
    download: Callable[[str], None]
    load: Callable[[str], list[Sample]]

    def dir(self, root: str = DATA_ROOT) -> str:
        return os.path.join(root, self.id)

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "source_url": self.source_url, "license": self.license,
                "kind": self.kind, "notes": self.notes}


def normalise_condition(tag: str) -> str:
    t = re.sub(r"[\s-]+", "_", str(tag).strip().lower())
    return _CONDITION_ALIASES.get(t, t)


# ──────────────────────────────────────────────────────────────────────
# HTTP (stdlib; HF_TOKEN used for huggingface.co if set)
# ──────────────────────────────────────────────────────────────────────
def http_get(url: str, dest: str | None = None, retries: int = 3, timeout: float = 60.0) -> bytes | None:
    headers = {"User-Agent": UA}
    host = urllib.parse.urlparse(url).hostname or ""
    if host.endswith("huggingface.co") and os.environ.get("HF_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['HF_TOKEN']}"
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
                if dest is None:
                    return resp.read()
                os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
                tmp = dest + ".part"
                with open(tmp, "wb") as f:
                    shutil.copyfileobj(resp, f, 1 << 20)
                os.replace(tmp, dest)
                return None
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404):
                raise DatasetUnavailable(f"HTTP {e.code} for {url}") from None
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
        if attempt < retries:
            time.sleep(1.5 * (2**attempt))
    raise DatasetUnavailable(f"download failed for {url}: {type(last).__name__}")


def hf_tree(repo: str) -> list[dict]:
    raw = http_get(f"https://huggingface.co/api/datasets/{repo}/tree/main?recursive=true")
    return [x for x in json.loads(raw or b"[]") if x.get("type") == "file"]


def hf_file_url(repo: str, path: str) -> str:
    return f"https://huggingface.co/datasets/{repo}/resolve/main/{urllib.parse.quote(path)}"


# ──────────────────────────────────────────────────────────────────────
# Generic labelled folder (labels.csv / .json / .jsonl / parquet / VOC)
# ──────────────────────────────────────────────────────────────────────
_FILE_COLS = ("filename", "file", "image", "image_path", "path", "img", "file_name", "image_name")
_TEXT_COLS = ("plate_text", "plate", "text", "label", "gt", "ground_truth", "number_plate", "plate_number", "registration")
_COND_COLS = ("conditions", "condition", "tags", "tag", "weather", "lighting", "category", "subset")


def _split_multi(value: str) -> list[str]:
    return [v.strip() for v in re.split(r"[|;,]", value or "") if v.strip()]


def _row_box(row: dict) -> list[float] | None:
    keys = [("x", "y", "w", "h"), ("x", "y", "width", "height"), ("xmin", "ymin", "xmax", "ymax"), ("x1", "y1", "x2", "y2")]
    for k in keys:
        try:
            vals = [float(row[c]) for c in k]
        except (KeyError, TypeError, ValueError):
            continue
        if k[2] in ("xmax", "x2"):
            vals = [vals[0], vals[1], vals[2] - vals[0], vals[3] - vals[1]]
        if vals[2] > 0 and vals[3] > 0:
            return vals
    return None


def _pick_col(cols: Iterable[str], wanted: tuple[str, ...]) -> str | None:
    lower = {c.lower().strip(): c for c in cols if c}
    return next((lower[w] for w in wanted if w in lower), None)


def _index_images(root: str) -> dict[str, str]:
    """basename and stem -> path, for resolving label rows to files."""
    idx: dict[str, str] = {}
    for dp, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith(IMAGE_EXTS):
                p = os.path.join(dp, f)
                idx.setdefault(f, p)
                idx.setdefault(os.path.splitext(f)[0], p)
                idx.setdefault(os.path.relpath(p, root).replace(os.sep, "/"), p)
    return idx


def _path_conditions(path: str, root: str) -> dict[str, str]:
    """Folder names like night/, rain/, blur/ become label tags."""
    parts = os.path.relpath(os.path.dirname(path), root).replace(os.sep, "/").split("/")
    tags = {}
    for p in parts:
        c = normalise_condition(p)
        if c in CONDITIONS:
            tags[c] = "label"
    return tags


def load_labelled_rows(rows: Iterable[dict], root: str, dataset: str) -> list[Sample]:
    """Rows from a CSV/JSON label file -> Samples (multiple rows per image are merged)."""
    rows = list(rows)
    if not rows:
        return []
    cols = list(rows[0].keys())
    fcol, tcol, ccol = _pick_col(cols, _FILE_COLS), _pick_col(cols, _TEXT_COLS), _pick_col(cols, _COND_COLS)
    if not fcol or not tcol:
        raise DatasetUnavailable(f"{dataset}: label file needs a filename column {_FILE_COLS} and a text column {_TEXT_COLS}; got {cols}")
    idx = _index_images(root)
    by_file: dict[str, Sample] = {}
    for row in rows:
        ref = str(row.get(fcol) or "").strip().replace("\\", "/")
        path = idx.get(ref) or idx.get(os.path.basename(ref)) or idx.get(os.path.splitext(os.path.basename(ref))[0])
        if not path:
            continue
        s = by_file.get(path)
        if s is None:
            sid = os.path.splitext(os.path.relpath(path, root))[0].replace(os.sep, "/")
            s = by_file[path] = Sample(id=sid, dataset=dataset, path=path, plates=[], tags=_path_conditions(path, root))
        box = _row_box(row)
        for text in str(row.get(tcol) or "").split("|"):
            if normalise_plate(text):
                s.plates.append({"text": text.strip(), "bbox": box})
        if ccol and row.get(ccol):
            for c in _split_multi(str(row[ccol])):
                s.tags[normalise_condition(c)] = "label"
    return [s for s in by_file.values() if s.plates]


def load_labelled_dir(root: str, dataset: str) -> list[Sample]:
    """Auto-detects the label format in ``root``: labels.csv/any *.csv, *.json(l), *.parquet, *.txt (tab/space)."""
    if not os.path.isdir(root):
        raise DatasetUnavailable(f"{dataset}: {root} does not exist — run `python pipeline/eval/datasets.py download {dataset}`")
    candidates = []
    for dp, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith((".csv", ".json", ".jsonl", ".parquet", ".tsv")) and not f.startswith("."):
                candidates.append(os.path.join(dp, f))
    candidates.sort(key=lambda p: (0 if os.path.basename(p).lower().startswith(("labels", "gt", "annotations", "test")) else 1, p))
    for lf in candidates:
        rows = _read_rows(lf, root)
        if rows:
            try:
                samples = load_labelled_rows(rows, os.path.dirname(lf) if _index_images(os.path.dirname(lf)) else root, dataset)
            except DatasetUnavailable:
                continue
            if samples:
                return samples
    voc = load_voc_dir(root, dataset, text_from="auto")
    if voc:
        return voc
    raise DatasetUnavailable(f"{dataset}: no recognisable labels in {root} (expected labels.csv with filename,plate_text[,conditions][,x,y,w,h])")


def _read_rows(path: str, root: str) -> list[dict]:
    low = path.lower()
    try:
        if low.endswith((".csv", ".tsv")):
            with open(path, newline="", encoding="utf-8-sig") as f:
                sample = f.read(4096)
                f.seek(0)
                delim = "\t" if low.endswith(".tsv") or sample.count("\t") > sample.count(",") else ","
                return list(csv.DictReader(f, delimiter=delim))
        if low.endswith(".jsonl"):
            with open(path, encoding="utf-8") as f:
                return [json.loads(line) for line in f if line.strip()]
        if low.endswith(".json"):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data = next((v for v in data.values() if isinstance(v, list)), [])
            return [r for r in data if isinstance(r, dict)]
        if low.endswith(".parquet"):
            return _parquet_rows(path, root)
    except (OSError, ValueError, UnicodeDecodeError):
        return []
    return []


def _parquet_rows(path: str, root: str) -> list[dict]:
    """HF-style parquet (image struct with bytes + text column). Needs pyarrow."""
    try:
        import pyarrow.parquet as pq  # noqa: PLC0415
    except ImportError:
        print(f"[!] {os.path.basename(path)}: install pyarrow to read parquet labels", file=sys.stderr)
        return []
    table = pq.read_table(path)
    out_dir = os.path.join(root, "_parquet_images")
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    stem = os.path.splitext(os.path.basename(path))[0]
    for i, r in enumerate(table.to_pylist()):
        img = next((v for v in r.values() if isinstance(v, dict) and isinstance(v.get("bytes"), (bytes, bytearray))), None)
        if img is None:
            continue
        fn = f"{stem}_{i:05d}.jpg"
        fp = os.path.join(out_dir, fn)
        if not os.path.exists(fp):
            with open(fp, "wb") as f:
                f.write(img["bytes"])
        rows.append({**{k: v for k, v in r.items() if not isinstance(v, dict)}, "filename": fn})
    return rows


# ──────────────────────────────────────────────────────────────────────
# Pascal VOC
# ──────────────────────────────────────────────────────────────────────
_PLATE_CLASS = re.compile(r"(number|license|licence|vehicle)?_?plate|^lp$|^np$", re.I)


def _voc_text(obj: ET.Element, text_from: str) -> str | None:
    """Plate text from a VOC <object>: attribute number_plate_text (DataCluster) or the <name> itself (saisirishan)."""
    for attr in obj.iter("attribute"):
        if (attr.findtext("name") or "").strip().lower() in ("number_plate_text", "plate_text", "text"):
            v = (attr.findtext("value") or "").strip()
            if v:
                return v
    if text_from in ("name", "auto"):
        name = (obj.findtext("name") or "").strip()
        norm = normalise_plate(name)
        # A class label ("number_plate") is not plate text; a real Indian plate has letters AND digits.
        if norm and not _PLATE_CLASS.search(name) and re.search(r"\d", norm) and re.search(r"[A-Z]", norm) and len(norm) >= 6:
            return name
    return None


def parse_voc(xml_path: str, text_from: str = "attribute") -> tuple[str | None, list[dict], dict[str, str]]:
    root = ET.parse(xml_path).getroot()
    fname = (root.findtext("filename") or "").strip() or None
    plates, tags = [], {}
    for obj in root.iter("object"):
        text = _voc_text(obj, text_from)
        bb = obj.find("bndbox")
        box = None
        if bb is not None:
            try:
                x1, y1, x2, y2 = (float(bb.findtext(k) or "nan") for k in ("xmin", "ymin", "xmax", "ymax"))
                box = [x1, y1, x2 - x1, y2 - y1] if x2 > x1 and y2 > y1 else None
            except ValueError:
                box = None
        if not text:
            continue
        plates.append({"text": text, "bbox": box})
        if (obj.findtext("occluded") or "0").strip() == "1" or (obj.findtext("truncated") or "0").strip() == "1":
            tags["occluded"] = "label"
        for attr in obj.iter("attribute"):
            if (attr.findtext("name") or "").strip().lower() == "rotation":
                try:
                    if abs(float(attr.findtext("value") or 0)) >= 10:
                        tags["angle"] = "label"
                except ValueError:
                    pass
    return fname, plates, tags


def load_voc_dir(root: str, dataset: str, text_from: str = "attribute") -> list[Sample]:
    idx = _index_images(root)
    out = []
    for dp, _, files in os.walk(root):
        for f in sorted(files):
            if not f.lower().endswith(".xml"):
                continue
            xp = os.path.join(dp, f)
            try:
                fname, plates, tags = parse_voc(xp, text_from)
            except ET.ParseError:
                continue
            if not plates:
                continue
            stem = os.path.splitext(f)[0]
            path = (fname and (idx.get(fname) or idx.get(os.path.splitext(fname)[0]))) or idx.get(stem)
            if not path:
                continue
            out.append(Sample(id=stem, dataset=dataset, path=path, plates=plates, tags=tags))
    return out


# ──────────────────────────────────────────────────────────────────────
# 1. thundarstrom/indian-anpr-ocr-benchmark  (HF, CC BY 4.0)
# ──────────────────────────────────────────────────────────────────────
BENCH_REPO = "thundarstrom/indian-anpr-ocr-benchmark"


def download_benchmark(dest: str) -> None:
    files = [f for f in hf_tree(BENCH_REPO) if f["path"] not in (".gitattributes", "README.md")]
    if not files:
        raise DatasetUnavailable(
            f"{BENCH_REPO} currently publishes only its dataset card (no image/label files; HF reports 0 bytes "
            "of storage as of 2026-09-30). Re-run this command when data appears, or ask the maintainer "
            "(huggingface.co/thundarstrom) for the archive and unpack it into "
            f"{dest} — the loader auto-detects labels.csv / JSON / parquet / VOC."
        )
    for f in files:
        target = os.path.join(dest, f["path"])
        if not os.path.exists(target):
            print(f"    {f['path']} ({(f.get('size') or 0) // 1024} KB)")
            http_get(hf_file_url(BENCH_REPO, f["path"]), target)
        if target.lower().endswith(".zip"):
            with zipfile.ZipFile(target) as z:
                z.extractall(os.path.dirname(target))


def load_benchmark(dest: str) -> list[Sample]:
    return load_labelled_dir(dest, "anpr-benchmark")


# ──────────────────────────────────────────────────────────────────────
# 2. DataCluster Labs Indian number plates sample (HF mirror of the Kaggle sample)
# ──────────────────────────────────────────────────────────────────────
DC_REPO = "Dataclusterlabspvtltd/indian-number-plates-dataset"


def download_datacluster(dest: str, all_images: bool = False) -> None:
    """Fetches the VOC XMLs, then only the images that carry `number_plate_text` (~65 MB instead of ~150 MB)."""
    files = hf_tree(DC_REPO)
    xmls = [f for f in files if f["path"].lower().endswith(".xml")]
    imgs = {os.path.splitext(os.path.basename(f["path"]))[0]: f for f in files if f["path"].lower().endswith(IMAGE_EXTS)}
    for f in xmls:
        target = os.path.join(dest, "Annotations", os.path.basename(f["path"]))
        if not os.path.exists(target):
            http_get(hf_file_url(DC_REPO, f["path"]), target)
    wanted = []
    for f in xmls:
        stem = os.path.splitext(os.path.basename(f["path"]))[0]
        _, plates, _ = parse_voc(os.path.join(dest, "Annotations", os.path.basename(f["path"])))
        if (plates or all_images) and stem in imgs:
            wanted.append(imgs[stem])
    for i, f in enumerate(wanted, 1):
        target = os.path.join(dest, "images", os.path.basename(f["path"]))
        if not os.path.exists(target):
            print(f"    [{i}/{len(wanted)}] {os.path.basename(f['path'])} ({(f.get('size') or 0) // 1024} KB)")
            http_get(hf_file_url(DC_REPO, f["path"]), target)


def load_datacluster(dest: str) -> list[Sample]:
    if not os.path.isdir(dest):
        raise DatasetUnavailable(f"datacluster: {dest} missing — run `python pipeline/eval/datasets.py download datacluster`")
    return load_voc_dir(dest, "datacluster", text_from="attribute")


# ──────────────────────────────────────────────────────────────────────
# 3. zenitsu09/indian-number-plate — plate crops with text (HF datasets-server)
# ──────────────────────────────────────────────────────────────────────
CROPS_REPO = "zenitsu09/indian-number-plate"
_RF_SUFFIX = re.compile(r"\.rf\.[0-9a-f]+", re.I)


def download_plate_crops(dest: str, dedupe: bool = True) -> None:
    """Pages the HF datasets-server /rows API (JSON + signed image URLs) — no pyarrow needed.

    Roboflow exports keep 3 augmented copies of each source image (`...rf.<hash>.jpg`);
    with ``dedupe`` only the first copy of each source is kept.
    """
    base = "https://datasets-server.huggingface.co/rows?" + urllib.parse.urlencode(
        {"dataset": CROPS_REPO, "config": "default", "split": "train"})
    os.makedirs(os.path.join(dest, "images"), exist_ok=True)
    rows_out, seen, offset, total = [], set(), 0, None
    while total is None or offset < total:
        page = json.loads(http_get(f"{base}&offset={offset}&length=100") or b"{}")
        total = page.get("num_rows_total", 0)
        rows = page.get("rows", [])
        if not rows:
            break
        for r in rows:
            row, i = r["row"], r["row_idx"]
            text = row.get("plate_text") or ""
            src = _RF_SUFFIX.sub("", row.get("orig_filename") or str(i))
            if not normalise_plate(text) or (dedupe and src in seen):
                continue
            seen.add(src)
            fn = f"{i:05d}.jpg"
            target = os.path.join(dest, "images", fn)
            if not os.path.exists(target):
                http_get(row["image"]["src"], target)
            rows_out.append({"filename": fn, "plate_text": text, "state": row.get("state") or "",
                             "orig_filename": row.get("orig_filename") or "", "conditions": ""})
        offset += len(rows)
        print(f"    rows {offset}/{total} -> {len(rows_out)} kept")
    with open(os.path.join(dest, "labels.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["filename", "plate_text", "state", "orig_filename", "conditions"])
        w.writeheader()
        w.writerows(rows_out)


def load_plate_crops(dest: str) -> list[Sample]:
    return load_labelled_dir(dest, "hf-plate-crops")


# ──────────────────────────────────────────────────────────────────────
# 4. saisirishan/indian-vehicle-dataset (Kaggle, VOC with plate text in <name>)
# ──────────────────────────────────────────────────────────────────────
KAGGLE_REF = "saisirishan/indian-vehicle-dataset"


def download_saisirishan(dest: str) -> None:
    has_creds = os.path.exists(os.path.expanduser("~/.kaggle/kaggle.json")) or (
        os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"))
    if shutil.which("kaggle") and has_creds:
        os.makedirs(dest, exist_ok=True)
        subprocess.run(["kaggle", "datasets", "download", "-d", KAGGLE_REF, "-p", dest, "--unzip"], check=True)
        return
    raise DatasetUnavailable(
        "Kaggle requires a signed-in account for downloads (unauthenticated API returns 404). Either:\n"
        "  pip install kaggle && put your API token in ~/.kaggle/kaggle.json (kaggle.com -> Settings -> API),\n"
        "  then re-run this command; or\n"
        f"  download https://www.kaggle.com/datasets/{KAGGLE_REF} in the browser (~187 MB) and unzip it into\n"
        f"  {dest}  (any layout — XMLs are matched to images by <filename> or file stem)."
    )


def load_saisirishan(dest: str) -> list[Sample]:
    if not os.path.isdir(dest):
        raise DatasetUnavailable(f"saisirishan: {dest} missing — see `python pipeline/eval/datasets.py download saisirishan`")
    return load_voc_dir(dest, "saisirishan", text_from="name")


# ──────────────────────────────────────────────────────────────────────
# 5. Synthetic (offline mock run only — NOT an accuracy benchmark)
# ──────────────────────────────────────────────────────────────────────
_STATES = ["MH", "MH", "MH", "DL", "KA", "GJ", "TN", "UP", "RJ", "WB"]


def synthetic_plate_text(rng: random.Random) -> str:
    return f"{rng.choice(_STATES)}{rng.randint(1, 50):02d}{''.join(rng.choices('ABCDEFGHJKLMNPRSTUVWXYZ', k=2))}{rng.randint(1, 9999):04d}"


def build_synthetic(dest: str, n: int = 48, seed: int = 7) -> list[Sample]:
    rng = random.Random(seed)
    os.makedirs(dest, exist_ok=True)
    out = []
    for i in range(n):
        text = synthetic_plate_text(rng)
        night = i % 3 == 2
        small = i % 5 == 4
        fn = os.path.join(dest, f"syn_{i:03d}.png")
        if not os.path.exists(fn):
            with open(fn, "wb") as f:
                f.write(synthetic_plate_png(text, brightness=0.25 if night else 1.0, scale=1 if small else 3))
        tags = {"night" if night else "day": "label"}
        if small:
            tags["low_res"] = "label"
        out.append(Sample(id=f"syn_{i:03d}", dataset="synthetic", path=fn, plates=[{"text": text, "bbox": None}], tags=tags))
    return out


# ──────────────────────────────────────────────────────────────────────
# Registry
# ──────────────────────────────────────────────────────────────────────
DATASETS: dict[str, DatasetSpec] = {
    s.id: s
    for s in [
        DatasetSpec("anpr-benchmark", "DashCop Indian ANPR OCR benchmark", f"https://huggingface.co/datasets/{BENCH_REPO}",
                    "CC BY 4.0", "crop", True,
                    "3,034 real dashcam plate crops (blur, glare, rain) per the card; data files not yet published.",
                    download_benchmark, load_benchmark),
        DatasetSpec("datacluster", "DataCluster Labs Indian number plates (sample)", f"https://huggingface.co/datasets/{DC_REPO}",
                    "CC BY-NC-ND 4.0", "scene", False,
                    "Phone photos across India; only images with the number_plate_text attribute are scored.",
                    download_datacluster, load_datacluster),
        DatasetSpec("hf-plate-crops", "Indian number plate crops (zenitsu09)", f"https://huggingface.co/datasets/{CROPS_REPO}",
                    "not stated (evaluation only)", "crop", False,
                    "Roboflow plate crops with plate_text; augmented duplicates removed.",
                    download_plate_crops, load_plate_crops),
        DatasetSpec("saisirishan", "Indian vehicle license plate dataset (saisirishan)", f"https://www.kaggle.com/datasets/{KAGGLE_REF}",
                    "CC BY-NC-ND 4.0", "scene", False,
                    "VOC XML; plate text is the object <name>. Kaggle login required.",
                    download_saisirishan, load_saisirishan),
        DatasetSpec("synthetic", "Synthetic rendered plates (plumbing test)", "local", "generated", "crop", True,
                    "Rendered 5x7-font plates for the offline mock run. Not an accuracy benchmark.",
                    lambda dest: None, lambda dest: build_synthetic(dest)),
    ]
}


def folder_spec(path: str, name: str | None = None) -> DatasetSpec:
    path = os.path.abspath(path)
    did = "folder:" + os.path.basename(path.rstrip(os.sep))
    return DatasetSpec(did, name or f"Local set ({os.path.basename(path)})", path, "team-owned", "scene", True,
                       "Local frames + labels.csv (filename,plate_text[,conditions][,x,y,w,h]).",
                       lambda dest: None, lambda dest: load_labelled_dir(path, did))


def resolve(ds_id: str) -> DatasetSpec:
    if ds_id.startswith("folder:"):
        return folder_spec(ds_id.split(":", 1)[1])
    if ds_id not in DATASETS:
        raise KeyError(f"unknown dataset '{ds_id}' (known: {', '.join(DATASETS)}, folder:<path>)")
    return DATASETS[ds_id]


def load(ds_id: str, root: str = DATA_ROOT, download: bool = False) -> tuple[DatasetSpec, list[Sample]]:
    spec = resolve(ds_id)
    dest = spec.dir(root) if not ds_id.startswith("folder:") else spec.source_url
    if download:
        spec.download(dest)
    return spec, spec.load(dest)


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Download / inspect ANPR evaluation datasets")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    d = sub.add_parser("download")
    d.add_argument("ids", nargs="+")
    d.add_argument("--all-images", action="store_true", help="datacluster: also fetch images without plate text")
    d.add_argument("--keep-augmented", action="store_true", help="hf-plate-crops: keep Roboflow augmented copies")
    c = sub.add_parser("check")
    c.add_argument("ids", nargs="*")
    p.add_argument("--data_dir", default=DATA_ROOT)
    args = p.parse_args(argv)

    if args.cmd == "list":
        for s in DATASETS.values():
            print(f"{s.id:15s} {s.license:28s} {s.source_url}\n{'':15s} {s.notes}")
        print(f"{'folder:<path>':15s} {'team-owned':28s} labels.csv with filename,plate_text[,conditions][,x,y,w,h]")
        return 0

    if args.cmd == "download":
        rc = 0
        for ds_id in args.ids:
            spec = resolve(ds_id)
            dest = spec.dir(args.data_dir)
            print(f"[*] {ds_id} -> {dest}")
            try:
                if ds_id == "datacluster":
                    download_datacluster(dest, all_images=args.all_images)
                elif ds_id == "hf-plate-crops":
                    download_plate_crops(dest, dedupe=not args.keep_augmented)
                else:
                    spec.download(dest)
                n = len(spec.load(dest))
                print(f"[OK] {ds_id}: {n} labelled images")
            except DatasetUnavailable as e:
                print(f"[!] {ds_id}: {e}", file=sys.stderr)
                rc = 1
        return rc

    ids = args.ids or list(DATASETS)
    for ds_id in ids:
        spec = resolve(ds_id)
        try:
            samples = spec.load(spec.dir(args.data_dir) if not ds_id.startswith("folder:") else spec.source_url)
            plates = sum(len(s.plates) for s in samples)
            print(f"{ds_id:15s} {len(samples):5d} images {plates:5d} plates")
        except DatasetUnavailable as e:
            print(f"{ds_id:15s} not available: {str(e).splitlines()[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
