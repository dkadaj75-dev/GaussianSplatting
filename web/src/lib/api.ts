import { apiUrl } from './env';
import type {
  Artifact,
  Calibration,
  CalibrationMethod,
  Job,
  JobStage,
  JobStatus,
  Measurement,
  MeasurementInput,
  MeasurementKind,
  Point3,
  Project,
  ProjectStatus,
} from '../types';

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

export interface ApiCalibration {
  scale: number;
  method: CalibrationMethod;
  /** Absent on an ArUco calibration: it was not solved from a picked pair. */
  reference?: {
    point_a: Point3;
    point_b: Point3;
    real_distance_m: number;
  } | null;
  calibrated_at: string;
  /** ArUco only (`api/app/schemas.py::CalibrationRead`). */
  residual?: number | null;
  sample_count?: number | null;
  marker_length_m?: number | null;
  marker_dictionary?: string | null;
}

export interface ApiProject {
  id: string;
  name: string;
  created_at: string;
  status: ProjectStatus;
  photo_count?: number;
  /** Absent on API builds that predate WP 3.3. */
  calibration?: ApiCalibration | null;
}

export interface ApiMeasurement {
  id: string;
  project_id: string;
  kind: MeasurementKind;
  points: unknown[];
  value: number | null;
  unit: string;
  label: string | null;
  created_at: string;
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

/**
 * Defensive rather than a straight cast: `points` is a JSON column on the API
 * side (`list[Any]`), so a row could legitimately hold anything.
 */
function toPoints(raw: unknown[]): Point3[] {
  const points: Point3[] = [];
  for (const entry of raw) {
    if (
      Array.isArray(entry) &&
      entry.length >= 3 &&
      entry.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      points.push([entry[0] as number, entry[1] as number, entry[2] as number]);
    }
  }
  return points;
}

export function toCalibration(raw: ApiCalibration | null | undefined): Calibration | null {
  if (!raw || typeof raw.scale !== 'number' || !Number.isFinite(raw.scale)) return null;
  const reference = raw.reference;
  return {
    scale: raw.scale,
    method: raw.method ?? 'known_distance',
    // A missing reference stays missing rather than becoming a zero-length
    // segment at the origin — the viewer draws the reference pair, and drawing
    // one that never existed would be a lie about where the scale came from.
    reference: reference
      ? {
          pointA: reference.point_a ?? [0, 0, 0],
          pointB: reference.point_b ?? [0, 0, 0],
          realDistanceM: reference.real_distance_m ?? 0,
        }
      : null,
    calibratedAt: raw.calibrated_at,
    residual: raw.residual ?? null,
    sampleCount: raw.sample_count ?? null,
    markerLengthM: raw.marker_length_m ?? null,
    markerDictionary: raw.marker_dictionary ?? null,
  };
}

export function toProject(raw: ApiProject): Project {
  const calibration = toCalibration(raw.calibration);
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.created_at,
    status: raw.status,
    photoCount: raw.photo_count ?? 0,
    calibration,
    calibrated: calibration !== null,
  };
}

export function toMeasurement(raw: ApiMeasurement): Measurement {
  return {
    id: raw.id,
    projectId: raw.project_id,
    kind: raw.kind,
    points: toPoints(raw.points ?? []),
    value: raw.value ?? null,
    unit: raw.unit,
    label: raw.label ?? null,
    createdAt: raw.created_at,
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

  // --- Measurements (WP 3.2) -------------------------------------------------

  listMeasurements: (projectId: string) =>
    request<ApiMeasurement[]>(
      `/api/projects/${encodeURIComponent(projectId)}/measurements`,
    ).then((rows) => rows.map(toMeasurement)),

  createMeasurement: (projectId: string, input: MeasurementInput) =>
    request<ApiMeasurement>(`/api/projects/${encodeURIComponent(projectId)}/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: input.kind,
        points: input.points,
        value: input.value,
        unit: input.unit,
        label: input.label,
      }),
    }).then(toMeasurement),

  deleteMeasurement: (projectId: string, measurementId: string) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/measurements/${encodeURIComponent(measurementId)}`,
      { method: 'DELETE' },
    ),

  // --- Calibration (WP 3.3) --------------------------------------------------
  //
  // Owned by the API package; a build that predates it answers 404/405 and the
  // viewer degrades to "uncalibrated" rather than breaking.

  setCalibration: (
    projectId: string,
    reference: { pointA: Point3; pointB: Point3; realDistanceM: number },
  ) =>
    request<ApiProject>(`/api/projects/${encodeURIComponent(projectId)}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        point_a: reference.pointA,
        point_b: reference.pointB,
        real_distance_m: reference.realDistanceM,
      }),
    }).then(toProject),

  clearCalibration: (projectId: string) =>
    request<ApiProject>(`/api/projects/${encodeURIComponent(projectId)}/calibration`, {
      method: 'DELETE',
    }).then(toProject),

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
  measurements: (projectId: string) => ['projects', projectId, 'measurements'] as const,
};
