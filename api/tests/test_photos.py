"""Photo upload endpoint."""

from __future__ import annotations

import io
from pathlib import Path

from httpx import AsyncClient

from app.config import Settings
from tests.conftest import png_bytes, upload_files


async def test_upload_single_photo(client: AsyncClient, project: dict, env: Settings) -> None:
    response = await client.post(
        f"/api/projects/{project['id']}/photos", files=upload_files(1, name="DSC")
    )
    assert response.status_code == 201, response.text

    photos = response.json()
    assert len(photos) == 1
    photo = photos[0]
    assert photo["filename"] == "DSC0.png"
    assert photo["content_type"] == "image/png"
    assert photo["size"] == len(png_bytes())
    assert photo["project_id"] == project["id"]

    stored = list((Path(env.storage_dir) / project["id"]).iterdir())
    assert len(stored) == 1
    assert stored[0].name.startswith(photo["id"])
    assert stored[0].read_bytes() == png_bytes()


async def test_upload_multiple_photos_and_list(client: AsyncClient, project: dict) -> None:
    response = await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(3))
    assert response.status_code == 201
    assert len(response.json()) == 3

    listing = await client.get(f"/api/projects/{project['id']}/photos")
    assert listing.status_code == 200
    assert len(listing.json()) == 3


async def test_upload_rejects_non_image(client: AsyncClient, project: dict, env: Settings) -> None:
    response = await client.post(
        f"/api/projects/{project['id']}/photos",
        files=[("files", ("notes.txt", io.BytesIO(b"hello"), "text/plain"))],
    )
    assert response.status_code == 415
    assert "Unsupported content type" in response.json()["detail"]

    # Nothing persisted, nothing written.
    listing = await client.get(f"/api/projects/{project['id']}/photos")
    assert listing.json() == []
    assert not (Path(env.storage_dir) / project["id"]).exists()


async def test_upload_infers_type_from_extension(client: AsyncClient, project: dict) -> None:
    """Android gallery picks often arrive as application/octet-stream."""
    response = await client.post(
        f"/api/projects/{project['id']}/photos",
        files=[("files", ("shot.jpg", io.BytesIO(png_bytes()), "application/octet-stream"))],
    )
    assert response.status_code == 201
    assert response.json()[0]["content_type"] == "image/jpeg"


async def test_upload_sanitizes_traversal_filename(
    client: AsyncClient, project: dict, env: Settings
) -> None:
    response = await client.post(
        f"/api/projects/{project['id']}/photos",
        files=[("files", ("../../etc/passwd.png", io.BytesIO(png_bytes()), "image/png"))],
    )
    assert response.status_code == 201
    assert response.json()[0]["filename"] == "passwd.png"

    stored = list((Path(env.storage_dir) / project["id"]).iterdir())
    assert len(stored) == 1
    assert stored[0].parent.name == project["id"]


async def test_upload_rejects_oversized_photo(
    client: AsyncClient, project: dict, env: Settings, monkeypatch
) -> None:
    monkeypatch.setattr(env, "max_photo_bytes", 10)
    response = await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    assert response.status_code == 413
    assert (await client.get(f"/api/projects/{project['id']}/photos")).json() == []
    assert list((Path(env.storage_dir) / project["id"]).iterdir()) == []


async def test_upload_to_unknown_project_is_404(client: AsyncClient) -> None:
    response = await client.post("/api/projects/nope/photos", files=upload_files(1))
    assert response.status_code == 404


async def test_delete_photo_removes_file(client: AsyncClient, project: dict, env: Settings) -> None:
    upload = await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    photo = upload.json()[0]

    response = await client.delete(f"/api/projects/{project['id']}/photos/{photo['id']}")
    assert response.status_code == 204
    assert list((Path(env.storage_dir) / project["id"]).iterdir()) == []
    assert (await client.get(f"/api/projects/{project['id']}/photos")).json() == []
