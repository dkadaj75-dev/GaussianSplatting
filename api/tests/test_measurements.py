"""Measurement CRUD."""

from __future__ import annotations

from httpx import AsyncClient

DISTANCE = {
    "kind": "distance",
    "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 1.5]],
    "value": 1.5,
    "unit": "m",
    "label": "Anchor spacing",
}


async def test_create_and_get_measurement(client: AsyncClient, project: dict) -> None:
    created = await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["kind"] == "distance"
    assert body["points"] == DISTANCE["points"]
    assert body["value"] == 1.5
    assert body["unit"] == "m"
    assert body["label"] == "Anchor spacing"
    assert body["project_id"] == project["id"]

    fetched = await client.get(f"/api/projects/{project['id']}/measurements/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == body


async def test_list_and_filter_measurements(client: AsyncClient, project: dict) -> None:
    await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    await client.post(
        f"/api/projects/{project['id']}/measurements",
        json={
            "kind": "angle",
            "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            "value": 90,
            "unit": "deg",
        },
    )

    listing = await client.get(f"/api/projects/{project['id']}/measurements")
    assert listing.status_code == 200
    assert len(listing.json()) == 2

    angles = await client.get(
        f"/api/projects/{project['id']}/measurements", params={"kind": "angle"}
    )
    assert [m["unit"] for m in angles.json()] == ["deg"]


async def test_update_measurement(client: AsyncClient, project: dict) -> None:
    created = (
        await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    ).json()

    updated = await client.patch(
        f"/api/projects/{project['id']}/measurements/{created['id']}",
        json={"label": "Clearance", "value": 1.62, "points": [[0, 0, 0], [0, 0, 1.62]]},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["label"] == "Clearance"
    assert body["value"] == 1.62
    assert body["points"] == [[0, 0, 0], [0, 0, 1.62]]
    assert body["kind"] == "distance"  # untouched


async def test_delete_measurement(client: AsyncClient, project: dict) -> None:
    created = (
        await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    ).json()

    response = await client.delete(f"/api/projects/{project['id']}/measurements/{created['id']}")
    assert response.status_code == 204
    assert (await client.get(f"/api/projects/{project['id']}/measurements")).json() == []


async def test_measurement_is_scoped_to_its_project(client: AsyncClient, project: dict) -> None:
    other = (await client.post("/api/projects", json={"name": "Other"})).json()
    created = (
        await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    ).json()

    response = await client.get(f"/api/projects/{other['id']}/measurements/{created['id']}")
    assert response.status_code == 404


async def test_measurement_on_unknown_project_is_404(client: AsyncClient) -> None:
    response = await client.post("/api/projects/nope/measurements", json=DISTANCE)
    assert response.status_code == 404
