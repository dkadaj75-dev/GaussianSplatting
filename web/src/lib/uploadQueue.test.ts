import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  UPLOAD_BATCH_SIZE,
  backoffDelayMs,
  createUploadQueue,
  initialQueueState,
  isPermanentFailure,
  nextBatch,
  nextWakeDelayMs,
  queueReducer,
  summarizeQueue,
} from './uploadQueue';
import type {
  ConnectivitySource,
  UploadItem,
  UploadQueueState,
  UploadRecord,
} from './uploadQueue';
import { createMemoryQueueStorage } from './uploadQueueStorage';

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: 'i1',
    projectId: 'p1',
    name: 'photo.jpg',
    size: 1000,
    status: 'queued',
    attempts: 0,
    error: null,
    createdAt: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

function state(items: UploadItem[], overrides: Partial<UploadQueueState> = {}): UploadQueueState {
  return { ...initialQueueState, items, ...overrides };
}

describe('backoffDelayMs', () => {
  it('doubles each attempt and then holds at the ceiling', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(4)).toBe(BACKOFF_BASE_MS * 8);
    expect(backoffDelayMs(20)).toBe(BACKOFF_MAX_MS);
  });
});

describe('isPermanentFailure', () => {
  it('treats 4xx as final but keeps retrying timeouts, rate limits and 5xx', () => {
    expect(isPermanentFailure({ status: 415 })).toBe(true);
    expect(isPermanentFailure({ status: 413 })).toBe(true);
    expect(isPermanentFailure({ status: 408 })).toBe(false);
    expect(isPermanentFailure({ status: 429 })).toBe(false);
    expect(isPermanentFailure({ status: 503 })).toBe(false);
    // A network error has no status at all.
    expect(isPermanentFailure(new Error('Failed to fetch'))).toBe(false);
    expect(isPermanentFailure(null)).toBe(false);
  });
});

