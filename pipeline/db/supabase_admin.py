"""
Service-role Supabase access for the offline pipeline scripts.

Every writer in pipeline/ goes through here so the rules are in one place:

* Writes require SUPABASE_SERVICE_ROLE_KEY. There is deliberately NO fallback
  to the anon key: with RLS on (supabase/migrations/*_rls.sql) anon writes are
  rejected anyway, and silently degrading hides misconfiguration.
* The project URL comes from the environment only (SUPABASE_URL, or
  VITE_SUPABASE_URL for convenience) — never hardcoded.
* Network writes are retried with exponential backoff; the caller decides what
  a final failure means (the scripts exit non-zero).
"""

from __future__ import annotations

import os
import re
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from typing import Any, TypeVar

T = TypeVar("T")

EXIT_CONFIG = 2   # misconfiguration: missing env, bad args, unknown cameras
EXIT_PARTIAL = 3  # some chunks could not be written after all retries

_PLACEHOLDER = re.compile(r"your[-_]|<project|example\.", re.IGNORECASE)


class ConfigError(SystemExit):
    """Raised (and printed) for configuration problems; exits with code 2."""

    def __init__(self, message: str):
        print(f"[!] {message}", file=sys.stderr)
        super().__init__(EXIT_CONFIG)
        self.message = message


def _env(*names: str) -> str | None:
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value and not _PLACEHOLDER.search(value):
            return value
    return None


def get_service_client():
    """Supabase client authenticated with the service-role key (bypasses RLS)."""
    url = _env("SUPABASE_URL", "VITE_SUPABASE_URL")
    if not url:
        raise ConfigError("SUPABASE_URL is not set (e.g. https://<project-ref>.supabase.co).")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise ConfigError(
            "SUPABASE_SERVICE_ROLE_KEY is not set. Pipeline writes require the service-role key "
            "(Dashboard -> Project Settings -> API). The anon key is never used for writes."
        )
    try:
        import supabase  # imported lazily so tests / --dry_run need no network deps
    except ImportError as exc:  # pragma: no cover - environment problem
        raise ConfigError("The 'supabase' package is not installed: pip install -r pipeline/requirements.txt") from exc
    print(f"[*] Connecting to Supabase: {url}")
    return supabase.create_client(url, key)


def normalize_plate(plate: str | None) -> str:
    """'MH 01-ab 1234' -> 'MH01AB1234' (same rule as public.normalize_plate in SQL)."""
    return re.sub(r"[^A-Za-z0-9]", "", plate or "").upper()


def chunked(items: list[T], size: int) -> Iterator[list[T]]:
    if size < 1:
        raise ValueError("chunk size must be >= 1")
    for i in range(0, len(items), size):
        yield items[i : i + size]


def with_retries(
    fn: Callable[[], T],
    *,
    attempts: int = 4,
    base_delay: float = 1.0,
    label: str = "request",
    sleep: Callable[[float], Any] | None = None,
) -> T:
    """Call fn(); on exception retry with delays base, 2*base, 4*base, ... Re-raises the last error."""
    sleep = sleep or time.sleep
    attempts = max(1, attempts)
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:
            if attempt == attempts:
                raise
            delay = base_delay * (2 ** (attempt - 1))
            print(f"  [!] {label} failed (attempt {attempt}/{attempts}): {exc} — retrying in {delay:.1f}s")
            sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def fetch_cameras_by_code(client, *, attempts: int = 4, base_delay: float = 1.0) -> dict[str, dict]:
    """{camera code: row} from the `cameras` table. Raises on failure (no silent fallback)."""
    res = with_retries(
        lambda: client.table("cameras").select("*").execute(),
        attempts=attempts, base_delay=base_delay, label="fetch cameras",
    )
    cameras: dict[str, dict] = {}
    for row in res.data or []:
        code = row.get("code")
        if not code:
            continue
        row = dict(row)
        # Pre-reconcile projects may only have one of the two coordinate spellings.
        row["lat"] = row.get("lat") if row.get("lat") is not None else row.get("latitude")
        row["lng"] = row.get("lng") if row.get("lng") is not None else row.get("longitude")
        cameras[code] = row
    return cameras


def missing_codes(needed: Iterable[str], cameras: dict[str, dict]) -> list[str]:
    return sorted({c for c in needed if c not in cameras})
