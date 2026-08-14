/**
 * Shared domain types.
 *
 * These mirror the FastAPI contract in `api/app/schemas.py`, translated to
 * camelCase at the edge (see `lib/api.ts`) so components never deal with two
 * naming conventions.
 */

/** Stages of the reconstruction pipeline, in execution order. */
export const JOB_STAGES = ['ingest', 'sfm', 'train', 'compress', 'publish'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  ingest: 'Ingest',
  sfm: 'Camera poses',
  train: 'Training',
  compress: 'Compress',
  publish: 'Publish',
};

/** Job lifecycle, as reported by the API and the worker. */
export type JobStatus = 'queued' | 'running' | 'failed' | 'done';

export type ProjectStatus = 'draft' | 'processing' | 'ready' | 'failed';

/** A point in scene space. SfM units, not metres — see `Calibration`. */
export type Point3 = [number, number, number];

/**
 * A project's real-world scale (PLAN.md §5).
 *
 * `scale` is **metres per scene unit**: multiply a scene-unit length by it to
 * get metres. `null` on a project means the reconstruction is scale-ambiguous
 * and every measurement in it is relative.
 */
export interface Calibration {
  scale: number;
  method: 'known_distance';
  reference: {
    pointA: Point3;
    pointB: Point3;
    realDistanceM: number;
  };
  /** ISO-8601 timestamp. */
  calibratedAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  status: ProjectStatus;
  photoCount: number;
  /** Preview image for the project card (not yet produced by the pipeline). */
  thumbnailUrl?: string;
  /** Whether the scene has a real-world scale (PLAN.md §5). */
  calibrated?: boolean;
  /** `null` when uncalibrated; `undefined` if the API predates calibration. */
  calibration?: Calibration | null;
}

/** Measurement tools; mirrors `MeasurementKind` in `api/app/models.py`. */
export const MEASUREMENT_KINDS = [
  'distance',
  'polyline',
  'height',
  'angle',
  'area',
  'scale_reference',
] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

/** A measurement persisted against a project (`/api/projects/{id}/measurements`). */
export interface Measurement {
  id: string;
  projectId: string;
  kind: MeasurementKind;
  points: Point3[];
  /** Magnitude in `unit`. The viewer writes scene units (`unit: "scene"`). */
  value: number | null;
  unit: string;
  label: string | null;
  createdAt: string;
}

/** The create payload; `id`/`createdAt` are assigned by the API. */
export interface MeasurementInput {
  kind: MeasurementKind;
  points: Point3[];
  value: number | null;
  unit: string;
  label: string | null;
}

export interface Job {
  id: string;
  projectId: string;
  status: JobStatus;
  stage: JobStage;
  /**
   * Progress **within the current stage**, 0–1. The worker reports per-stage
   * progress; use `overallProgress()` for a whole-pipeline figure.
   */
  progress: number;
  message?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** One file published by a finished job (`GET /api/jobs/{id}/artifacts`). */
export interface Artifact {
  filename: string;
  bytes: number;
  /** Lower-case extension: `splat`, `ksplat`, `spz`, `ply`, … */
  format: string;
}

/** A photo held client-side before it has been uploaded. */
export interface PendingPhoto {
  id: string;
  file: File;
  /** Object URL for the thumbnail; revoked when the photo is removed. */
  previewUrl: string;
  name: string;
  size: number;
}