describe('queueReducer', () => {
  it('appends new items and ignores ones already queued', () => {
    const first = queueReducer(initialQueueState, {
      type: 'enqueue',
      items: [item({ id: 'a' }), item({ id: 'b' })],
    });
    expect(first.items.map((entry) => entry.id)).toEqual(['a', 'b']);

    const again = queueReducer(first, { type: 'enqueue', items: [item({ id: 'b' })] });
    expect(again).toBe(first);
  });

  it('walks an item through uploading → done', () => {
    const queued = state([item({ id: 'a' })]);
    const uploading = queueReducer(queued, { type: 'batch-start', ids: ['a'] });
    expect(uploading.items[0].status).toBe('uploading');

    const progressed = queueReducer(uploading, { type: 'batch-progress', percent: 42.4 });
    expect(progressed.batchPercent).toBe(42);

    const done = queueReducer(progressed, { type: 'batch-done', ids: ['a'] });
    expect(done.items[0]).toMatchObject({ status: 'done', error: null });
  });

  it('requeues a failed batch with backoff and fails it once attempts run out', () => {
    let current = state([item({ id: 'a' }), item({ id: 'b' })]);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      current = queueReducer(current, { type: 'batch-start', ids: ['a', 'b'] });
      current = queueReducer(current, {
        type: 'batch-error',
        ids: ['a', 'b'],
        error: 'Network down',
        now: 10_000,
      });
      expect(current.items.map((entry) => entry.status)).toEqual(['queued', 'queued']);
      expect(current.items[0]).toMatchObject({
        attempts: attempt,
        error: 'Network down',
        nextAttemptAt: 10_000 + backoffDelayMs(attempt),
      });
    }

    current = queueReducer(current, { type: 'batch-start', ids: ['a', 'b'] });
    current = queueReducer(current, {
      type: 'batch-error',
      ids: ['a', 'b'],
      error: 'Network down',
      now: 20_000,
    });
    // The whole batch fails together — the API accepts or rejects it as a unit.
    expect(current.items.map((entry) => entry.status)).toEqual(['failed', 'failed']);
    expect(current.items[0].attempts).toBe(MAX_ATTEMPTS);
    expect(current.batchPercent).toBe(0);
  });

  it('fails a rejected batch immediately when no retry could help', () => {
    const uploading = queueReducer(state([item({ id: 'a' })]), {
      type: 'batch-start',
      ids: ['a'],
    });
    const failed = queueReducer(uploading, {
      type: 'batch-error',
      ids: ['a'],
      error: "Unsupported content type 'text/plain'",
      permanent: true,
      now: 1_000,
    });

    expect(failed.items[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('requeues an aborted batch without spending an attempt', () => {
    const uploading = queueReducer(state([item({ id: 'a', attempts: 2 })]), {
      type: 'batch-start',
      ids: ['a'],
    });
    const aborted = queueReducer(uploading, { type: 'batch-abort', ids: ['a'], now: 500 });

    expect(aborted.items[0]).toMatchObject({ status: 'queued', attempts: 2, nextAttemptAt: 500 });
  });

  it('re-arms failed items on retry, all of them or by id', () => {
    const failed = state([
      item({ id: 'a', status: 'failed', attempts: 5, error: 'boom' }),
      item({ id: 'b', status: 'failed', attempts: 5, error: 'boom' }),
      item({ id: 'c', status: 'done' }),
    ]);

    const all = queueReducer(failed, { type: 'retry', now: 900 });
    expect(all.items.map((entry) => entry.status)).toEqual(['queued', 'queued', 'done']);
    expect(all.items[0]).toMatchObject({ attempts: 0, error: null, nextAttemptAt: 900 });

    const one = queueReducer(failed, { type: 'retry', ids: ['b'], now: 900 });
    expect(one.items.map((entry) => entry.status)).toEqual(['failed', 'queued', 'done']);
  });

  it('cancels items and clears the finished and failed piles', () => {
    const mixed = state([
      item({ id: 'a', status: 'queued' }),
      item({ id: 'b', status: 'failed' }),
      item({ id: 'c', status: 'done' }),
    ]);

    expect(queueReducer(mixed, { type: 'cancel', ids: ['a'] }).items.map((e) => e.id)).toEqual([
      'b',
      'c',
    ]);
    expect(queueReducer(mixed, { type: 'clear-failed' }).items.map((e) => e.id)).toEqual([
      'a',
      'c',
    ]);
    expect(queueReducer(mixed, { type: 'clear-done' }).items.map((e) => e.id)).toEqual(['a', 'b']);
    expect(queueReducer(mixed, { type: 'cancel', ids: ['nope'] })).toBe(mixed);
  });

  it('drops every backoff when connectivity returns', () => {
    const waiting = state([item({ id: 'a', nextAttemptAt: 60_000 })], { online: false });

    const back = queueReducer(waiting, { type: 'connectivity', online: true, now: 5_000 });
    expect(back.online).toBe(true);
    expect(back.items[0].nextAttemptAt).toBe(5_000);
    // No change means no re-render.
    expect(queueReducer(back, { type: 'connectivity', online: true, now: 6_000 })).toBe(back);
  });

  it('requeues whatever a reload interrupted mid-upload', () => {
    const restored = queueReducer(initialQueueState, {
      type: 'hydrate',
      items: [item({ id: 'a', status: 'uploading', attempts: 1 }), item({ id: 'b' })],
      now: 77,
    });

    expect(restored.items[0]).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: 77 });
    expect(restored.items[1].status).toBe('queued');
  });
});

describe('nextBatch', () => {
  const many = Array.from({ length: 20 }, (_, index) => item({ id: `i${index}` }));

  it('takes at most one batch, from a single project', () => {
    const mixed = state([
      ...many.slice(0, 3),
      item({ id: 'other', projectId: 'p2' }),
      ...many.slice(3),
    ]);

    const batch = nextBatch(mixed, 0);
    expect(batch).toHaveLength(UPLOAD_BATCH_SIZE);
    expect(new Set(batch.map((entry) => entry.projectId))).toEqual(new Set(['p1']));
  });

  it('sends nothing while offline or while a batch is already in flight', () => {
    expect(nextBatch(state(many, { online: false }), 0)).toEqual([]);
    expect(nextBatch(state([item({ id: 'a', status: 'uploading' }), ...many]), 0)).toEqual([]);
    expect(nextBatch(state([item({ id: 'a', status: 'done' })]), 0)).toEqual([]);
  });

  it('waits for an item’s backoff to expire', () => {
    const waiting = state([item({ id: 'a', nextAttemptAt: 5_000 })]);
    expect(nextBatch(waiting, 4_999)).toEqual([]);
    expect(nextBatch(waiting, 5_000)).toHaveLength(1);
  });
});

describe('nextWakeDelayMs', () => {
  it('reports the earliest backoff still to run', () => {
    const waiting = state([
      item({ id: 'a', nextAttemptAt: 9_000 }),
      item({ id: 'b', nextAttemptAt: 4_000 }),
    ]);

    expect(nextWakeDelayMs(waiting, 1_000)).toBe(3_000);
    // Nothing to wait for: ready now, offline, or empty.
    expect(nextWakeDelayMs(waiting, 9_000)).toBeNull();
    expect(nextWakeDelayMs({ ...waiting, online: false }, 1_000)).toBeNull();
    expect(nextWakeDelayMs(initialQueueState, 0)).toBeNull();
  });
});

describe('summarizeQueue', () => {
  it('counts each state and blends the in-flight batch into progress', () => {
    const summary = summarizeQueue(
      state(
        [
          item({ id: 'a', status: 'done', size: 100 }),
          item({ id: 'b', status: 'uploading', size: 100 }),
          item({ id: 'c', status: 'queued', size: 200 }),
          item({ id: 'd', status: 'failed', size: 400 }),
        ],
        { batchPercent: 50 },
      ),
    );

    expect(summary).toMatchObject({
      total: 4,
      queued: 1,
      uploading: 1,
      done: 1,
      failed: 1,
      pending: 2,
      pendingBytes: 300,
      active: true,
      waitingForNetwork: false,
      projectIds: ['p1'],
    });
    // 100 done + half of the 100 in flight, over the 400 bytes still tracked.
    expect(summary.progress).toBeCloseTo(150 / 400, 5);
  });

  it('reports waiting-for-network only when something is actually pending', () => {
    expect(
      summarizeQueue(state([item({ id: 'a' })], { online: false })).waitingForNetwork,
    ).toBe(true);
    expect(
      summarizeQueue(state([item({ id: 'a', status: 'done' })], { online: false }))
        .waitingForNetwork,
    ).toBe(false);
    expect(summarizeQueue(initialQueueState).progress).toBe(0);
  });
});

// --- Controller --------------------------------------------------------------

function fakeConnectivity(initial = true) {
  const listeners = new Set<(online: boolean) => void>();
  let online = initial;
  const source: ConnectivitySource & { set: (next: boolean) => void } = {
    isOnline: () => online,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    set(next) {
      online = next;
      for (const listener of listeners) listener(next);
    },
  };
  return source;
}

function photos(count: number, prefix = 'shot'): File[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      new File([new Uint8Array(10)], `${prefix}-${index}.jpg`, { type: 'image/jpeg' }),
  );
}

