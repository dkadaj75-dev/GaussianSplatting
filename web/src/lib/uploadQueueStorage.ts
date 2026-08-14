/**
 * Persistence for the upload queue (`lib/uploadQueue.ts`).
 *
 * IndexedDB, not localStorage: the queue has to survive a reload holding the
 * actual photo bytes, and IndexedDB is the only web store that keeps a `Blob`
 * (localStorage would need a base64 copy of every photo in a 5 MB budget —
 * roughly one photo).
 *
 * The store is addressed only through {@link QueueStorage}, so tests inject
 * {@link createMemoryQueueStorage} and browsers without IndexedDB (or with it
 * blocked in private mode) degrade to an in-memory queue that still uploads —
 * it just does not survive a reload.
 */

import type { QueueStorage, UploadRecord } from './uploadQueue';

export const QUEUE_DB_NAME = 'splatscene-uploads';
export const QUEUE_STORE_NAME = 'uploads';
const DB_VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed'));
  });
}

/** Records written by an older/newer build must never crash the queue. */
function isUploadRecord(value: unknown): value is UploadRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<UploadRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.name === 'string' &&
    typeof record.size === 'number' &&
    typeof record.blob === 'object' &&
    record.blob !== null &&
    typeof (record.blob as Blob).size === 'number'
  );
}

export function createIndexedDbQueueStorage(factory: IDBFactory): QueueStorage {
  let connection: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(QUEUE_DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
          db.createObjectStore(QUEUE_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    }).catch((error: unknown) => {
      // Never cache a failure: a later attempt may well succeed.
      connection = null;
      throw error;
    });
    return connection;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const db = await open();
    const transaction = db.transaction(QUEUE_STORE_NAME, mode);
    const result = await work(transaction.objectStore(QUEUE_STORE_NAME));
    if (mode !== 'readonly') await finished(transaction);
    return result;
  };

  return {
    async load() {
      const rows = await withStore('readonly', (store) =>
        promisify<unknown[]>(store.getAll() as IDBRequest<unknown[]>),
      );
      return rows.filter(isUploadRecord).sort((a, b) => a.createdAt - b.createdAt);
    },

    async put(records) {
      if (records.length === 0) return;
      await withStore('readwrite', (store) => {
        for (const record of records) store.put(record);
      });
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await withStore('readwrite', (store) => {
        for (const id of ids) store.delete(id);
      });
    },

    async clear() {
      await withStore('readwrite', (store) => {
        store.clear();
      });
    },
  };
}

/** In-memory stand-in: the test fake, and the fallback where IndexedDB is off. */
export function createMemoryQueueStorage(seed: readonly UploadRecord[] = []): QueueStorage {
  const rows = new Map<string, UploadRecord>(seed.map((record) => [record.id, record]));
  return {
    load: async () => [...rows.values()].sort((a, b) => a.createdAt - b.createdAt),
    put: async (records) => {
      for (const record of records) rows.set(record.id, record);
    },
    remove: async (ids) => {
      for (const id of ids) rows.delete(id);
    },
    clear: async () => {
      rows.clear();
    },
  };
}

/**
 * The best storage this environment can offer. Falls back to memory rather
 * than failing: an upload queue that forgets across reloads still beats no
 * upload queue at all.
 */
export function createQueueStorage(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): QueueStorage {
  return factory ? createIndexedDbQueueStorage(factory) : createMemoryQueueStorage();
}
