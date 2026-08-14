/**
 * Offline-tolerant photo upload queue (PLAN.md §3: "chunked, resumable
 * uploads … queue now, upload on Wi-Fi").
 *
 * A site visit is exactly where connectivity dies, so a photo set is never
 * handed straight to `fetch` and hoped for. It goes into a durable queue that:
 *
 *   - persists the actual `File`/`Blob` in IndexedDB, so a reload, a killed tab
 *     or a lost signal never loses the photos (see `uploadQueueStorage.ts`);
 *   - uploads in **batches of {@link UPLOAD_BATCH_SIZE}**, because the API's
 *     `POST /api/projects/{id}/photos` is all-or-nothing: it rejects the whole
 *     multipart body if any file fails validation. A batch is therefore the
 *     unit of retry — a failure re-sends the batch, never a half of it;
 *   - retries with exponential backoff, and gives up into a `failed` state the
 *     user can retry by hand;
 *   - pauses while offline and resumes on the `online` event.
 *
 * Everything interesting — state transitions, the backoff schedule, batching —
 * is a pure function of state; `createUploadQueue` only wires those to a clock,
 * a network call and a storage layer, all injectable.
 */

/** Photos per request. The API treats one request as one all-or-nothing batch. */
export const UPLOAD_BATCH_SIZE = 8;

/** Automatic attempts per batch before an item needs a manual retry. */
export const MAX_ATTEMPTS = 5;

/** First backoff step; each further attempt doubles it. */
export const BACKOFF_BASE_MS = 2_000;

/** Backoff ceiling — a phone in a basement should still poke the network. */
export const BACKOFF_MAX_MS = 60_000;

export type UploadItemStatus = 'queued' | 'uploading' | 'done' | 'failed';

/** A queued photo as the UI sees it: no payload, so state stays cheap to diff. */
export interface UploadItem {
  id: string;
  projectId: string;
  name: string;
  size: number;
  status: UploadItemStatus;
  /** Failed batch attempts so far. */
  attempts: number;
  error: string | null;
  createdAt: number;
  /** Epoch ms; the item is not eligible for a batch before this. */
  nextAttemptAt: number;
}

/** What persistence stores: the item plus the bytes to send. */
export interface UploadRecord extends UploadItem {
  blob: Blob;
}

/**
 * Durable backing store. Small on purpose: tests inject an in-memory fake and
 * the IndexedDB implementation stays swappable.
 */
