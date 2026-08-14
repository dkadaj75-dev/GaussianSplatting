"""Job state transitions and progress publication.

Single place where a Job row is mutated and the corresponding event is pushed
onto the bus, so REST endpoints, the dev-advance helper and (later) the Celery
result handler cannot drift apart.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

from sqlmodel import Session

from app.artifact_service import read_manifest_calibration
from app.config import QueueMode, Settings, get_settings
from app.events import job_event_bus
from app.models import JOB_STAGE_ORDER, Job, JobStage, JobStatus, Project, ProjectStatus, utcnow
from app.schemas import JobEvent
from app.storage import job_output_dir

logger = logging.getLogger(__name__)

# How far a single dev-advance call moves a stage.
DEFAULT_PROGRESS_STEP = 0.25

# Bounded connection-retry policy: a dead broker must not hold a request open.
BROKER_RETRY_POLICY = {
    "max_retries": 2,
    "interval_start": 0.0,
    "interval_step": 0.2,
    "interval_max": 0.5,
}
BROKER_TRANSPORT_OPTIONS = {"socket_timeout": 5.0, "socket_connect_timeout": 5.0}


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


# --- Queue dispatch (WP 0.4) ------------------------------------------------
#
# The API never imports the worker package: it publishes a message addressed by
# *task name* ("worker.run_pipeline") to the shared Redis broker. That keeps the
# two deployables independent — the worker can be rewritten, re-versioned or run
# from a different image without the API knowing anything but the name + args.


class JobDispatcher(Protocol):
    """Pluggable queue backend. ``dispatch`` returns the task id, if any."""

    def dispatch(self, job: Job) -> str | None: ...


class NullDispatcher:
    """No-op queue used in dev and tests (QUEUE_MODE=none).

    Jobs stay ``queued`` and are driven by POST /api/dev/jobs/{id}/advance.
    """

    def dispatch(self, job: Job) -> str | None:
        return None


def _build_celery_app(broker_url: str) -> Any:
    """Create a send-only Celery client.

    Imported lazily so that neither the default (QUEUE_MODE=none) code path nor
    the test suite requires celery to be installed. Patched in tests.
    """
    from celery import Celery  # noqa: PLC0415 - deliberate lazy import

    client = Celery("splatscene_api", broker=broker_url)
    client.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        broker_transport_options=BROKER_TRANSPORT_OPTIONS,
        broker_connection_retry_on_startup=True,
    )
    return client


class CeleryDispatcher:
    """Dispatch by task name over the Celery/Redis broker (QUEUE_MODE=celery)."""

    def __init__(
        self,
        broker_url: str,
        *,
        task_name: str = "worker.run_pipeline",
        queue: str | None = None,
    ) -> None:
        self.broker_url = broker_url
        self.task_name = task_name
        self.queue = queue
        self._app: Any | None = None

    def _client(self) -> Any:
        if self._app is None:
            self._app = _build_celery_app(self.broker_url)
        return self._app

    def dispatch(self, job: Job) -> str | None:
        params: dict[str, Any] = {"stage": JobStage(job.stage).value}
        options: dict[str, Any] = {"retry": True, "retry_policy": BROKER_RETRY_POLICY}
        if self.queue:
            options["queue"] = self.queue
        result = self._client().send_task(
            self.task_name,
            args=[job.id, job.project_id, params],
            **options,
        )
        return getattr(result, "id", None)


_dispatcher_override: JobDispatcher | None = None
_dispatcher_cache: tuple[tuple[str, str, str | None, str | None], JobDispatcher] | None = None


def set_dispatcher(dispatcher: JobDispatcher | None) -> None:
    """Force a dispatcher (tests / embedding), or ``None`` to fall back to env."""
    global _dispatcher_override, _dispatcher_cache
    _dispatcher_override = dispatcher
    _dispatcher_cache = None


def get_dispatcher(settings: Settings | None = None) -> JobDispatcher:
    """Return the dispatcher selected by QUEUE_MODE.

    The instance is memoized per configuration, so a Celery client (and its
    connection pool) is created once, while a settings change — as in tests —
    transparently rebuilds it.
    """
    global _dispatcher_cache
    if _dispatcher_override is not None:
        return _dispatcher_override

    settings = settings or get_settings()
    key = (
        settings.queue_mode.value,
        settings.broker_url,
        settings.celery_task_name,
        settings.celery_queue,
    )
    if _dispatcher_cache is not None and _dispatcher_cache[0] == key:
        return _dispatcher_cache[1]

    dispatcher: JobDispatcher
    if settings.queue_mode == QueueMode.celery:
        dispatcher = CeleryDispatcher(
            settings.broker_url,
            task_name=settings.celery_task_name,
            queue=settings.celery_queue,
        )
    else:
        dispatcher = NullDispatcher()

    _dispatcher_cache = (key, dispatcher)
    return dispatcher


def enqueue_job(job: Job, settings: Settings | None = None) -> str | None:
    """Hand the job to the processing queue; returns the task id (or ``None``).

    Blocking call — invoke it from a worker thread inside async routes.

    A broker failure is *not* fatal: the Job row already exists, so the error is
    logged and the job stays ``queued`` (visible in the UI, retryable) rather
    than 500-ing a request whose side effects were already committed.
    """
    dispatcher = get_dispatcher(settings)
    try:
        return dispatcher.dispatch(job)
    except Exception:  # pragma: no cover - broker outage path
        logger.exception("Failed to dispatch job %s to the queue", job.id)
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


def sync_project_status(session: Session, job: Job) -> None:
    """Mirror a job's state onto its project (done → ready, failed → failed)."""
    project = session.get(Project, job.project_id)
    if project is None:
        return
    if job.status == JobStatus.done:
        project.status = ProjectStatus.ready
        apply_manifest_calibration(project, job)
    elif job.status == JobStatus.failed:
        project.status = ProjectStatus.failed
    else:
        project.status = ProjectStatus.processing
    session.add(project)
    session.commit()


def apply_manifest_calibration(
    project: Project, job: Job, settings: Settings | None = None
) -> bool:
    """Adopt the worker's automatic scale for a finished job, if any.

    A manual ``known_distance`` calibration always wins: the user measured
    something real and typed it in, so a later marker-derived estimate must not
    silently overwrite it. An earlier ``aruco`` figure is refreshed, because
    that is just a newer reconstruction of the same automatic measurement.
    Returns whether the project's calibration changed.
    """
    existing = project.calibration
    if isinstance(existing, dict) and existing.get("method") != "aruco":
        return False

    settings = settings or get_settings()
    output_dir = job_output_dir(settings.storage_dir, job.project_id, job.id)
    calibration = read_manifest_calibration(output_dir)
    if calibration is None:
        return False

    calibration["calibrated_at"] = utcnow().isoformat()
    project.calibration = calibration
    logger.info(
        "Applied automatic calibration to project %s from job %s (scale=%g)",
        project.id,
        job.id,
        calibration["scale"],
    )
    return True


def _stamp_lifecycle(job: Job) -> None:
    if job.status == JobStatus.running and job.started_at is None:
        job.started_at = utcnow()
    if job.status in (JobStatus.done, JobStatus.failed):
        if job.finished_at is None:
            job.finished_at = utcnow()
    else:
        job.finished_at = None
