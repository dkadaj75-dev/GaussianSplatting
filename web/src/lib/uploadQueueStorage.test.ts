import { describe, expect, it } from 'vitest';
import {
  QUEUE_STORE_NAME,
  createIndexedDbQueueStorage,
  createMemoryQueueStorage,
  createQueueStorage,
} from './uploadQueueStorage';
import type { QueueStorage, UploadRecord } from './uploadQueue';

function record(id: string, createdAt = 0): UploadRecord {
  return {
    id,
    projectId: 'p1',
    name: `${id}.jpg`,
    size: 4,
    status: 'queued',
    attempts: 0,
    error: null,
    createdAt,
    nextAttemptAt: createdAt,
    blob: new Blob([new Uint8Array(4)], { type: 'image/jpeg' }),
  };
}

/**
 * A minimal IndexedDB stand-in — jsdom ships none, and the wrapper's job
 * (upgrade, request/transaction plumbing, ordering, junk filtering) is worth
 * exercising rather than mocking away.
 */
function fakeIndexedDb() {
  const rows = new Map<string, unknown>();
  const stores = new Set<string>();

  const request = <T>(produce: () => T) => {
    const handle = {
      result: undefined as T,
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => {
      handle.result = produce();
      handle.onsuccess?.();
    });
    return handle as unknown as IDBRequest<T>;
  };

  const store = {
    getAll: () => request(() => [...rows.values()]),
    put: (value: { id: string }) => {
      rows.set(value.id, value);
      return request(() => undefined);
    },
    delete: (id: string) => {
      rows.delete(id);
      return request(() => undefined);
    },
    clear: () => {
      rows.clear();
      return request(() => undefined);
    },
  };

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.add(name);
      return store;
    },
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => store,
      };
      // After the caller has queued its work and attached handlers.
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
  };

  const factory = {
    open: () => {
      const handle = {
        result: db,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      queueMicrotask(() => {
        handle.onupgradeneeded?.();
        handle.onsuccess?.();
      });
      return handle;
    },
  };

  return { factory: factory as unknown as IDBFactory, rows, stores };
}

/** Both implementations must behave identically — that is the point of the interface. */
function describeStorageContract(name: string, make: () => QueueStorage) {
  describe(name, () => {
    it('round-trips records, keeping the payload', async () => {
      const storage = make();
      await storage.put([record('a', 2), record('b', 1)]);

      const loaded = await storage.load();
      expect(loaded.map((entry) => entry.id)).toEqual(['b', 'a']); // oldest first
      expect(loaded[0].blob.size).toBe(4);
    });

    it('overwrites by id, removes by id, and clears', async () => {
      const storage = make();
      await storage.put([record('a'), record('b')]);
      await storage.put([{ ...record('a'), status: 'failed', attempts: 3 }]);
      expect((await storage.load()).find((entry) => entry.id === 'a')).toMatchObject({
        status: 'failed',
        attempts: 3,
      });

      await storage.remove(['a']);
      expect((await storage.load()).map((entry) => entry.id)).toEqual(['b']);

      await storage.clear();
      await expect(storage.load()).resolves.toEqual([]);
    });

    it('treats empty writes as no-ops', async () => {
      const storage = make();
      await storage.put([]);
      await storage.remove([]);
      await expect(storage.load()).resolves.toEqual([]);
    });
  });
}

describeStorageContract('memory queue storage', () => createMemoryQueueStorage());
describeStorageContract('IndexedDB queue storage', () =>
  createIndexedDbQueueStorage(fakeIndexedDb().factory),
);

describe('IndexedDB queue storage specifics', () => {
  it('creates the object store on first open', async () => {
    const db = fakeIndexedDb();
    await createIndexedDbQueueStorage(db.factory).load();
    expect(db.stores.has(QUEUE_STORE_NAME)).toBe(true);
  });

  it('ignores rows it cannot understand rather than failing the queue', async () => {
    const db = fakeIndexedDb();
    const storage = createIndexedDbQueueStorage(db.factory);
    await storage.put([record('good')]);
    db.rows.set('junk', { id: 'junk', projectId: 'p1' }); // written by an older build
    db.rows.set('nonsense', 42);

    expect((await storage.load()).map((entry) => entry.id)).toEqual(['good']);
  });
});

describe('createQueueStorage', () => {
  it('falls back to memory where IndexedDB is unavailable', async () => {
    const storage = createQueueStorage(undefined);
    await storage.put([record('a')]);
    await expect(storage.load()).resolves.toHaveLength(1);
  });

  it('uses IndexedDB when the platform has it', async () => {
    const db = fakeIndexedDb();
    await createQueueStorage(db.factory).put([record('a')]);
    expect(db.rows.has('a')).toBe(true);
  });
});