export interface QueueStorage {
  load(): Promise<UploadRecord[]>;
  put(records: readonly UploadRecord[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface UploadQueueState {
  items: UploadItem[];
  online: boolean;
  /** Upload progress of the batch in flight, 0–100. */
  batchPercent: number;
}

export const initialQueueState: UploadQueueState = { items: [], online: true, batchPercent: 0 };

export type UploadQueueAction =
  /** Restore from storage; anything caught mid-upload by a reload requeues. */
  | { type: 'hydrate'; items: readonly UploadItem[]; now: number }
  | { type: 'enqueue'; items: readonly UploadItem[] }
  | { type: 'batch-start'; ids: readonly string[] }
  | { type: 'batch-progress'; percent: number }
  | { type: 'batch-done'; ids: readonly string[] }
  | {
      type: 'batch-error';
      ids: readonly string[];
      error: string;
      /** A rejection no retry can fix (4xx): fail immediately. */
      permanent?: boolean;
      now: number;
    }
  /** The batch was interrupted (cancel/shutdown), which is nobody's fault. */
  | { type: 'batch-abort'; ids: readonly string[]; now: number }
  | { type: 'retry'; ids?: readonly string[]; now: number }
  | { type: 'cancel'; ids: readonly string[] }
  | { type: 'clear-failed' }
  | { type: 'clear-done' }
  | { type: 'connectivity'; online: boolean; now: number };

/** Delay before attempt `attempt` (1-based): 2s, 4s, 8s, 16s, 32s, capped at 60s. */
export function backoffDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/** 4xx means the server will say no again; 408/429 are worth another try. */
export function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function mapItems(
  state: UploadQueueState,
  ids: readonly string[],
  transform: (item: UploadItem) => UploadItem,
): UploadQueueState {
  const targets = new Set(ids);
  let changed = false;
  const items = state.items.map((item) => {
    if (!targets.has(item.id)) return item;
    const next = transform(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...state, items } : state;
}

/**
 * The whole queue lifecycle, as a pure reducer.
 *
 * Returns `state` by reference when an action changes nothing, so a React
 * subscriber can skip the render.
 */
export function queueReducer(
  state: UploadQueueState,
  action: UploadQueueAction,
): UploadQueueState {
  switch (action.type) {
    case 'hydrate': {
      const items = action.items.map((item) =>
        item.status === 'uploading'
          ? { ...item, status: 'queued' as const, nextAttemptAt: action.now }
          : item,
      );
      return { ...state, items, batchPercent: 0 };
    }

    case 'enqueue': {
      const known = new Set(state.items.map((item) => item.id));
      const added = action.items.filter((item) => !known.has(item.id));
      if (added.length === 0) return state;
      return { ...state, items: [...state.items, ...added] };
    }

    case 'batch-start':
      return {
        ...mapItems(state, action.ids, (item) => ({
          ...item,
          status: 'uploading',
          error: null,
        })),
        batchPercent: 0,
      };

    case 'batch-progress': {
      const percent = Math.max(0, Math.min(100, Math.round(action.percent)));
      return percent === state.batchPercent ? state : { ...state, batchPercent: percent };
    }

    case 'batch-done':
      return {
        ...mapItems(state, action.ids, (item) => ({
          ...item,
          status: 'done',
          error: null,
          nextAttemptAt: item.nextAttemptAt,
        })),
        batchPercent: 100,
      };

    case 'batch-error':
      return {
        ...mapItems(state, action.ids, (item) => {
          const attempts = item.attempts + 1;
          const exhausted = action.permanent === true || attempts >= MAX_ATTEMPTS;
          return {
            ...item,
            attempts,
            error: action.error,
            status: exhausted ? 'failed' : 'queued',
            nextAttemptAt: exhausted ? item.nextAttemptAt : action.now + backoffDelayMs(attempts),
          };
        }),
        batchPercent: 0,
      };

    case 'batch-abort':
      // Not a real attempt: the count and the backoff stay where they were.
      return {
        ...mapItems(state, action.ids, (item) =>
          item.status === 'uploading'
            ? { ...item, status: 'queued', nextAttemptAt: action.now }
            : item,
        ),
        batchPercent: 0,
      };

    case 'retry': {
      const ids =
        action.ids ??
        state.items.filter((item) => item.status === 'failed').map((item) => item.id);
      return mapItems(state, ids, (item) =>
        item.status === 'done' || item.status === 'uploading'
          ? item
          : { ...item, status: 'queued', attempts: 0, error: null, nextAttemptAt: action.now },
      );
    }

    case 'cancel': {
      const targets = new Set(action.ids);
      const items = state.items.filter((item) => !targets.has(item.id));
      return items.length === state.items.length ? state : { ...state, items };
    }

    case 'clear-failed': {
      const items = state.items.filter((item) => item.status !== 'failed');
      return items.length === state.items.length ? state : { ...state, items };
    }

    case 'clear-done': {
      const items = state.items.filter((item) => item.status !== 'done');
      return items.length === state.items.length ? state : { ...state, items };
    }

    case 'connectivity': {
      if (state.online === action.online) return state;
      if (!action.online) return { ...state, online: false };
      // Coming back on-line invalidates every network-error backoff: the thing
      // we were waiting for has happened.
      return {
        ...state,
        online: true,
        items: state.items.map((item) =>
          item.status === 'queued' && item.nextAttemptAt > action.now
            ? { ...item, nextAttemptAt: action.now }
            : item,
        ),
      };
    }

    default:
      return state;
  }
}

/**
 * The next batch to send, or `[]` when nothing may go now.
 *
 * One batch is in flight at a time (a phone's uplink is the bottleneck, and
 * serial batches keep progress reporting honest), every item in it belongs to
 * one project because the endpoint is per-project, and nothing leaves while the
 * device is offline.
 */
export function nextBatch(
  state: UploadQueueState,
  now: number,
  size: number = UPLOAD_BATCH_SIZE,
): UploadItem[] {
  if (!state.online) return [];
  if (state.items.some((item) => item.status === 'uploading')) return [];

  const eligible = state.items.filter(
    (item) => item.status === 'queued' && item.nextAttemptAt <= now,
  );
  if (eligible.length === 0) return [];

  const projectId = eligible[0].projectId;
  return eligible.filter((item) => item.projectId === projectId).slice(0, Math.max(1, size));
}

/**
 * Milliseconds until the earliest waiting item becomes eligible, or `null` when
 * nothing is waiting on the clock (idle, offline, or ready right now).
 */
export function nextWakeDelayMs(state: UploadQueueState, now: number): number | null {
  if (!state.online) return null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const item of state.items) {
    if (item.status === 'queued' && item.nextAttemptAt > now) {
      earliest = Math.min(earliest, item.nextAttemptAt);
    }
  }
  return Number.isFinite(earliest) ? Math.max(0, earliest - now) : null;
}

export interface UploadQueueSummary {
  total: number;
  queued: number;
  uploading: number;
  done: number;
  failed: number;
  /** Photos still owed to the server. */
  pending: number;
  pendingBytes: number;
  /** 0–1 across everything that has not failed. */
  progress: number;
  /** Photos are waiting only because there is no connection. */
  waitingForNetwork: boolean;
  active: boolean;
  /** Projects with at least one pending photo, in insertion order. */
  projectIds: string[];
}

export function summarizeQueue(state: UploadQueueState): UploadQueueSummary {
  let queued = 0;
  let uploading = 0;
  let done = 0;
  let failed = 0;
  let pendingBytes = 0;
  let doneBytes = 0;
  let uploadingBytes = 0;
  const projectIds: string[] = [];

  for (const item of state.items) {
    switch (item.status) {
      case 'queued':
        queued += 1;
        pendingBytes += item.size;
        break;
      case 'uploading':
        uploading += 1;
        pendingBytes += item.size;
        uploadingBytes += item.size;
        break;
      case 'done':
        done += 1;
        doneBytes += item.size;
        break;
      case 'failed':
        failed += 1;
        break;
    }
    if (item.status !== 'done' && !projectIds.includes(item.projectId)) {
      projectIds.push(item.projectId);
    }
  }

  const tracked = doneBytes + pendingBytes;
  const progress =
    tracked === 0
      ? 0
      : Math.min(1, (doneBytes + (uploadingBytes * state.batchPercent) / 100) / tracked);

  const pending = queued + uploading;
  return {
    total: state.items.length,
    queued,
    uploading,
    done,
    failed,
    pending,
    pendingBytes,
    progress,
    waitingForNetwork: !state.online && pending > 0,
    active: uploading > 0,
    projectIds,
  };
}

// --- Controller --------------------------------------------------------------

export interface UploadFn {
  (
    projectId: string,
    files: File[],
    options: { onProgress?: (percent: number) => void; signal?: AbortSignal },
  ): Promise<{ uploaded: number }>;
}

/** `navigator.onLine` + the `online`/`offline` events, injectable for tests. */
export interface ConnectivitySource {
  isOnline(): boolean;
  subscribe(onChange: (online: boolean) => void): () => void;
}

export function browserConnectivity(): ConnectivitySource {
  return {
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    subscribe(onChange) {
      if (typeof window === 'undefined') return () => {};
      const goOnline = () => onChange(true);
      const goOffline = () => onChange(false);
      window.addEventListener('online', goOnline);
      window.addEventListener('offline', goOffline);
      return () => {
        window.removeEventListener('online', goOnline);
        window.removeEventListener('offline', goOffline);
      };
    },
  };
}

export interface UploadQueueOptions {
  storage: QueueStorage;
  upload: UploadFn;
  connectivity?: ConnectivitySource;
  now?: () => number;
  batchSize?: number;
  /** Called after a batch lands, so server-derived views can be refreshed. */
  onUploaded?: (projectId: string, count: number) => void;
}

export interface UploadQueue {
  getState(): UploadQueueState;
  subscribe(listener: () => void): () => void;
  /** Loads anything left over from a previous session and starts working. */
  start(): Promise<void>;
  stop(): void;
  enqueue(projectId: string, files: readonly File[]): Promise<UploadItem[]>;
  /** Re-arms failed items (all of them, or the ones named). */
  retry(ids?: readonly string[]): void;
  cancel(id: string): void;
  clearFailed(): void;
  clearDone(): void;
}

function makeId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `up_${Date.now().toString(36)}_${random}`;
}

/** A stored blob is sent under its original name even if it lost `File`-ness. */
function toUploadFile(record: UploadRecord): File {
  if (typeof File === 'function') {
    if (record.blob instanceof File && record.blob.name === record.name) return record.blob;
    try {
      return new File([record.blob], record.name, {
        type: record.blob.type || 'application/octet-stream',
      });
    } catch {
      /* Fall through: FormData's filename argument still names the part. */
    }
  }
  return record.blob as File;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Upload failed.';
}

export function createUploadQueue(options: UploadQueueOptions): UploadQueue {
  const now = options.now ?? (() => Date.now());
  const connectivity = options.connectivity ?? browserConnectivity();
  const batchSize = options.batchSize ?? UPLOAD_BATCH_SIZE;

  let state: UploadQueueState = { ...initialQueueState, online: connectivity.isOnline() };
  const blobs = new Map<string, Blob>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeConnectivity: (() => void) | undefined;
  let inFlight: AbortController | null = null;
  let pumping = false;
  let stopped = false;
  let started = false;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const dispatch = (action: UploadQueueAction) => {
    const next = queueReducer(state, action);
    if (next === state) return;
    state = next;
    emit();
  };

  /** Storage is a convenience, never a dependency: log and carry on. */
  const persistSafely = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      console.warn('Upload queue storage unavailable:', error);
    }
  };

  const recordsFor = (ids: readonly string[]): UploadRecord[] => {
    const wanted = new Set(ids);
    const records: UploadRecord[] = [];
    for (const item of state.items) {
      const blob = blobs.get(item.id);
      if (wanted.has(item.id) && blob) records.push({ ...item, blob });
    }
    return records;
  };

  const forget = (ids: readonly string[]) => {
    for (const id of ids) blobs.delete(id);
    void persistSafely(() => options.storage.remove(ids));
  };

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const scheduleWake = () => {
    clearTimer();
    if (stopped) return;
    const delay = nextWakeDelayMs(state, now());
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, delay);
  };

