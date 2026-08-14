import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import { API_URL } from '../lib/env';
import { useAppStore } from '../store/useAppStore';
import type { Project, ProjectStatus } from '../types';
import { AlertIcon } from '../components/icons';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_STYLE: Record<ProjectStatus, string> = {
  draft: 'bg-raised text-muted',
  uploading: 'bg-raised text-content',
  processing: 'bg-raised text-content',
  ready: 'bg-accent text-on-accent',
  failed: 'bg-raised text-content',
};

function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: (p: Project) => void }) {
  const openable = Boolean(project.splatUrl);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(project)}
        disabled={!openable}
        className="flex w-full min-h-touch items-center gap-3 rounded-xl border border-line bg-raised p-3 text-left transition-colors enabled:hover:border-accent/60 disabled:opacity-60"
      >
        <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-sunken">
          {project.thumbnailUrl ? (
            <img
              src={project.thumbnailUrl}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{project.name}</p>
          <p className="truncate text-xs text-muted">
            {project.photoCount} photo{project.photoCount === 1 ? '' : 's'} ·{' '}
            {new Date(project.createdAt).toLocaleDateString()}
          </p>
        </div>
        <StatusBadge status={project.status} />
      </button>
    </li>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const setProjects = useAppStore((s) => s.setProjects);
  const setViewerSrc = useAppStore((s) => s.setViewerSrc);

  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
  });

  useEffect(() => {
    if (data) setProjects(data);
  }, [data, setProjects]);

  const openProject = (project: Project) => {
    if (!project.splatUrl) return;
    setViewerSrc(project.splatUrl);
    navigate('/viewer');
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted">
              One project is one reconstructed scene.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/capture')}
            className="min-h-touch shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            New
          </button>
        </header>

        {isPending ? (
          <ul className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-[72px] animate-pulse rounded-xl bg-raised" />
            ))}
          </ul>
        ) : error ? (
          <div className="rounded-xl border border-line bg-raised p-4">
            <div className="flex items-start gap-3">
              <AlertIcon className="mt-0.5 size-5 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Can&rsquo;t reach the API</p>
                <p className="mt-1 text-xs break-words text-muted">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Expected at <code className="font-mono">{API_URL}</code> — set{' '}
                  <code className="font-mono">VITE_API_URL</code> to change it.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-3 min-h-touch w-full rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-sunken sm:w-auto"
            >
              {isFetching ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : data && data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {data.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={openProject} />
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-line p-8 text-center">
            <p className="text-sm font-medium">No projects yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
              Photograph a subject from all sides — 30+ shots with 60–70% overlap works best.
            </p>
            <button
              type="button"
              onClick={() => navigate('/capture')}
              className="mt-4 min-h-touch rounded-lg bg-accent px-5 text-sm font-semibold text-on-accent"
            >
              Capture photos
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectsPage;
