"""Known-distance project calibration API."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

CALIBRATION = {
    "point_a": [0.0, 0.0, 0.0],
    "point_b": [1.0, 0.0, 0.0],
    "real_distance_m": 0.5,
}


async def test_calibration_is_null_by_default_in_project_list_and_detail(
    client: AsyncClient, project: dict
) -> None:
    assert project["calibration"] is None

    listing = await client.get("/api/projects")
    assert listing.status_code == 200
    assert listing.json()[0]["calibration"] is None

    detail = await client.get(f"/api/projects/{project['id']}")
    assert detail.status_code == 200
    assert detail.json()["calibration"] is None


async def test_set_calibration_returns_computed_scale(client: AsyncClient, project: dict) -> None:
    response = await client.put(f"/api/projects/{project['id']}/calibration", json=CALIBRATION)
    assert response.status_code == 200, response.text

    calibration = response.json()["calibration"]
    assert calibration["scale"] == pytest.approx(0.5, abs=1e-9)
    assert calibration["method"] == "known_distance"
    assert calibration["reference"] == CALIBRATION
    assert datetime.fromisoformat(calibration["calibrated_at"]).utcoffset() == UTC.utcoffset(None)


async def test_recalibrate_overwrites_and_delete_clears(client: AsyncClient, project: dict) -> None:
    project_url = f"/api/projects/{project['id']}"
    await client.put(f"{project_url}/calibration", json=CALIBRATION)

    recalibrated = await client.put(
        f"{project_url}/calibration",
        json={"point_a": [0, 0, 0], "point_b": [0, 2, 0], "real_distance_m": 3},
    )
    assert recalibrated.status_code == 200
    assert recalibrated.json()["calibration"]["scale"] == pytest.approx(1.5, abs=1e-9)

    cleared = await client.delete(f"{project_url}/calibration")
    assert cleared.status_code == 200
    assert cleared.json()["calibration"] is None

    cleared_again = await client.delete(f"{project_url}/calibration")
    assert cleared_again.status_code == 200
    assert cleared_again.json()["calibration"] is None


async def test_calibration_unknown_project_is_404(client: AsyncClient) -> None:
    assert (await client.put("/api/projects/nope/calibration", json=CALIBRATION)).status_code == 404
    assert (await client.delete("/api/projects/nope/calibration")).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {**CALIBRATION, "real_distance_m": 0},
        {**CALIBRATION, "real_distance_m": -1},
        {**CALIBRATION, "point_b": [0, 0, 0]},
        {**CALIBRATION, "point_a": [0, 0]},
        {**CALIBRATION, "point_b": [0, 0, 0, 1]},
    ],
)
async def test_invalid_calibration_is_422(
    client: AsyncClient, project: dict, payload: dict
) -> None:
    response = await client.put(f"/api/projects/{project['id']}/calibration", json=payload)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {**CALIBRATION, "point_a": [float("inf"), 0, 0]},
        {**CALIBRATION, "real_distance_m": float("nan")},
    ],
)
async def test_non_finite_calibration_is_rejected(
    client: AsyncClient, project: dict, payload: dict
) -> None:
    # httpx's json= encoder refuses non-finite floats outright, so serialize with
    # Python's lenient encoder (it emits the non-compliant ``Infinity``/``NaN``
    # tokens some clients send). FastAPI's body parser rejects those tokens with
    # 400 before schema validation; either way the request must be refused and
    # the project must stay uncalibrated.
    response = await client.put(
        f"/api/projects/{project['id']}/calibration",
        content=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code in (400, 422)

    detail = await client.get(f"/api/projects/{project['id']}")
    assert detail.json()["calibration"] is None
