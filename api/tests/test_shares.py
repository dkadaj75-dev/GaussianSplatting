"""Read-only share links (WP 6.1).

Two halves: the owner minting/listing/revoking links, and what the recipient of
a link can — and above all cannot — reach with it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlmodel import Session

from app import db as db_module
from app.config import Settings
from app.models import ShareLink

SPLAT_BODY = b"\x00\x01\x02\x03" * 32
PLY_BODY = b"ply\nformat ascii 1.0\nend_header\n"

DISTANCE = {
    "kind": "distance",
    "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 1.5]],
    "value": 1.5,
    "unit": "m",
    "label": "Anchor spacing",
}

# Every public endpoint, as a template over the token.
SHARED_PATHS = (
    "/api/shared/{token}",
    "/api/shared/{token}/artifacts",
    "/api/shared/{token}/artifacts/scene.splat",
    "/api/shared/{token}/measurements",
)


# --- helpers ----------------------------------------------------------------


def output_dir(settings: Settings, project_id: str, job_id: str) -> Path:
    """The directory the worker would publish into (see worker/README.md)."""
    path = settings.storage_dir.expanduser() / "projects" / project_id / "jobs" / job_id / "output"
    path.mkdir(parents=True, exist_ok=True)
    return path


async def make_project(client: AsyncClient, name: str = "Other scene") -> dict:
    response = await client.post("/api/projects", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def make_photo(client: AsyncClient, project: dict) -> None:
    from tests.conftest import upload_files

    response = await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    assert response.status_code == 201, response.text


async def make_done_job(client: AsyncClient, project: dict) -> dict:
    """Create a job and drive it to ``done`` through the dev endpoint."""
    created = await client.post(f"/api/projects/{project['id']}/jobs", json={})
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]

    advanced = await client.post(
        f"/api/dev/jobs/{job_id}/advance",
        json={"stage": "publish", "progress": 1.0, "status": "done"},
    )
    assert advanced.status_code == 200, advanced.text
    return advanced.json()


async def publish_scene(
    client: AsyncClient,
    project: dict,
    env: Settings,
    filename: str = "scene.splat",
    body: bytes = SPLAT_BODY,
) -> dict:
    """A finished job with one artifact on disk."""
    job = await make_done_job(client, project)
    (output_dir(env, job["project_id"], job["id"]) / filename).write_bytes(body)
    return job


async def make_share(client: AsyncClient, project: dict, **payload) -> dict:
    response = await client.post(f"/api/projects/{project['id']}/shares", json=payload or {})
    assert response.status_code == 201, response.text
    return response.json()


def set_expiry(share_id: str, expires_at: datetime | None) -> None:
    """Rewrite a link's expiry directly — no clock freezing needed."""
    with Session(db_module.get_engine()) as session:
        share = session.get(ShareLink, share_id)
        assert share is not None
        share.expires_at = expires_at
        session.add(share)
        session.commit()


# --- owner: creation --------------------------------------------------------


async def test_create_share_returns_a_usable_token_and_url_path(
    client: AsyncClient, project: dict
) -> None:
    body = await make_share(client, project, label="Site A hand-off")

    assert body["label"] == "Site A hand-off"
    assert body["expires_at"] is None
    assert body["revoked_at"] is None
    assert datetime.fromisoformat(body["created_at"]).utcoffset() == UTC.utcoffset(None)
    # secrets.token_urlsafe(32) → 43 URL-safe characters.
    assert len(body["token"]) >= 43
    assert body["url_path"] == f"/shared/{body['token']}"

    assert (await client.get(f"/api/shared/{body['token']}")).status_code == 200


async def test_create_share_accepts_an_empty_body(client: AsyncClient, project: dict) -> None:
    response = await client.post(f"/api/projects/{project['id']}/shares")
    assert response.status_code == 201, response.text
    assert response.json()["label"] is None


