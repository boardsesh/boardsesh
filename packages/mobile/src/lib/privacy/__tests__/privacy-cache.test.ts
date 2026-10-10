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
      queryKey: ['searchClimbs'],
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
