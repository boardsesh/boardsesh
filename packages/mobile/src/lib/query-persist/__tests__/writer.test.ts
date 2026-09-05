import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { parsePersistedCache, serializePersistedCache, PERSISTED_CACHE_VERSION } from '../envelope';
import { restorePersistedCache } from '../restore';
import {
  getLastWrittenQueries,
  resetQueryPersistRuntime,
  setLastWrittenQueries,
  setPersistOwner,
  setCacheWriter,
  suspendCacheWriter,
} from '../runtime';
import { createCacheWriter, type CacheWriter } from '../writer';

const OWNER = 'user-1';
const DAY = 24 * 60 * 60 * 1000;

type Harness = {
  client: QueryClient;
  writer: CacheWriter;
  writes: string[];
  fireScheduled: () => void;
  scheduled: () => boolean;
  cancelled: number;
  stop: () => void;
};

function createHarness(now: () => number = Date.now): Harness {
  const client = new QueryClient();
  const writes: string[] = [];
  let pending: (() => void) | null = null;
  const state = { cancelled: 0 };

  const writer = createCacheWriter({
    client,
    write: (serialized) => {
      writes.push(serialized);
    },
    getOwner: () => {
      // Mirrors the real wiring: the writer reads the runtime owner at fire time.
      return runtimeOwner;
    },
    now,
    schedule: (callback) => {
      pending = callback;
      return 'handle';
    },
    cancel: () => {
      state.cancelled += 1;
      pending = null;
    },
  });
  const unsubscribe = writer.start();
  setCacheWriter(writer);

  return {
    client,
    writer,
    writes,
    fireScheduled: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    scheduled: () => pending !== null,
    get cancelled() {
      return state.cancelled;
    },
    stop: () => {
      unsubscribe();
      setCacheWriter(null);
    },
  };
}

// The real writer reads `getPersistOwner()`; the harness proxies it so a test can
// flip ownership between scheduling and firing.
let runtimeOwner: string | null = null;

function armOwner(userId: string): void {
  runtimeOwner = userId;
  setPersistOwner(userId);
}

function disarmOwner(): void {
  runtimeOwner = null;
  suspendCacheWriter();
}

function keysIn(serialized: string): string[] {
  const parsed = parsePersistedCache(serialized);
  if (parsed.status !== 'ok') throw new Error(`unreadable write: ${parsed.status}`);
  return parsed.envelope.queries.map((entry) => String(entry.queryKey[0])).sort();
}

beforeEach(() => {
  runtimeOwner = null;
  resetQueryPersistRuntime();
});

