"""Artifact listing and download for a finished job.

The worker is a separate process, so these tests fake its side of the contract:
files dropped into ``{STORAGE_DIR}/projects/{project}/jobs/{job}/output``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import Settings
from app.storage import resolve_within

PLY_BODY = b"ply\nformat ascii 1.0\nend_header\n"
SPLAT_BODY = b"\x00\x01\x02\x03" * 32


def output_dir(settings: Settings, project_id: str, job_id: str) -> Path:
    path = settings.storage_dir.expanduser() / "projects" / project_id / "jobs" / job_id / "output"
    path.mkdir(parents=True, exist_ok=True)
    return path


async def make_job(client: AsyncClient, project: dict) -> dict:
    response = await client.post(f"/api/projects/{project['id']}/jobs", json={})
    assert response.status_code == 201, response.text
    return response.json()


async def test_listing_is_empty_before_the_worker_publishes(
    client: AsyncClient, project_with_photo: dict
) -> None:
    job = await make_job(client, project_with_photo)

    response = await client.get(f"/api/jobs/{job['id']}/artifacts")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_artifacts_by_scanning_the_output_dir(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    directory = output_dir(env, job["project_id"], job["id"])
    (directory / "output.ply").write_bytes(PLY_BODY)
    (directory / "scene.splat").write_bytes(SPLAT_BODY)
    # Subdirectories the worker leaves behind are not artifacts.
    (directory / "logs").mkdir()

    response = await client.get(f"/api/jobs/{job['id']}/artifacts")
    assert response.status_code == 200
    assert response.json() == [
        {"filename": "output.ply", "bytes": len(PLY_BODY), "format": "ply"},
        {"filename": "scene.splat", "bytes": len(SPLAT_BODY), "format": "splat"},
    ]


async def test_manifest_supplies_the_format_and_is_not_itself_an_artifact(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    directory = output_dir(env, job["project_id"], job["id"])
    (directory / "scene.splat").write_bytes(SPLAT_BODY)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "artifacts": [
                    {"filename": "scene.splat", "format": "SPLAT"},
                    # Listed but never written: the directory is authoritative.
                    {"filename": "missing.ksplat", "format": "ksplat"},
                ]
            }
        ),
        encoding="utf-8",
    )

    body = (await client.get(f"/api/jobs/{job['id']}/artifacts")).json()
    assert body == [{"filename": "scene.splat", "bytes": len(SPLAT_BODY), "format": "splat"}]


async def test_malformed_manifest_falls_back_to_a_scan(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    directory = output_dir(env, job["project_id"], job["id"])
    (directory / "output.ply").write_bytes(PLY_BODY)
    (directory / "manifest.json").write_text("{not json", encoding="utf-8")

    body = (await client.get(f"/api/jobs/{job['id']}/artifacts")).json()
    assert [entry["filename"] for entry in body] == ["output.ply"]


async def test_list_artifacts_unknown_job_is_404(client: AsyncClient) -> None:
    assert (await client.get("/api/jobs/nope/artifacts")).status_code == 404


async def test_download_artifact(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    (output_dir(env, job["project_id"], job["id"]) / "scene.splat").write_bytes(SPLAT_BODY)

    response = await client.get(f"/api/jobs/{job['id']}/artifacts/scene.splat")
    assert response.status_code == 200
    assert response.content == SPLAT_BODY
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(SPLAT_BODY))
    assert "scene.splat" in response.headers["content-disposition"]


async def test_download_supports_range_requests(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    """The progressive splat loader streams with Range."""
    job = await make_job(client, project_with_photo)
    (output_dir(env, job["project_id"], job["id"]) / "scene.splat").write_bytes(SPLAT_BODY)

    response = await client.get(
        f"/api/jobs/{job['id']}/artifacts/scene.splat",
        headers={"Range": "bytes=0-9"},
    )
    assert response.status_code == 206
    assert response.content == SPLAT_BODY[:10]
    assert response.headers["content-range"] == f"bytes 0-9/{len(SPLAT_BODY)}"
    assert response.headers["accept-ranges"] == "bytes"


async def test_head_reports_the_size_without_a_body(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    """Streaming loaders probe with HEAD before downloading."""
    job = await make_job(client, project_with_photo)
    (output_dir(env, job["project_id"], job["id"]) / "scene.splat").write_bytes(SPLAT_BODY)

    response = await client.head(f"/api/jobs/{job['id']}/artifacts/scene.splat")
    assert response.status_code == 200
    assert response.headers["content-length"] == str(len(SPLAT_BODY))
    assert response.headers["accept-ranges"] == "bytes"
    assert response.content == b""


async def test_download_missing_artifact_is_404(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    output_dir(env, job["project_id"], job["id"])

    response = await client.get(f"/api/jobs/{job['id']}/artifacts/nothing.splat")
    assert response.status_code == 404


async def test_download_unknown_job_is_404(client: AsyncClient) -> None:
    assert (await client.get("/api/jobs/nope/artifacts/scene.splat")).status_code == 404


async def test_path_traversal_is_rejected(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    directory = output_dir(env, job["project_id"], job["id"])
    secret = env.storage_dir.expanduser() / "secret.txt"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("password", encoding="utf-8")
    (directory / "scene.splat").write_bytes(SPLAT_BODY)

    hostile = [
        "../../../../secret.txt",
        "..%2f..%2fsecret.txt",
        "%2e%2e%2fsecret.txt",
        "sub/scene.splat",
        r"..\secret.txt",
        "/etc/passwd",
        "",
    ]
    for name in hostile:
        response = await client.get(f"/api/jobs/{job['id']}/artifacts/{name}")
        assert response.status_code in (400, 404), f"{name} → {response.status_code}"
        assert b"password" not in response.content, name

    # The legitimate sibling still works.
    assert (await client.get(f"/api/jobs/{job['id']}/artifacts/scene.splat")).status_code == 200


@pytest.mark.parametrize(
    "name",
    ["", "  ", ".", "..", "../secret.txt", "sub/scene.splat", r"..\secret.txt", "/etc/passwd"],
)
def test_resolve_within_rejects_anything_but_a_bare_filename(tmp_path: Path, name: str) -> None:
    """Names an HTTP client would normalise away, checked at the seam itself."""
    assert resolve_within(tmp_path, name) is None


def test_resolve_within_accepts_a_plain_name(tmp_path: Path) -> None:
    assert resolve_within(tmp_path, "scene.splat") == (tmp_path / "scene.splat").resolve()


async def test_symlink_out_of_the_output_dir_is_rejected(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await make_job(client, project_with_photo)
    directory = output_dir(env, job["project_id"], job["id"])
    secret = env.storage_dir.expanduser() / "secret.txt"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("password", encoding="utf-8")
    (directory / "escape.splat").symlink_to(secret)

    response = await client.get(f"/api/jobs/{job['id']}/artifacts/escape.splat")
    assert response.status_code == 400
    assert b"password" not in response.content


async def test_artifacts_of_one_job_are_not_visible_from_another(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    first = await make_job(client, project_with_photo)
    second = await make_job(client, project_with_photo)
    (output_dir(env, first["project_id"], first["id"]) / "scene.splat").write_bytes(SPLAT_BODY)

    assert (await client.get(f"/api/jobs/{second['id']}/artifacts")).json() == []
    assert (await client.get(f"/api/jobs/{second['id']}/artifacts/scene.splat")).status_code == 404
