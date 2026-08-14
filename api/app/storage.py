"""Local-filesystem photo + job-artifact storage.

Layout:

* photos    — ``{STORAGE_DIR}/{project_id}/{photo_id}{ext}``
* artifacts — ``{STORAGE_DIR}/projects/{project_id}/jobs/{job_id}/output/*``
  (written by the worker; see ``worker/README.md``)

================================ INTEGRATION POINT ============================
PLAN.md §1 targets MinIO/S3 with presigned uploads for multi-node deploys.
Keep ``save_upload`` as the seam: swap its body for a presign+PUT flow and the
routers stay unchanged.
===============================================================================
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import BinaryIO

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_FILENAME_LEN = 200
_CHUNK = 1024 * 1024


class PhotoTooLargeError(Exception):
    """Raised when an upload exceeds MAX_PHOTO_BYTES."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"Upload exceeds the {limit} byte limit")
        self.limit = limit


def sanitize_filename(filename: str | None) -> str:
    """Strip directory components and hostile characters from a client name.

    The result is only ever used as *metadata* — the on-disk name is derived
    from the photo's UUID — but it still gets echoed back to browsers.
    """
    name = os.path.basename(filename or "").strip() or "upload"
    name = _UNSAFE.sub("_", name).lstrip(".") or "upload"
    return name[:_MAX_FILENAME_LEN]


def project_dir(storage_dir: Path, project_id: str) -> Path:
    return Path(storage_dir).expanduser() / project_id


def job_output_dir(storage_dir: Path, project_id: str, job_id: str) -> Path:
    """Directory the worker publishes a job's artifacts into.

    Mirrors ``worker.tasks._job_context`` exactly — the two are joined only by
    this convention, so it is spelled out in one place on each side.
    """
    return Path(storage_dir).expanduser() / "projects" / project_id / "jobs" / job_id / "output"


def resolve_within(directory: Path, filename: str) -> Path | None:
    """Resolve ``filename`` inside ``directory``, or ``None`` if it escapes.

    Two independent guards, because either alone has known bypasses:

    1. the name must be a bare filename (no separators, no ``..``, not hidden
       traversal like ``..%2f`` once the server has decoded it), and
    2. the resolved path's parent must be the resolved directory — which also
       catches a symlink inside the output dir pointing elsewhere.
    """
    name = filename.strip()
    if not name or name in {".", ".."}:
        return None
    if "/" in name or "\\" in name or "\x00" in name:
        return None
    if os.path.basename(name) != name:  # pragma: no cover - covered by the checks above
        return None

    base = Path(directory).expanduser()
    try:
        resolved_base = base.resolve(strict=False)
        candidate = (base / name).resolve(strict=False)
    except OSError:  # pragma: no cover - unreadable mount point
        return None

    if candidate.parent != resolved_base:
        return None
    return candidate


def save_upload(
    storage_dir: Path,
    project_id: str,
    photo_id: str,
    original_filename: str | None,
    source: BinaryIO,
    max_bytes: int | None = None,
) -> tuple[Path, int]:
    """Stream ``source`` to disk. Returns ``(path, size_in_bytes)``.

    Streaming (rather than ``read()``) keeps memory flat for 40-megapixel
    phone photos. Raises :class:`PhotoTooLargeError` — after removing the
    partial file — once ``max_bytes`` is exceeded, so an oversized upload never
    fills the disk.
    """
    directory = project_dir(storage_dir, project_id)
    directory.mkdir(parents=True, exist_ok=True)

    suffix = Path(sanitize_filename(original_filename)).suffix.lower()[:16]
    destination = directory / f"{photo_id}{suffix}"

    written = 0
    try:
        with destination.open("wb") as handle:
            while True:
                chunk = source.read(_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if max_bytes is not None and written > max_bytes:
                    raise PhotoTooLargeError(max_bytes)
                handle.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise

    return destination, written


def delete_project_files(storage_dir: Path, project_id: str) -> None:
    """Remove a project's photo directory; a missing directory is fine."""
    shutil.rmtree(project_dir(storage_dir, project_id), ignore_errors=True)


def delete_file(path: str | Path) -> None:
    """Delete a single stored file, ignoring a missing one."""
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:  # pragma: no cover - permission/IO edge case
        pass
