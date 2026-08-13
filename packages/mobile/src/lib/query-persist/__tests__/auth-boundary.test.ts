import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// The storage fork is what differs between native and web, so it is mocked
// rather than imported: `supportsSync` flips this suite between the native
// (restore already happened at mount) and web (restore happens here) paths.
const storageState = vi.hoisted(() => ({
  supportsSync: true,
  raw: null as string | null,
}));
const readPersistedCacheAsyncMock = vi.hoisted(() => vi.fn(async (_owner?: unknown) => storageState.raw));
const clearPersistedQueryCacheMock = vi.hoisted(() => vi.fn(async (_owner?: unknown) => {}));
const writeCacheOwnerMock = vi.hoisted(() => vi.fn((_userId: string) => {}));

vi.mock('../storage', () => ({
  get SUPPORTS_SYNC_RESTORE() {
    return storageState.supportsSync;
  },
  get REQUIRES_OWNER_HINT() {
    return storageState.supportsSync;
  },
  readPersistedCacheSync: () => storageState.raw,
  readCacheOwnerSync: () => null,
  readPersistedCacheAsync: readPersistedCacheAsyncMock,
  writePersistedCache: vi.fn(),
  writeCacheOwner: writeCacheOwnerMock,
  persistedQueryCacheExists: vi.fn(async () => storageState.raw !== null),
  clearPersistedQueryCache: clearPersistedQueryCacheMock,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

import { adoptPersistedQueryCache, decideOwnerTransition } from '../auth-boundary';
import { PERSISTED_CACHE_VERSION, serializePersistedCache, type PersistedQueryEntry } from '../envelope';
import { getPersistOwner, resetQueryPersistRuntime, setLastRestore, suspendCacheWriter } from '../runtime';
import { restorePersistedCache } from '../restore';

const OWNER = 'user-1';

function blobFor(userId: string, now = Date.now()): string {
  return serializePersistedCache({
    version: PERSISTED_CACHE_VERSION,
    userId,
    savedAt: now,
    queries: [
      {
        queryHash: '["profile"]',
        queryKey: ['profile'],
        state: { data: { id: userId }, dataUpdatedAt: now, status: 'success', fetchStatus: 'idle' },
      },
    ] as unknown as PersistedQueryEntry[],
  });
}

beforeEach(() => {
  resetQueryPersistRuntime();
  storageState.supportsSync = true;
  storageState.raw = null;
  readPersistedCacheAsyncMock.mockClear();
  clearPersistedQueryCacheMock.mockClear();
  writeCacheOwnerMock.mockClear();
  trackMock.mockClear();
  reportHandledErrorMock.mockClear();
});

// T-14
describe('decideOwnerTransition', () => {
  it('covers the whole truth table', () => {
    expect(decideOwnerTransition({ resolvedUserId: undefined, hydratedUserId: undefined })).toBe('evict');
    expect(decideOwnerTransition({ resolvedUserId: undefined, hydratedUserId: OWNER })).toBe('evict');
    expect(decideOwnerTransition({ resolvedUserId: OWNER, hydratedUserId: undefined })).toBe('adopt');
    expect(decideOwnerTransition({ resolvedUserId: OWNER, hydratedUserId: OWNER })).toBe('adopt');
    expect(decideOwnerTransition({ resolvedUserId: OWNER, hydratedUserId: 'user-2' })).toBe('evict-then-adopt');
  });
});

describe('adoptPersistedQueryCache (native, restore already done at mount)', () => {
  it('adopts what the mount-time restore hydrated and reports it once', async () => {
    const client = new QueryClient();
    setLastRestore(
      restorePersistedCache(client, {
        raw: blobFor(OWNER),
        ownerHint: OWNER,
        requireOwnerHint: true,
        now: Date.now(),
      }),
    );

    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(getPersistOwner()).toBe(OWNER);
    expect(writeCacheOwnerMock).toHaveBeenCalledWith(OWNER);
    expect(clearPersistedQueryCacheMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledTimes(1);
    const [eventName, properties] = trackMock.mock.calls[0];
    expect(eventName).toBe('Offline Query Cache Restored');
    expect(properties).toMatchObject({ outcome: 'hydrated', entryCount: 1 });
    expect(properties.bytes).toBeGreaterThan(0);
  });

  // T-23 — the C3 regression test.
  it('is a no-op on every later foreground for the same user', async () => {
    const client = new QueryClient();
    setLastRestore(
      restorePersistedCache(client, {
        raw: blobFor(OWNER),
        ownerHint: OWNER,
        requireOwnerHint: true,
        now: Date.now(),
      }),
    );

    await adoptPersistedQueryCache(client, OWNER, undefined);
    trackMock.mockClear();
    writeCacheOwnerMock.mockClear();

    await adoptPersistedQueryCache(client, OWNER, undefined);
    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(trackMock).not.toHaveBeenCalled();
    expect(writeCacheOwnerMock).not.toHaveBeenCalled();
    expect(clearPersistedQueryCacheMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
    expect(client.getQueryData(['profile'])).toEqual({ id: OWNER });
  });

  it('evicts precisely and alarms when the blob belongs to someone else', async () => {
    const client = new QueryClient();
    // A blob stamped user-2 that the mount-time restore hydrated because the
    // owner sentinel agreed with it — auth then resolves user-1.
    const restore = restorePersistedCache(client, {
      raw: blobFor('user-2'),
      ownerHint: 'user-2',
      requireOwnerHint: true,
      now: Date.now(),
    });
    setLastRestore(restore);
    // Something fetched after the restore must survive the eviction.
    client.setQueryData(['myGyms'], [{ id: 'gym-1' }]);

    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(client.getQueryData(['profile'])).toBeUndefined();
    expect(client.getQueryData(['myGyms'])).toEqual([{ id: 'gym-1' }]);
    expect(clearPersistedQueryCacheMock).toHaveBeenCalledTimes(1);
    expect(reportHandledErrorMock).toHaveBeenCalledTimes(1);
    expect(getPersistOwner()).toBe(OWNER);
  });

  it('stays silent for a torn write with no owner sentinel', async () => {
    const client = new QueryClient();
    setLastRestore(
      restorePersistedCache(client, {
        raw: blobFor(OWNER),
        ownerHint: null,
        requireOwnerHint: true,
        now: Date.now(),
      }),
    );

    await adoptPersistedQueryCache(client, OWNER, undefined);

    // Deleted and re-armed, but NOT reported: a torn write is not a leak, and
    // keeping owner_mismatch meaningful is the point.
    expect(clearPersistedQueryCacheMock).toHaveBeenCalledTimes(1);
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock.mock.calls[0][1]).toMatchObject({ outcome: 'owner_missing' });
    expect(trackMock.mock.calls[0][1].entryCount).toBeUndefined();
  });

  it('emits nothing at all when there was no blob', async () => {
    const client = new QueryClient();
    setLastRestore(
      restorePersistedCache(client, { raw: null, ownerHint: OWNER, requireOwnerHint: true, now: Date.now() }),
    );

    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(trackMock).not.toHaveBeenCalled();
    expect(getPersistOwner()).toBe(OWNER);
  });

  // T-24 — an in-launch account switch must not leave a phantom mismatch behind.
  it('does not re-decide against a departed user after a sign-out', async () => {
    const client = new QueryClient();
    setLastRestore(
      restorePersistedCache(client, {
        raw: blobFor(OWNER),
        ownerHint: OWNER,
        requireOwnerHint: true,
        now: Date.now(),
      }),
    );
    await adoptPersistedQueryCache(client, OWNER, undefined);

    // Sign-out: suspendCacheWriter clears owner + lastRestore.
    suspendCacheWriter();
    clearPersistedQueryCacheMock.mockClear();
    reportHandledErrorMock.mockClear();
    trackMock.mockClear();

    // User B signs in on the same launch; nothing is on disk for them.
    await adoptPersistedQueryCache(client, 'user-2', undefined);
    await adoptPersistedQueryCache(client, 'user-2', undefined);
    await adoptPersistedQueryCache(client, 'user-2', undefined);

    expect(getPersistOwner()).toBe('user-2');
    expect(clearPersistedQueryCacheMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('adoptPersistedQueryCache (web, async restore at the auth boundary)', () => {
  beforeEach(() => {
    storageState.supportsSync = false;
  });

  // T-21 — the C2 regression test. `undefined` is the only correct owner
  // argument: it resolves the account `handleAuthenticatedTransition` just
  // published. A captured owner is `null` on every web cold start, and
  // `userScopedStorageKey(base, null)` returns null, so the read and the
  // mismatch-path delete would both silently no-op.
  it('reads the blob with an undefined owner so the post-transition key resolves', async () => {
    storageState.raw = blobFor(OWNER);
    const client = new QueryClient();

    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(readPersistedCacheAsyncMock).toHaveBeenCalledTimes(1);
    expect(readPersistedCacheAsyncMock).toHaveBeenCalledWith(undefined);
    expect(client.getQueryData(['profile'])).toEqual({ id: OWNER });
    expect(getPersistOwner()).toBe(OWNER);
  });

  it('reads storage exactly once across repeated foreground checks', async () => {
    storageState.raw = blobFor(OWNER);
    const client = new QueryClient();

    await adoptPersistedQueryCache(client, OWNER, undefined);
    await adoptPersistedQueryCache(client, OWNER, undefined);
    await adoptPersistedQueryCache(client, OWNER, undefined);

    expect(readPersistedCacheAsyncMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('evicts without reading when auth could not name the user', async () => {
    storageState.raw = blobFor(OWNER);
    const client = new QueryClient();

    await adoptPersistedQueryCache(client, undefined, undefined);

    expect(readPersistedCacheAsyncMock).not.toHaveBeenCalled();
    expect(clearPersistedQueryCacheMock).toHaveBeenCalledTimes(1);
    expect(getPersistOwner()).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
