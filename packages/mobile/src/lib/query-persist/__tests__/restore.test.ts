import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { myBoardsQueryKey } from '../../graphql/query-keys';
import { dehydrateAllowlisted } from '../dehydrate';
import {
  PERSISTED_CACHE_VERSION,
  serializePersistedCache,
  type PersistedCacheEnvelope,
  type PersistedQueryEntry,
} from '../envelope';
import { restorePersistedCache } from '../restore';
import { getLastWrittenQueries, resetQueryPersistRuntime } from '../runtime';

const OWNER = 'user-1';
// Real wall-clock, because two of these tests compare a hand-built entry
// against one produced by `dehydrate`/`setQueryData`, which stamp `Date.now()`.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entry(queryKey: readonly unknown[], data: unknown, dataUpdatedAt = NOW): PersistedQueryEntry {
  return {
    queryHash: JSON.stringify(queryKey),
    queryKey: queryKey as unknown[],
    state: {
      data,
      dataUpdateCount: 1,
      dataUpdatedAt,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: 'success',
      fetchStatus: 'idle',
    },
  } as unknown as PersistedQueryEntry;
}

function blob(queries: readonly PersistedQueryEntry[], overrides: Partial<PersistedCacheEnvelope> = {}): string {
  return serializePersistedCache({
    version: PERSISTED_CACHE_VERSION,
    userId: OWNER,
    savedAt: NOW,
    queries,
    ...overrides,
  });
}

beforeEach(() => {
  resetQueryPersistRuntime();
});

describe('restorePersistedCache', () => {
  it('reports absent and unreadable without touching the client', () => {
    const client = new QueryClient();
    expect(
      restorePersistedCache(client, { raw: null, ownerHint: OWNER, requireOwnerHint: false, now: NOW }).outcome,
    ).toBe('absent');
    expect(
      restorePersistedCache(client, { raw: '{broken', ownerHint: OWNER, requireOwnerHint: false, now: NOW }).outcome,
    ).toBe('unreadable');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  // T-10: the allowlist is re-applied on the RESTORE path, so a blob written by
  // a future build (or tampered with on a rooted device) cannot smuggle a
  // non-allowlisted key — or another climber's public profile — into memory.
  it('refuses non-allowlisted and cross-user entries that a blob claims', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([
        entry(['infiniteSearchClimbs', { query: 'crimps' }], { pages: [] }),
        entry(['publicProfile', 'stranger'], { id: 'stranger' }),
        entry(['profile'], { id: OWNER }),
      ]),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });

    expect(outcome.outcome).toBe('hydrated');
    expect(outcome.entryCount).toBe(1);
    expect(outcome.droppedCount).toBe(2);
    expect(client.getQueryData(['infiniteSearchClimbs', { query: 'crimps' }])).toBeUndefined();
    expect(client.getQueryData(['publicProfile', 'stranger'])).toBeUndefined();
    expect(client.getQueryData(['profile'])).toEqual({ id: OWNER });
  });

  // T-11: JSON turns `undefined` into `null`, but `hashKey` produces
  // `["myBoards",null]` for both, so every reader still finds the entry.
  it('survives the undefined→null round trip on myBoardsQueryKey()', () => {
    const source = new QueryClient();
    source.setQueryData(myBoardsQueryKey(), [{ uuid: 'board-1', name: 'Home wall' }]);
    const raw = blob(dehydrateAllowlisted(source, OWNER));
    expect(raw).toContain('"myBoards",null');

    const client = new QueryClient();
    restorePersistedCache(client, { raw, ownerHint: OWNER, requireOwnerHint: false, now: NOW });
    expect(client.getQueryData(myBoardsQueryKey())).toEqual([{ uuid: 'board-1', name: 'Home wall' }]);
  });

  // T-12
  it('hydrates nothing on an owner mismatch', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER })]),
      ownerHint: 'someone-else',
      requireOwnerHint: false,
      now: NOW,
    });

    expect(outcome.outcome).toBe('owner_mismatch');
    expect(outcome.userId).toBe(OWNER);
    expect(outcome.hydratedHashes).toEqual([]);
    expect(client.getQueryData(['profile'])).toBeUndefined();
  });

  it('hydrates nothing when the platform requires an owner hint and none is there', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER })]),
      ownerHint: null,
      requireOwnerHint: true,
      now: NOW,
    });

    expect(outcome.outcome).toBe('owner_missing');
    expect(client.getQueryData(['profile'])).toBeUndefined();
  });

  it('drops entries past their own rule’s maxAge and keeps the rest', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([
        entry(['profile'], { id: OWNER }, NOW - 15 * DAY),
        entry(['publicProfile', OWNER], { id: OWNER }, NOW - 25 * HOUR),
        entry(['grades', 'kilter'], [{ difficultyId: 10 }], NOW - 13 * DAY),
      ]),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });

    expect(outcome.outcome).toBe('hydrated');
    expect(outcome.entryCount).toBe(1);
    expect(outcome.droppedCount).toBe(2);
    expect(outcome.oldestEntryAgeHours).toBe(13 * 24);
    expect(client.getQueryData(['profile'])).toBeUndefined();
    expect(client.getQueryData(['publicProfile', OWNER])).toBeUndefined();
    expect(client.getQueryData(['grades', 'kilter'])).toEqual([{ difficultyId: 10 }]);
  });

  it('reports empty when the blob parsed and was owned but nothing survived', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER }, NOW - 15 * DAY)]),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });

    expect(outcome.outcome).toBe('empty');
    expect(outcome.entryCount).toBe(0);
    expect(outcome.droppedCount).toBeGreaterThan(0);
    expect(outcome.bytes).toBeGreaterThan(0);
  });

  // T-13: `hydrate` refuses to overwrite an entry with a fresher
  // `dataUpdatedAt`, which is what makes a late web restore incapable of
  // clobbering a live fetch — and why no IsRestoringProvider is needed.
  it('never clobbers a fresher live entry', () => {
    const client = new QueryClient();
    client.setQueryData(['profile'], { id: OWNER, name: 'fresh' });
    const liveUpdatedAt = client.getQueryState(['profile'])?.dataUpdatedAt;

    restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER, name: 'stale' }, NOW - DAY)]),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });

    expect(client.getQueryData(['profile'])).toEqual({ id: OWNER, name: 'fresh' });
    expect(client.getQueryState(['profile'])?.dataUpdatedAt).toBe(liveUpdatedAt);
  });

  // T-08b: without this the merge set stays empty until the first write, so a gc
  // `removed` event more than 30 minutes into a launch triggers a first write
  // that drops every mount-hydrated entry from disk.
  it('seeds the writer’s merge set from what it hydrated', () => {
    const client = new QueryClient();
    restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER }), entry(['myGyms'], [{ id: 'gym-1' }])]),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });

    expect(
      getLastWrittenQueries()
        .map((one) => one.queryKey[0])
        .sort(),
    ).toEqual(['myGyms', 'profile']);
  });

  it('carries the evicted flag out of the blob it read', () => {
    const client = new QueryClient();
    const outcome = restorePersistedCache(client, {
      raw: blob([entry(['profile'], { id: OWNER })], { evicted: true }),
      ownerHint: OWNER,
      requireOwnerHint: false,
      now: NOW,
    });
    expect(outcome.evicted).toBe(true);
  });
});
