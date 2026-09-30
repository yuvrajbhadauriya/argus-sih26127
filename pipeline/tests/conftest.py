"""
Shared pytest fixtures for the NERO offline Python pipeline.

Heavy / networked dependencies (cv2, torch, supabase, dotenv) are replaced
with light stubs in ``sys.modules`` *before* the pipeline modules are
imported, so the suite runs without a GPU, video codecs, or network.
"""

import importlib
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]          # repo root
PIPELINE = Path(__file__).resolve().parents[1]      # pipeline/
sys.path.insert(0, str(PIPELINE))
sys.path.insert(0, str(PIPELINE / "legacy_local_model"))


# ── cv2 stub ──────────────────────────────────────────────────────────
class FakeVideoCapture:
    """Configurable stand-in for cv2.VideoCapture.

    Set ``FakeVideoCapture.spec = {"fps": 30, "frames": 12, "shape": (720, 1280, 3)}``
    before the code under test opens a capture. ``opened_paths`` records calls.
    """

    spec = {"fps": 30.0, "frames": 10, "shape": (720, 1280, 3), "opened": True}
    opened_paths: list = []

    def __init__(self, path):
        FakeVideoCapture.opened_paths.append(path)
        self._i = 0
        self._open = self.spec.get("opened", True)

    def isOpened(self):
        return self._open

    def get(self, prop):
        if prop == CAP_PROP_FPS:
            return self.spec["fps"]
        if prop == CAP_PROP_FRAME_COUNT:
            return self.spec["frames"]
        return 0

    def read(self):
        if self._i >= self.spec["frames"]:
            return False, None
        self._i += 1
        return True, np.zeros(self.spec["shape"], dtype=np.uint8)

    def release(self):
        self._open = False


CAP_PROP_FPS = 5
CAP_PROP_FRAME_COUNT = 7


class _FakeBgSub:
    def apply(self, frame):
        return np.zeros(frame.shape[:2], dtype=np.uint8)


cv2_stub = types.ModuleType("cv2")
cv2_stub.VideoCapture = FakeVideoCapture
cv2_stub.CAP_PROP_FPS = CAP_PROP_FPS
cv2_stub.CAP_PROP_FRAME_COUNT = CAP_PROP_FRAME_COUNT
cv2_stub.MORPH_RECT = 0
cv2_stub.MORPH_OPEN = 2
cv2_stub.RETR_EXTERNAL = 0
cv2_stub.CHAIN_APPROX_SIMPLE = 2
cv2_stub.createBackgroundSubtractorMOG2 = lambda **kw: _FakeBgSub()
cv2_stub.getStructuringElement = lambda *a, **k: None
cv2_stub.morphologyEx = lambda mask, *a, **k: mask
cv2_stub.findContours = lambda *a, **k: ([], None)
cv2_stub.contourArea = lambda c: 0
cv2_stub.boundingRect = lambda c: (0, 0, 0, 0)
sys.modules["cv2"] = cv2_stub

# ── dotenv stub ───────────────────────────────────────────────────────
dotenv_stub = types.ModuleType("dotenv")
dotenv_stub.load_dotenv = lambda *a, **k: False
sys.modules.setdefault("dotenv", dotenv_stub)

# ── supabase stub (create_client must never be used for real) ─────────
supabase_stub = types.ModuleType("supabase")


def _no_network(*a, **k):
    raise RuntimeError("tests must inject a FakeSupabase instead of calling create_client")


supabase_stub.create_client = _no_network
sys.modules["supabase"] = supabase_stub


# ── Fake Supabase client for ingestion tests ──────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self.client, self.table, self.ops = client, table, []

    def __getattr__(self, name):
        def chain(*args, **kwargs):
            self.ops.append((name, args, kwargs))
            return self
        return chain

    def execute(self):
        self.client.executed.append((self.table, self.ops))
        for name, args, _ in self.ops:
            if name == "insert":
                hook = self.client.insert_hook
                if hook:
                    hook(self.table, args[0])
                self.client.inserted.setdefault(self.table, []).append(args[0])
        return _Result(self.client.select_data.get(self.table, []))


class FakeSupabase:
    def __init__(self, select_data=None, insert_hook=None):
        self.select_data = select_data or {}
        self.insert_hook = insert_hook
        self.inserted: dict = {}
        self.executed: list = []

    def table(self, name):
        return _Query(self, name)


@pytest.fixture
def fake_supabase_cls():
    return FakeSupabase


@pytest.fixture
def fake_capture():
    FakeVideoCapture.opened_paths = []
    FakeVideoCapture.spec = {"fps": 30.0, "frames": 10, "shape": (720, 1280, 3), "opened": True}
    return FakeVideoCapture


@pytest.fixture
def run_detection():
    return importlib.import_module("run_detection")


@pytest.fixture
def insert_detections():
    return importlib.import_module("insert_detections")


@pytest.fixture
def migrations_sql():
    mig = ROOT / "supabase" / "migrations"
    return "\n".join(p.read_text() for p in sorted(mig.glob("*.sql")))


def table_columns(sql: str, table: str) -> set:
    """Columns from CREATE TABLE + ALTER TABLE ... ADD COLUMN in the migrations."""
    import re

    cols = set()
    m = re.search(rf"CREATE TABLE IF NOT EXISTS public\.{table} \((.*?)\n\);", sql, re.S)
    if m:
        for line in m.group(1).splitlines():
            tok = line.strip().split()
            if tok and re.fullmatch(r"[a-z_]+", tok[0]):
                cols.add(tok[0])
    for alter in re.finditer(rf"ALTER TABLE public\.{table}(.*?);", sql, re.S):
        cols.update(re.findall(r"ADD COLUMN IF NOT EXISTS (\w+)", alter.group(1)))
    return cols


@pytest.fixture
def columns_of(migrations_sql):
    return lambda table: table_columns(migrations_sql, table)


@pytest.fixture
def chdir_tmp(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


ROOT_DIR = ROOT
PIPELINE_DIR = PIPELINE
os.environ.setdefault("PYTHONHASHSEED", "0")
