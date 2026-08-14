"""Request/response schemas — the public API contract.

Kept separate from the SQLModel tables so the storage layout can evolve
(storage_path, task_id, …) without leaking into the client contract.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, FiniteFloat

from app.models import JobStage, JobStatus, MeasurementKind, ProjectStatus, as_utc

# Naive rows from SQLite would otherwise serialize as ``2026-08-14T19:57:19``
# and be read as *local* time by browsers; ``as_utc`` tags them (app.models).
UTCDatetime = Annotated[datetime, AfterValidator(as_utc)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Projects ---------------------------------------------------------------


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    status: ProjectStatus = ProjectStatus.draft


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    status: ProjectStatus | None = None


Point3D = Annotated[list[FiniteFloat], Field(min_length=3, max_length=3)]


class CalibrationReference(BaseModel):
    point_a: Point3D
    point_b: Point3D
    real_distance_m: FiniteFloat


class CalibrationCreate(CalibrationReference):
    real_distance_m: FiniteFloat = Field(gt=0)


class CalibrationRead(BaseModel):
    """How a project's scene units map to meters.

    ``known_distance`` is the user picking two points and typing the real
    length; ``aruco`` is the worker solving scale from a printed marker of
    known size (WP 5.1). Only the manual method carries a two-point
    ``reference``; the automatic one reports the marker and how tightly the
    per-marker estimates agreed, which the UI turns into an uncertainty.
    """

    scale: FiniteFloat
    method: Literal["known_distance", "aruco"]
    reference: CalibrationReference | None = None
    calibrated_at: UTCDatetime
    residual: FiniteFloat | None = None
    sample_count: int | None = Field(default=None, ge=0)
    marker_length_m: FiniteFloat | None = None
    marker_dictionary: str | None = None


class ProjectRead(ORMModel):
    id: str
    name: str
    created_at: UTCDatetime
    status: ProjectStatus
    calibration: CalibrationRead | None = None
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


class RegistrationRead(BaseModel):
    """How many submitted photos SfM actually placed in the reconstruction."""

    input_images: int = Field(ge=0)
    registered_images: int = Field(ge=0)


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
    # Read from the job's manifest per request rather than stored: the output
    # directory is already the authority on what a finished job produced, and
    # the live progress message that carried this is long gone by then.
    registration: RegistrationRead | None = None


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


# --- Share links ------------------------------------------------------------


class ShareLinkCreate(BaseModel):
    """Body of ``POST /api/projects/{id}/shares`` (every field optional)."""

    label: str | None = Field(default=None, max_length=200)
    # Ten years is "effectively forever" while still bounding a typo like 1e9.
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ShareLinkRead(BaseModel):
    """Owner-facing view of a share link — token included.

    Only the project's owner reaches this schema (the two endpoints returning it
    live under ``/api/projects/{project_id}/shares``), so showing the token is
    the point: it is what the user copies and sends. See ``models.ShareLink``
    for why the token is stored in the clear.
    """

    id: str
    token: str
    # Client-facing route, not an API path: the viewer serves /shared/{token}.
    url_path: str
    label: str | None = None
    created_at: UTCDatetime
    expires_at: UTCDatetime | None = None
    revoked_at: UTCDatetime | None = None


class SharedJobRead(BaseModel):
    """A finished job as seen through a share link.

    Deliberately narrower than :class:`JobRead`: no ``task_id`` (an internal
    Celery handle) and no progress/status churn — a shared scene only ever shows
    runs that are ``done``.
    """

    id: str
    stage: JobStage
    created_at: UTCDatetime
    finished_at: UTCDatetime | None = None


class SharedProjectRead(BaseModel):
    """Public scene summary behind ``GET /api/shared/{token}``.

    Everything here is scene data the recipient is meant to see. Storage paths,
    photo filenames and Celery task ids are all absent, and so is the project
    id: the holder of a share token addresses the scene through the token.
    """

    name: str
    created_at: UTCDatetime
    status: ProjectStatus
    photo_count: int = Field(default=0, ge=0)
    # The calibration badge (PLAN.md §5) matters just as much to the recipient:
    # it tells them whether "412 mm" is trustworthy.
    calibration: CalibrationRead | None = None
    jobs: list[SharedJobRead] = Field(default_factory=list)
    # About the link itself, so the viewer can title the page and warn on expiry.
    label: str | None = None
    expires_at: UTCDatetime | None = None


# --- Misc -------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    dev_mode: bool
