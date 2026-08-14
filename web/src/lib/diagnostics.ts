/**
 * Turning worker messages into something a user can act on (PLAN.md §3:
 * "failure diagnostics — only 12 of 40 photos registered — add more
 * overlapping shots of the left side").
 *
 * The pipeline reports in its own words: COLMAP/OpenSplat phase names, exit
 * codes, file paths. Those are exactly right for a log and exactly wrong as
 * the only thing a user on a site visit gets to read. This module recognises
 * the handful of failures that actually happen and pairs each with one
 * sentence about what to do next.
 *
 * Two rules it never breaks:
 *   - the worker's own message is always carried through verbatim in `detail`,
 *     so nothing is swallowed and a log paste still works;
 *   - an unrecognised message is still a diagnostic — `kind: 'unknown'` with a
 *     generic remedy — never an empty card.
 */

import type { Job, JobStage } from '../types';

/** Extracted from `warning: only 12/40 photos registered - …`. */
export interface RegistrationReport {
  registered: number;
  total: number;
  /** `total - registered`: the photos SfM could not place. */
  missing: number;
  /** 0–1. */
  ratio: number;
  /** The worker's message, verbatim. */
  message: string;
}

export type FailureKind =
  | 'not-enough-photos'
  | 'no-model'
  | 'missing-executable'
  | 'training-failed'
  | 'unknown';

export interface FailureReport {
  kind: FailureKind;
  /** Short headline, safe to show on its own. */
  title: string;
  /** One sentence: what to do about it. */
  remedy: string;
  /** The worker's message, verbatim — never summarised away. */
  detail: string;
  /** Whether shooting/adding photos is the fix (drives the primary action). */
  needsMorePhotos: boolean;
}

export interface JobDiagnostics {
  /** Set only for a job that failed. */
  failure: FailureReport | null;
  /** Set whenever SfM reported a low registration rate, success or not. */
  registration: RegistrationReport | null;
}

/** `only 12/40 photos registered`, and the `12 of 40` phrasing too. */
const REGISTRATION_PATTERN = /(\d+)\s*(?:\/|of)\s*(\d+)\s+photos\s+registered/i;

const MISSING_EXECUTABLE =
  /(?:is not installed or not on path|could not start ['"`]?[\w.\-/]+['"`]?:|command not found|no such file or directory: ['"`]?(?:colmap|opensplat))/i;

const NOT_ENOUGH_PHOTOS =
  /(?:need at least \d+ usable images|found \d+ supported non-empty images|(?:project )?has no photos|no files supplied)/i;

const NO_MODEL =
  /(?:no sparse model|did not produce images\.txt|\b(?:extracting|matching|mapping)\s+colmap\b[^\n]*\bfailed\b)/i;

const TRAINING_FAILED =
  /(?:\btraining\s+opensplat\b[^\n]*\bfailed\b|opensplat completed without producing|cannot compress|no output artifacts)/i;

/** Generic "<phase> failed (exit N)" — the stage tells us which half broke. */
const PHASE_FAILED = /\bfailed\s*\(exit\s*-?\d+\)/i;

/**
 * Reads a registration warning out of one message, or returns `null`.
 *
 * Deliberately tolerant of the surrounding prose: the worker's exact wording
 * has already changed once, and the numbers are the part that matters.
 */
export function parseRegistrationWarning(
  message: string | null | undefined,
): RegistrationReport | null {
  if (!message) return null;
  const match = REGISTRATION_PATTERN.exec(message);
  if (!match) return null;

  const registered = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(registered) || !Number.isFinite(total)) return null;
  if (total <= 0 || registered < 0 || registered > total) return null;

  return {
    registered,
    total,
    missing: total - registered,
    ratio: registered / total,
    message: message.trim(),
  };
}

/** The non-blocking sentence shown next to an otherwise-finished scene. */
export function describeRegistration(report: RegistrationReport): string {
  return `Scene built, but ${report.missing} of ${report.total} photo${
    report.total === 1 ? '' : 's'
  } didn’t register — parts of the subject may be missing.`;
}

const REPORTS: Record<Exclude<FailureKind, 'unknown'>, Omit<FailureReport, 'detail'>> = {
  'not-enough-photos': {
    kind: 'not-enough-photos',
    title: 'Not enough usable photos',
    remedy:
      'Add more photos — the pipeline needs at least 3, and 30+ overlapping shots for a scene worth measuring in.',
    needsMorePhotos: true,
  },
  'no-model': {
    kind: 'no-model',
    title: 'The photos could not be aligned',
    remedy:
      'Re-shoot orbiting the subject with 60–70% overlap, keeping the zoom fixed and avoiding blank or shiny surfaces, then add those photos and run again.',
    needsMorePhotos: true,
  },
  'missing-executable': {
    kind: 'missing-executable',
    title: 'The processing server is missing a tool',
    remedy:
      'COLMAP or OpenSplat is not installed on the worker — this is a server setup problem, so re-shooting will not help.',
    needsMorePhotos: false,
  },
  'training-failed': {
    kind: 'training-failed',
    title: 'Training did not finish',
    remedy:
      'The trainer stopped before it produced a scene. Start the job again; if it keeps stopping, try a smaller photo set or check the worker’s logs.',
    needsMorePhotos: false,
  },
};

const UNKNOWN: Omit<FailureReport, 'detail'> = {
  kind: 'unknown',
  title: 'Processing failed',
  remedy: 'Check the message below, then start the job again once the cause is addressed.',
  needsMorePhotos: false,
};

/**
 * Maps a failure message (plus the stage it failed in, when known) onto a
 * remedy. Never returns `null`: an unrecognised failure is still reported,
 * with its message intact.
 */
export function classifyFailure(
  message: string | null | undefined,
  stage?: JobStage | null,
): FailureReport {
  const detail = (message ?? '').trim();

  const template = ((): Omit<FailureReport, 'detail'> => {
    if (!detail) return UNKNOWN;
    // Order matters: a crashing phase quotes "COLMAP/OpenSplat output" in its
    // tail, so the specific patterns must win over any keyword sniffing.
    if (MISSING_EXECUTABLE.test(detail)) return REPORTS['missing-executable'];
    if (NOT_ENOUGH_PHOTOS.test(detail)) return REPORTS['not-enough-photos'];
    if (NO_MODEL.test(detail)) return REPORTS['no-model'];
    if (TRAINING_FAILED.test(detail)) return REPORTS['training-failed'];
    if (PHASE_FAILED.test(detail)) {
      return stage === 'sfm' || stage === 'ingest'
        ? REPORTS['no-model']
        : REPORTS['training-failed'];
    }
    return UNKNOWN;
  })();

  return {
    ...template,
    detail: detail || 'The worker stopped without a message.',
  };
}

/**
 * Everything worth showing about a job.
 *
 * `messages` is the stream seen while watching the job — the registration
 * warning arrives mid-run and is long overwritten by later progress messages
 * by the time the job finishes, so it can only be recovered from the history.
 */
export function diagnoseJob(
  job: Pick<Job, 'status' | 'stage' | 'message'> | null | undefined,
  messages: readonly (string | null | undefined)[] = [],
): JobDiagnostics {
  if (!job) return { failure: null, registration: null };

  let registration: RegistrationReport | null = null;
  for (const message of [...messages, job.message]) {
    // Later warnings win: a re-run's numbers replace the previous run's.
    registration = parseRegistrationWarning(message) ?? registration;
  }

  const failure =
    job.status === 'failed'
      ? classifyFailure(job.message ?? [...messages].reverse().find(Boolean) ?? null, job.stage)
      : null;

  return { failure, registration };
}
