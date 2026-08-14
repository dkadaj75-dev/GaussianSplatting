import { apiUrl } from './env';
import type { Job, Project } from '../types';

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
    throw new ApiError(detail || `${response.status} ${response.statusText}`, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),

  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),

  createProject: (name: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  listJobs: (projectId: string) =>
    request<Job[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`),

  /**
   * Uploads a photo set as multipart/form-data.
   *
   * Stubbed against the WP 0.2 endpoint; resumable/chunked uploads arrive in
   * WP 4.2. Progress is reported via XHR because `fetch` has no upload-progress
   * event.
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
          const body = xhr.response as { uploaded?: number } | null;
          resolve({ uploaded: body?.uploaded ?? files.length });
        } else {
          reject(new ApiError(`Upload failed: ${xhr.status} ${xhr.statusText}`, xhr.status));
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
};
