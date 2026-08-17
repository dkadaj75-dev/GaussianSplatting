"""SQLModel tables — the persistence layer for projects, photos, jobs and measurements.

IDs are UUID4 strings so the client can reference an entity across services
(worker, storage paths, share links) without a central sequence.
"""

from __future__ import annotations

import secrets
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


def as_utc(value: datetime) -> datetime:
    """Tag a naive timestamp as UTC.

    SQLite drops tzinfo on the way in, so rows come back naive. Comparing such
    a value against :func:`utcnow` (aware) raises ``TypeError``, and serializing
    it would let browsers read ``2026-08-14T19:57:19`` as *local* time.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


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
    # SQLite dev databases have no migrations. Delete the dev DB after a schema
    # bump so create_all() can create newly added columns.
    calibration: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON, nullable=True))


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
    # Pipeline tuning forwarded verbatim to the worker (downscale, iterations,
    # matcher, marker_length_m, …). The API stays agnostic about keys so worker
    # capabilities can evolve without an API release; validation is size-only.
    params: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON, nullable=True))


SHARE_TOKEN_BYTES = 32


def new_share_token() -> str:
    """A fresh share token: 32 random bytes (256 bits) as 43 URL-safe chars."""
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


class ShareLink(SQLModel, table=True):
    """A capability URL granting read-only access to one project's scene.

    "Send this link to a colleague" (PLAN.md §3.5) — whoever holds the token can
    read the scene summary, its artifacts and its measurements, and nothing else:
    no other project, no mutating verb, no internal storage path.

    ============================ TOKEN STORAGE TRADEOFF =======================
    The token is stored **in the clear**, not hashed. A hash would mean the
    plaintext exists only in the 201 response, and the owner's own listing
    (``GET /api/projects/{id}/shares``) could never show a link again — the user
    would have to revoke and re-share every time they lost the URL, which is the
    common case for a link mailed weeks ago. Since the token is a bearer
    capability that travels in a URL (browser history, chat logs, proxy logs), a
    hash also protects far less than it does for a password: the URL itself is
    the secret everywhere else along the path.

    What carries the security instead:
      * 256 bits of ``secrets`` entropy — unguessable, never enumerable;
      * least privilege — the shared surface is read-only and single-project;
      * revocation (``revoked_at``) and optional expiry (``expires_at``), both
        checked on every request;
      * no PII in the shared payload.

    When user accounts land (and the DB starts holding credentials worth
    stealing), switch to storing ``sha256(token)`` plus a short non-secret
    prefix for display, and show the plaintext once at creation.
    ===========================================================================
    """

    __tablename__ = "share_links"

    id: str = Field(default_factory=new_id, primary_key=True)
    # Indexed + unique: token lookup is the hot path on every shared request.
    token: str = Field(default_factory=new_share_token, index=True, unique=True, max_length=64)
    project_id: str = Field(foreign_key="projects.id", index=True)
    created_at: datetime = Field(default_factory=utcnow, nullable=False)
    # Both nullable: a link with neither set is valid forever until revoked.
    expires_at: datetime | None = Field(default=None)
    revoked_at: datetime | None = Field(default=None)
    # The owner's own note about the recipient, e.g. "Site A hand-off".
    label: str | None = Field(default=None, max_length=200)

    def is_active(self, now: datetime | None = None) -> bool:
        """Usable right now — neither revoked nor past its expiry."""
        if self.revoked_at is not None:
            return False
        if self.expires_at is None:
            return True
        return as_utc(self.expires_at) > (now or utcnow())


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
