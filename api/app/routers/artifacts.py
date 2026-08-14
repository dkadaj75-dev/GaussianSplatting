"""Job artifact listing and download — the owner's read path onto a job's
published output directory.

The filesystem logic (manifest handling, directory scan, traversal guards)
lives in ``app.artifact_service``, which the read-only share endpoints
(``app.routers.shares``) reuse verbatim.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.artifact_service import ARTIFACT_MEDIA_TYPE, artifact_file_response, list_artifacts
from app.deps import SessionDep, SettingsDep
from app.models import Job
from app.schemas import ArtifactRead
from app.storage import job_output_dir

router = APIRouter(tags=["jobs"])


def _get_job_or_404(session: SessionDep, job_id: str) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} not found",
        )
    return job


@router.get("/api/jobs/{job_id}/artifacts", response_model=list[ArtifactRead])
def list_job_artifacts(
    job_id: str,
    session: SessionDep,
    settings: SettingsDep,
) -> list[ArtifactRead]:
    """List the files a job published.

    Returns an empty list for a job that has not published anything yet, so a
    client polling a running job gets ``200 []`` rather than a 404 it would
    have to special-case.
    """
    job = _get_job_or_404(session, job_id)
    return list_artifacts(job_output_dir(settings.storage_dir, job.project_id, job.id))


# HEAD as well as GET: streaming loaders probe size and Range support before
# downloading, and a 405 there costs a whole scene load. It is kept out of the
# schema so the two registrations do not collide on one operation id.
@router.head("/api/jobs/{job_id}/artifacts/{filename:path}", include_in_schema=False)
@router.get(
    "/api/jobs/{job_id}/artifacts/{filename:path}",
    response_class=FileResponse,
    responses={200: {"content": {ARTIFACT_MEDIA_TYPE: {}}}},
)
def download_job_artifact(
    job_id: str,
    filename: str,
    session: SessionDep,
    settings: SettingsDep,
) -> FileResponse:
    """Stream one artifact.

    Declared with a ``:path`` converter so that traversal attempts reach this
    handler and are rejected explicitly, instead of relying on the router's URL
    normalisation.
    """
    job = _get_job_or_404(session, job_id)
    directory = job_output_dir(settings.storage_dir, job.project_id, job.id)
    return artifact_file_response(directory, filename, context=f"job {job_id}")
