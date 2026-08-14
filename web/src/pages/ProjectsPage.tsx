import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import { API_URL } from '../lib/env';
import { useAppStore } from '../store/useAppStore';
import type { Project, ProjectStatus } from '../types';
import { AlertIcon } from '../components/icons';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_STYLE: Record<ProjectStatus, string> = {
  draft: 'bg-raised text-muted',
  processing: 'bg-raised text-content',
  ready: 'bg-accent text-on-accent',
  failed: 'border border-line bg-sunken text-content',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: (p: Project) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(project)}
        className="flex w-full min-h-touch items-center gap-3 rounded-xl border border-line bg-raised p-3 text-left transition-colors hover:border-accent/60"
      >
        <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-sunken">
          {project.thumbnailUrl ? (
            <img src={project.thumbnailUrl} alt="" className="size-full object-cover" loading="lazy" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{project.name}</p>
          <p className="truncate text-xs text-muted">
            {project.photoCount} photo{project.photoCount === 1 ? '' : 's'} ·{' '}
            {new Date(project.createdAt).toLocaleDateString()}
          </p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </button>
    </li>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setProjects = useAppStore((s) => s.setProjects);
  const selectProject = useAppStore((s) => s.selectProject);
  const [name, setName] = useState('');

  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
  });

  useEffect(() => {
    if (data) setProjects(data);
  }, [data, setProjects]);

  const create = useMutation({
    mutationFn: (projectName: string) => api.createProject(projectName),
    onSuccess: async (project) => {
      setName('');
      selectProject(project.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      navigate(`/projects/${project.id}`);
    },
  });

  const openProject = (project: Project) => {
    selectProject(project.id);
    navigate(`/projects/${project.id}`);
  };

  const trimmed = name.trim();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <header className="mb-4">
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">One project is one reconstructed scene.</p>
        </header>

        <form
          className="mb-5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && !create.isPending) create.mutate(trimmed);
          }}
        >
          <label htmlFor="project-name" className="sr-only">
            New project name
          </label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Balcony anchor detail — Site A"
            autoComplete="off"
            className="min-h-touch min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!trimmed || create.isPending}
            className="min-h-touch shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
          >
            {create.isPending ? 'Creating…' : 'New project'}
          </button>
        </form>

        {create.isError ? (
          <p className="mb-4 flex items-start gap-2 text-xs break-words text-muted">
            <AlertIcon className="mt-0.5 size-4 shrink-0" />
            {create.error instanceof Error ? create.error.message : 'Could not create the project.'}
          </p>
        ) : null}

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
              Name a project above, then photograph the subject from all sides — 30+ shots with
              60–70% overlap works best.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectsPage;
