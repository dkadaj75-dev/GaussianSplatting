import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../test/renderApp';
import { useAppStore } from '../store/useAppStore';
import { resetUploadQueue } from '../hooks/useUploadQueue';

/** Inert socket: this suite is about the REST-driven parts of the page. */
class SilentWebSocket {
  onopen: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  onclose: unknown = null;
  close(): void {}
}

/** Socket the test drives frame by frame, for the live-message diagnostics. */
class DrivenWebSocket {
  static instances: DrivenWebSocket[] = [];

  static get last(): DrivenWebSocket {
    const socket = DrivenWebSocket.instances.at(-1);
    if (!socket) throw new Error('No WebSocket was opened');
    return socket;
  }

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor() {
    DrivenWebSocket.instances.push(this);
  }

  close(): void {}

  deliver(payload: Record<string, unknown>): void {
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

interface Route {
  match: (url: string) => boolean;
  body: unknown;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockApi(routes: Route[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) return jsonResponse({ detail: `No route for ${url}` }, 404);
    return jsonResponse(route.body, route.status);
  });
}

const PROJECT = {
  id: 'p1',
  name: 'Balcony anchor detail',
  created_at: '2026-08-14T10:00:00Z',
  status: 'processing',
  photo_count: 34,
};

const RUNNING_JOB = {
  id: 'j1',
  project_id: 'p1',
  stage: 'train',
  progress: 0.4,
  status: 'running',
  message: 'train in progress',
  created_at: '2026-08-14T10:01:00Z',
  updated_at: '2026-08-14T10:05:00Z',
  started_at: '2026-08-14T10:01:10Z',
  finished_at: null,
};

const DONE_JOB = {
  ...RUNNING_JOB,
  stage: 'publish',
  progress: 1,
  status: 'done',
  message: 'Pipeline complete',
  finished_at: '2026-08-14T10:20:00Z',
};

let originalWebSocket: typeof WebSocket | undefined;

beforeEach(() => {
  useAppStore.getState().reset();
  DrivenWebSocket.instances = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket as typeof WebSocket;
  resetUploadQueue();
  vi.restoreAllMocks();
});

describe('project detail page', () => {
  it('shows the photo count and the pipeline stepper for a running job', async () => {
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: PROJECT },
      { match: (url) => url.endsWith('/api/projects/p1/jobs'), body: [RUNNING_JOB] },
    ]);

    renderApp('/projects/p1');

    expect(await screen.findByRole('heading', { name: PROJECT.name })).toBeInTheDocument();
    expect(await screen.findByTestId('photo-count')).toHaveTextContent('34');

    const progress = await screen.findByRole('region', { name: /job progress/i });
    expect(progress).toBeInTheDocument();
    // One bar per pipeline stage.
    expect(screen.getAllByRole('progressbar')).toHaveLength(5);
    expect(screen.getByTestId('job-message')).toHaveTextContent('train in progress');
    // 3 stages behind + 40% of 'train' out of five stages.
    expect(progress).toHaveTextContent('48% of pipeline');

    // A job is already running, so a second one cannot be started.
    expect(screen.getByRole('button', { name: /start processing/i })).toBeDisabled();
  });

  it('offers the finished scene, naming the artifact it picked', async () => {
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: { ...PROJECT, status: 'ready' } },
      { match: (url) => url.endsWith('/api/projects/p1/jobs'), body: [DONE_JOB] },
      {
        match: (url) => url.endsWith('/api/jobs/j1/artifacts'),
        body: [
          { filename: 'output.ply', bytes: 2_097_152, format: 'ply' },
          { filename: 'scene.splat', bytes: 524_288, format: 'splat' },
        ],
      },
    ]);

    renderApp('/projects/p1');

    expect(await screen.findByText(/scene ready/i)).toBeInTheDocument();
    // scene.splat wins over the much larger raw ply.
    expect(await screen.findByText(/scene\.splat · 512 KB/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /open in viewer/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /start processing/i })).toBeEnabled();
  });

  it('degrades to a retryable message when the API is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    renderApp('/projects/p1');

    await waitFor(() => expect(screen.getByText(/can’t reach the api/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all projects/i })).toBeInTheDocument();
  });

  it('reports a missing project instead of an empty page', async () => {
    mockApi([{ match: () => true, body: { detail: 'Project p1 not found' }, status: 404 }]);

    renderApp('/projects/p1');

    expect(await screen.findByText(/project not found/i)).toBeInTheDocument();
    expect(screen.getByText(/Project p1 not found/)).toBeInTheDocument();
  });
});

