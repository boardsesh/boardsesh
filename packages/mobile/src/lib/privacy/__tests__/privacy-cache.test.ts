import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidatePrivacyQueries } from '../privacy-cache';

describe('privacy revocation', () => {
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
