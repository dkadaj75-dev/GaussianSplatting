import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SOCKET_FAILURES, POLL_INTERVAL_MS, useJobProgress } from './useJobProgress';
import { api } from '../lib/api';
import type { Job } from '../types';

/** Minimal, fully-driven WebSocket stand-in: nothing happens until a test says so. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static get last(): MockWebSocket {
    const socket = MockWebSocket.instances.at(-1);
    if (!socket) throw new Error('No WebSocket was opened');
    return socket;
  }

  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // --- test drivers ---
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({});
  }
}

const JOB_ID = 'j1';

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'progress',
    job_id: JOB_ID,
    project_id: 'p1',
    stage: 'sfm',
    progress: 0.5,
    status: 'running',
    message: 'sfm in progress',
    updated_at: '2026-08-14T10:00:10Z',
    ...overrides,
  };
}

const polledJob: Job = {
  id: JOB_ID,
  projectId: 'p1',
  stage: 'train',
  progress: 0.25,
  status: 'running',
  message: 'from polling',
  createdAt: '2026-08-14T10:00:00Z',
  updatedAt: '2026-08-14T10:02:00Z',
};

let originalWebSocket: typeof WebSocket | undefined;

beforeEach(() => {
  MockWebSocket.instances = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket as typeof WebSocket;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useJobProgress', () => {
  it('does nothing without a job id', () => {
    const { result } = renderHook(() => useJobProgress(null));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.connection).toBe('idle');
    expect(result.current.job).toBeNull();
  });

  it('subscribes to the job socket derived from the API URL', () => {
    renderHook(() => useJobProgress(JOB_ID));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last.url).toBe('ws://localhost:8000/ws/jobs/j1');
  });

  it('folds snapshot and progress frames into the job', () => {
    const { result } = renderHook(() => useJobProgress(JOB_ID));

    act(() => {
      MockWebSocket.last.accept();
      MockWebSocket.last.deliver(frame({ type: 'snapshot', stage: 'ingest', progress: 0 }));
    });
    expect(result.current.connection).toBe('live');
    expect(result.current.job).toMatchObject({ stage: 'ingest', progress: 0 });

    act(() => {
      MockWebSocket.last.deliver(frame({ stage: 'train', progress: 0.75, updated_at: '2026-08-14T10:01:00Z' }));
    });
    expect(result.current.job).toMatchObject({ stage: 'train', progress: 0.75 });
  });

  it('keeps the distinct messages seen, so a mid-run warning survives the run', () => {
    const { result } = renderHook(() => useJobProgress(JOB_ID));

    act(() => {
      MockWebSocket.last.accept();
      MockWebSocket.last.deliver(frame({ message: 'matching COLMAP features complete' }));
      MockWebSocket.last.deliver(
        frame({
          message: 'warning: only 12/40 photos registered - add more overlapping shots',
          updated_at: '2026-08-14T10:00:20Z',
        }),
      );
      // A repeat of the last message adds nothing.
      MockWebSocket.last.deliver(
        frame({
          message: 'warning: only 12/40 photos registered - add more overlapping shots',
          updated_at: '2026-08-14T10:00:30Z',
        }),
      );
      MockWebSocket.last.deliver(
        frame({ stage: 'train', message: 'training OpenSplat model 1/7000', updated_at: '2026-08-14T10:01:00Z' }),
      );
    });

    expect(result.current.messages).toEqual([
      'matching COLMAP features complete',
      'warning: only 12/40 photos registered - add more overlapping shots',
      'training OpenSplat model 1/7000',
    ]);
  });

  it('closes the socket and reports settlement when the job finishes', () => {
    const onSettled = vi.fn();
    const { result } = renderHook(() => useJobProgress(JOB_ID, { onSettled }));

    act(() => {
      MockWebSocket.last.accept();
      MockWebSocket.last.deliver(
        frame({ stage: 'publish', progress: 1, status: 'done', updated_at: '2026-08-14T10:09:00Z' }),
      );
    });

    expect(result.current.job?.status).toBe('done');
    expect(result.current.connection).toBe('closed');
    expect(MockWebSocket.instances[0].closed).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('never opens a socket for an already-finished job', () => {
    const done: Job = { ...polledJob, status: 'done', stage: 'publish', progress: 1 };
    const { result } = renderHook(() => useJobProgress(JOB_ID, { initialJob: done }));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.connection).toBe('closed');
    expect(result.current.job).toBe(done);
  });

  it('reconnects after a drop while the job is still running', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useJobProgress(JOB_ID));

    act(() => {
      MockWebSocket.last.accept();
      MockWebSocket.last.deliver(frame());
    });
    expect(result.current.connection).toBe('live');

    act(() => MockWebSocket.last.drop());
    expect(result.current.connection).toBe('reconnecting');
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    // The progress seen so far survives the reconnect.
    expect(result.current.job).toMatchObject({ stage: 'sfm', progress: 0.5 });
  });

  it('falls back to polling after repeated silent connections', async () => {
    vi.useFakeTimers();
    const getJob = vi.spyOn(api, 'getJob').mockResolvedValue(polledJob);

    const { result } = renderHook(() => useJobProgress(JOB_ID));

    for (let attempt = 0; attempt < MAX_SOCKET_FAILURES; attempt += 1) {
      act(() => MockWebSocket.last.drop());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }

    expect(MockWebSocket.instances).toHaveLength(MAX_SOCKET_FAILURES);
    expect(result.current.connection).toBe('polling');
    expect(result.current.error).toBeNull();
    expect(getJob).toHaveBeenCalledWith(JOB_ID);
    expect(result.current.job).toMatchObject({ stage: 'train', message: 'from polling' });

    // Polling keeps ticking on its own interval.
    getJob.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the polled job is terminal', async () => {
    vi.useFakeTimers();
    const getJob = vi
      .spyOn(api, 'getJob')
      .mockResolvedValue({ ...polledJob, status: 'done', stage: 'publish', progress: 1 });

    const { result } = renderHook(() => useJobProgress(JOB_ID));

    for (let attempt = 0; attempt < MAX_SOCKET_FAILURES; attempt += 1) {
      act(() => MockWebSocket.last.drop());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }

    expect(result.current.connection).toBe('closed');
    getJob.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(getJob).not.toHaveBeenCalled();
  });

  it('surfaces a polling failure without crashing', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getJob').mockRejectedValue(new Error('Could not reach the API at http://x'));

    const { result } = renderHook(() => useJobProgress(JOB_ID));
    for (let attempt = 0; attempt < MAX_SOCKET_FAILURES; attempt += 1) {
      act(() => MockWebSocket.last.drop());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }

    expect(result.current.connection).toBe('polling');
    expect(result.current.error).toMatch(/could not reach the api/i);
  });

  it('polls straight away where WebSocket is unavailable', async () => {
    const getJob = vi.spyOn(api, 'getJob').mockResolvedValue(polledJob);
    // @ts-expect-error - deliberately simulating an environment without sockets.
    delete globalThis.WebSocket;

    const { result } = renderHook(() => useJobProgress(JOB_ID));

    await waitFor(() => expect(result.current.job).toMatchObject({ message: 'from polling' }));
    expect(getJob).toHaveBeenCalledWith(JOB_ID);
    expect(result.current.connection).toBe('polling');
  });

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useJobProgress(JOB_ID));
    const socket = MockWebSocket.last;

    unmount();

    expect(socket.closed).toBe(true);
  });
});
