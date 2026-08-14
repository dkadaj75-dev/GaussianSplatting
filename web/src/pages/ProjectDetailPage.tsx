import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import { API_URL } from '../lib/env';
import { isActive } from '../lib/jobProgress';
import { diagnoseJob } from '../lib/diagnostics';
import { formatBytes, selectSceneArtifact } from '../lib/artifacts';
import { useJobProgress } from '../hooks/useJobProgress';
import { useAppStore } from '../store/useAppStore';
import { JobProgress, JobStatusBadge } from '../components/JobProgress';
import { JobFailureCard, RegistrationWarning } from '../components/JobDiagnostics';
import { ProjectStatusBadge } from './ProjectsPage';
import { AlertIcon, CaptureIcon, ViewerIcon } from '../components/icons';
import type { Job } from '../types';

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** Newest job first — the API already sorts, but never rely on that for UI order. */
function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const selectProject = useAppStore((s) => s.selectProject);
  const setViewerSrc = useAppStore((s) => s.setViewerSrc);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) selectProject(projectId);
  }, [projectId, selectProject]);

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
  });

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs(projectId),
    queryFn: () => api.listJobs(projectId),
    enabled: Boolean(projectId),
  });

  const jobs = useMemo(() => sortJobs(jobsQuery.data ?? []), [jobsQuery.data]);
  const activeJob = useMemo(() => jobs.find((job) => isActive(job.status)) ?? null, [jobs]);

  // Refresh the project (status, photo count) and the job list once the live
  // job settles, so the rest of the page agrees with the socket.
  const onSettled = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.jobs(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }, [queryClient, projectId]);

  const live = useJobProgress(activeJob?.id ?? null, {
    initialJob: activeJob,
    onSettled,
  });

  const watched = live.job ?? activeJob;
  const doneJob = useMemo(
    () =>
      (watched && watched.status === 'done' ? watched : null) ??
      jobs.find((job) => job.status === 'done') ??
      null,
    [watched, jobs],
  );

  // Diagnostics describe the newest run only: an older failure must not shout
  // over a run that has since succeeded.
  const latestJob = useMemo(() => {
    const newest = jobs[0] ?? null;
    return watched && newest && watched.id === newest.id ? watched : newest;
  }, [watched, jobs]);

  const diagnostics = useMemo(
    () => diagnoseJob(latestJob, live.messages),
    [latestJob, live.messages],
  );

  // Prefetched so "Open in viewer" is instant once a job finishes.
  const doneJobId = doneJob?.id ?? '';
  const artifactsQuery = useQuery({
    queryKey: queryKeys.artifacts(doneJobId),
    queryFn: () => api.listArtifacts(doneJobId),
    enabled: doneJobId.length > 0,
  });

  const scene = selectSceneArtifact(artifactsQuery.data);

  const startJob = useMutation({
    mutationFn: () => api.createJob(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs(projectId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });

  const goToCapture = useCallback(() => {
    selectProject(projectId);
    navigate('/capture');
  }, [selectProject, projectId, navigate]);

  const openInViewer = useCallback(
    async (jobId: string) => {
      setOpenError(null);
      try {
        const artifacts = await queryClient.fetchQuery({
          queryKey: queryKeys.artifacts(jobId),
          queryFn: () => api.listArtifacts(jobId),
        });
        const artifact = selectSceneArtifact(artifacts);
        if (!artifact) {
          setOpenError('This job published no scene the viewer can display.');
          return;
        }
        const src = api.artifactUrl(jobId, artifact.filename);
        setViewerSrc(src);
        // `project` is what lets the viewer persist measurements and read the
        // scene's calibration (WP 3.2).
        navigate(
          `/viewer?src=${encodeURIComponent(src)}&project=${encodeURIComponent(projectId)}`,
        );
      } catch (error) {
        setOpenError(
          error instanceof Error ? error.message : 'Could not load the job’s artifacts.',
        );
      }
    },
    [queryClient, setViewerSrc, navigate, projectId],
  );

  const project = projectQuery.data;
  const photoCount = project?.photoCount ?? 0;
  const canStart = Boolean(project) && photoCount > 0 && !activeJob && !startJob.isPending;

  if (projectQuery.isPending) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded-lg bg-raised" />
          <div className="mt-4 h-24 animate-pulse rounded-xl bg-raised" />
        </div>
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    const error = projectQuery.error;
    const missing = error && typeof error === 'object' && 'status' in error && error.status === 404;
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5">
          <div className="rounded-xl border border-line bg-raised p-4">
            <div className="flex items-start gap-3">
              <AlertIcon className="mt-0.5 size-5 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {missing ? 'Project not found' : 'Can’t reach the API'}
                </p>
                <p className="mt-1 text-xs break-words text-muted">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
                {missing ? null : (
                  <p className="mt-1 text-xs text-muted">
                    Expected at <code className="font-mono">{API_URL}</code>.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void projectQuery.refetch()}
                className="min-h-touch rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-sunken"
              >
                Retry
              </button>
              <Link
                to="/"
                className="grid min-h-touch place-items-center rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-sunken"
              >
                All projects
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <Link to="/" className="text-xs text-muted transition-colors hover:text-content">
          ← All projects
        </Link>

        <header className="mt-2 mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
            <p className="mt-1 text-sm text-muted">
              <span data-testid="photo-count">{photoCount}</span> photo
              {photoCount === 1 ? '' : 's'} · created {formatWhen(project.createdAt)}
            </p>
          </div>
          <ProjectStatusBadge status={project.status} />
        </header>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={goToCapture}
            className="flex min-h-touch flex-1 items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-raised"
          >
            <CaptureIcon className="size-5" />
            Upload photos
          </button>
          <button
            type="button"
            disabled={!canStart}
            onClick={() => startJob.mutate()}
            className="min-h-touch flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
          >
            {startJob.isPending ? 'Starting…' : 'Start processing'}
          </button>
        </div>

        {photoCount === 0 ? (
          <p className="mt-2 text-xs text-muted">
            Upload photos before starting — the pipeline needs at least one, and 30+ for a reliable
            reconstruction.
          </p>
        ) : activeJob ? (
          <p className="mt-2 text-xs text-muted">A job is already running for this project.</p>
        ) : null}

        {startJob.isError ? (
          <p className="mt-2 flex items-start gap-2 text-xs break-words text-muted">
            <AlertIcon className="mt-0.5 size-4 shrink-0" />
            {startJob.error instanceof Error ? startJob.error.message : 'Could not start the job.'}
          </p>
        ) : null}

        {watched && isActive(watched.status) ? (
          <div className="mt-5">
            <JobProgress job={watched} connection={live.connection} error={live.error} />
          </div>
        ) : null}

        {diagnostics.failure ? (
          <div className="mt-5">
            <JobFailureCard
              failure={diagnostics.failure}
              onAddPhotos={goToCapture}
              onRetry={photoCount > 0 && !activeJob ? () => startJob.mutate() : undefined}
              retrying={startJob.isPending}
            />
          </div>
        ) : latestJob?.status === 'done' && diagnostics.registration ? (
          <div className="mt-5">
            <RegistrationWarning report={diagnostics.registration} onAddPhotos={goToCapture} />
          </div>
        ) : null}

        {doneJob ? (
          <section className="mt-5 rounded-xl border border-line bg-raised p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Scene ready</p>
                <p className="mt-0.5 text-xs text-muted">
                  {artifactsQuery.isPending
                    ? 'Loading artifacts…'
                    : scene
                      ? `${scene.filename} · ${formatBytes(scene.bytes)}`
                      : artifactsQuery.isError
                        ? 'Could not list the artifacts.'
                        : 'No displayable artifact was published.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void openInViewer(doneJob.id)}
                className="flex min-h-touch items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
              >
                <ViewerIcon className="size-5" />
                Open in viewer
              </button>
            </div>
            {openError ? (
              <p className="mt-3 flex items-start gap-2 text-xs break-words text-muted">
                <AlertIcon className="mt-0.5 size-4 shrink-0" />
                {openError}
              </p>
            ) : null}
          </section>
        ) : null}

        <h2 className="mt-6 mb-2 text-sm font-semibold">Jobs</h2>
        {jobsQuery.isPending ? (
          <div className="h-16 animate-pulse rounded-xl bg-raised" aria-busy="true" />
        ) : jobsQuery.isError ? (
          <p className="flex items-start gap-2 text-xs break-words text-muted">
            <AlertIcon className="mt-0.5 size-4 shrink-0" />
            {jobsQuery.error instanceof Error ? jobsQuery.error.message : 'Could not load jobs.'}
          </p>
        ) : jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-muted">
            No pipeline runs yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => {
              const row = watched && watched.id === job.id ? watched : job;
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-raised p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="capitalize">{row.stage}</span>
                      <JobStatusBadge status={row.status} />
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {Math.round(row.progress * 100)}% · {formatWhen(row.updatedAt)}
                      {row.message ? ` · ${row.message}` : ''}
                    </p>
                  </div>
                  {row.status === 'done' ? (
                    <button
                      type="button"
                      onClick={() => void openInViewer(job.id)}
                      className="min-h-touch shrink-0 rounded-lg border border-line px-3 text-xs font-medium transition-colors hover:bg-sunken"
                    >
                      Open in viewer
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default ProjectDetailPage;
