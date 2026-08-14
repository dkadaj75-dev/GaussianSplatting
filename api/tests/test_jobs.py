"""Job creation, lookup and the dev-only advance endpoint."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import Settings, get_settings
from app.main import create_app
from tests.conftest import upload_files


async def test_create_job_requires_photos(client: AsyncClient, project: dict) -> None:
    response = await client.post(f"/api/projects/{project['id']}/jobs", json={})
    assert response.status_code == 400
    assert "no photos" in response.json()["detail"]


async def test_create_job(client: AsyncClient, project_with_photo: dict) -> None:
    project_id = project_with_photo["id"]
    response = await client.post(f"/api/projects/{project_id}/jobs", json={})
    assert response.status_code == 201, response.text

    job = response.json()
    assert job["project_id"] == project_id
    assert job["status"] == "queued"
    assert job["stage"] == "ingest"
    assert job["progress"] == 0.0
    # Celery integration is not wired yet (WP 0.4).
    assert job["task_id"] is None

    # Creating a job flips the project into 'processing'.
    project = await client.get(f"/api/projects/{project_id}")
    assert project.json()["status"] == "processing"

    fetched = await client.get(f"/api/jobs/{job['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == job["id"]

    listing = await client.get(f"/api/projects/{project_id}/jobs")
    assert [j["id"] for j in listing.json()] == [job["id"]]


async def test_get_unknown_job_is_404(client: AsyncClient) -> None:
    assert (await client.get("/api/jobs/nope")).status_code == 404


async def test_dev_advance_walks_all_stages(client: AsyncClient, project_with_photo: dict) -> None:
    project_id = project_with_photo["id"]
    job = (await client.post(f"/api/projects/{project_id}/jobs", json={})).json()

    first = await client.post(f"/api/dev/jobs/{job['id']}/advance")
    assert first.status_code == 200
    assert first.json()["status"] == "running"
    assert first.json()["stage"] == "ingest"
    assert first.json()["started_at"] is not None

    seen_stages = ["ingest"]
    body = first.json()
    for _ in range(60):
        if body["status"] == "done":
            break
        body = (await client.post(f"/api/dev/jobs/{job['id']}/advance")).json()
        if body["stage"] != seen_stages[-1]:
            seen_stages.append(body["stage"])

    assert body["status"] == "done"
    assert body["progress"] == 1.0
    assert body["stage"] == "publish"
    assert body["finished_at"] is not None
    assert seen_stages == ["ingest", "sfm", "train", "compress", "publish"]

    # Terminal state mirrors onto the project.
    project = await client.get(f"/api/projects/{project_id}")
    assert project.json()["status"] == "ready"

    # Advancing a finished job is a no-op, not an error.
    again = await client.post(f"/api/dev/jobs/{job['id']}/advance")
    assert again.status_code == 200
    assert again.json()["status"] == "done"


async def test_dev_advance_explicit_state(client: AsyncClient, project_with_photo: dict) -> None:
    project_id = project_with_photo["id"]
    job = (await client.post(f"/api/projects/{project_id}/jobs", json={})).json()

    response = await client.post(
        f"/api/dev/jobs/{job['id']}/advance",
        json={
            "stage": "sfm",
            "progress": 0.4,
            "status": "failed",
            "message": "only 12 of 40 photos registered",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["stage"] == "sfm"
    assert body["progress"] == 0.4
    assert body["status"] == "failed"
    assert body["message"] == "only 12 of 40 photos registered"

    project = await client.get(f"/api/projects/{project_id}")
    assert project.json()["status"] == "failed"


async def test_dev_advance_unknown_job_is_404(client: AsyncClient) -> None:
    assert (await client.post("/api/dev/jobs/nope/advance")).status_code == 404


@pytest.mark.asyncio
async def test_dev_endpoints_disabled_without_dev_mode(
    env: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEV_MODE", "0")
    get_settings.cache_clear()
    app: FastAPI = create_app(get_settings())

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        project = (await client.post("/api/projects", json={"name": "P"})).json()
        await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
        job = (await client.post(f"/api/projects/{project['id']}/jobs", json={})).json()

        response = await client.post(f"/api/dev/jobs/{job['id']}/advance")
        assert response.status_code == 404
        assert "DEV_MODE" in response.json()["detail"]

        health = await client.get("/healthz")
        assert health.json()["dev_mode"] is False