describe('createUploadQueue', () => {
  let clock = 0;

  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function harness(overrides: {
    upload?: ReturnType<typeof vi.fn>;
    storage?: ReturnType<typeof createMemoryQueueStorage>;
    connectivity?: ReturnType<typeof fakeConnectivity>;
  } = {}) {
    const upload = overrides.upload ?? vi.fn().mockResolvedValue({ uploaded: 0 });
    const storage = overrides.storage ?? createMemoryQueueStorage();
    const connectivity = overrides.connectivity ?? fakeConnectivity();
    const onUploaded = vi.fn();
    const queue = createUploadQueue({
      storage,
      upload: upload as never,
      connectivity,
      onUploaded,
      now: () => clock,
    });
    return { queue, upload, storage, connectivity, onUploaded };
  }

  it('uploads in batches the API can accept whole, and clears storage as it goes', async () => {
    const { queue, upload, storage, onUploaded } = harness();
    await queue.start();

    await queue.enqueue('p1', photos(UPLOAD_BATCH_SIZE + 3));
    await advance(0);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toBe('p1');
    expect(upload.mock.calls[0][1]).toHaveLength(UPLOAD_BATCH_SIZE);
    expect(upload.mock.calls[1][1]).toHaveLength(3);
    // Names survive the round-trip through storage.
    expect((upload.mock.calls[0][1] as File[])[0].name).toBe('shot-0.jpg');

    const summary = summarizeQueue(queue.getState());
    expect(summary).toMatchObject({ done: 11, pending: 0, failed: 0 });
    expect(summary.progress).toBe(1);
    expect(onUploaded).toHaveBeenCalledTimes(2);
    // Nothing left to resume after a reload.
    await expect(storage.load()).resolves.toEqual([]);
  });

  it('persists queued photos before they are sent', async () => {
    const upload = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { queue, storage } = harness({ upload });
    await queue.start();

    await queue.enqueue('p1', photos(2));

    const stored = await storage.load();
    expect(stored.map((record) => record.name)).toEqual(['shot-0.jpg', 'shot-1.jpg']);
    expect(stored[0].blob.size).toBe(10);
  });

  it('retries a failed batch on the backoff schedule', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue({ uploaded: 2 });
    const { queue } = harness({ upload });
    await queue.start();

    await queue.enqueue('p1', photos(2));
    await advance(0);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(queue.getState().items[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
      error: 'Failed to fetch',
    });

    // Nothing happens before the backoff elapses…
    await advance(BACKOFF_BASE_MS - 1);
    expect(upload).toHaveBeenCalledTimes(1);
    // …and then the whole batch goes again.
    await advance(1);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(summarizeQueue(queue.getState())).toMatchObject({ done: 2, pending: 0 });
  });

  it('gives up after the attempt budget and re-arms on a manual retry', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const { queue } = harness({ upload });
    await queue.start();

    await queue.enqueue('p1', photos(1));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await advance(BACKOFF_MAX_MS);
    }

    expect(upload).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(summarizeQueue(queue.getState())).toMatchObject({ failed: 1, pending: 0 });

    upload.mockResolvedValue({ uploaded: 1 });
    queue.retry();
    await advance(0);
    expect(summarizeQueue(queue.getState())).toMatchObject({ done: 1, failed: 0 });
  });

  it('stops trying while offline and resumes on the online event', async () => {
    const connectivity = fakeConnectivity(false);
    const upload = vi.fn().mockResolvedValue({ uploaded: 3 });
    const { queue } = harness({ upload, connectivity });
    await queue.start();

    await queue.enqueue('p1', photos(3));
    await advance(30_000);

    expect(upload).not.toHaveBeenCalled();
    expect(summarizeQueue(queue.getState())).toMatchObject({
      waitingForNetwork: true,
      pending: 3,
    });

    connectivity.set(true);
    await advance(0);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(summarizeQueue(queue.getState())).toMatchObject({
      waitingForNetwork: false,
      done: 3,
    });
  });

  it('resumes a queue left behind by a previous session', async () => {
    const leftovers: UploadRecord[] = [
      {
        ...item({ id: 'left-1', name: 'left-1.jpg', status: 'uploading', attempts: 2 }),
        blob: new File([new Uint8Array(4)], 'left-1.jpg', { type: 'image/jpeg' }),
      },
      {
        ...item({ id: 'left-2', name: 'left-2.jpg' }),
        blob: new File([new Uint8Array(4)], 'left-2.jpg', { type: 'image/jpeg' }),
      },
    ];
    const upload = vi.fn().mockResolvedValue({ uploaded: 2 });
    const { queue, storage } = harness({
      upload,
      storage: createMemoryQueueStorage(leftovers),
    });

    await queue.start();
    await advance(0);

    // The interrupted item is retried rather than lost.
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0][1] as File[]).map((file) => file.name)).toEqual([
      'left-1.jpg',
      'left-2.jpg',
    ]);
    await expect(storage.load()).resolves.toEqual([]);
  });

  it('cancels a single photo without disturbing the rest', async () => {
    const upload = vi.fn().mockResolvedValue({ uploaded: 1 });
    const { queue, storage } = harness({ upload, connectivity: fakeConnectivity(false) });
    await queue.start();

    const queued = await queue.enqueue('p1', photos(3));
    queue.cancel(queued[1].id);

    expect(queue.getState().items.map((entry) => entry.name)).toEqual([
      'shot-0.jpg',
      'shot-2.jpg',
    ]);
    await expect(storage.load()).resolves.toHaveLength(2);
  });

  it('drops failed items on clearFailed', async () => {
    const upload = vi.fn().mockRejectedValue({ status: 415, message: 'Unsupported' });
    const { queue, storage } = harness({ upload });
    await queue.start();

    await queue.enqueue('p1', photos(2));
    await advance(0);
    expect(summarizeQueue(queue.getState()).failed).toBe(2);

    queue.clearFailed();
    expect(queue.getState().items).toEqual([]);
    await expect(storage.load()).resolves.toEqual([]);
  });

  it('notifies subscribers only when the state actually changes', async () => {
    const { queue } = harness({ upload: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await queue.start();

    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    const before = queue.getState();

    queue.clearFailed(); // nothing failed — no-op
    expect(listener).not.toHaveBeenCalled();
    expect(queue.getState()).toBe(before);

    await queue.enqueue('p1', photos(1));
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    queue.stop();
  });
});
