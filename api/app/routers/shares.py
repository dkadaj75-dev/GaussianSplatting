"""Read-only share links (ROADMAP WP 6.1, PLAN.md §3.5).

Two surfaces, deliberately kept apart:

* **owner** — ``/api/projects/{project_id}/shares`` and ``/api/shares/{id}``:
  mint, list and revoke links for a project the caller owns.
* **public** — everything under ``/api/shared/{token}``: what the recipient of
  the link can read. Registered on its own router that declares *only* GET and
  HEAD, so "no mutating verb is reachable with a share token" is a property of
  the routing table rather than of everyone's diligence.

Every rejection on the public surface is a 404 with the same body — unknown,
revoked, expired and "project since deleted" are indistinguishable from
outside. A 403 would confirm that a link once existed, which is exactly the
thing a revoked link must stop doing.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlmodel import Session, select

from app.artifact_service import ARTIFACT_MEDIA_TYPE, artifact_file_response, list_artifacts
from app.deps import ProjectDep, SessionDep, SettingsDep
from app.models import Job, JobStatus, Measurement, Photo, Project, ShareLink, utcnow
from app.schemas import (
    ArtifactRead,
    MeasurementRead,
    SharedJobRead,
    SharedProjectRead,
    ShareLinkCreate,
    ShareLinkRead,
)
from app.storage import job_output_dir

# Client-facing route the token is pasted into — a web app path, not an API
# one. The API's own public endpoints live under /api/shared/{token}.
SHARE_URL_PREFIX = "/shared"

router = APIRouter(tags=["shares"])
public_router = APIRouter(prefix="/api/shared/{token}", tags=["shared"])


# --- Owner surface ----------------------------------------------------------


def _read(share: ShareLink) -> ShareLinkRead:
    return ShareLinkRead(
        id=share.id,
        token=share.token,
        url_path=f"{SHARE_URL_PREFIX}/{share.token}",
        label=share.label,
        created_at=share.created_at,
        expires_at=share.expires_at,
        revoked_at=share.revoked_at,
    )


@router.post(
    "/api/projects/{project_id}/shares",
    response_model=ShareLinkRead,
    status_code=status.HTTP_201_CREATED,
)
def create_share_link(
    project: ProjectDep,
    session: SessionDep,
    payload: ShareLinkCreate | None = None,
) -> ShareLinkRead:
    """Mint a read-only link for a project.

    The body is optional: no body at all means "never expires, no label". A
    project may hold several links (one per recipient), so each can be revoked
    on its own.
    """
    payload = payload or ShareLinkCreate()
    expires_at = (
        utcnow() + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days is not None
        else None
    )
    # The token comes from the model's default_factory (secrets.token_urlsafe):
    # 256 bits, so a collision on the unique index is not a case worth retrying.
    share = ShareLink(project_id=project.id, label=payload.label, expires_at=expires_at)
    session.add(share)
    session.commit()
    session.refresh(share)
    return _read(share)


@router.get("/api/projects/{project_id}/shares", response_model=list[ShareLinkRead])
def list_share_links(project: ProjectDep, session: SessionDep) -> list[ShareLinkRead]:
    """All links ever minted for a project, newest first.

    Revoked and expired ones are included — the owner's screen wants the full
    history, and ``revoked_at``/``expires_at`` say which are still live.
    """
    statement = (
        select(ShareLink)
        .where(ShareLink.project_id == project.id)
        .order_by(ShareLink.created_at.desc())
    )
    return [_read(share) for share in session.exec(statement).all()]


@router.delete("/api/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(share_id: str, session: SessionDep) -> Response:
    """Revoke a link. Idempotent: revoking twice is another 204 and keeps the
    original ``revoked_at``, so "when did we cut this off?" stays answerable.

    The row is kept rather than deleted — an audit trail of who was shared what,
    and a guarantee the token is never re-issued.
    """
    share = session.get(ShareLink, share_id)
    if share is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Share link {share_id} not found",
        )
    if share.revoked_at is None:
        share.revoked_at = utcnow()
        session.add(share)
        session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Public surface ---------------------------------------------------------


@dataclass(frozen=True)
class SharedScene:
    """What a valid token resolves to."""

    share: ShareLink
    project: Project


def _not_found() -> HTTPException:
    """The one rejection the public surface ever emits."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Share link not found",
    )


