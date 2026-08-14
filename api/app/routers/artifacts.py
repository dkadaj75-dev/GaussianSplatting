"""Job artifact listing and download.

The worker publishes a finished scene into
``{STORAGE_DIR}/projects/{project_id}/jobs/{job_id}/output/`` (see
``worker/README.md``): typically ``output.ply`` plus a compressed
``scene.splat``, and — once WP 2.3 lands — a ``manifest.json`` describing them.

This router is the browser's read path onto that directory. Listing tolerates
both worlds: the manifest is used when present and parseable, and a plain
directory scan is the fallback, so the API works against a worker of either
vintage.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.deps import SessionDep, SettingsDep
from app.models import Job
from app.schemas import ArtifactRead
from app.storage import job_output_dir, resolve_within

logger = logging.getLogger(__name__)

router = APIRouter(tags=["jobs"])

MANIFEST_FILENAME = "manifest.json"

# Splat payloads are opaque binaries; browsers must never try to sniff or
# render them, and the splat loader streams them with Range requests.
ARTIFACT_MEDIA_TYPE = "application/octet-stream"


def _get_job_or_404(session: SessionDep, job_id: str) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} not found",
        )
    return job


def _format_of(filename: str) -> str:
    """Lower-case extension without the dot (``scene.splat`` → ``splat``)."""
    return Path(filename).suffix.lstrip(".").lower() or "bin"


def _read_manifest(directory: Path) -> dict[str, dict[str, Any]]:
    """Return ``{filename: entry}`` from ``manifest.json``, or ``{}``.

    Accepts either ``{"artifacts": [...]}`` or a bare list, with entries keyed
    by ``filename``/``name``/``path``. A malformed manifest is logged and
    ignored rather than failing the request — the directory scan below is
    always authoritative about what actually exists.
    """
    path = directory / MANIFEST_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Ignoring unreadable %s in %s", MANIFEST_FILENAME, directory)
        return {}

    entries: Any = raw.get("artifacts", raw.get("files")) if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("filename") or entry.get("name") or entry.get("path")
        if not isinstance(name, str) or not name:
            continue
        # Manifest names are metadata: only the basename is ever trusted.
        result[Path(name).name] = entry
    return result


def _list_artifacts(directory: Path) -> list[ArtifactRead]:
    """Every regular file in ``directory``, enriched from the manifest."""
    try:
        entries = sorted(directory.iterdir(), key=lambda p: p.name)
    except (FileNotFoundError, NotADirectoryError):
        return []
    except OSError:  # pragma: no cover - permission edge case
        logger.warning("Could not read artifact directory %s", directory)
        return []

    manifest = _read_manifest(directory)

    artifacts: list[ArtifactRead] = []
    for entry in entries:
        if entry.name == MANIFEST_FILENAME or not entry.is_file():
            continue
        described = manifest.get(entry.name, {})
        declared_format = described.get("format")
        artifacts.append(
            ArtifactRead(
                filename=entry.name,
                bytes=entry.stat().st_size,
                format=(
                    declared_format.lower()
                    if isinstance(declared_format, str) and declared_format
                    else _format_of(entry.name)
                ),
            )
        )
    return artifacts


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
    return _list_artifacts(job_output_dir(settings.storage_dir, job.project_id, job.id))


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
    normalisation. ``FileResponse`` sets Content-Length and answers Range
    requests, which the progressive splat loader relies on.
    """
    job = _get_job_or_404(session, job_id)
    directory = job_output_dir(settings.storage_dir, job.project_id, job.id)

    path = resolve_within(directory, filename)
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid artifact filename",
        )
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Artifact {path.name} not found for job {job_id}",
        )

    return FileResponse(
        path,
        media_type=ARTIFACT_MEDIA_TYPE,
        filename=path.name,
        content_disposition_type="inline",
    )