async def test_expires_in_days_sets_an_expiry(client: AsyncClient, project: dict) -> None:
    body = await make_share(client, project, expires_in_days=7)

    expires_at = datetime.fromisoformat(body["expires_at"])
    assert abs(expires_at - (datetime.now(UTC) + timedelta(days=7))) < timedelta(minutes=1)
    assert (await client.get(f"/api/shared/{body['token']}")).status_code == 200


async def test_every_link_gets_its_own_token(client: AsyncClient, project: dict) -> None:
    first = await make_share(client, project)
    second = await make_share(client, project)
    assert first["token"] != second["token"]
    assert first["id"] != second["id"]


@pytest.mark.parametrize("days", [0, -1, 4000])
async def test_absurd_expiry_is_422(client: AsyncClient, project: dict, days: int) -> None:
    response = await client.post(
        f"/api/projects/{project['id']}/shares", json={"expires_in_days": days}
    )
    assert response.status_code == 422


async def test_share_on_unknown_project_is_404(client: AsyncClient) -> None:
    assert (await client.post("/api/projects/nope/shares", json={})).status_code == 404
    assert (await client.get("/api/projects/nope/shares")).status_code == 404


# --- owner: listing and revocation ------------------------------------------


async def test_list_shares_is_newest_first_and_shows_the_tokens(
    client: AsyncClient, project: dict
) -> None:
    first = await make_share(client, project, label="one")
    second = await make_share(client, project, label="two")

    response = await client.get(f"/api/projects/{project['id']}/shares")
    assert response.status_code == 200
    listed = response.json()
    assert {entry["id"] for entry in listed} == {first["id"], second["id"]}
    # The owner sees their own tokens — that is what they copy and send.
    assert {entry["token"] for entry in listed} == {first["token"], second["token"]}
    assert all(entry["url_path"] == f"/shared/{entry['token']}" for entry in listed)


async def test_list_shares_is_scoped_to_one_project(client: AsyncClient, project: dict) -> None:
    mine = await make_share(client, project)
    other = await make_project(client)
    theirs = await make_share(client, other)

    listed = (await client.get(f"/api/projects/{project['id']}/shares")).json()
    assert [entry["id"] for entry in listed] == [mine["id"]]
    assert theirs["token"] not in {entry["token"] for entry in listed}


async def test_revoked_links_stay_listed(client: AsyncClient, project: dict) -> None:
    share = await make_share(client, project)
    await client.delete(f"/api/shares/{share['id']}")

    listed = (await client.get(f"/api/projects/{project['id']}/shares")).json()
    assert len(listed) == 1
    assert listed[0]["revoked_at"] is not None


async def test_revocation_is_idempotent_and_keeps_the_first_timestamp(
    client: AsyncClient, project: dict
) -> None:
    share = await make_share(client, project)

    first = await client.delete(f"/api/shares/{share['id']}")
    assert first.status_code == 204
    assert first.content == b""
    revoked_at = (await client.get(f"/api/projects/{project['id']}/shares")).json()[0]["revoked_at"]

    second = await client.delete(f"/api/shares/{share['id']}")
    assert second.status_code == 204
    again = (await client.get(f"/api/projects/{project['id']}/shares")).json()[0]["revoked_at"]
    assert again == revoked_at  # "when was this cut off?" stays answerable


async def test_revoke_unknown_share_is_404(client: AsyncClient) -> None:
    assert (await client.delete("/api/shares/nope")).status_code == 404


# --- public: the scene a recipient sees -------------------------------------


