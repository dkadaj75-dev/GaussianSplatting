"""Environment-backed settings for the processing worker."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    redis_url: str
    storage_dir: Path
    pipeline_backend: str


def get_settings() -> Settings:
    """Read settings at use time, keeping local development configuration simple."""
    backend = os.getenv("PIPELINE_BACKEND", "fake").strip().lower()
    if backend not in {"fake", "real"}:
        raise ValueError("PIPELINE_BACKEND must be either 'fake' or 'real'")
    return Settings(
        redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        storage_dir=Path(os.getenv("STORAGE_DIR", "./data")),
        pipeline_backend=backend,
    )
