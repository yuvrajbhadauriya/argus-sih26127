"""
In-memory stand-in for the supabase-py client, for tests of the pipeline writers.

Supports the query-builder subset the scripts use:
    client.table(name).select(...).in_(...).eq(...).order(...).limit(...).execute()
    client.table(name).upsert(rows, on_conflict=..., ignore_duplicates=...).execute()
    client.table(name).insert(rows).execute()

Upserts are applied to an in-memory table keyed by ``on_conflict`` so tests can
assert idempotency on the resulting *state*, not just on the calls made.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, client: FakeClient, table: str):
        self.client, self.table = client, table
        self.op: str | None = None
        self.payload: Any = None
        self.kwargs: dict = {}
        self.filters: list[tuple[str, str, Any]] = []
        self._limit: int | None = None

    # read builder
    def select(self, *_a, **_k):
        self.op = self.op or "select"
        return self

    def in_(self, col, values):
        self.filters.append(("in", col, list(values)))
        return self

    def eq(self, col, value):
        self.filters.append(("eq", col, value))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    # write builder
    def upsert(self, rows, **kwargs):
        self.op, self.payload, self.kwargs = "upsert", rows, kwargs
        return self

    def insert(self, rows, **kwargs):
        self.op, self.payload, self.kwargs = "insert", rows, kwargs
        return self

    def execute(self):
        return self.client._execute(self)


class FakeClient:
    """
    ``tables``   initial rows per table (e.g. {"cameras": [...]}).
    ``fail``     callable(query) -> Exception | None, consulted before each write.
    """

    def __init__(self, tables: dict[str, list[dict]] | None = None,
                 fail: Callable[[FakeQuery], Exception | None] | None = None):
        self.tables: dict[str, list[dict]] = {k: [dict(r) for r in v] for k, v in (tables or {}).items()}
        self.fail = fail
        self.calls: list[FakeQuery] = []
        self._auto_id = 0

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)

    def writes(self, table: str) -> list[FakeQuery]:
        return [q for q in self.calls if q.table == table and q.op in ("upsert", "insert")]

    def _execute(self, q: FakeQuery):
        self.calls.append(q)
        if q.op in ("upsert", "insert"):
            if self.fail:
                err = self.fail(q)
                if err:
                    raise err
            rows = q.payload if isinstance(q.payload, list) else [q.payload]
            store = self.tables.setdefault(q.table, [])
            key = q.kwargs.get("on_conflict") if q.op == "upsert" else None
            for row in rows:
                row = dict(row)
                existing = next((r for r in store if key and r.get(key) is not None and r.get(key) == row.get(key)), None)
                if existing is not None:
                    if not q.kwargs.get("ignore_duplicates"):
                        existing.update(row)
                    continue
                if "id" not in row and q.table in ("alerts", "blacklist_entries"):
                    self._auto_id += 1
                    row["id"] = f"{q.table}-{self._auto_id}"
                store.append(row)
            return FakeResult(rows)
        rows = list(self.tables.get(q.table, []))
        for kind, col, value in q.filters:
            rows = [r for r in rows if (r.get(col) in value if kind == "in" else r.get(col) == value)]
        if q._limit is not None:
            rows = rows[: q._limit]
        return FakeResult(rows)
