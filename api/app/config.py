"""Application settings, sourced from environment variables (12-factor style)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration.

    Every field can be overridden with an environment variable of the same
    (case-insensitive) name, or via a local ``.env`` file.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Database -----------------------------------------------------------
    # SQLite for dev; swap for postgresql+psycopg://... in production.
    database_url: str = "sqlite:///./data/splatscene.db"

    # --- Storage ------------------------------------------------------------
    # Photos land in {storage_dir}/{project_id}/{photo_id}{ext}.
    # Replaced by MinIO/S3 presigned uploads in a later milestone (PLAN.md §1).
    storage_dir: Path = Path("./data/photos")

    # --- CORS ---------------------------------------------------------------
    # Comma-separated list of allowed browser origins (the Vite dev server).
    cors_origins: str = "http://localhost:5173"

    # --- Feature flags ------------------------------------------------------
    # DEV_MODE=1 exposes /api/dev/* helpers (job advance) used to demo the
    # WebSocket progress channel without a running Celery worker.
    dev_mode: bool = False

    # --- Uploads ------------------------------------------------------------
    allowed_image_types: str = "image/jpeg,image/png,image/webp,image/heic,image/heif"
    max_photo_bytes: int = 50 * 1024 * 1024  # 50 MiB per photo

    # --- Queue (integration point) -----------------------------------------
    # Used by the Celery/Redis integration in WP 0.3/0.4. Unused for now.
    redis_url: str = "redis://localhost:6379/0"

    @field_validator("dev_mode", mode="before")
    @classmethod
    def _coerce_dev_mode(cls, value: object) -> object:
        """Accept DEV_MODE=1/true/yes/on."""
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_image_type_set(self) -> set[str]:
        return {t.strip().lower() for t in self.allowed_image_types.split(",") if t.strip()}


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (also a FastAPI dependency)."""
    return Settings()
