import { describe, expect, it } from 'vitest';
import {
  applyJobEvent,
  isActive,
  isTerminal,
  overallProgress,
  parseJobEvent,
  stageState,
} from './jobProgress';
import type { Job } from '../types';

function frame(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'progress',
    job_id: 'j1',
    project_id: 'p1',
    stage: 'sfm',
    progress: 0.5,
    status: 'running',
    message: 'sfm in progress',
    updated_at: '2026-08-14T10:00:10Z',
    ...overrides,
  });
}

const running: Job = {
  id: 'j1',
  projectId: 'p1',
  stage: 'sfm',
  progress: 0.5,
  status: 'running',
  message: 'sfm in progress',
  createdAt: '2026-08-14T10:00:00Z',
  updatedAt: '2026-08-14T10:00:10Z',
};

describe('parseJobEvent', () => {
  it('parses a JSON frame from the socket', () => {
    expect(parseJobEvent(frame())).toMatchObject({
      job_id: 'j1',
      stage: 'sfm',
      progress: 0.5,
      status: 'running',
    });
  });

  it('accepts an already-parsed object', () => {
    expect(parseJobEvent(JSON.parse(frame({ type: 'snapshot' })))?.type).toBe('snapshot');
  });

  it('rejects keepalives, malformed JSON and unknown vocabulary', () => {
    expect(parseJobEvent('{"type":"ping","job_id":"j1"}')).toBeNull();
    expect(parseJobEvent('not json')).toBeNull();
    expect(parseJobEvent(null)).toBeNull();
    expect(parseJobEvent(frame({ stage: 'teleport' }))).toBeNull();
    expect(parseJobEvent(frame({ status: 'vibing' }))).toBeNull();
    expect(parseJobEvent(frame({ job_id: '' }))).toBeNull();
  });

  it('clamps progress and normalises a missing message', () => {
    expect(parseJobEvent(frame({ progress: 4 }))?.progress).toBe(1);
    expect(parseJobEvent(frame({ progress: -2 }))?.progress).toBe(0);
    expect(parseJobEvent(frame({ progress: 'half' }))?.progress).toBe(0);
    expect(parseJobEvent(frame({ message: null }))?.message).toBeNull();
  });
});

describe('applyJobEvent', () => {
  it('builds a job from the first frame', () => {
    const job = applyJobEvent(null, frame({ type: 'snapshot' }));
    expect(job).toMatchObject({ id: 'j1', projectId: 'p1', stage: 'sfm', status: 'running' });
  });

  it('advances stage and progress', () => {
    const next = applyJobEvent(running, frame({ stage: 'train', progress: 0.25, updated_at: '2026-08-14T10:00:20Z' }));
    expect(next).toMatchObject({ stage: 'train', progress: 0.25 });
    expect(next?.createdAt).toBe(running.createdAt);
  });

  it('keeps the same object when nothing changed, so React can skip a render', () => {
    expect(applyJobEvent(running, frame())).toBe(running);
    expect(applyJobEvent(running, '{"type":"ping"}')).toBe(running);
    expect(applyJobEvent(running, 'garbage')).toBe(running);
  });

  it('ignores frames for a different job', () => {
    expect(applyJobEvent(running, frame({ job_id: 'other', progress: 0.9 }))).toBe(running);
  });

  it('ignores a replayed older frame after a reconnect', () => {
    const stale = frame({ progress: 0.1, updated_at: '2026-08-14T09:59:00Z' });
    expect(applyJobEvent(running, stale)).toBe(running);
  });

  it('stamps finishedAt on a terminal frame', () => {
    const done = applyJobEvent(
      running,
      frame({ stage: 'publish', progress: 1, status: 'done', updated_at: '2026-08-14T10:05:00Z' }),
    );
    expect(done?.status).toBe('done');
    expect(done?.finishedAt).toBe('2026-08-14T10:05:00Z');

    const failed = applyJobEvent(
      running,
      frame({ status: 'failed', message: 'only 12 of 40 registered', updated_at: '2026-08-14T10:06:00Z' }),
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.message).toBe('only 12 of 40 registered');
  });
});

describe('status helpers', () => {
  it('classifies terminal and active statuses', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isActive('queued')).toBe(true);
    expect(isActive('done')).toBe(false);
  });
});

describe('overallProgress', () => {
  it('spreads per-stage progress across the five stages', () => {
    expect(overallProgress({ stage: 'ingest', progress: 0, status: 'running' })).toBe(0);
    expect(overallProgress({ stage: 'ingest', progress: 1, status: 'running' })).toBeCloseTo(0.2);
    expect(overallProgress({ stage: 'train', progress: 0.5, status: 'running' })).toBeCloseTo(0.5);
    // A done job is complete even if the final frame reported less.
    expect(overallProgress({ stage: 'publish', progress: 0.2, status: 'done' })).toBe(1);
  });
});

describe('stageState', () => {
  it('marks earlier stages complete, the current one active and the rest pending', () => {
    const job = { stage: 'train', status: 'running' } as const;
    expect(stageState(job, 'ingest')).toBe('complete');
    expect(stageState(job, 'train')).toBe('active');
    expect(stageState(job, 'publish')).toBe('pending');
  });

  it('marks the current stage failed and every stage complete when done', () => {
    expect(stageState({ stage: 'sfm', status: 'failed' }, 'sfm')).toBe('failed');
    expect(stageState({ stage: 'publish', status: 'done' }, 'ingest')).toBe('complete');
    expect(stageState({ stage: 'publish', status: 'done' }, 'publish')).toBe('complete');
  });
});
