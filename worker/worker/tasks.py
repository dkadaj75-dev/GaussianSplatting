"""Celery task entrypoint and Redis progress-event publication."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Protocol

from celery import Celery
from redis import Redis

from .backends import ColmapOpenSplatBackend, FakeBackend, JobContext, PipelineBackend
from .config import Settings, get_settings


class EventPublisher(Protocol):
    def publish(self, event: dict[str, Any]) -> None:
        """Publish one serializable job-progress event."""


class RedisPublisher:
    """Publish events to the Redis pub/sub channel consumed by the API."""

    def __init__(self, redis_url: str) -> None:
        self._redis = Redis.from_url(redis_url)

    def publish(self, event: dict[str, Any]) -> None:
        self._redis.publish(f"jobs:{event['job_id']}", json.dumps(event))


class InMemoryPublisher:
    """Event collector for unit tests and synchronous local experiments."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def publish(self, event: dict[str, Any]) -> None:
        self.events.append(event.copy())


_initial_settings = get_settings()
celery_app = Celery("splatscene_worker")
celery_app.conf.update(
    broker_url=_initial_settings.redis_url,
    result_backend=_initial_settings.redis_url,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
)
# Conventional alias so ``celery -A worker.tasks worker`` discovers this app.
app = celery_app


def get_backend(settings: Settings) -> PipelineBackend:
    return FakeBackend() if settings.pipeline_backend == "fake" else ColmapOpenSplatBackend()


def get_publisher(settings: Settings) -> EventPublisher:
    return RedisPublisher(settings.redis_url)


def _job_context(job_id: str, project_id: str, params: dict[str, Any], settings: Settings) -> JobContext:
    job_root = settings.storage_dir / "projects" / project_id / "jobs" / job_id
    input_dir = job_root / "input"
    work_dir = job_root / "work"
    output_dir = job_root / "output"
    for directory in (input_dir, work_dir, output_dir):
        directory.mkdir(parents=True, exist_ok=True)
    return JobContext(job_id, project_id, input_dir, work_dir, output_dir, params)


def run_pipeline_sync(
    job_id: str,
    project_id: str,
    params: dict[str, Any] | None,
    *,
    backend: PipelineBackend | None = None,
    publisher: EventPublisher | None = None,
    settings: Settings | None = None,
) -> dict[str, str]:
    """Run the pipeline synchronously; injectable dependencies make it unit-testable."""
    settings = settings or get_settings()
    backend = backend or get_backend(settings)
    publisher = publisher or get_publisher(settings)
    job = _job_context(job_id, project_id, dict(params or {}), settings)
    current_stage = "ingest"
    last_progress: dict[str, float] = {}

    def emit(stage: str, progress: float, message: str, status: str = "running") -> None:
        normalized_progress = max(0.0, min(1.0, float(progress)))
        if status == "running":
            last_progress[stage] = normalized_progress
        publisher.publish(
            {
                "job_id": job_id,
                "stage": stage,
                "progress": normalized_progress,
                "status": status,
                "message": message,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )

    stages = (
        ("ingest", backend.ingest),
        ("sfm", backend.run_sfm),
        ("train", backend.train),
        ("compress", backend.compress),
        ("publish", backend.publish),
    )
    try:
        for current_stage, operation in stages:
            operation(job, emit)
    except Exception as exc:
        emit(
            current_stage,
            last_progress.get(current_stage, 0.0),
            str(exc) or exc.__class__.__name__,
            status="failed",
        )
        raise

    emit("publish", 1.0, "Pipeline complete", status="done")
    return {"job_id": job_id, "output_dir": str(job.output_dir)}


@celery_app.task(name="worker.run_pipeline")
def run_pipeline(job_id: str, project_id: str, params: dict[str, Any] | None = None) -> dict[str, str]:
    """Celery entrypoint for an ordered scene processing job."""
    return run_pipeline_sync(job_id, project_id, params)