async def test_shared_summary_reports_the_scene_without_internals(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    await client.put(
        f"/api/projects/{project_with_photo['id']}/calibration",
        json={"point_a": [0, 0, 0], "point_b": [1, 0, 0], "real_distance_m": 0.5},
    )
    job = await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo, label="For the site engineer")

    response = await client.get(f"/api/shared/{share['token']}")
    assert response.status_code == 200
    body = response.json()

    assert body["name"] == "Balcony anchor detail"
    assert body["status"] == "ready"  # the done job synced the project status
    assert body["photo_count"] == 1
    assert body["calibration"]["scale"] == pytest.approx(0.5)
    assert body["calibration"]["method"] == "known_distance"
    assert [entry["id"] for entry in body["jobs"]] == [job["id"]]
    assert body["jobs"][0]["finished_at"] is not None
    assert body["label"] == "For the site engineer"
    assert body["expires_at"] is None
    assert datetime.fromisoformat(body["created_at"]).utcoffset() == UTC.utcoffset(None)

    # No storage paths, no internal handles.
    assert set(body) == {
        "name",
        "created_at",
        "status",
        "photo_count",
        "calibration",
        "jobs",
        "label",
        "expires_at",
    }
    assert set(body["jobs"][0]) == {"id", "stage", "created_at", "finished_at"}
    assert str(env.storage_dir) not in response.text
    assert "task_id" not in response.text
    assert project_with_photo["id"] not in response.text