// --- Failure diagnostics (WP 4.3) -------------------------------------------

const NO_MODEL_MESSAGE =
  'COLMAP mapper produced no sparse model. Try more photos with stronger overlap and texture.';

function failedJob(message: string, stage = 'sfm') {
  return {
    ...RUNNING_JOB,
    stage,
    status: 'failed',
    message,
    finished_at: '2026-08-14T10:07:00Z',
  };
}

describe('project failure diagnostics', () => {
  it('turns a worker failure into a remedy, without hiding the original message', async () => {
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: { ...PROJECT, status: 'failed' } },
      { match: (url) => url.endsWith('/api/projects/p1/jobs'), body: [failedJob(NO_MODEL_MESSAGE)] },
    ]);

    renderApp('/projects/p1');

    const card = await screen.findByRole('region', { name: /processing failure/i });
    expect(card).toHaveTextContent(/the photos could not be aligned/i);
    expect(card).toHaveTextContent(/60–70% overlap/i);
    // The worker's own words survive verbatim.
    expect(card).toHaveTextContent(NO_MODEL_MESSAGE);
  });

  it('routes the fix straight back to capture for this project', async () => {
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: { ...PROJECT, status: 'failed' } },
      {
        match: (url) => url.endsWith('/api/projects/p1/jobs'),
        body: [failedJob('Need at least 3 usable images; found 2 supported non-empty images', 'ingest')],
      },
      { match: (url) => url.endsWith('/api/projects'), body: [] },
    ]);

    renderApp('/projects/p1');

    const card = await screen.findByRole('region', { name: /processing failure/i });
    expect(card).toHaveTextContent(/not enough usable photos/i);

    fireEvent.click(within(card).getByRole('button', { name: /add more photos/i }));

    expect(await screen.findByRole('heading', { name: 'Capture' })).toBeInTheDocument();
    expect(useAppStore.getState().selectedProjectId).toBe('p1');
  });

  it('keeps an unrecognised failure readable rather than swallowing it', async () => {
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: { ...PROJECT, status: 'failed' } },
      {
        match: (url) => url.endsWith('/api/projects/p1/jobs'),
        body: [failedJob('Redis connection reset by peer', 'train')],
      },
    ]);

    renderApp('/projects/p1');

    const card = await screen.findByRole('region', { name: /processing failure/i });
    expect(card).toHaveTextContent('Processing failed');
    expect(card).toHaveTextContent('Redis connection reset by peer');
  });

  it('warns about unregistered photos on a scene that still built', async () => {
    globalThis.WebSocket = DrivenWebSocket as unknown as typeof WebSocket;
    mockApi([
      { match: (url) => url.endsWith('/api/projects/p1'), body: PROJECT },
      { match: (url) => url.endsWith('/api/projects/p1/jobs'), body: [RUNNING_JOB] },
      { match: (url) => url.endsWith('/api/jobs/j1/artifacts'), body: [] },
    ]);

    renderApp('/projects/p1');
    await screen.findByRole('region', { name: /job progress/i });

    const frame = (overrides: Record<string, unknown>) => ({
      type: 'progress',
      job_id: 'j1',
      project_id: 'p1',
      stage: 'sfm',
      progress: 1,
      status: 'running',
      updated_at: '2026-08-14T10:06:00Z',
      ...overrides,
    });

    // The warning arrives mid-run and is overwritten by later messages…
    act(() =>
      DrivenWebSocket.last.deliver(
        frame({ message: 'warning: only 12/40 photos registered - add more overlapping shots' }),
      ),
    );
    act(() =>
      DrivenWebSocket.last.deliver(
        frame({ stage: 'train', message: 'training OpenSplat model 7000/7000', updated_at: '2026-08-14T10:08:00Z' }),
      ),
    );
    act(() =>
      DrivenWebSocket.last.deliver(
        frame({
          stage: 'publish',
          status: 'done',
          message: 'Pipeline complete',
          updated_at: '2026-08-14T10:09:00Z',
        }),
      ),
    );

    // …so the finished scene still gets its coverage caveat, non-blocking.
    const warning = await screen.findByRole('region', { name: /coverage warning/i });
    expect(warning).toHaveTextContent(/scene built, but 28 of 40 photos didn’t register/i);
    expect(warning).toHaveTextContent('only 12/40 photos registered');
    expect(await screen.findByText(/scene ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /processing failure/i })).not.toBeInTheDocument();
  });
});