def get_shared_scene(
    session: SessionDep,
    token: Annotated[str, Path(description="Share token")],
) -> SharedScene:
    """Resolve a share token to its project, or 404.

    The indexed equality lookup is the normal path and is *not* constant-time —
    a B-tree probe leaks a little timing regardless of what we do here. That is
    not a practical oracle against 256 bits of entropy (an attacker would need
    to steer a search through ~2^256 keys), but the confirmation compare below
    is done with :func:`secrets.compare_digest` anyway: it costs nothing, it
    documents the intent, and it keeps the property if the lookup is ever
    replaced by something that scans candidates.
    """
    share = session.exec(select(ShareLink).where(ShareLink.token == token)).first()
    # Encoded rather than compared as str: compare_digest rejects non-ASCII
    # text, and the token half of this comparison is client-supplied.
    if share is None or not secrets.compare_digest(
        share.token.encode("utf-8"), token.encode("utf-8")
    ):
        raise _not_found()
    if not share.is_active():
        raise _not_found()

    project = session.get(Project, share.project_id)
    if project is None:  # project deleted out from under a live link
        raise _not_found()
    return SharedScene(share=share, project=project)


SharedSceneDep = Annotated[SharedScene, Depends(get_shared_scene)]


def _done_jobs(session: Session, project_id: str, limit: int | None = None) -> list[Job]:
    """A project's finished jobs, newest first.

    Ordered by ``finished_at`` falling back to ``created_at``: a job written by
    an older worker may have no finish timestamp, and NULL ordering differs
    between SQLite and PostgreSQL — coalescing sidesteps both.
    """
    statement = (
        select(Job)
        .where(Job.project_id == project_id, Job.status == JobStatus.done)
        .order_by(func.coalesce(Job.finished_at, Job.created_at).desc(), Job.created_at.desc())
    )
    if limit is not None:
        statement = statement.limit(limit)
    return list(session.exec(statement).all())


def _latest_done_job(session: Session, project_id: str) -> Job | None:
    """The project's most recent finished job — the one a shared scene shows."""
    jobs = _done_jobs(session, project_id, limit=1)
    return jobs[0] if jobs else None


@public_router.get("", response_model=SharedProjectRead)
def get_shared_project(scene: SharedSceneDep, session: SessionDep) -> SharedProjectRead:
    """Scene summary for the holder of the link."""
    photo_count = session.exec(
        select(func.count(Photo.id)).where(Photo.project_id == scene.project.id)
    ).one()

    return SharedProjectRead(
        name=scene.project.name,
        created_at=scene.project.created_at,
        status=scene.project.status,
        photo_count=photo_count,
        calibration=scene.project.calibration,
        jobs=[
            SharedJobRead(
                id=job.id,
                stage=job.stage,
                created_at=job.created_at,
                finished_at=job.finished_at,
            )
            for job in _done_jobs(session, scene.project.id)
        ],
        label=scene.share.label,
        expires_at=scene.share.expires_at,
    )


@public_router.get("/artifacts", response_model=list[ArtifactRead])
def list_shared_artifacts(
    scene: SharedSceneDep,
    session: SessionDep,
    settings: SettingsDep,
) -> list[ArtifactRead]:
    """Artifacts of the project's most recent finished job.

    A project with no finished job yet lists ``[]`` rather than 404-ing: the
    link is valid, the scene simply has nothing published (same contract as the
    owner's per-job listing).
    """
    job = _latest_done_job(session, scene.project.id)
    if job is None:
        return []
    return list_artifacts(job_output_dir(settings.storage_dir, job.project_id, job.id))


# HEAD as well as GET, for the same reason as the owner endpoint: streaming
# loaders probe size and Range support before downloading.
@public_router.head("/artifacts/{filename:path}", include_in_schema=False)
@public_router.get(
    "/artifacts/{filename:path}",
    response_class=FileResponse,
    responses={200: {"content": {ARTIFACT_MEDIA_TYPE: {}}}},
)
def download_shared_artifact(
    filename: str,
    scene: SharedSceneDep,
    session: SessionDep,
    settings: SettingsDep,
) -> FileResponse:
    """Stream one artifact of the most recent finished job.

    Same guards as the owner path — they are the same function — so a traversal
    attempt is a 400 here too, and never reads a byte outside the job's own
    output directory.
    """
    job = _latest_done_job(session, scene.project.id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This scene has no published artifacts",
        )
    directory = job_output_dir(settings.storage_dir, job.project_id, job.id)
    return artifact_file_response(directory, filename, context="this share link")


@public_router.get("/measurements", response_model=list[MeasurementRead])
def list_shared_measurements(scene: SharedSceneDep, session: SessionDep) -> list[Measurement]:
    """The scene's measurements, oldest first — read-only by construction: this
    router has no POST/PATCH/DELETE for a client to reach."""
    statement = (
        select(Measurement)
        .where(Measurement.project_id == scene.project.id)
        .order_by(Measurement.created_at)
    )
    return list(session.exec(statement).all())
