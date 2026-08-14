/**
 * Presentation for `lib/diagnostics.ts`: what a user sees when a pipeline run
 * fails, or finishes with photos that never registered.
 *
 * Both cards keep the worker's own message on screen. The remedy is the
 * headline, not a replacement for the evidence — a message we did not
 * recognise is still the most useful thing on the page.
 */

import { describeRegistration } from '../lib/diagnostics';
import type { FailureReport, RegistrationReport } from '../lib/diagnostics';
import { AlertIcon, CaptureIcon, RetryIcon } from './icons';

function WorkerMessage({ text }: { text: string }) {
  return (
    <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-sunken p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
      {text}
    </pre>
  );
}

export interface JobFailureCardProps {
  failure: FailureReport;
  /** Routes back to capture for this project. */
  onAddPhotos: () => void;
  /** Omitted when a re-run is not currently possible. */
  onRetry?: () => void;
  retrying?: boolean;
}

export function JobFailureCard({
  failure,
  onAddPhotos,
  onRetry,
  retrying = false,
}: JobFailureCardProps) {
  const primary =
    'flex min-h-touch flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40';
  const secondary =
    'flex min-h-touch flex-1 items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-medium transition-colors enabled:hover:bg-sunken disabled:opacity-40';

  return (
    <section
      aria-label="Processing failure"
      className="rounded-xl border border-danger/40 bg-danger/10 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertIcon className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{failure.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{failure.remedy}</p>
          <WorkerMessage text={failure.detail} />
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onAddPhotos}
          className={failure.needsMorePhotos ? primary : secondary}
        >
          <CaptureIcon className="size-5" />
          Add more photos
        </button>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className={failure.needsMorePhotos ? secondary : primary}
          >
            <RetryIcon className="size-5" />
            {retrying ? 'Starting…' : 'Run again'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export interface RegistrationWarningProps {
  report: RegistrationReport;
  onAddPhotos: () => void;
}

/**
 * Non-blocking: the scene is usable, but some viewpoints are missing from it.
 * Never gets in the way of opening the viewer.
 */
export function RegistrationWarning({ report, onAddPhotos }: RegistrationWarningProps) {
  return (
    <section
      aria-label="Coverage warning"
      className="rounded-xl border border-warn/40 bg-warn/10 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertIcon className="mt-0.5 size-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{describeRegistration(report)}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {report.registered} of {report.total} photos were placed. Shots of the missing side,
            taken with 60–70% overlap, will fill it in on the next run.
          </p>
          <WorkerMessage text={report.message} />
          <button
            type="button"
            onClick={onAddPhotos}
            className="mt-3 flex min-h-touch items-center gap-2 rounded-lg border border-line px-4 text-sm font-medium transition-colors hover:bg-sunken"
          >
            <CaptureIcon className="size-5" />
            Add more photos
          </button>
        </div>
      </div>
    </section>
  );
}