async def test_shared_summary_lists_only_finished_jobs(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    done = await publish_scene(client, project_with_photo, env)
    queued = (await client.post(f"/api/projects/{project_with_photo['id']}/jobs", json={})).json()
    share = await make_share(client, project_with_photo)

    listed = (await client.get(f"/api/shared/{share['token']}")).json()["jobs"]
    assert [entry["id"] for entry in listed] == [done["id"]]
    assert queued["id"] not in {entry["id"] for entry in listed}


async def test_shared_artifacts_come_from_the_latest_finished_job(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    await publish_scene(client, project_with_photo, env, filename="old.splat", body=PLY_BODY)
    await publish_scene(client, project_with_photo, env, filename="scene.splat")
    share = await make_share(client, project_with_photo)

    response = await client.get(f"/api/shared/{share['token']}/artifacts")
    assert response.status_code == 200
    assert response.json() == [
        {"filename": "scene.splat", "bytes": len(SPLAT_BODY), "format": "splat"}
    ]


async def test_shared_artifacts_are_empty_before_anything_is_published(
    client: AsyncClient, project_with_photo: dict
) -> None:
    share = await make_share(client, project_with_photo)

    listing = await client.get(f"/api/shared/{share['token']}/artifacts")
    assert listing.status_code == 200
    assert listing.json() == []

    download = await client.get(f"/api/shared/{share['token']}/artifacts/scene.splat")
    assert download.status_code == 404


async def test_download_shared_artifact(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo)

    response = await client.get(f"/api/shared/{share['token']}/artifacts/scene.splat")
    assert response.status_code == 200
    assert response.content == SPLAT_BODY
    assert response.headers["content-type"] == "application/octet-stream"
    assert "scene.splat" in response.headers["content-disposition"]


async def test_shared_download_supports_range_and_head(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    """The progressive splat loader probes with HEAD and streams with Range."""
    await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo)
    url = f"/api/shared/{share['token']}/artifacts/scene.splat"

    ranged = await client.get(url, headers={"Range": "bytes=0-9"})
    assert ranged.status_code == 206
    assert ranged.content == SPLAT_BODY[:10]
    assert ranged.headers["content-range"] == f"bytes 0-9/{len(SPLAT_BODY)}"

    probed = await client.head(url)
    assert probed.status_code == 200
    assert probed.headers["content-length"] == str(len(SPLAT_BODY))
    assert probed.headers["accept-ranges"] == "bytes"
    assert probed.content == b""


async def test_shared_measurements_are_the_projects_own(client: AsyncClient, project: dict) -> None:
    created = (
        await client.post(f"/api/projects/{project['id']}/measurements", json=DISTANCE)
    ).json()
    share = await make_share(client, project)

    response = await client.get(f"/api/shared/{share['token']}/measurements")
    assert response.status_code == 200
    body = response.json()
    assert [entry["id"] for entry in body] == [created["id"]]
    assert body[0]["value"] == 1.5
    assert body[0]["label"] == "Anchor spacing"


# --- public: rejection cases ------------------------------------------------


@pytest.mark.parametrize("template", SHARED_PATHS)
async def test_unknown_token_is_404(client: AsyncClient, template: str) -> None:
    response = await client.get(template.format(token="not-a-real-token"))
    assert response.status_code == 404
    assert response.json()["detail"] == "Share link not found"


async def test_non_ascii_token_is_404_not_a_crash(client: AsyncClient) -> None:
    """The constant-time compare rejects non-ASCII text; it must never reach it
    as ``str`` and raise."""
    assert (await client.get("/api/shared/tökén")).status_code == 404


@pytest.mark.parametrize("template", SHARED_PATHS)
async def test_revoked_token_is_404_everywhere(
    client: AsyncClient, project_with_photo: dict, env: Settings, template: str
) -> None:
    await publish_scene(client, project_with_photo, env)
    await client.post(f"/api/projects/{project_with_photo['id']}/measurements", json=DISTANCE)
    share = await make_share(client, project_with_photo)
    assert (await client.get(template.format(token=share["token"]))).status_code == 200

    assert (await client.delete(f"/api/shares/{share['id']}")).status_code == 204

    response = await client.get(template.format(token=share["token"]))
    # 404, never 403: a revoked link must not confirm it ever existed.
    assert response.status_code == 404
    assert response.json()["detail"] == "Share link not found"
    assert SPLAT_BODY not in response.content


@pytest.mark.parametrize("template", SHARED_PATHS)
async def test_expired_token_is_404_everywhere(
    client: AsyncClient, project_with_photo: dict, env: Settings, template: str
) -> None:
    await publish_scene(client, project_with_photo, env)
    await client.post(f"/api/projects/{project_with_photo['id']}/measurements", json=DISTANCE)
    share = await make_share(client, project_with_photo, expires_in_days=1)
    assert (await client.get(template.format(token=share["token"]))).status_code == 200

    set_expiry(share["id"], datetime.now(UTC) - timedelta(seconds=1))

    response = await client.get(template.format(token=share["token"]))
    assert response.status_code == 404
    assert response.json()["detail"] == "Share link not found"
    assert SPLAT_BODY not in response.content


async def test_expiry_is_checked_against_now_not_at_creation(
    client: AsyncClient, project: dict
) -> None:
    share = await make_share(client, project, expires_in_days=1)

    set_expiry(share["id"], datetime.now(UTC) + timedelta(seconds=30))
    assert (await client.get(f"/api/shared/{share['token']}")).status_code == 200

    set_expiry(share["id"], datetime.now(UTC) - timedelta(seconds=30))
    assert (await client.get(f"/api/shared/{share['token']}")).status_code == 404


async def test_deleting_the_project_kills_its_links(
    client: AsyncClient, project_with_photo: dict
) -> None:
    share = await make_share(client, project_with_photo)
    assert (await client.delete(f"/api/projects/{project_with_photo['id']}")).status_code == 204

    assert (await client.get(f"/api/shared/{share['token']}")).status_code == 404


# --- public: isolation and traversal ----------------------------------------


async def test_a_token_for_one_project_cannot_read_another(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    """The whole point of a share link: it grants exactly one scene."""
    secret_project = await make_project(client, name="Confidential site B")
    await make_photo(client, secret_project)
    await publish_scene(client, secret_project, env, filename="scene.splat", body=b"SECRET-SPLAT")
    await client.post(
        f"/api/projects/{secret_project['id']}/measurements",
        json={**DISTANCE, "label": "Secret clearance"},
    )

    # A link on the *other* project, itself fully published.
    await publish_scene(client, project_with_photo, env, filename="mine.splat")
    await client.post(f"/api/projects/{project_with_photo['id']}/measurements", json=DISTANCE)
    share = await make_share(client, project_with_photo)
    token = share["token"]

    summary = await client.get(f"/api/shared/{token}")
    assert summary.json()["name"] == "Balcony anchor detail"
    assert "Confidential" not in summary.text

    artifacts = await client.get(f"/api/shared/{token}/artifacts")
    assert [entry["filename"] for entry in artifacts.json()] == ["mine.splat"]

    # Same filename as project B's artifact — it must not resolve to B's file.
    leaked = await client.get(f"/api/shared/{token}/artifacts/scene.splat")
    assert leaked.status_code == 404
    assert b"SECRET-SPLAT" not in leaked.content

    measurements = await client.get(f"/api/shared/{token}/measurements")
    assert [entry["label"] for entry in measurements.json()] == ["Anchor spacing"]
    assert all(entry["project_id"] == project_with_photo["id"] for entry in measurements.json())


async def test_traversal_through_the_shared_path_is_rejected(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    """Exactly the owner endpoint's guard — it is the same function."""
    await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo)
    secret = env.storage_dir.expanduser() / "secret.txt"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("password", encoding="utf-8")

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
        response = await client.get(f"/api/shared/{share['token']}/artifacts/{name}")
        assert response.status_code in (400, 404), f"{name} → {response.status_code}"
        assert b"password" not in response.content, name

    # The legitimate sibling still works.
    legit = await client.get(f"/api/shared/{share['token']}/artifacts/scene.splat")
    assert legit.status_code == 200


async def test_symlink_out_of_the_output_dir_is_rejected_on_the_shared_path(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    job = await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo)
    secret = env.storage_dir.expanduser() / "secret.txt"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("password", encoding="utf-8")
    directory = output_dir(env, job["project_id"], job["id"])
    (directory / "escape.splat").symlink_to(secret)

    response = await client.get(f"/api/shared/{share['token']}/artifacts/escape.splat")
    assert response.status_code == 400
    assert b"password" not in response.content


# --- public: the surface itself ---------------------------------------------


def test_no_mutating_verb_is_routed_under_shared(app: FastAPI) -> None:
    """A structural check: read-only is a property of the routing table."""
    shared = {
        route.path: set(route.methods)
        for route in app.routes
        if getattr(route, "path", "").startswith("/api/shared")
    }
    assert shared, "the public share routes are not registered"
    for path, methods in shared.items():
        assert methods <= {"GET", "HEAD"}, f"{path} exposes {methods}"


async def test_mutating_requests_with_a_token_are_refused(
    client: AsyncClient, project_with_photo: dict, env: Settings
) -> None:
    await publish_scene(client, project_with_photo, env)
    share = await make_share(client, project_with_photo)
    token = share["token"]

    attempts = [
        client.post(f"/api/shared/{token}/measurements", json=DISTANCE),
        client.patch(f"/api/shared/{token}", json={"name": "hijacked"}),
        client.put(f"/api/shared/{token}/calibration", json={}),
        client.delete(f"/api/shared/{token}"),
        client.delete(f"/api/shared/{token}/artifacts/scene.splat"),
        client.post(f"/api/shared/{token}/artifacts", json={}),
    ]
    for attempt in attempts:
        response = await attempt
        assert response.status_code in (404, 405), response.request.url

    # Nothing was mutated.
    assert (await client.get(f"/api/shared/{token}")).json()["name"] == "Balcony anchor detail"
    assert (await client.get(f"/api/shared/{token}/measurements")).json() == []


async def test_openapi_documents_the_shared_surface_as_read_only(client: AsyncClient) -> None:
    paths = (await client.get("/openapi.json")).json()["paths"]
    assert "/api/projects/{project_id}/shares" in paths
    assert "/api/shares/{share_id}" in paths
    for path, operations in paths.items():
        if path.startswith("/api/shared"):
            assert set(operations) <= {"get", "head"}, path
