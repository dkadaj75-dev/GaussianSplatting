"""Reading a job's published artifacts off disk.

The worker publishes a finished scene into
``{STORAGE_DIR}/projects/{project_id}/jobs/{job_id}/output/`` (see
``worker/README.md``): typically ``output.ply`` plus a compressed
``scene.splat``, and — once WP 2.3 lands — a ``manifest.json`` describing them.

Listing tolerates both worlds: the manifest is used when present and parseable,
and a plain directory scan is the fallback, so the API works against a worker of
either vintage.

This module holds the logic itself so that both read paths onto that directory —
the owner's ``/api/jobs/{job_id}/artifacts`` and the read-only
``/api/shared/{token}/artifacts`` (WP 6.1) — share one implementation, including
the traversal guards. A second copy of those guards is exactly the kind of thing
that drifts.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from fastapi.responses import FileResponse

from app.schemas import ArtifactRead
from app.storage import resolve_within

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = "manifest.json"

# Splat payloads are opaque binaries; browsers must never try to sniff or
# render them, and the splat loader streams them with Range requests.
ARTIFACT_MEDIA_TYPE = "application/octet-stream"


def format_of(filename: str) -> str:
    """Lower-case extension without the dot (``scene.splat`` → ``splat``)."""
    return Path(filename).suffix.lstrip(".").lower() or "bin"


def read_manifest(directory: Path) -> dict[str, dict[str, Any]]:
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


def list_artifacts(directory: Path) -> list[ArtifactRead]:
    """Every regular file in ``directory``, enriched from the manifest."""
    try:
        entries = sorted(directory.iterdir(), key=lambda p: p.name)
    except (FileNotFoundError, NotADirectoryError):
        return []
    except OSError:  # pragma: no cover - permission edge case
        logger.warning("Could not read artifact directory %s", directory)
        return []

    manifest = read_manifest(directory)

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
                    else format_of(entry.name)
                ),
            )
        )
    return artifacts


def artifact_file_response(directory: Path, filename: str, *, context: str) -> FileResponse:
    """Stream one artifact out of ``directory``, or raise 400/404.

    ``resolve_within`` is the single traversal guard for both read paths: a name
    that is not a bare filename, or that resolves (via ``..`` or a symlink)
    outside ``directory``, is a 400 — it never reaches the filesystem read.
    ``FileResponse`` sets Content-Length and answers Range requests, which the
    progressive splat loader relies on.

    ``context`` names the owner of the directory in the 404 detail ("job abc",
    "this share link").
    """
    path = resolve_within(directory, filename)
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid artifact filename",
        )
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Artifact {path.name} not found for {context}",
        )

    return FileResponse(
        path,
        media_type=ARTIFACT_MEDIA_TYPE,
        filename=path.name,
        content_disposition_type="inline",
    )
