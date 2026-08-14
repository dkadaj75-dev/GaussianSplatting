import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { API_URL } from '../lib/env';
import { useAppStore } from '../store/useAppStore';
import type { PendingPhoto } from '../types';
import { AlertIcon, CaptureIcon, TrashIcon } from '../components/icons';

/** Rough guidance from PLAN.md §3 — enough coverage for SfM to converge. */
const RECOMMENDED_PHOTOS = 30;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function makePhoto(file: File): PendingPhoto {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
    name: file.name,
    size: file.size,
  };
}

export function CapturePage() {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  // Seeded once: the store holds a selection only when arriving from a project.
  const [projectId, setProjectId] = useState(
    () => useAppStore.getState().selectedProjectId ?? 'demo',
  );
  const [progress, setProgress] = useState(0);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // Revoke every object URL when the page unmounts, without re-running on each add.
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  });
  useEffect(
    () => () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.previewUrl);
    },
    [],
  );

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const images = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    setPhotos((current) => [...current, ...images.map(makePhoto)]);
  }, []);

  const removePhoto = useCallback((id: string) => {
    setPhotos((current) => {
      const target = current.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((p) => p.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setPhotos((current) => {
      for (const photo of current) URL.revokeObjectURL(photo.previewUrl);
      return [];
    });
  }, []);

  const upload = useMutation({
    mutationFn: () =>
      api.uploadPhotos(
        projectId.trim(),
        photos.map((p) => p.file),
        { onProgress: setProgress },
      ),
    onMutate: () => setProgress(0),
  });

  const totalBytes = photos.reduce((sum, p) => sum + p.size, 0);
  const canUpload = photos.length > 0 && projectId.trim().length > 0 && !upload.isPending;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">Capture</h1>
          <p className="mt-1 text-sm text-muted">
            Orbit the subject with 60–70% overlap between shots. Aim for {RECOMMENDED_PHOTOS}+
            photos.
          </p>
        </header>

        {/* Hidden inputs; the visible buttons keep a >= 44px hit target. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          data-testid="camera-input"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          data-testid="gallery-input"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="flex min-h-touch flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            <CaptureIcon className="size-5" />
            Take photos
          </button>
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            className="min-h-touch flex-1 rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-raised"
          >
            Choose from gallery
          </button>
        </div>

        <div className="mt-5 flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums" data-testid="photo-count">
              {photos.length}
            </span>{' '}
            <span className="text-muted">
              photo{photos.length === 1 ? '' : 's'} selected
              {photos.length > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
            </span>
          </p>
          {photos.length > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className="min-h-touch rounded-lg px-3 text-sm text-muted transition-colors hover:text-content"
            >
              Clear all
            </button>
          ) : null}
        </div>

        {photos.length > 0 && photos.length < RECOMMENDED_PHOTOS ? (
          <p className="mt-1 text-xs text-muted">
            {RECOMMENDED_PHOTOS - photos.length} more recommended for a reliable reconstruction.
          </p>
        ) : null}

        {photos.length > 0 ? (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {photos.map((photo) => (
              <li key={photo.id} className="group relative aspect-square">
                <img
                  src={photo.previewUrl}
                  alt={photo.name}
                  className="size-full rounded-lg object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  aria-label={`Remove ${photo.name}`}
                  onClick={() => removePhoto(photo.id)}
                  className="absolute top-1 right-1 grid size-9 place-items-center rounded-full bg-sunken/85 text-content backdrop-blur-sm"
                >
                  <TrashIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 grid place-items-center rounded-xl border border-dashed border-line p-10 text-center">
            <CaptureIcon className="size-8 text-muted" />
            <p className="mt-2 text-sm text-muted">No photos yet</p>
          </div>
        )}

        <section className="mt-6 rounded-xl border border-line bg-raised p-4">
          <label htmlFor="project-id" className="block text-sm font-medium">
            Project ID
          </label>
          <p className="mt-1 text-xs text-muted">
            Photos are posted to{' '}
            <code className="font-mono break-all">
              {API_URL}/api/projects/{projectId || '{id}'}/photos
            </code>
          </p>
          <input
            id="project-id"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="demo"
            autoComplete="off"
            className="mt-2 min-h-touch w-full rounded-lg border border-line bg-sunken px-3 font-mono text-sm outline-none focus:border-accent"
          />

          <button
            type="button"
            disabled={!canUpload}
            onClick={() => upload.mutate()}
            className="mt-3 min-h-touch w-full rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
          >
            {upload.isPending ? `Uploading… ${progress}%` : `Upload ${photos.length} photos`}
          </button>

          {upload.isPending ? (
            <div
              className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-sunken"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}

          {upload.isError ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-sunken p-3">
              <AlertIcon className="mt-0.5 size-4 shrink-0 text-muted" />
              <p className="text-xs break-words text-muted">
                {upload.error instanceof Error ? upload.error.message : 'Upload failed.'} The
                pipeline API is not wired up yet — this is expected in Milestone 0.
              </p>
            </div>
          ) : null}

          {upload.isSuccess ? (
            <p className="mt-3 text-xs text-muted">
              Uploaded {upload.data.uploaded} photo{upload.data.uploaded === 1 ? '' : 's'}.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default CapturePage;
