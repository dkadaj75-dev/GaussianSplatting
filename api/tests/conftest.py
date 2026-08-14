"""Shared test fixtures.

Every test gets an isolated temp directory holding its own SQLite file and
photo storage, so nothing touches the developer's ./data.
"""

from __future__ import annotations

import io
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app import db as db_module
from app.config import Settings, get_settings
from app.main import create_app


def png_bytes() -> bytes:
    """Minimal valid PNG payload for upload tests."""
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89"
        b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def upload_files(count: int = 1, name: str = "photo", content_type: str = "image/png"):
    """Build a multipart ``files`` payload for httpx."""
    return [
        (
            "files",
            (f"{name}{index}.png", io.BytesIO(png_bytes()), content_type),
        )
        for index in range(count)
    ]


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Settings]:
    """Point the app at a temp SQLite DB + temp storage dir, DEV_MODE on."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "photos"))
    monkeypatch.setenv("DEV_MODE", "1")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")

    get_settings.cache_clear()
    db_module.set_engine(None)
    settings = get_settings()
    db_module.init_db()

    yield settings

    db_module.set_engine(None)
    get_settings.cache_clear()


@pytest.fixture
def app(env: Settings) -> FastAPI:
    return create_app(env)


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


@pytest.fixture
def sync_client(app: FastAPI) -> Iterator[TestClient]:
    """Starlette TestClient — needed for WebSocket tests (httpx has no ws)."""
    with TestClient(app) as tc:
        yield tc


@pytest_asyncio.fixture
async def project(client: AsyncClient) -> dict:
    response = await client.post("/api/projects", json={"name": "Balcony anchor detail"})
    assert response.status_code == 201
    return response.json()


@pytest_asyncio.fixture
async def project_with_photo(client: AsyncClient, project: dict) -> dict:
    response = await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    assert response.status_code == 201, response.text
    return project
