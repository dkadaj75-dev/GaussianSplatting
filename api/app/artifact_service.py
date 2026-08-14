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
import math
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


def read_manifest_calibration(directory: Path) -> dict[str, Any] | None:
    """Return the worker's ``calibration`` block, or ``None``.

    The worker writes this when it solved scale from an ArUco marker (WP 5.1);
    it is absent, ``null``, or malformed whenever it could not. Anything other
    than a usable positive finite scale reads as "no calibration" — an
    automatic figure is never worth failing a request over.
    """
    path = directory / MANIFEST_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        logger.warning("Ignoring unreadable %s in %s", MANIFEST_FILENAME, directory)
        return None

    if not isinstance(raw, dict):
        return None
    block = raw.get("calibration")
    if not isinstance(block, dict):
        return None

    scale = block.get("scale")
    if not isinstance(scale, int | float) or isinstance(scale, bool):
        return None
    scale = float(scale)
    if not math.isfinite(scale) or scale <= 0:
        return None

    calibration: dict[str, Any] = {"scale": scale, "method": "aruco"}
    for key in ("residual", "marker_length_m"):
        value = block.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
            calibration[key] = float(value)
    sample_count = block.get("sample_count")
    if isinstance(sample_count, int) and not isinstance(sample_count, bool) and sample_count >= 0:
        calibration["sample_count"] = sample_count
    dictionary = block.get("marker_dictionary")
    if isinstance(dictionary, str) and dictionary:
        calibration["marker_dictionary"] = dictionary
    return calibration


def read_manifest_registration(directory: Path) -> dict[str, int] | None:
    """Return the worker's ``registration`` counts, or ``None``.

    How many of the submitted photos SfM actually placed is the single most
    useful diagnostic a user can be given about a finished scene — "28 of 40
    registered" explains a hole in the reconstruction that no error message
    would, because the job itself succeeded. The worker records it in
    ``manifest.json``; reading it here keeps that fact available long after the
    live progress messages have scrolled away.
    """
    path = directory / MANIFEST_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        logger.warning("Ignoring unreadable %s in %s", MANIFEST_FILENAME, directory)
        return None

    if not isinstance(raw, dict):
        return None
    block = raw.get("registration")
    if not isinstance(block, dict):
        return None

    counts: dict[str, int] = {}
    for key in ("input_images", "registered_images"):
        value = block.get(key)
        # bool is an int subclass; a JSON true here means a broken writer.
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return None
        counts[key] = value
    if counts["registered_images"] > counts["input_images"]:
        logger.warning("Discarding impossible registration counts in %s", directory)
        return None
    return counts
