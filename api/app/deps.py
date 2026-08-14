"""Shared FastAPI dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Path, status
from sqlmodel import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.models import Project

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_project_or_404(
    session: SessionDep,
    project_id: Annotated[str, Path(description="Project UUID")],
) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project {project_id} not found",
        )
    return project


ProjectDep = Annotated[Project, Depends(get_project_or_404)]


def require_dev_mode(settings: SettingsDep) -> Settings:
    """Guard for the /api/dev/* helpers."""
    if not settings.dev_mode:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dev endpoints are disabled (set DEV_MODE=1 to enable)",
        )
    return settings
