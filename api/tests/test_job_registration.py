"""Registration counts surfaced on a finished job (M4.3 durability).

The worker warns mid-run when SfM places only some of the submitted photos,
but that message is overwritten by "Pipeline complete" long before anyone
reloads the page. The counts live on in the job's manifest, so the API reads
them back per request.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import get_settings
from app.storage import job_output_dir
from tests.conftest import upload_files


def write_manifest(project_id: str, job_id: str, registration: object) -> Path:
    output_dir = job_output_dir(get_settings().storage_dir, project_id, job_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "scene.splat").write_bytes(b"\x00" * 32)
    (output_dir / "manifest.json").write_text(
        json.dumps(
            {
                "artifacts": [{"filename": "scene.splat", "bytes": 32, "format": "splat"}],
                "registration": registration,
                "calibration": None,
            }
        )
    )
    return output_dir


async def start_job(client: AsyncClient, project_id: str) -> str:
    await client.post(f"/api/projects/{project_id}/photos", files=upload_files(1))
    created = await client.post(f"/api/projects/{project_id}/jobs", json={})
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def finish(client: AsyncClient, job_id: str) -> None:
    for _ in range(40):
        response = await client.post(f"/api/dev/jobs/{job_id}/advance")
        assert response.status_code == 200, response.text
        if response.json()["status"] == "done":
            return
    pytest.fail("job never reached done")


async def test_finished_job_reports_registration_counts(
    client: AsyncClient, project: dict
) -> None:
    job_id = await start_job(client, project["id"])
    write_manifest(project["id"], job_id, {"input_images": 40, "registered_images": 28})
    await finish(client, job_id)

    detail = await client.get(f"/api/jobs/{job_id}")
    assert detail.json()["registration"] == {"input_images": 40, "registered_images": 28}

    listing = await client.get(f"/api/projects/{project['id']}/jobs")
    assert listing.json()[0]["registration"] == {"input_images": 40, "registered_images": 28}


async def test_unfinished_job_reports_no_registration(
    client: AsyncClient, project: dict
) -> None:
    """A running job's manifest may be half-written; don't read it."""
    job_id = await start_job(client, project["id"])
    write_manifest(project["id"], job_id, {"input_images": 40, "registered_images": 28})

    assert (await client.get(f"/api/jobs/{job_id}")).json()["registration"] is None


async def test_missing_manifest_reports_no_registration(
    client: AsyncClient, project: dict
) -> None:
    """The fake backend writes no manifest; the job must still read fine."""
    job_id = await start_job(client, project["id"])
    await finish(client, job_id)

    detail = await client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    assert detail.json()["registration"] is None


@pytest.mark.parametrize(
    "registration",
    [
        None,
        "not-a-mapping",
        {"input_images": 40},
        {"input_images": 40, "registered_images": -1},
        {"input_images": 40, "registered_images": "28"},
        {"input_images": True, "registered_images": True},
        # More registered than submitted can only mean a broken writer.
        {"input_images": 10, "registered_images": 11},
    ],
)
async def test_unusable_registration_is_dropped(
    client: AsyncClient, project: dict, registration: object
) -> None:
    job_id = await start_job(client, project["id"])
    write_manifest(project["id"], job_id, registration)
    await finish(client, job_id)

    assert (await client.get(f"/api/jobs/{job_id}")).json()["registration"] is None
