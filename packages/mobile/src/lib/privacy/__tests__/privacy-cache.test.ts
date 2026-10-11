import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  getPrivacyRevocationGeneration,
  invalidatePrivacyQueries,
  subscribeToPrivacyRevocations,
  registerPrivacyRevalidation,
} from '../privacy-cache';

vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));

describe('privacy revocation', () => {
  it('retires captured callbacks synchronously before query cancellation finishes', async () => {
    const queryClient = new QueryClient();
    let finishCancellation!: () => void;
    vi.spyOn(queryClient, 'cancelQueries').mockImplementation(
      () => new Promise<void>((resolve) => (finishCancellation = resolve)),
    );
    const previousGeneration = getPrivacyRevocationGeneration();
    const listener = vi.fn();
    const unsubscribe = subscribeToPrivacyRevocations(listener);

    const invalidation = invalidatePrivacyQueries(queryClient);
    expect(getPrivacyRevocationGeneration()).toBe(previousGeneration + 1);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    finishCancellation();
    await invalidation;
    queryClient.clear();
  });

  it('starts catalog withdrawal before listeners and refetches while repair is pending', async () => {
    const queryClient = new QueryClient();
    const order: string[] = [];
    let finish!: () => void;
    const revalidation = new Promise<void>((resolve) => (finish = resolve));
    const unregisterOld = registerPrivacyRevalidation(async () => {
      throw new Error('superseded');
    });
    const unregister = registerPrivacyRevalidation(() => {
      order.push('catalog');
      return revalidation;
    });
    unregisterOld();
    const unsubscribe = subscribeToPrivacyRevocations(() => order.push('snapshots'));
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async () => {
      order.push('refetch');
    });
    try {
      const invalidation = invalidatePrivacyQueries(queryClient);
      expect(order).toEqual(['catalog', 'snapshots']);
      await invalidation;
      finish();
      expect(order).toEqual(['catalog', 'snapshots', 'refetch']);
    } finally {
      unsubscribe();
      unregister();
      queryClient.clear();
    }
  });

  it('withdraws snapshots even when catalog revalidation throws', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['climb', 'private'], { name: 'Private climb' });
    const previous = getPrivacyRevocationGeneration();
    const unregister = registerPrivacyRevalidation(() => {
      throw new Error('offline');
    });
    try {
      await expect(invalidatePrivacyQueries(queryClient)).resolves.toBeUndefined();
      expect(getPrivacyRevocationGeneration()).toBe(previous + 1);
      expect(queryClient.getQueryData(['climb', 'private'])).toBeUndefined();
    } finally {
      unregister();
      queryClient.clear();
    }
  });

  it('refetches an observed cleared query even when local repair rejects', async () => {
    const queryClient = new QueryClient();
    const observer = new QueryObserver(queryClient, {
      queryKey: ['publicProfile', 'private-user'],
      initialData: { name: 'Withdrawn' },
      staleTime: Infinity,
      queryFn: async () => ({ name: 'Server authorized' }),
    });
    const unsubscribe = observer.subscribe(() => {});
    const unregister = registerPrivacyRevalidation(() => Promise.reject(new Error('database is locked')));
    try {
      await invalidatePrivacyQueries(queryClient);
      expect(observer.getCurrentResult().data).toEqual({ name: 'Server authorized' });
      expect(observer.getCurrentResult().status).toBe('success');
    } finally {
      unregister();
      unsubscribe();
      queryClient.clear();
    }
  });

  it('removes copied identity and private board projections but preserves personal unsynced ticks', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['publicProfile', 'private-user'], { displayName: 'Old name' });
    queryClient.setQueryData(['resourcePrivacy', 'viewer', 1, 'board', 'home'], { ownerId: 'private-user' });
    queryClient.setQueryData(['localPendingTicks'], [{ uuid: 'unsynced-tick' }]);
    await invalidatePrivacyQueries(queryClient);
    expect(queryClient.getQueryData(['publicProfile', 'private-user'])).toBeUndefined();
    expect(queryClient.getQueryData(['resourcePrivacy', 'viewer', 1, 'board', 'home'])).toBeUndefined();
    expect(queryClient.getQueryData(['localPendingTicks'])).toEqual([{ uuid: 'unsynced-tick' }]);
    queryClient.clear();
  });
  it('does not restore initialData after revocation', async () => {
    const queryClient = new QueryClient();
    const observer = new QueryObserver(queryClient, {
      queryKey: ['sessionDetail', 'session'],
      initialData: { notes: 'Private note' },
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await invalidatePrivacyQueries(queryClient);
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
    queryClient.clear();
  });
  it('withdraws every privacy-sensitive root, including roots it has never heard of', async () => {
    const queryClient = new QueryClient();
    const sensitiveKeys = [
      ['publicProfile', 'private-user'],
      ['userTicks', 'private-user'],
      ['logbook', 'viewer', 'kilter'],
      ['activityFeed', 'viewer'],
      ['crewFeed', 'viewer'],
      ['sessionDetail', 'session'],
      ['comments', 'tick', 'tick-1'],
      ['notifications', 'viewer'],
      ['board', 'wall-uuid'],
      ['myBoards', undefined],
      ['playlist', 'playlist-uuid'],
      ['betaLinks', 'kilter', 'climb'],
      ['climb', { boardName: 'kilter', climbUuid: 'climb' }],
      ['searchClimbs', { boardName: 'spray', layoutId: 9001 }],
      ['infiniteSearchClimbs', { boardName: 'spray', layoutId: 9001 }],
      ['searchClimbsCount', { boardName: 'spray', layoutId: 9001 }],
      // A search key whose input moved or vanished cannot be shown not to be spray.
      ['searchClimbs', 'viewer', { boardName: 'spray', layoutId: 9001 }],
      ['searchClimbs'],
      ['infiniteSearchClimbs', { layoutId: 1 }],
      ['someFutureQuery', 'id'],
    ];
    for (const key of sensitiveKeys) queryClient.setQueryData(key, { copied: 'identity' });
    await invalidatePrivacyQueries(queryClient);
    for (const key of sensitiveKeys) expect(queryClient.getQueryData(key), JSON.stringify(key)).toBeUndefined();
    queryClient.clear();
  });

  it('leaves device-local state and static reference data alone', async () => {
    const queryClient = new QueryClient();
    const neutralKeys = [
      ['profile', 'viewer'],
      ['grades', 'kilter'],
      ['angles', 'kilter', 1],
      ['popularBoardConfigs', undefined],
      ['snapshotManifest'],
      ['downloadedScopeKeys'],
      ['bootstrapMetadataByScope', 3],
      ['offlineStorage', true],
      ['offlineReclaimableBytes'],
      ['deadLetters', 'count', true],
    ];
    for (const key of neutralKeys) queryClient.setQueryData(key, { kept: true });
    await invalidatePrivacyQueries(queryClient);
    for (const key of neutralKeys) {
      const state = queryClient.getQueryState(key);
      expect(state?.data, JSON.stringify(key)).toEqual({ kept: true });
      expect(state?.isInvalidated, JSON.stringify(key)).toBe(false);
    }
    queryClient.clear();
  });

  it('refetches an on-screen climb list without blanking it and withdraws off-screen ones', async () => {
    const queryClient = new QueryClient();
    const kilterSearch = ['infiniteSearchClimbs', { boardName: 'kilter', layoutId: 1 }];
    const kilterCount = ['searchClimbsCount', { boardName: 'kilter', layoutId: 1 }];
    // The followed-authors filter appends the viewer after the input.
    const followedSearch = ['searchClimbs', { boardName: 'tension', layoutId: 9 }, 'viewer'];
    queryClient.setQueryData(kilterSearch, { climbs: ['first page'] });
    queryClient.setQueryData(kilterCount, 120);
    queryClient.setQueryData(followedSearch, { climbs: ['followed page'] });
    let resolveRefetch!: (page: { climbs: string[] }) => void;
    const observer = new QueryObserver(queryClient, {
      queryKey: kilterSearch,
      staleTime: Infinity,
      queryFn: () =>
        new Promise<{ climbs: string[] }>((resolve) => {
          resolveRefetch = resolve;
        }),
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const invalidation = invalidatePrivacyQueries(queryClient);
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(true));
      // The list stays on screen while the authorized answer is in flight.
      expect(observer.getCurrentResult().data).toEqual({ climbs: ['first page'] });
      resolveRefetch({ climbs: ['authorized page'] });
      await invalidation;
      expect(observer.getCurrentResult().data).toEqual({ climbs: ['authorized page'] });
      // Nothing observes these, so invalidation would not refetch them.
      expect(queryClient.getQueryData(kilterCount)).toBeUndefined();
      expect(queryClient.getQueryData(followedSearch)).toBeUndefined();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('ignores a stale response from before the revocation', async () => {
    const queryClient = new QueryClient();
    let resolveOld!: (response: { displayName: string }) => void;
    const oldRequest = queryClient
      .fetchQuery({
        queryKey: ['publicProfile', 'private-user'],
        queryFn: () =>
          new Promise<{ displayName: string }>((resolve) => {
            resolveOld = resolve;
          }),
      })
      .catch(() => undefined);
    await invalidatePrivacyQueries(queryClient);
    resolveOld({ displayName: 'Withdrawn identity' });
    await oldRequest;
    expect(queryClient.getQueryData(['publicProfile', 'private-user'])).toBeUndefined();
    queryClient.clear();
  });
});
