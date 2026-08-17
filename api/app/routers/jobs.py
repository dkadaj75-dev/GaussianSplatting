"""Job creation and lookup.

A Job is one run of the processing pipeline (ingest → sfm → train → compress
→ publish) for a project.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, status
from sqlmodel import select

from app.artifact_service import read_manifest_registration
from app.config import get_settings
from app.deps import ProjectDep, SessionDep
from app.job_service import enqueue_job, publish_job_event
from app.models import Job, JobStatus, Photo, ProjectStatus
from app.schemas import JobCreate, JobRead, RegistrationRead
from app.storage import job_output_dir

router = APIRouter(tags=["jobs"])


def with_registration(job: Job) -> JobRead:
    """Attach the manifest's registration counts to a finished job."""
    payload = JobRead.model_validate(job)
    if job.status != JobStatus.done:
        return payload
    output_dir = job_output_dir(get_settings().storage_dir, job.project_id, job.id)
    counts = read_manifest_registration(output_dir)
    if counts is not None:
        payload.registration = RegistrationRead(**counts)
    return payload


@router.post(
    "/api/projects/{project_id}/jobs",
    response_model=JobRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_job(payload: JobCreate, project: ProjectDep, session: SessionDep) -> Job:
    """Create a queued job for a project.

    Requires at least one uploaded photo — a pipeline run on an empty set can
    only fail, and failing here gives the user a far better message.
    """
    photo_count = len(session.exec(select(Photo.id).where(Photo.project_id == project.id)).all())
    if photo_count == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project has no photos; upload photos before starting a job",
        )

    job = Job(
        project_id=project.id,
        stage=payload.stage,
        status=JobStatus.queued,
        progress=0.0,
        message=payload.message,
        params=payload.params or None,
    )
    session.add(job)

    project.status = ProjectStatus.processing
    session.add(project)
    session.commit()
    session.refresh(job)

    # Hand the job to the worker (QUEUE_MODE=celery); a no-op under the default
    # QUEUE_MODE=none, where the job stays 'queued' for /api/dev/jobs/{id}/advance.
    # Off-loaded to a thread: the broker handshake is blocking socket I/O.
    task_id = await asyncio.to_thread(enqueue_job, job)
    if task_id:
        job.task_id = task_id
        session.add(job)
        session.commit()
        session.refresh(job)

    await publish_job_event(job, event_type="created")
    return job


@router.get("/api/projects/{project_id}/jobs", response_model=list[JobRead])
def list_project_jobs(
    project: ProjectDep,
    session: SessionDep,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[JobRead]:
    statement = (
        select(Job).where(Job.project_id == project.id).order_by(Job.created_at.desc()).limit(limit)
    )
    return [with_registration(job) for job in session.exec(statement).all()]


@router.get("/api/jobs/{job_id}", response_model=JobRead)
def get_job(job_id: str, session: SessionDep) -> JobRead:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} not found",
        )
    return with_registration(job)
