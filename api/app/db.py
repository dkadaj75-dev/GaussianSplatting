"""Database engine + session management.

SQLite is the dev default (DATABASE_URL=sqlite:///./data/splatscene.db).
Point DATABASE_URL at PostgreSQL for production — nothing else changes.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy.engine import Engine, make_url
from sqlmodel import Session, SQLModel, create_engine

# Imported for its side effect: registering the tables on SQLModel.metadata.
from app import models  # noqa: F401
from app.config import get_settings

_engine: Engine | None = None


def _build_engine(database_url: str) -> Engine:
    connect_args: dict[str, object] = {}
    url = make_url(database_url)

    if url.drivername.startswith("sqlite"):
        # FastAPI serves requests from a threadpool; SQLite guards connections
        # per-thread by default.
        connect_args["check_same_thread"] = False
        # Ensure the parent directory of a file-backed SQLite DB exists.
        if url.database and url.database != ":memory:":
            Path(url.database).expanduser().parent.mkdir(parents=True, exist_ok=True)

    return create_engine(database_url, echo=False, connect_args=connect_args)


def get_engine() -> Engine:
    """Lazily create (and memoize) the process-wide engine."""
    global _engine
    if _engine is None:
        _engine = _build_engine(get_settings().database_url)
    return _engine


def set_engine(engine: Engine | None) -> None:
    """Override the process-wide engine (used by the test fixtures)."""
    global _engine
    _engine = engine


def init_db() -> None:
    """Create tables that do not exist yet.

    Good enough while the schema is young; Alembic migrations arrive with the
    PostgreSQL switch.
    """
    SQLModel.metadata.create_all(get_engine())


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a transactional session."""
    with Session(get_engine()) as session:
        yield session
