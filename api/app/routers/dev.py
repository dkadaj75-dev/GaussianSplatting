"""Dev-only helpers (enabled with DEV_MODE=1).

These exist so the whole progress path — REST → event bus → WebSocket → UI —
can be demoed and tested before the Celery worker (WP 0.3) exists. They are
404s in any deployment that does not set DEV_MODE.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session

from app.deps import SessionDep, require_dev_mode
from app.job_service import advance_job, apply_job_update, publish_job_event
from app.models import Job, JobStatus, Project, ProjectStatus
from app.schemas import DevAdvanceRequest, JobRead

router = APIRouter(
    prefix="/api/dev",
    tags=["dev"],
    dependencies=[Depends(require_dev_mode)],
)


@router.post("/jobs/{job_id}/advance", response_model=JobRead)
async def advance_job_endpoint(
    job_id: str,
    session: SessionDep,
    payload: DevAdvanceRequest | None = None,
) -> Job:
    """Push a job forward and publish the resulting event.

    With an empty body the job steps along the canonical stage order; with
    explicit ``stage``/``progress``/``status``/``message`` fields it jumps
    straight to that state (handy for exercising the failure UI).
    """
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} not found",
        )

    explicit = payload is not None and payload.model_dump(exclude_unset=True)
    if explicit:
        job = apply_job_update(
            session,
            job,
            stage=payload.stage,
            progress=payload.progress,
            status=payload.status,
            message=payload.message,
        )
    else:
        job = advance_job(session, job)

    _sync_project_status(session, job)
    await publish_job_event(job)
    return job


def _sync_project_status(session: Session, job: Job) -> None:
    """Mirror terminal job states onto the project, like the worker will."""
    project = session.get(Project, job.project_id)
    if project is None:
        return
    if job.status == JobStatus.done:
        project.status = ProjectStatus.ready
    elif job.status == JobStatus.failed:
        project.status = ProjectStatus.failed
    else:
        project.status = ProjectStatus.processing
    session.add(project)
    session.commit()
