import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderApp } from '../test/renderApp';
import { useAppStore } from '../store/useAppStore';

/** Inert socket: this suite is about the REST-driven parts of the page. */
class SilentWebSocket {
  onopen: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  onclose: unknown = null;
  close(): void {}
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
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket as typeof WebSocket;
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
