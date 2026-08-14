/**
 * React binding for the app-wide upload queue.
 *
 * One queue instance per app, not per component: uploads must keep running
 * when the user leaves the capture page (that is the whole point of a queue),
 * and the shell's "N photos queued" indicator reads the same state the capture
 * page writes.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { api, queryKeys } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { createUploadQueue, summarizeQueue } from '../lib/uploadQueue';
import { createQueueStorage } from '../lib/uploadQueueStorage';
import type {
  UploadItem,
  UploadQueue,
  UploadQueueState,
  UploadQueueSummary,
} from '../lib/uploadQueue';

let instance: UploadQueue | null = null;

export function getUploadQueue(): UploadQueue {
  if (!instance) {
    instance = createUploadQueue({
      storage: createQueueStorage(),
      upload: (projectId, files, options) => api.uploadPhotos(projectId, files, options),
      onUploaded: (projectId) => {
        // The project's photo count and job eligibility just changed.
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      },
    });
    void instance.start();
  }
  return instance;
}

/** Drops the singleton (tests, and nothing else). */
export function resetUploadQueue(next: UploadQueue | null = null): void {
  instance?.stop();
  instance = next;
}

export interface UploadQueueView extends UploadQueueSummary {
  state: UploadQueueState;
  items: UploadItem[];
  online: boolean;
  /** Upload progress of the batch in flight, 0–100. */
  batchPercent: number;
  enqueue: (projectId: string, files: readonly File[]) => Promise<UploadItem[]>;
  retry: (ids?: readonly string[]) => void;
  cancel: (id: string) => void;
  clearFailed: () => void;
  clearDone: () => void;
}

export function useUploadQueue(): UploadQueueView {
  const queue = getUploadQueue();
  const state = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState);
  const summary = useMemo(() => summarizeQueue(state), [state]);

  const enqueue = useCallback(
    (projectId: string, files: readonly File[]) => queue.enqueue(projectId, files),
    [queue],
  );
  const retry = useCallback((ids?: readonly string[]) => queue.retry(ids), [queue]);
  const cancel = useCallback((id: string) => queue.cancel(id), [queue]);
  const clearFailed = useCallback(() => queue.clearFailed(), [queue]);
  const clearDone = useCallback(() => queue.clearDone(), [queue]);

  return {
    ...summary,
    state,
    items: state.items,
    online: state.online,
    batchPercent: state.batchPercent,
    enqueue,
    retry,
    cancel,
    clearFailed,
    clearDone,
  };
}
