import { apiUrl } from './env';
import type { Artifact, Job, JobStage, JobStatus, Project, ProjectStatus } from '../types';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Turns any failure (offline, DNS, CORS, 5xx) into a message we can show. */
function describeNetworkError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Request cancelled.';
  return `Could not reach the API at ${apiUrl('')}. Is the server running?`;
}

/** FastAPI reports errors as `{"detail": ...}`; anything else is passed through. */
function describeErrorBody(body: string, response: Response): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
      const { detail } = parsed as { detail: unknown };
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length > 0) return JSON.stringify(detail[0]);
    }
  } catch {
    /* Not JSON — fall through to the raw text. */
  }
  return body || `${response.status} ${response.statusText}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });
  } catch (error) {
    throw new ApiError(describeNetworkError(error), 0);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError(describeErrorBody(detail, response), response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Wire shapes -------------------------------------------------------------
//
// The API speaks snake_case (api/app/schemas.py). Translation happens here, at
// the single boundary, so nothing downstream has to know that.

export interface ApiProject {
  id: string;
  name: string;
  created_at: string;
  status: ProjectStatus;
  photo_count?: number;
}

export interface ApiJob {
  id: string;
  project_id: string;
  stage: JobStage;
  progress: number;
  status: JobStatus;
  message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  task_id?: string | null;
}

export function toProject(raw: ApiProject): Project {
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.created_at,
    status: raw.status,
    photoCount: raw.photo_count ?? 0,
  };
}

export function toJob(raw: ApiJob): Job {
  return {
    id: raw.id,
    projectId: raw.project_id,
    stage: raw.stage,
    progress: raw.progress,
    status: raw.status,
    message: raw.message,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
  };
}

export const api = {
  listProjects: () => request<ApiProject[]>('/api/projects').then((rows) => rows.map(toProject)),

  getProject: (id: string) =>
    request<ApiProject>(`/api/projects/${encodeURIComponent(id)}`).then(toProject),

  createProject: (name: string) =>
    request<ApiProject>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(toProject),

  listJobs: (projectId: string) =>
    request<ApiJob[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`).then((rows) =>
      rows.map(toJob),
    ),

  getJob: (jobId: string) => request<ApiJob>(`/api/jobs/${encodeURIComponent(jobId)}`).then(toJob),

  /** Starts a pipeline run. The API rejects a project with no photos (400). */
  createJob: (projectId: string) =>
    request<ApiJob>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(toJob),

  listArtifacts: (jobId: string) =>
    request<Artifact[]>(`/api/jobs/${encodeURIComponent(jobId)}/artifacts`),

  /** Absolute URL the splat viewer streams an artifact from. */
  artifactUrl: (jobId: string, filename: string) =>
    apiUrl(`/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`),

  /**
   * Uploads a photo set as multipart/form-data.
   *
   * Resumable/chunked uploads arrive in WP 4.2. Progress is reported via XHR
   * because `fetch` has no upload-progress event.
   */
  uploadPhotos: (
    projectId: string,
    files: File[],
    options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
  ) =>
    new Promise<{ uploaded: number }>((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(`/api/projects/${encodeURIComponent(projectId)}/photos`));
      xhr.responseType = 'json';

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          options.onProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const body = xhr.response as unknown;
          resolve({ uploaded: Array.isArray(body) ? body.length : files.length });
        } else {
          const detail =
            (xhr.response as { detail?: string } | null)?.detail ??
            `${xhr.status} ${xhr.statusText}`;
          reject(new ApiError(`Upload failed: ${detail}`, xhr.status));
        }
      });
      xhr.addEventListener('error', () => {
        reject(new ApiError(describeNetworkError(null), 0));
      });
      xhr.addEventListener('abort', () => {
        reject(new ApiError('Upload cancelled.', 0));
      });

      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    }),
};

/** Query keys for TanStack Query. */
export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  jobs: (projectId: string) => ['projects', projectId, 'jobs'] as const,
  job: (jobId: string) => ['jobs', jobId] as const,
  artifacts: (jobId: string) => ['jobs', jobId, 'artifacts'] as const,
};
