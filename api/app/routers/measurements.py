"""CRUD for measurements attached to a project (PLAN.md §4)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlmodel import select

from app.deps import ProjectDep, SessionDep
from app.models import Measurement, MeasurementKind
from app.schemas import MeasurementCreate, MeasurementRead, MeasurementUpdate

router = APIRouter(prefix="/api/projects/{project_id}/measurements", tags=["measurements"])


def _get_or_404(session: SessionDep, project_id: str, measurement_id: str) -> Measurement:
    measurement = session.get(Measurement, measurement_id)
    if measurement is None or measurement.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Measurement {measurement_id} not found",
        )
    return measurement


@router.post("", response_model=MeasurementRead, status_code=status.HTTP_201_CREATED)
def create_measurement(
    payload: MeasurementCreate, project: ProjectDep, session: SessionDep
) -> Measurement:
    measurement = Measurement(
        project_id=project.id,
        kind=payload.kind,
        points=payload.points,
        value=payload.value,
        unit=payload.unit,
        label=payload.label,
    )
    session.add(measurement)
    session.commit()
    session.refresh(measurement)
    return measurement


@router.get("", response_model=list[MeasurementRead])
def list_measurements(
    project: ProjectDep,
    session: SessionDep,
    kind: MeasurementKind | None = Query(default=None),
) -> list[Measurement]:
    statement = select(Measurement).where(Measurement.project_id == project.id)
    if kind is not None:
        statement = statement.where(Measurement.kind == kind)
    return list(session.exec(statement.order_by(Measurement.created_at)).all())


@router.get("/{measurement_id}", response_model=MeasurementRead)
def get_measurement(measurement_id: str, project: ProjectDep, session: SessionDep) -> Measurement:
    return _get_or_404(session, project.id, measurement_id)


@router.patch("/{measurement_id}", response_model=MeasurementRead)
def update_measurement(
    measurement_id: str,
    payload: MeasurementUpdate,
    project: ProjectDep,
    session: SessionDep,
) -> Measurement:
    measurement = _get_or_404(session, project.id, measurement_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(measurement, field, value)
    session.add(measurement)
    session.commit()
    session.refresh(measurement)
    return measurement


@router.delete("/{measurement_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_measurement(measurement_id: str, project: ProjectDep, session: SessionDep) -> Response:
    measurement = _get_or_404(session, project.id, measurement_id)
    session.delete(measurement)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
