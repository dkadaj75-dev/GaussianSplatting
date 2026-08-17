/**
 * Pure job-progress logic: parsing `/ws/jobs/{id}` frames and folding them into
 * the current `Job`.
 *
 * Kept free of React and of the socket itself so the interesting rules — stale
 * frames, unknown frames, terminal detection — are unit-testable without
 * timers or a fake server.
 */

import { JOB_STAGES } from '../types';
import type { Job, JobStage, JobStatus } from '../types';

/** Server → client frame (api/app/schemas.py :: JobEvent). */
export interface JobEvent {
  /** `snapshot` on connect, then `created` / `progress`; `ping` is a keepalive. */
  type: string;
  job_id: string;
  project_id: string;
  stage: JobStage;
  progress: number;
  status: JobStatus;
  message?: string | null;
  updated_at: string;
}

const STAGES: readonly string[] = JOB_STAGES;
const STATUSES: readonly string[] = ['queued', 'running', 'failed', 'done'];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed'];

export function isTerminal(status: JobStatus | undefined | null): boolean {
  return status === 'done' || status === 'failed';
}

export function isActive(status: JobStatus | undefined | null): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Validates one frame, accepting a raw string (what `MessageEvent.data`
 * carries) or an already-parsed object. Returns `null` for keepalives and for
 * anything a future server version might send that we do not understand — a
 * frame we cannot trust must never corrupt the displayed state.
 */
export function parseJobEvent(input: unknown): JobEvent | null {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;
  if (raw.type === 'ping') return null;
  if (typeof raw.job_id !== 'string' || raw.job_id.length === 0) return null;
  if (typeof raw.stage !== 'string' || !STAGES.includes(raw.stage)) return null;
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return null;
  if (typeof raw.updated_at !== 'string') return null;

  const progress = typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? raw.progress : 0;

  return {
    type: typeof raw.type === 'string' ? raw.type : 'progress',
    job_id: raw.job_id,
    project_id: typeof raw.project_id === 'string' ? raw.project_id : '',
    stage: raw.stage as JobStage,
    progress: Math.min(1, Math.max(0, progress)),
    status: raw.status as JobStatus,
    message: typeof raw.message === 'string' ? raw.message : null,
    updated_at: raw.updated_at,
  };
}

function timestamp(value: string | undefined | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Folds one frame into the current job.
 *
 * Returns `current` **by reference** when the frame changes nothing, so a
 * caller can use identity to skip a React re-render. Frames for another job,
 * and frames older than what we already have (which a reconnect can replay),
 * are ignored.
 */
export function applyJobEvent(current: Job | null, input: unknown): Job | null {
  const event = parseJobEvent(input);
  if (!event) return current;
  if (current && current.id !== event.job_id) return current;
  if (current && timestamp(event.updated_at) < timestamp(current.updatedAt)) return current;

  const next: Job = {
    id: event.job_id,
    projectId: event.project_id || current?.projectId || '',
    stage: event.stage,
    progress: event.progress,
    status: event.status,
    message: event.message ?? null,
    createdAt: current?.createdAt ?? event.updated_at,
    updatedAt: event.updated_at,
    startedAt: current?.startedAt ?? null,
    finishedAt: isTerminal(event.status)
      ? (current?.finishedAt ?? event.updated_at)
      : null,
    // Progress frames never restate how the run was configured; carrying the
    // params forward keeps the options summary on screen mid-run.
    params: current?.params,
  };

  if (
    current &&
    current.stage === next.stage &&
    current.progress === next.progress &&
    current.status === next.status &&
    current.message === next.message &&
    current.updatedAt === next.updatedAt
  ) {
    return current;
  }
  return next;
}

export function stageIndex(stage: JobStage): number {
  const index = JOB_STAGES.indexOf(stage);
  return index === -1 ? 0 : index;
}

/** Whole-pipeline completion, 0–1, from a per-stage progress value. */
export function overallProgress(job: Pick<Job, 'stage' | 'progress' | 'status'>): number {
  if (job.status === 'done') return 1;
  const fraction = (stageIndex(job.stage) + Math.min(1, Math.max(0, job.progress))) / JOB_STAGES.length;
  return Math.min(1, Math.max(0, fraction));
}

export type StageState = 'complete' | 'active' | 'failed' | 'pending';

/** How one stage of the stepper should render for the given job. */
export function stageState(job: Pick<Job, 'stage' | 'status'>, stage: JobStage): StageState {
  const current = stageIndex(job.stage);
  const target = stageIndex(stage);
  if (job.status === 'done') return 'complete';
  if (target < current) return 'complete';
  if (target > current) return 'pending';
  if (job.status === 'failed') return 'failed';
  return 'active';
}
