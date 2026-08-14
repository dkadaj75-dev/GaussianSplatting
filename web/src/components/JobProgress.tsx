import { JOB_STAGES, JOB_STAGE_LABEL } from '../types';
import type { Job, JobStatus } from '../types';
import { overallProgress, stageState } from '../lib/jobProgress';
import type { JobConnection } from '../hooks/useJobProgress';
import { AlertIcon } from './icons';

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  failed: 'Failed',
  done: 'Done',
};

const CONNECTION_LABEL: Record<JobConnection, string> = {
  idle: '',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling (no live updates)',
  closed: '',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const style =
    status === 'done'
      ? 'bg-accent text-on-accent'
      : status === 'failed'
        ? 'border border-line bg-sunken text-content'
        : 'bg-raised text-content';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function StageRow({ job, stage }: { job: Job; stage: (typeof JOB_STAGES)[number] }) {
  const state = stageState(job, stage);
  const percent = state === 'complete' ? 100 : state === 'active' ? Math.round(job.progress * 100) : 0;

  const dot =
    state === 'complete'
      ? 'bg-accent'
      : state === 'active'
        ? 'bg-accent animate-pulse'
        : state === 'failed'
          ? 'bg-content'
          : 'bg-line';

  return (
    <li className="flex items-center gap-3">
      <span className={`size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span
        className={`w-28 shrink-0 text-xs ${state === 'pending' ? 'text-muted' : 'text-content'}`}
      >
        {JOB_STAGE_LABEL[stage]}
      </span>
      <span
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken"
        role="progressbar"
        aria-label={`${JOB_STAGE_LABEL[stage]} progress`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-300 ${
            state === 'failed' ? 'bg-muted' : 'bg-accent'
          }`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {state === 'pending' ? '' : `${percent}%`}
      </span>
    </li>
  );
}

export interface JobProgressProps {
  job: Job;
  connection?: JobConnection;
  /** Degraded-transport or fetch error; shown inline, never as a crash. */
  error?: string | null;
}

/**
 * The five-stage pipeline stepper: one row per stage with its own bar, plus the
 * latest worker message. Mobile-first — the rows stack and never overflow.
 */
export function JobProgress({ job, connection = 'idle', error = null }: JobProgressProps) {
  const overall = Math.round(overallProgress(job) * 100);
  const connectionLabel = CONNECTION_LABEL[connection];

  return (
    <section className="rounded-xl border border-line bg-raised p-4" aria-label="Job progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <JobStatusBadge status={job.status} />
          <span className="text-xs text-muted">{overall}% of pipeline</span>
        </div>
        {connectionLabel ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={`size-1.5 rounded-full ${connection === 'live' ? 'bg-accent' : 'bg-muted'}`}
              aria-hidden="true"
            />
            {connectionLabel}
          </span>
        ) : null}
      </div>

      <ol className="mt-4 flex flex-col gap-2.5">
        {JOB_STAGES.map((stage) => (
          <StageRow key={stage} job={job} stage={stage} />
        ))}
      </ol>

      {job.message ? (
        <p className="mt-3 text-xs break-words text-muted" data-testid="job-message">
          {job.message}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 flex items-start gap-2 text-xs break-words text-muted">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </section>
  );
}

export default JobProgress;
