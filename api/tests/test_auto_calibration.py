"""Adopting the worker's ArUco scale when a job finishes (WP 5.1 wiring)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import get_settings
from app.storage import job_output_dir
from tests.conftest import upload_files

MANIFEST_CALIBRATION = {
    "method": "aruco",
    "scale": 0.0342,
    "residual": 0.018,
    "sample_count": 12,
    "marker_length_m": 0.15,
    "marker_dictionary": "DICT_4X4_50",
}


def write_manifest(project_id: str, job_id: str, calibration: object) -> Path:
    output_dir = job_output_dir(get_settings().storage_dir, project_id, job_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "scene.splat").write_bytes(b"\x00" * 32)
    manifest = {
        "artifacts": [{"filename": "scene.splat", "bytes": 32, "format": "splat"}],
        "registration": {"input_images": 40, "registered_images": 38},
        "calibration": calibration,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest))
    return output_dir


async def finish_job(client: AsyncClient, project_id: str) -> str:
    """Drive a job to done through the dev endpoint, as the worker would."""
    created = await client.post(f"/api/projects/{project_id}/jobs", json={})
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]
    for _ in range(40):
        response = await client.post(f"/api/dev/jobs/{job_id}/advance")
        assert response.status_code == 200, response.text
        if response.json()["status"] == "done":
            break
    else:  # pragma: no cover - guards an infinite pipeline
        pytest.fail("job never reached done")
    return job_id


async def test_finished_job_applies_marker_calibration(
    client: AsyncClient, project: dict
) -> None:
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    # The manifest must exist before the job completes, as the worker writes it
    # during publish, i.e. before it reports done.
    job_id = (await client.post(f"/api/projects/{project['id']}/jobs", json={})).json()["id"]
    write_manifest(project["id"], job_id, MANIFEST_CALIBRATION)
    for _ in range(40):
        response = await client.post(f"/api/dev/jobs/{job_id}/advance")
        if response.json()["status"] == "done":
            break

    detail = await client.get(f"/api/projects/{project['id']}")
    calibration = detail.json()["calibration"]
    assert calibration is not None
    assert calibration["method"] == "aruco"
    assert calibration["scale"] == pytest.approx(0.0342)
    assert calibration["residual"] == pytest.approx(0.018)
    assert calibration["sample_count"] == 12
    assert calibration["marker_dictionary"] == "DICT_4X4_50"
    assert calibration["reference"] is None
    assert calibration["calibrated_at"]


async def test_manual_calibration_is_not_overwritten_by_the_worker(
    client: AsyncClient, project: dict
) -> None:
    """A hand-measured scale outranks an automatic one — the user measured it."""
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    manual = await client.put(
        f"/api/projects/{project['id']}/calibration",
        json={"point_a": [0, 0, 0], "point_b": [1, 0, 0], "real_distance_m": 0.5},
    )
    assert manual.json()["calibration"]["scale"] == pytest.approx(0.5)

    job_id = (await client.post(f"/api/projects/{project['id']}/jobs", json={})).json()["id"]
    write_manifest(project["id"], job_id, MANIFEST_CALIBRATION)
    for _ in range(40):
        if (await client.post(f"/api/dev/jobs/{job_id}/advance")).json()["status"] == "done":
            break

    calibration = (await client.get(f"/api/projects/{project['id']}")).json()["calibration"]
    assert calibration["method"] == "known_distance"
    assert calibration["scale"] == pytest.approx(0.5)


@pytest.mark.parametrize(
    "calibration",
    [
        None,
        {"method": "aruco"},
        {"method": "aruco", "scale": 0},
        {"method": "aruco", "scale": -1.0},
        {"method": "aruco", "scale": "0.5"},
        {"method": "aruco", "scale": True},
        "not-a-mapping",
    ],
)
async def test_unusable_manifest_calibration_leaves_project_uncalibrated(
    client: AsyncClient, project: dict, calibration: object
) -> None:
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    job_id = (await client.post(f"/api/projects/{project['id']}/jobs", json={})).json()["id"]
    write_manifest(project["id"], job_id, calibration)
    for _ in range(40):
        if (await client.post(f"/api/dev/jobs/{job_id}/advance")).json()["status"] == "done":
            break

    assert (await client.get(f"/api/projects/{project['id']}")).json()["calibration"] is None


async def test_missing_manifest_is_not_an_error(
    client: AsyncClient, project: dict
) -> None:
    """The fake backend publishes no manifest; completing must still work."""
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    await finish_job(client, project["id"])

    detail = await client.get(f"/api/projects/{project['id']}")
    assert detail.json()["calibration"] is None
    assert detail.json()["status"] == "ready"