  const pump = async (): Promise<void> => {
    if (pumping || stopped) return;
    const batch = nextBatch(state, now(), batchSize);
    if (batch.length === 0) {
      scheduleWake();
      return;
    }

    pumping = true;
    clearTimer();
    const ids = batch.map((item) => item.id);
    const projectId = batch[0].projectId;
    const records = recordsFor(ids);

    if (records.length !== ids.length) {
      // The payload is gone (storage was cleared under us). Failing loudly is
      // better than retrying forever against nothing.
      dispatch({
        type: 'batch-error',
        ids,
        error: 'Photo data is no longer available on this device.',
        permanent: true,
        now: now(),
      });
      pumping = false;
      void pump();
      return;
    }

    dispatch({ type: 'batch-start', ids });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    inFlight = controller;

    try {
      await options.upload(projectId, records.map(toUploadFile), {
        onProgress: (percent) => dispatch({ type: 'batch-progress', percent }),
        signal: controller?.signal,
      });
      dispatch({ type: 'batch-done', ids });
      forget(ids);
      options.onUploaded?.(projectId, ids.length);
    } catch (error) {
      if (controller?.signal.aborted) {
        dispatch({ type: 'batch-abort', ids, now: now() });
      } else {
        dispatch({
          type: 'batch-error',
          ids,
          error: describeError(error),
          permanent: isPermanentFailure(error),
          now: now(),
        });
        void persistSafely(() => options.storage.put(recordsFor(ids)));
      }
    } finally {
      inFlight = null;
      pumping = false;
    }

    await pump();
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start() {
      stopped = false;
      unsubscribeConnectivity ??= connectivity.subscribe((online) => {
        dispatch({ type: 'connectivity', online, now: now() });
        if (online) void pump();
        else inFlight?.abort();
      });

      // Hydration replaces the item list, so it happens exactly once; a second
      // start() only re-arms the pump.
      let restored: UploadRecord[] = [];
      if (!started) {
        started = true;
        try {
          restored = await options.storage.load();
        } catch (error) {
          console.warn('Upload queue could not be restored:', error);
        }
      }
      if (restored.length > 0) {
        for (const record of restored) blobs.set(record.id, record.blob);
        dispatch({
          type: 'hydrate',
          items: restored.map(({ blob: _blob, ...item }) => item),
          now: now(),
        });
      }
      dispatch({ type: 'connectivity', online: connectivity.isOnline(), now: now() });
      await pump();
    },

    stop() {
      stopped = true;
      clearTimer();
      unsubscribeConnectivity?.();
      unsubscribeConnectivity = undefined;
      inFlight?.abort();
    },

    async enqueue(projectId, files) {
      const created = now();
      const records: UploadRecord[] = Array.from(files, (file) => ({
        id: makeId(),
        projectId,
        name: file.name || 'photo.jpg',
        size: file.size,
        status: 'queued' as const,
        attempts: 0,
        error: null,
        createdAt: created,
        nextAttemptAt: created,
        blob: file,
      }));
      if (records.length === 0) return [];

      for (const record of records) blobs.set(record.id, record.blob);
      // Persist *before* announcing: a crash between the two must not lose
      // photos the UI has already reported as queued.
      await persistSafely(() => options.storage.put(records));
      dispatch({
        type: 'enqueue',
        items: records.map(({ blob: _blob, ...item }) => item),
      });
      void pump();
      return records.map(({ blob: _blob, ...item }) => item);
    },

    retry(ids) {
      dispatch({ type: 'retry', ids, now: now() });
      void pump();
    },

    cancel(id) {
      const wasUploading = state.items.some(
        (item) => item.id === id && item.status === 'uploading',
      );
      dispatch({ type: 'cancel', ids: [id] });
      forget([id]);
      // The batch it belonged to is no longer the batch we asked for.
      if (wasUploading) inFlight?.abort();
    },

    clearFailed() {
      const ids = state.items.filter((item) => item.status === 'failed').map((item) => item.id);
      dispatch({ type: 'clear-failed' });
      forget(ids);
    },

    clearDone() {
      dispatch({ type: 'clear-done' });
    },
  };
}