describe('createCacheWriter', () => {
  // T-09
  it('writes nothing while no owner is set, and writes once the owner arrives', () => {
    const harness = createHarness();
    harness.client.setQueryData(['profile'], { id: OWNER });
    expect(harness.scheduled()).toBe(true);
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(0);

    armOwner(OWNER);
    harness.client.setQueryData(['myGyms'], [{ id: 'gym-1' }]);
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(1);
    expect(keysIn(harness.writes[0])).toEqual(['myGyms', 'profile']);
    harness.stop();
  });

  it('coalesces a burst into one trailing-edge write', () => {
    const harness = createHarness();
    armOwner(OWNER);
    harness.client.setQueryData(['profile'], { id: OWNER });
    harness.client.setQueryData(['myGyms'], []);
    harness.client.setQueryData(['grades', 'kilter'], []);
    expect(harness.scheduled()).toBe(true);
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(1);
    harness.stop();
  });

  it('flush() writes immediately and cancels the pending timer', () => {
    const harness = createHarness();
    armOwner(OWNER);
    harness.client.setQueryData(['profile'], { id: OWNER });
    harness.writer.flush();

    expect(harness.writes).toHaveLength(1);
    expect(harness.scheduled()).toBe(false);
    expect(harness.cancelled).toBe(1);
    harness.stop();
  });

  // T-09b, first half — the C1 regression test. `suspendCacheWriter` is a PAUSE:
  // a queued write that fires after it does nothing, and the next
  // `setPersistOwner` re-arms the same subscription with no restart call.
  it('is paused (not killed) by suspendCacheWriter and re-arms on the next owner', () => {
    const harness = createHarness();
    armOwner(OWNER);
    harness.client.setQueryData(['profile'], { id: OWNER });

    disarmOwner();
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(0);

    // Same writer instance, no restart: setting an owner is the whole re-arm.
    armOwner('user-2');
    harness.client.setQueryData(['myGyms'], [{ id: 'gym-2' }]);
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(1);
    const parsed = parsePersistedCache(harness.writes[0]);
    expect(parsed.status === 'ok' && parsed.envelope.userId).toBe('user-2');
    harness.stop();
  });

  // T-09b, second half — the shape of a real logged-out launch → sign-in →
  // background. The light signed-out path calls `suspendCacheWriter` on every
  // anonymous launch, so this is the sequence a latched stop would break.
  it('still persists for the first sign-in after an anonymous launch', () => {
    const harness = createHarness();
    // Anonymous cold start: clearPersistedUserStores → suspendCacheWriter.
    disarmOwner();
    harness.fireScheduled();
    expect(harness.writes).toHaveLength(0);

    // Sign-in: the auth boundary sets the owner.
    armOwner(OWNER);
    harness.client.setQueryData(['profile'], { id: OWNER });
    harness.client.setQueryData(['myBoards', undefined], [{ uuid: 'board-1' }]);
    // Backgrounding flushes — the guaranteed write point before any cold start.
    harness.writer.flush();

    expect(harness.writes).toHaveLength(1);
    expect(keysIn(harness.writes[0])).toEqual(['myBoards', 'profile']);
    harness.stop();
  });

  // T-08: React Query's 30-minute gcTime removes unobserved entries. Without
  // merge-on-write the blob would erode toward "only what you looked at in the
  // last 30 minutes".
  it('carries a gc’d entry forward, but not one past its maxAge', () => {
    const now = Date.now();
    const harness = createHarness(() => now);
    armOwner(OWNER);
    setLastWrittenQueries([
      {
        queryHash: '["angles","kilter",8]',
        queryKey: ['angles', 'kilter', 8],
        state: { data: [40, 45], dataUpdatedAt: now - DAY, status: 'success', fetchStatus: 'idle' },
      },
      {
        queryHash: '["grades","tension"]',
        queryKey: ['grades', 'tension'],
        state: { data: [], dataUpdatedAt: now - 15 * DAY, status: 'success', fetchStatus: 'idle' },
      },
    ] as unknown as ReturnType<typeof getLastWrittenQueries>);

    harness.client.setQueryData(['profile'], { id: OWNER });
    harness.fireScheduled();

    // The day-old angles entry survives even though the client never held it;
    // the 15-day-old grades entry is past its rule's 14-day maxAge.
    expect(keysIn(harness.writes[0])).toEqual(['angles', 'profile']);
    harness.stop();
  });

  it('lets a fresh entry win over the previously written one with the same hash', () => {
    const harness = createHarness();
    armOwner(OWNER);
    setLastWrittenQueries([
      {
        queryHash: '["profile"]',
        queryKey: ['profile'],
        state: { data: { id: OWNER, name: 'old' }, dataUpdatedAt: Date.now(), status: 'success', fetchStatus: 'idle' },
      },
    ] as unknown as ReturnType<typeof getLastWrittenQueries>);

    harness.client.setQueryData(['profile'], { id: OWNER, name: 'new' });
    harness.fireScheduled();

    const parsed = parsePersistedCache(harness.writes[0]);
    expect(parsed.status === 'ok' && parsed.envelope.queries).toHaveLength(1);
    expect(harness.writes[0]).toContain('"new"');
    harness.stop();
  });

  // T-08b end-to-end: a restore seeds the merge set, so a first write triggered
  // from an EMPTY client still contains what was hydrated at mount.
  it('writes what the restore hydrated even when the client has since been emptied', () => {
    const now = Date.now();
    const raw = serializePersistedCache({
      version: PERSISTED_CACHE_VERSION,
      userId: OWNER,
      savedAt: now,
      queries: [
        {
          queryHash: '["profile"]',
          queryKey: ['profile'],
          state: { data: { id: OWNER }, dataUpdatedAt: now, status: 'success', fetchStatus: 'idle' },
        },
        {
          queryHash: '["myGyms"]',
          queryKey: ['myGyms'],
          state: { data: [{ id: 'gym-1' }], dataUpdatedAt: now, status: 'success', fetchStatus: 'idle' },
        },
      ] as unknown as ReturnType<typeof getLastWrittenQueries>,
    });

    const harness = createHarness(() => now);
    restorePersistedCache(harness.client, { raw, ownerHint: OWNER, requireOwnerHint: false, now });
    armOwner(OWNER);
    // The 30-minute gc sweep: every hydrated entry leaves the in-memory cache.
    harness.client.clear();
    harness.writer.flush();

    expect(keysIn(harness.writes[0])).toEqual(['myGyms', 'profile']);
    harness.stop();
  });

  it('reports the write failure through onError instead of throwing', () => {
    const client = new QueryClient();
    const onError = vi.fn();
    let pending: (() => void) | null = null;
    const writer = createCacheWriter({
      client,
      write: () => {
        throw new Error('mmkv full');
      },
      getOwner: () => OWNER,
      now: Date.now,
      schedule: (callback) => {
        pending = callback;
        return 'handle';
      },
      cancel: () => {
        pending = null;
      },
      onError,
    });
    const unsubscribe = writer.start();
    client.setQueryData(['profile'], { id: OWNER });
    expect(() => (pending as unknown as () => void)()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
