/**
 * Shared domain types.
 *
 * These mirror the API contract sketched in PLAN.md §1. The real schema lands
 * with the FastAPI package (WP 0.2); until then these are the single source of
 * truth for the client and are intentionally permissive.
 */

/** Stages of the reconstruction pipeline, in execution order. */
export const JOB_STAGES = ['ingest', 'sfm', 'train', 'compress', 'publish'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ProjectStatus = 'draft' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface Project {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  status: ProjectStatus;
  photoCount: number;
  /** URL of the published splat artifact, once the pipeline has finished. */
  splatUrl?: string;
  /** Preview image for the project card. */
  thumbnailUrl?: string;
  /** Whether the scene has a real-world scale (PLAN.md §5). */
  calibrated?: boolean;
}

export interface Job {
  id: string;
  projectId: string;
  status: JobStatus;
  stage: JobStage;
  /** 0–100 across the whole pipeline. */
  progress: number;
  message?: string;
  error?: string;
  updatedAt: string;
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
