"""Job state transitions and progress publication.

Single place where a Job row is mutated and the corresponding event is pushed
onto the bus, so REST endpoints, the dev-advance helper and (later) the Celery
result handler cannot drift apart.
"""

from __future__ import annotations

from sqlmodel import Session

from app.events import job_event_bus
from app.models import JOB_STAGE_ORDER, Job, JobStage, JobStatus, utcnow
from app.schemas import JobEvent

# How far a single dev-advance call moves a stage.
DEFAULT_PROGRESS_STEP = 0.25


def job_to_event(job: Job, event_type: str = "progress") -> JobEvent:
    return JobEvent(
        type=event_type,
        job_id=job.id,
        project_id=job.project_id,
        stage=job.stage,
        progress=job.progress,
        status=job.status,
        message=job.message,
        updated_at=job.updated_at,
    )


async def publish_job_event(job: Job, event_type: str = "progress") -> None:
    """Fan out the job's current state to WebSocket subscribers."""
    await job_event_bus.publish(job.id, job_to_event(job, event_type).model_dump(mode="json"))


def enqueue_job(job: Job) -> str | None:
    """Hand the job to the processing queue.

    ============================ INTEGRATION POINT ============================
    WP 0.3/0.4 replace this no-op with a real Celery dispatch:

        from app.celery_app import celery_app
        result = celery_app.send_task("worker.pipeline.run", args=[job.id])
        return result.id

    The returned task id is stored on ``Job.task_id``. Until then jobs simply
    stay in ``queued`` and are driven by POST /api/dev/jobs/{id}/advance.
    ===========================================================================
    """
    return None


def apply_job_update(
    session: Session,
    job: Job,
    *,
    stage: JobStage | None = None,
    progress: float | None = None,
    status: JobStatus | None = None,
    message: str | None = None,
) -> Job:
    """Apply an explicit update to a job and persist it."""
    if stage is not None:
        job.stage = stage
    if progress is not None:
        job.progress = max(0.0, min(1.0, progress))
    if status is not None:
        job.status = status
    if message is not None:
        job.message = message

    _stamp_lifecycle(job)
    job.updated_at = utcnow()

    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def advance_job(session: Session, job: Job) -> Job:
    """Move a job one step forward along the pipeline.

    Steps progress by ``DEFAULT_PROGRESS_STEP`` within a stage; on reaching
    1.0 the job rolls over to the next stage at progress 0.0, and completing
    the final stage marks it ``done``.
    """
    if job.status in (JobStatus.done, JobStatus.failed):
        return job

    if job.status == JobStatus.queued:
        job.status = JobStatus.running
        job.progress = 0.0
    else:
        next_progress = round(job.progress + DEFAULT_PROGRESS_STEP, 6)
        if next_progress >= 1.0:
            index = JOB_STAGE_ORDER.index(job.stage)
            if index + 1 < len(JOB_STAGE_ORDER):
                job.stage = JOB_STAGE_ORDER[index + 1]
                job.progress = 0.0
            else:
                job.progress = 1.0
                job.status = JobStatus.done
        else:
            job.progress = next_progress

    _stamp_lifecycle(job)
    job.updated_at = utcnow()

    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def _stamp_lifecycle(job: Job) -> None:
    if job.status == JobStatus.running and job.started_at is None:
        job.started_at = utcnow()
    if job.status in (JobStatus.done, JobStatus.failed):
        if job.finished_at is None:
            job.finished_at = utcnow()
    else:
        job.finished_at = None
