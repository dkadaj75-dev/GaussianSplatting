"""CRUD for projects (a project == one scene)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Response, status
from sqlmodel import delete, select

from app.deps import ProjectDep, SessionDep, SettingsDep
from app.models import Job, Measurement, Photo, Project, ProjectStatus
from app.schemas import ProjectCreate, ProjectRead, ProjectUpdate
from app.storage import delete_project_files

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: SessionDep) -> Project:
    project = Project(name=payload.name, status=payload.status)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.get("", response_model=list[ProjectRead])
def list_projects(
    session: SessionDep,
    status_filter: ProjectStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[Project]:
    statement = select(Project)
    if status_filter is not None:
        statement = statement.where(Project.status == status_filter)
    statement = statement.order_by(Project.created_at.desc()).offset(offset).limit(limit)
    return list(session.exec(statement).all())


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project: ProjectDep) -> Project:
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(payload: ProjectUpdate, project: ProjectDep, session: SessionDep) -> Project:
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(project, field, value)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project: ProjectDep, session: SessionDep, settings: SettingsDep) -> Response:
    """Delete a project along with its photos, jobs and measurements.

    Cascade is done explicitly because SQLite does not enforce foreign keys by
    default.
    """
    project_id = project.id
    session.exec(delete(Photo).where(Photo.project_id == project_id))
    session.exec(delete(Job).where(Job.project_id == project_id))
    session.exec(delete(Measurement).where(Measurement.project_id == project_id))
    session.delete(project)
    session.commit()

    delete_project_files(settings.storage_dir, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
