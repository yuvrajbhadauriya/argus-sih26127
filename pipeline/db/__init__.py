"""Shared Supabase helpers for the trusted (service-role) pipeline scripts."""

from .supabase_admin import (  # noqa: F401
    EXIT_CONFIG,
    EXIT_PARTIAL,
    ConfigError,
    chunked,
    fetch_cameras_by_code,
    get_service_client,
    missing_codes,
    normalize_plate,
    with_retries,
)
