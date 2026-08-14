"""SQLModel tables — the persistence layer for projects, photos, jobs and measurements.

IDs are UUID4 strings so the client can reference an entity across services
(worker, storage paths, share links) without a central sequence.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    """Timezone-aware UTC now (stored naive-UTC by SQLite, serialized as ISO)."""
    return datetime.now(UTC)


class ProjectStatus(str, Enum):
    """Lifecycle of a scene, driven by the pipeline jobs it owns."""

    draft = "draft"  # created, photos may still be uploading
    processing = "processing"  # a job is running
    ready = "ready"  # a published splat artifact exists
    failed = "failed"


class JobStage(str, Enum):
    """Pipeline stages, in order (PLAN.md §1)."""

    ingest = "ingest"
    sfm = "sfm"
    train = "train"
    compress = "compress"
    publish = "publish"


# Canonical stage order, used by the dev advance endpoint and by the worker.
JOB_STAGE_ORDER: tuple[JobStage, ...] = (
    JobStage.ingest,
    JobStage.sfm,
    JobStage.train,
    JobStage.compress,
    JobStage.publish,
)


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    failed = "failed"
    done = "done"


class MeasurementKind(str, Enum):
    """Measurement tools (PLAN.md §4). ``scale_reference`` is the
    known-distance calibration input rather than a user-facing measurement."""

    distance = "distance"
    polyline = "polyline"
    height = "height"
    angle = "angle"
    area = "area"
    scale_reference = "scale_reference"


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str = Field(index=True, max_length=200)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)
    status: ProjectStatus = Field(default=ProjectStatus.draft, index=True)


class Photo(SQLModel, table=True):
    __tablename__ = "photos"

    id: str = Field(default_factory=new_id, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    filename: str = Field(max_length=512)
    size: int = Field(default=0, description="Size on disk, bytes")
    uploaded_at: datetime = Field(default_factory=utcnow, nullable=False)
    # Relative to STORAGE_DIR; kept out of the API surface's required fields so
    # the storage backend can move to S3/MinIO without breaking clients.
    content_type: str = Field(default="application/octet-stream", max_length=128)
    storage_path: str = Field(default="", max_length=1024)


class Job(SQLModel, table=True):
    __tablename__ = "jobs"

    id: str = Field(default_factory=new_id, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    stage: JobStage = Field(default=JobStage.ingest, index=True)
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    status: JobStatus = Field(default=JobStatus.queued, index=True)
    message: str | None = Field(default=None, max_length=2000)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=utcnow, nullable=False)
    started_at: datetime | None = Field(default=None)
    finished_at: datetime | None = Field(default=None)
    # Celery task id — populated once the queue integration lands (WP 0.4).
    task_id: str | None = Field(default=None, max_length=128, index=True)


class Measurement(SQLModel, table=True):
    __tablename__ = "measurements"

    id: str = Field(default_factory=new_id, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    kind: MeasurementKind = Field(default=MeasurementKind.distance, index=True)
    # List of [x, y, z] scene-space points picked in the viewer.
    points: list[Any] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    value: float | None = Field(default=None, description="Computed magnitude (length/angle/area)")
    unit: str = Field(default="m", max_length=16)
    label: str | None = Field(default=None, max_length=200)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)
