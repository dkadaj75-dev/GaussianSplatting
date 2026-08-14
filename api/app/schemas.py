"""Request/response schemas — the public API contract.

Kept separate from the SQLModel tables so the storage layout can evolve
(storage_path, task_id, …) without leaking into the client contract.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.models import JobStage, JobStatus, MeasurementKind, ProjectStatus


def _as_utc(value: datetime) -> datetime:
    """Tag naive timestamps as UTC.

    SQLite drops tzinfo on the way in, so rows come back naive. Without this,
    responses would serialize as ``2026-08-14T19:57:19`` and browsers would
    read them as *local* time.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


UTCDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Projects ---------------------------------------------------------------


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    status: ProjectStatus = ProjectStatus.draft


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    status: ProjectStatus | None = None


class ProjectRead(ORMModel):
    id: str
    name: str
    created_at: UTCDatetime
    status: ProjectStatus
    # Computed per request (there is no photo_count column): the project list is
    # the client's main screen and it would otherwise need one request per row.
    photo_count: int = Field(default=0, ge=0)


# --- Photos -----------------------------------------------------------------


class PhotoRead(ORMModel):
    id: str
    project_id: str
    filename: str
    size: int
    uploaded_at: UTCDatetime
    content_type: str


# --- Jobs -------------------------------------------------------------------


class JobCreate(BaseModel):
    """A job always enters at ``queued``; the stage is where it will start."""

    stage: JobStage = JobStage.ingest
    message: str | None = Field(default=None, max_length=2000)


class JobRead(ORMModel):
    id: str
    project_id: str
    stage: JobStage
    progress: float
    status: JobStatus
    message: str | None
    created_at: UTCDatetime
    updated_at: UTCDatetime
    started_at: UTCDatetime | None
    finished_at: UTCDatetime | None
    task_id: str | None


class JobEvent(BaseModel):
    """Payload pushed over ``/ws/jobs/{job_id}``.

    ``type`` is ``snapshot`` for the first frame after connecting and
    ``progress`` for subsequent updates, so clients can tell a replayed state
    from a live transition.
    """

    type: str = "progress"
    job_id: str
    project_id: str
    stage: JobStage
    progress: float
    status: JobStatus
    message: str | None = None
    updated_at: UTCDatetime


class ArtifactRead(BaseModel):
    """One file published by a job (``GET /api/jobs/{id}/artifacts``).

    ``format`` is the lower-case extension (``splat``, ``ply``, ``ksplat``,
    ``spz``) so the client can pick a loader without re-parsing filenames.
    """

    filename: str
    bytes: int = Field(ge=0, description="Size on disk, bytes")
    format: str


class DevAdvanceRequest(BaseModel):
    """Dev-only knob for driving a job forward without a worker.

    With no fields set the job advances by ``DEFAULT_PROGRESS_STEP`` and rolls
    over to the next stage when it reaches 1.0.
    """

    stage: JobStage | None = None
    progress: float | None = Field(default=None, ge=0.0, le=1.0)
    status: JobStatus | None = None
    message: str | None = Field(default=None, max_length=2000)


# --- Measurements -----------------------------------------------------------


class MeasurementCreate(BaseModel):
    kind: MeasurementKind = MeasurementKind.distance
    points: list[Any] = Field(default_factory=list)
    value: float | None = None
    unit: str = Field(default="m", max_length=16)
    label: str | None = Field(default=None, max_length=200)


class MeasurementUpdate(BaseModel):
    kind: MeasurementKind | None = None
    points: list[Any] | None = None
    value: float | None = None
    unit: str | None = Field(default=None, max_length=16)
    label: str | None = Field(default=None, max_length=200)


class MeasurementRead(ORMModel):
    id: str
    project_id: str
    kind: MeasurementKind
    points: list[Any]
    value: float | None
    unit: str
    label: str | None
    created_at: UTCDatetime


# --- Misc -------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    dev_mode: bool
