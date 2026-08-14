import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { usePhotoAnalysis } from '../hooks/usePhotoAnalysis';
import { useUploadQueue } from '../hooks/useUploadQueue';
import type { PendingPhoto } from '../types';
import {
  AlertIcon,
  CaptureIcon,
  CheckIcon,
  OfflineIcon,
  RetryIcon,
  TrashIcon,
  UploadIcon,
} from '../components/icons';

/** Rough guidance from PLAN.md §3 — enough coverage for SfM to converge. */
const RECOMMENDED_PHOTOS = 30;
/** Below this a reconstruction almost never succeeds. */
const MINIMUM_PHOTOS = 15;
/** Queue rows shown before collapsing into a count. */
const MAX_VISIBLE_QUEUE_ROWS = 8;

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

/** Red below the floor, amber below the recommendation, green at or above it. */
function countTone(count: number): string {
  if (count >= RECOMMENDED_PHOTOS) return 'text-ok';
  if (count >= MINIMUM_PHOTOS) return 'text-warn';
  return 'text-danger';
}

interface ChecklistEntry {
  label: string;
  hint: string;
  /** `null` for advice we cannot verify from here. */
  done: boolean | null;
}

function CoverageChecklist({ count }: { count: number }) {
  const entries: ChecklistEntry[] = [
    {
      label: `${RECOMMENDED_PHOTOS}+ photos recommended`,
      hint: count >= RECOMMENDED_PHOTOS ? 'enough for a solid solve' : `${count} so far`,
      done: count >= RECOMMENDED_PHOTOS,
    },
    { label: 'Orbit the subject', hint: 'walk all the way around it', done: null },
    { label: '60–70% overlap', hint: 'each shot repeats most of the last', done: null },
    { label: 'Avoid changing zoom', hint: 'step closer instead — zoom breaks the solve', done: null },
  ];

  return (
    <ul aria-label="Coverage checklist" className="mt-4 flex flex-col gap-2">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-start gap-2.5">
          {entry.done === true ? (
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
          ) : (
            <span
              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                entry.done === false ? 'bg-warn' : 'bg-line'
              }`}
              aria-hidden="true"
            />
          )}
          <p className="text-xs leading-relaxed">
            <span className={entry.done === true ? 'text-muted line-through' : ''}>
              {entry.label}
            </span>
            <span className="text-muted"> · {entry.hint}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

function Badge({ tone, children }: { tone: 'warn' | 'muted'; children: ReactNode }) {
  const color = tone === 'warn' ? 'text-warn' : 'text-muted';
  return (
    <span
      className={`rounded-md bg-sunken/90 px-1.5 py-0.5 text-[10px] leading-tight font-medium backdrop-blur-sm ${color}`}
    >
      {children}
    </span>
  );
}

export function CapturePage() {
  const navigate = useNavigate();
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  // Seeded once: the store holds a selection only when arriving from a project.
  const [projectId, setProjectId] = useState(() => useAppStore.getState().selectedProjectId ?? '');
  const [manualEntry, setManualEntry] = useState(false);
  const [queuedProjectId, setQueuedProjectId] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
  });

  const projects = projectsQuery.data ?? [];
  // With the API unreachable the picker cannot help; fall back to typing an ID.
  const usePicker = !manualEntry && !projectsQuery.isError && projects.length > 0;
  // Derived rather than stored, so a project list arriving late (or a stale
  // selection from a deleted project) always leaves the picker on a real value.
  const selectedProjectId =
    !usePicker || (projectId && projects.some((project) => project.id === projectId))
      ? projectId
      : projects[0].id;

  const analysis = usePhotoAnalysis(photos);
  const queue = useUploadQueue();

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

  const removePhotos = useCallback((ids: readonly string[]) => {
    const doomed = new Set(ids);
    setPhotos((current) => {
      for (const photo of current) {
        if (doomed.has(photo.id)) URL.revokeObjectURL(photo.previewUrl);
      }
      return current.filter((photo) => !doomed.has(photo.id));
    });
  }, []);

  const clearAll = useCallback(() => {
    setPhotos((current) => {
      for (const photo of current) URL.revokeObjectURL(photo.previewUrl);
      return [];
    });
  }, []);

  const targetId = selectedProjectId.trim();
  const totalBytes = photos.reduce((sum, p) => sum + p.size, 0);
  const canQueue = photos.length > 0 && targetId.length > 0;

  const queuePhotos = useCallback(async () => {
    if (photos.length === 0 || targetId.length === 0) return;
    // The queue owns the files from here: it persists them, uploads in
    // batches, and survives a reload or a lost signal.
    await queue.enqueue(
      targetId,
      photos.map((photo) => photo.file),
    );
    clearAll();
    setQueuedProjectId(targetId);
    useAppStore.getState().selectProject(targetId);
  }, [photos, targetId, queue, clearAll]);

  const pendingRows = useMemo(
    () => queue.items.filter((entry) => entry.status !== 'done'),
    [queue.items],
  );

  const showQueuePanel = pendingRows.length > 0 || (queue.done > 0 && queuedProjectId !== null);
  const goToProjectId = queuedProjectId ?? queue.projectIds[0] ?? targetId;

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
            <span
              className={`text-2xl font-semibold tabular-nums ${countTone(photos.length)}`}
              data-testid="photo-count"
            >
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

        <CoverageChecklist count={photos.length} />

        {photos.length > 0 && analysis.supported ? (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-raised px-3 py-2.5"
            data-testid="quality-summary"
          >
            <p className="text-xs text-muted">
              {analysis.remaining > 0
                ? `Checking photos… ${photos.length - analysis.remaining}/${photos.length}`
                : analysis.flaggedIds.length === 0
                  ? 'All photos look sharp and distinct.'
                  : `${analysis.blurryIds.length} blurry · ${analysis.duplicateIds.length} near-duplicate`}
            </p>
            {analysis.flaggedIds.length > 0 ? (
              <button
                type="button"
                onClick={() => removePhotos(analysis.flaggedIds)}
                className="min-h-touch rounded-lg border border-line px-3 text-xs font-medium transition-colors hover:bg-sunken"
              >
                Remove {analysis.flaggedIds.length} flagged
              </button>
            ) : null}
          </div>
        ) : null}

        {photos.length > 0 ? (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {photos.map((photo) => {
              const check = analysis.analyses[photo.id];
              const busy = check?.state === 'pending' || check?.state === 'analyzing';
              return (
                <li key={photo.id} className="group relative aspect-square">
                  <img
                    src={photo.previewUrl}
                    alt={photo.name}
                    className={`size-full rounded-lg object-cover ${
                      check?.flagged ? 'opacity-70 ring-2 ring-warn' : ''
                    }`}
                    loading="lazy"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${photo.name}`}
                    onClick={() => removePhotos([photo.id])}
                    className="absolute top-1 right-1 grid size-9 place-items-center rounded-full bg-sunken/85 text-content backdrop-blur-sm"
                  >
                    <TrashIcon className="size-4" />
                  </button>
                  <div className="absolute bottom-1 left-1 flex flex-wrap gap-1">
                    {busy ? <Badge tone="muted">Checking…</Badge> : null}
                    {check?.isBlurry ? <Badge tone="warn">Blurry</Badge> : null}
                    {check?.duplicateOf ? <Badge tone="warn">Duplicate</Badge> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="mt-4 grid place-items-center rounded-xl border border-dashed border-line p-10 text-center">
            <CaptureIcon className="size-8 text-muted" />
            <p className="mt-2 text-sm text-muted">No photos yet</p>
          </div>
        )}

        <section className="mt-6 rounded-xl border border-line bg-raised p-4">
          <label htmlFor="project-select" className="block text-sm font-medium">
            Upload to project
          </label>

          {usePicker ? (
            <select
              id="project-select"
              value={selectedProjectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="mt-2 min-h-touch w-full rounded-lg border border-line bg-sunken px-3 text-sm outline-none focus:border-accent"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.photoCount} photo
                  {project.photoCount === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="project-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="Project ID"
              autoComplete="off"
              className="mt-2 min-h-touch w-full rounded-lg border border-line bg-sunken px-3 font-mono text-sm outline-none focus:border-accent"
            />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            {projectsQuery.isPending ? <span>Loading projects…</span> : null}
            {projectsQuery.isError ? (
              <span className="flex items-start gap-1.5 break-words">
                <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
                Project list unavailable — enter the ID manually.
              </span>
            ) : null}
            {!projectsQuery.isPending && !projectsQuery.isError && projects.length === 0 ? (
              <Link to="/" className="underline underline-offset-2 hover:text-content">
                No projects yet — create one
              </Link>
            ) : null}
            {projects.length > 0 ? (
              <button
                type="button"
                onClick={() => setManualEntry((current) => !current)}
                className="underline underline-offset-2 hover:text-content"
              >
                {manualEntry ? 'Pick from list' : 'Enter ID manually'}
              </button>
            ) : null}
          </div>

          <button
            type="button"
            disabled={!canQueue}
            onClick={() => void queuePhotos()}
            className="mt-3 flex min-h-touch w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
          >
            <UploadIcon className="size-5" />
            {queue.online
              ? `Upload ${photos.length} photo${photos.length === 1 ? '' : 's'}`
              : `Queue ${photos.length} photo${photos.length === 1 ? '' : 's'} for Wi-Fi`}
          </button>

          {!queue.online ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-muted">
              <OfflineIcon className="mt-0.5 size-4 shrink-0" />
              You are offline. Photos are stored on this device and upload themselves as soon as
              there is a connection.
            </p>
          ) : null}
        </section>

        {showQueuePanel ? (
          <section
            aria-label="Upload queue"
            data-testid="queue-panel"
            className="mt-4 rounded-xl border border-line bg-raised p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                {queue.waitingForNetwork ? (
                  <>
                    <OfflineIcon className="size-5 shrink-0 text-warn" />
                    Waiting for Wi-Fi — {queue.pending} photo
                    {queue.pending === 1 ? '' : 's'} queued
                  </>
                ) : queue.active ? (
                  <>
                    <UploadIcon className="size-5 shrink-0 text-accent" />
                    Uploading {queue.pending} photo{queue.pending === 1 ? '' : 's'}…
                  </>
                ) : queue.pending > 0 ? (
                  <>
                    <UploadIcon className="size-5 shrink-0 text-muted" />
                    {queue.pending} photo{queue.pending === 1 ? '' : 's'} queued
                  </>
                ) : queue.failed > 0 ? (
                  <>
                    <AlertIcon className="size-5 shrink-0 text-danger" />
                    {queue.failed} photo{queue.failed === 1 ? '' : 's'} could not be uploaded
                  </>
                ) : (
                  <>
                    <CheckIcon className="size-5 shrink-0 text-ok" />
                    Uploaded {queue.done} photo{queue.done === 1 ? '' : 's'}
                  </>
                )}
              </p>
              {goToProjectId ? (
                <button
                  type="button"
                  onClick={() => navigate(`/projects/${goToProjectId}`)}
                  className="min-h-touch rounded-lg border border-line px-3 text-xs font-medium transition-colors hover:bg-sunken"
                >
                  Go to project
                </button>
              ) : null}
            </div>

            {queue.pending > 0 ? (
              <div
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-sunken"
                role="progressbar"
                aria-label="Upload progress"
                aria-valuenow={Math.round(queue.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-150"
                  style={{ width: `${Math.round(queue.progress * 100)}%` }}
                />
              </div>
            ) : null}

            {pendingRows.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1.5">
                {pendingRows.slice(0, MAX_VISIBLE_QUEUE_ROWS).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span
                      className={`shrink-0 ${
                        entry.status === 'failed'
                          ? 'text-danger'
                          : entry.status === 'uploading'
                            ? 'text-accent'
                            : 'text-muted'
                      }`}
                    >
                      {entry.status === 'failed'
                        ? (entry.error ?? 'Failed')
                        : entry.status === 'uploading'
                          ? 'Uploading'
                          : entry.attempts > 0
                            ? `Retrying (${entry.attempts})`
                            : 'Queued'}
                    </span>
                    {entry.status === 'failed' ? (
                      <button
                        type="button"
                        aria-label={`Retry ${entry.name}`}
                        onClick={() => queue.retry([entry.id])}
                        className="grid size-touch shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-content"
                      >
                        <RetryIcon className="size-4" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Cancel ${entry.name}`}
                      onClick={() => queue.cancel(entry.id)}
                      className="grid size-touch shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-content"
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </li>
                ))}
                {pendingRows.length > MAX_VISIBLE_QUEUE_ROWS ? (
                  <li className="text-xs text-muted">
                    + {pendingRows.length - MAX_VISIBLE_QUEUE_ROWS} more
                  </li>
                ) : null}
              </ul>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {queue.failed > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => queue.retry()}
                    className="flex min-h-touch items-center gap-2 rounded-lg border border-line px-3 text-xs font-medium transition-colors hover:bg-sunken"
                  >
                    <RetryIcon className="size-4" />
                    Retry {queue.failed} failed
                  </button>
                  <button
                    type="button"
                    onClick={() => queue.clearFailed()}
                    className="min-h-touch rounded-lg px-3 text-xs text-muted transition-colors hover:text-content"
                  >
                    Clear failed
                  </button>
                </>
              ) : null}
              {queue.done > 0 && queue.pending === 0 && queue.failed === 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    queue.clearDone();
                    setQueuedProjectId(null);
                  }}
                  className="min-h-touch rounded-lg px-3 text-xs text-muted transition-colors hover:text-content"
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default CapturePage;
