"""Photo upload + listing for a project."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from sqlmodel import select

from app.deps import ProjectDep, SessionDep, SettingsDep
from app.models import Photo, new_id
from app.schemas import PhotoRead
from app.storage import PhotoTooLargeError, delete_file, sanitize_filename, save_upload

router = APIRouter(prefix="/api/projects/{project_id}/photos", tags=["photos"])


def _resolve_content_type(upload: UploadFile) -> str:
    """Trust the declared type, falling back to the extension.

    Browsers routinely send ``application/octet-stream`` for gallery picks on
    Android, so a bare declared type is not enough to reject on.
    """
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    if declared and declared != "application/octet-stream":
        return declared
    guessed, _ = mimetypes.guess_type(upload.filename or "")
    return (guessed or declared or "application/octet-stream").lower()


@router.post("", response_model=list[PhotoRead], status_code=status.HTTP_201_CREATED)
async def upload_photos(
    project: ProjectDep,
    session: SessionDep,
    settings: SettingsDep,
    files: Annotated[list[UploadFile], File(description="One or more image files")],
) -> list[Photo]:
    """Upload one or more photos (multipart/form-data, repeated field ``files``).

    Files are stored at ``{STORAGE_DIR}/{project_id}/{photo_id}{ext}`` and a
    Photo row is recorded per file. The whole batch is rejected if any file
    fails validation, so the client never has to reconcile a partial upload.
    """
    if not files:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No files supplied",
        )

    allowed = settings.allowed_image_type_set
    prepared: list[tuple[UploadFile, str, str]] = []
    for upload in files:
        content_type = _resolve_content_type(upload)
        if content_type not in allowed:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=(
                    f"Unsupported content type '{content_type}' for "
                    f"'{upload.filename}'. Allowed: {sorted(allowed)}"
                ),
            )
        prepared.append((upload, content_type, sanitize_filename(upload.filename)))

    photos: list[Photo] = []
    written: list[Path] = []
    try:
        for upload, content_type, filename in prepared:
            photo_id = new_id()
            await upload.seek(0)
            path, size = save_upload(
                settings.storage_dir,
                project.id,
                photo_id,
                filename,
                upload.file,
                max_bytes=settings.max_photo_bytes,
            )
            written.append(path)
            photos.append(
                Photo(
                    id=photo_id,
                    project_id=project.id,
                    filename=filename,
                    size=size,
                    content_type=content_type,
                    storage_path=str(path),
                )
            )
    except PhotoTooLargeError as exc:
        for path in written:
            delete_file(path)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except Exception:
        for path in written:
            delete_file(path)
        raise

    for photo in photos:
        session.add(photo)
    session.commit()
    for photo in photos:
        session.refresh(photo)
    return photos


@router.get("", response_model=list[PhotoRead])
def list_photos(project: ProjectDep, session: SessionDep) -> list[Photo]:
    statement = select(Photo).where(Photo.project_id == project.id).order_by(Photo.uploaded_at)
    return list(session.exec(statement).all())


@router.delete("/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_photo(photo_id: str, project: ProjectDep, session: SessionDep) -> Response:
    photo = session.get(Photo, photo_id)
    if photo is None or photo.project_id != project.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Photo {photo_id} not found",
        )
    if photo.storage_path:
        delete_file(photo.storage_path)
    session.delete(photo)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
