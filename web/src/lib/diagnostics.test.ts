import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  describeRegistration,
  diagnoseJob,
  parseRegistrationWarning,
} from './diagnostics';
import type { Job } from '../types';

/** Verbatim strings the worker emits (worker/worker/backends/real.py). */
const WORKER = {
  registration: 'warning: only 12/40 photos registered - add more overlapping shots',
  tooFewImages:
    'Need at least 3 usable images; found 2 supported non-empty images in /data/projects/p1/jobs/j1/input',
  noSparseModel:
    'COLMAP mapper produced no sparse model. Try more photos with stronger overlap and texture.',
  noImagesTxt:
    'COLMAP model conversion did not produce images.txt; unable to inspect registration results.',
  colmapMissing:
    "'colmap' is not installed or not on PATH. Install COLMAP >= 3.8, or set PIPELINE_BACKEND=fake for local development.",
  couldNotStart: "Could not start 'opensplat': [Errno 2] No such file or directory",
  mapperCrashed:
    'mapping COLMAP cameras failed (exit 1). Last COLMAP/OpenSplat output:\nERROR: no good initial pair',
  trainCrashed:
    'training OpenSplat model failed (exit 137). Last COLMAP/OpenSplat output:\nCUDA out of memory',
  noPly: 'OpenSplat completed without producing work_dir/splat.ply',
  nothingToPublish: 'No output artifacts were available to publish',
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    projectId: 'p1',
    stage: 'publish',
    progress: 1,
    status: 'done',
    message: 'Pipeline complete',
    createdAt: '2026-08-14T10:00:00Z',
    updatedAt: '2026-08-14T10:20:00Z',
    ...overrides,
  };
}

describe('parseRegistrationWarning', () => {
  it('extracts the registered/total counts from the worker warning', () => {
    expect(parseRegistrationWarning(WORKER.registration)).toEqual({
      registered: 12,
      total: 40,
      missing: 28,
      ratio: 0.3,
      message: WORKER.registration,
    });
  });

  it('accepts the "12 of 40" phrasing too', () => {
    expect(parseRegistrationWarning('only 12 of 40 photos registered')).toMatchObject({
      registered: 12,
      total: 40,
    });
  });

  it('ignores anything that is not a registration report', () => {
    expect(parseRegistrationWarning(null)).toBeNull();
    expect(parseRegistrationWarning('')).toBeNull();
    expect(parseRegistrationWarning('prepared image 12/40')).toBeNull();
    expect(parseRegistrationWarning('training OpenSplat model 500/7000')).toBeNull();
    // Nonsense counts are not shown as fact.
    expect(parseRegistrationWarning('only 41/40 photos registered')).toBeNull();
    expect(parseRegistrationWarning('only 3/0 photos registered')).toBeNull();
  });
});

describe('describeRegistration', () => {
  it('says what is missing in plain words', () => {
    const report = parseRegistrationWarning(WORKER.registration);
    expect(describeRegistration(report!)).toBe(
      'Scene built, but 28 of 40 photos didn’t register — parts of the subject may be missing.',
    );
  });
});

describe('classifyFailure', () => {
  it('recognises too few usable photos', () => {
    const report = classifyFailure(WORKER.tooFewImages, 'ingest');
    expect(report.kind).toBe('not-enough-photos');
    expect(report.needsMorePhotos).toBe(true);
    expect(report.remedy).toMatch(/at least 3/);
  });

  it('recognises a reconstruction that produced no model', () => {
    expect(classifyFailure(WORKER.noSparseModel, 'sfm').kind).toBe('no-model');
    expect(classifyFailure(WORKER.noImagesTxt, 'sfm').kind).toBe('no-model');
    expect(classifyFailure(WORKER.mapperCrashed, 'sfm').kind).toBe('no-model');
    expect(classifyFailure(WORKER.noSparseModel, 'sfm').remedy).toMatch(/overlap/i);
  });

  it('recognises a missing executable as a server problem, not a photo problem', () => {
    for (const message of [WORKER.colmapMissing, WORKER.couldNotStart]) {
      const report = classifyFailure(message, 'sfm');
      expect(report.kind).toBe('missing-executable');
      expect(report.needsMorePhotos).toBe(false);
    }
  });

  it('recognises a training failure even though the tail names COLMAP', () => {
    // "Last COLMAP/OpenSplat output" appears in every crash tail; the phase
    // prefix is what decides.
    expect(classifyFailure(WORKER.trainCrashed, 'train').kind).toBe('training-failed');
    expect(classifyFailure(WORKER.noPly, 'train').kind).toBe('training-failed');
    expect(classifyFailure(WORKER.nothingToPublish, 'publish').kind).toBe('training-failed');
  });

  it('falls back to the stage for an unlabelled phase crash', () => {
    expect(classifyFailure('something failed (exit 9)', 'sfm').kind).toBe('no-model');
    expect(classifyFailure('something failed (exit 9)', 'train').kind).toBe('training-failed');
  });

  it('keeps an unknown message verbatim instead of swallowing it', () => {
    const report = classifyFailure('Redis connection reset by peer', 'train');
    expect(report.kind).toBe('unknown');
    expect(report.detail).toBe('Redis connection reset by peer');
    expect(report.title).toBe('Processing failed');
    expect(report.remedy).not.toBe('');
  });

  it('always has something to show, even with no message at all', () => {
    expect(classifyFailure(null).detail).toBe('The worker stopped without a message.');
    expect(classifyFailure('   ').kind).toBe('unknown');
  });
});

describe('diagnoseJob', () => {
  it('reports nothing for a clean run', () => {
    expect(diagnoseJob(job(), ['prepared image 40/40', 'Pipeline complete'])).toEqual({
      failure: null,
      registration: null,
    });
    expect(diagnoseJob(null)).toEqual({ failure: null, registration: null });
  });

  it('recovers a registration warning from the message history of a finished job', () => {
    // By the time the job is done its own message is long past the warning.
    const diagnostics = diagnoseJob(job(), [
      'matching COLMAP features complete',
      WORKER.registration,
      'training OpenSplat model 7000/7000',
      'Pipeline complete',
    ]);

    expect(diagnostics.failure).toBeNull();
    expect(diagnostics.registration).toMatchObject({ registered: 12, total: 40, missing: 28 });
  });

  it('prefers the most recent registration report', () => {
    const diagnostics = diagnoseJob(job(), [
      'warning: only 12/40 photos registered - add more overlapping shots',
      'warning: only 33/40 photos registered - add more overlapping shots',
    ]);
    expect(diagnostics.registration?.registered).toBe(33);
  });

  it('classifies a failed job from its own final message', () => {
    const diagnostics = diagnoseJob(
      job({ status: 'failed', stage: 'sfm', message: WORKER.noSparseModel }),
      ['extracting COLMAP features complete'],
    );

    expect(diagnostics.failure).toMatchObject({
      kind: 'no-model',
      needsMorePhotos: true,
      detail: WORKER.noSparseModel,
    });
  });

  it('falls back to the last message seen when the job carries none', () => {
    const diagnostics = diagnoseJob(job({ status: 'failed', stage: 'train', message: null }), [
      'training OpenSplat model 100/7000',
      WORKER.trainCrashed,
    ]);

    expect(diagnostics.failure?.kind).toBe('training-failed');
  });

  it('can report both a failure and the registration warning that preceded it', () => {
    const diagnostics = diagnoseJob(
      job({ status: 'failed', stage: 'train', message: WORKER.trainCrashed }),
      [WORKER.registration],
    );

    expect(diagnostics.failure?.kind).toBe('training-failed');
    expect(diagnostics.registration?.registered).toBe(12);
  });
});
