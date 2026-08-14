"""CRUD for projects (a project == one scene)."""

from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import func
from sqlmodel import Session, delete, select

from app.deps import ProjectDep, SessionDep, SettingsDep
from app.models import Job, Measurement, Photo, Project, ProjectStatus, ShareLink, utcnow
from app.schemas import CalibrationCreate, ProjectCreate, ProjectRead, ProjectUpdate
from app.storage import delete_project_files

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _photo_counts(session: Session, project_ids: list[str]) -> dict[str, int]:
    """Photos per project in one grouped query (never one query per row)."""
    if not project_ids:
        return {}
    statement = (
        select(Photo.project_id, func.count(Photo.id))
        .where(Photo.project_id.in_(project_ids))
        .group_by(Photo.project_id)
    )
    return {project_id: count for project_id, count in session.exec(statement).all()}


def _read(project: Project, photo_count: int) -> ProjectRead:
    return ProjectRead(**project.model_dump(), photo_count=photo_count)


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: SessionDep) -> ProjectRead:
    project = Project(name=payload.name, status=payload.status)
    session.add(project)
    session.commit()
    session.refresh(project)
    return _read(project, 0)


@router.get("", response_model=list[ProjectRead])
def list_projects(
    session: SessionDep,
    status_filter: ProjectStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[ProjectRead]:
    statement = select(Project)
    if status_filter is not None:
        statement = statement.where(Project.status == status_filter)
    statement = statement.order_by(Project.created_at.desc()).offset(offset).limit(limit)
    projects = list(session.exec(statement).all())

    counts = _photo_counts(session, [project.id for project in projects])
    return [_read(project, counts.get(project.id, 0)) for project in projects]


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project: ProjectDep, session: SessionDep) -> ProjectRead:
    return _read(project, _photo_counts(session, [project.id]).get(project.id, 0))


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(payload: ProjectUpdate, project: ProjectDep, session: SessionDep) -> ProjectRead:
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(project, field, value)
    session.add(project)
    session.commit()
    session.refresh(project)
    return _read(project, _photo_counts(session, [project.id]).get(project.id, 0))


@router.put("/{project_id}/calibration", response_model=ProjectRead)
def set_calibration(
    payload: CalibrationCreate, project: ProjectDep, session: SessionDep
) -> ProjectRead:
    """Set the known-distance scale without changing scene-space measurements."""
    scene_distance = math.dist(payload.point_a, payload.point_b)
    if scene_distance < 1e-9:
        # Pydantic handles malformed points; this handles valid but coincident ones.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Calibration points must be at least 1e-9 scene units apart",
        )

    project.calibration = {
        "scale": payload.real_distance_m / scene_distance,
        "method": "known_distance",
        "reference": payload.model_dump(),
        # JSON cannot persist datetime objects directly. The response schema
        # restores this ISO string as a UTC-aware datetime.
        "calibrated_at": utcnow().isoformat(),
    }
    session.add(project)
    session.commit()
    session.refresh(project)
    return _read(project, _photo_counts(session, [project.id]).get(project.id, 0))


@router.delete("/{project_id}/calibration", response_model=ProjectRead)
def clear_calibration(project: ProjectDep, session: SessionDep) -> ProjectRead:
    """Clear calibration. Clearing an already uncalibrated project is a no-op."""
    if project.calibration is not None:
        project.calibration = None
        session.add(project)
        session.commit()
        session.refresh(project)
    return _read(project, _photo_counts(session, [project.id]).get(project.id, 0))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project: ProjectDep, session: SessionDep, settings: SettingsDep) -> Response:
    """Delete a project along with its photos, jobs, measurements and shares.

    Cascade is done explicitly because SQLite does not enforce foreign keys by
    default. Share links go too: a link outliving its project would be a token
    pointing at nothing (the shared endpoints 404 on it either way, but a dead
    row is not worth keeping).
    """
    project_id = project.id
    session.exec(delete(Photo).where(Photo.project_id == project_id))
    session.exec(delete(Job).where(Job.project_id == project_id))
    session.exec(delete(Measurement).where(Measurement.project_id == project_id))
    session.exec(delete(ShareLink).where(ShareLink.project_id == project_id))
    session.delete(project)
    session.commit()

    delete_project_files(settings.storage_dir, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
