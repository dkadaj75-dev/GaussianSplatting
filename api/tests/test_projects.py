"""Project CRUD + health endpoint."""

from __future__ import annotations

from datetime import UTC

from httpx import AsyncClient


async def test_healthz(client: AsyncClient) -> None:
    response = await client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["dev_mode"] is True


async def test_openapi_served(client: AsyncClient) -> None:
    response = await client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/api/projects" in paths
    assert "/api/jobs/{job_id}" in paths


async def test_create_and_get_project(client: AsyncClient) -> None:
    created = await client.post("/api/projects", json={"name": "Fishing spot"})
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Fishing spot"
    assert body["status"] == "draft"
    assert body["id"]
    assert body["created_at"]

    fetched = await client.get(f"/api/projects/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == body


async def test_timestamps_are_utc_aware(client: AsyncClient, project: dict) -> None:
    """Naive timestamps would be read as local time by the browser."""
    from datetime import datetime

    parsed = datetime.fromisoformat(project["created_at"])
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == UTC.utcoffset(None)


async def test_create_project_rejects_empty_name(client: AsyncClient) -> None:
    response = await client.post("/api/projects", json={"name": ""})
    assert response.status_code == 422


async def test_list_projects_and_filter(client: AsyncClient) -> None:
    await client.post("/api/projects", json={"name": "A"})
    await client.post("/api/projects", json={"name": "B", "status": "ready"})

    all_projects = await client.get("/api/projects")
    assert all_projects.status_code == 200
    assert len(all_projects.json()) == 2

    ready = await client.get("/api/projects", params={"status": "ready"})
    assert [p["name"] for p in ready.json()] == ["B"]


async def test_photo_count_is_reported_per_project(
    client: AsyncClient, project_with_photo: dict
) -> None:
    """The project list is the client's main screen; it must not need N+1 calls."""
    from tests.conftest import upload_files

    empty = (await client.post("/api/projects", json={"name": "Empty"})).json()
    assert empty["photo_count"] == 0

    await client.post(f"/api/projects/{project_with_photo['id']}/photos", files=upload_files(2))

    detail = await client.get(f"/api/projects/{project_with_photo['id']}")
    assert detail.json()["photo_count"] == 3

    counts = {p["id"]: p["photo_count"] for p in (await client.get("/api/projects")).json()}
    assert counts == {project_with_photo["id"]: 3, empty["id"]: 0}


async def test_update_project(client: AsyncClient, project: dict) -> None:
    response = await client.patch(
        f"/api/projects/{project['id']}", json={"name": "Renamed", "status": "ready"}
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["status"] == "ready"


async def test_delete_project_cascades(client: AsyncClient, project_with_photo: dict) -> None:
    project_id = project_with_photo["id"]

    response = await client.delete(f"/api/projects/{project_id}")
    assert response.status_code == 204

    assert (await client.get(f"/api/projects/{project_id}")).status_code == 404
    assert (await client.get(f"/api/projects/{project_id}/photos")).status_code == 404


async def test_unknown_project_is_404(client: AsyncClient) -> None:
    assert (await client.get("/api/projects/does-not-exist")).status_code == 404
    assert (await client.patch("/api/projects/nope", json={"name": "x"})).status_code == 404
    assert (await client.delete("/api/projects/nope")).status_code == 404
