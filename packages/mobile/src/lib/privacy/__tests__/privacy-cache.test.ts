import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  getCredentialGeneration,
  invalidateCredentialSnapshots,
  refreshAfterOwnPrivacyChange,
  subscribeToCredentialChanges,
} from '../privacy-cache';

describe('credential boundaries', () => {
  it('moves the credential generation and notifies listeners before returning', () => {
    const credential = getCredentialGeneration();
    const listener = vi.fn(() => {
      // Listeners read the new generation, not the one being retired.
      expect(getCredentialGeneration()).toBe(credential + 1);
    });
    const unsubscribe = subscribeToCredentialChanges(listener);
    try {
      invalidateCredentialSnapshots();
      expect(getCredentialGeneration()).toBe(credential + 1);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});

describe("refreshing after the viewer's own privacy write", () => {
  it('refetches an on-screen query without blanking it', async () => {
    const queryClient = new QueryClient();
    const followRequests = ['privacyFollowRequests', 'viewer'];
    queryClient.setQueryData(followRequests, ['requester']);
    let resolveRefetch!: (requests: string[]) => void;
    const observer = new QueryObserver(queryClient, {
      queryKey: followRequests,
      staleTime: Infinity,
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          resolveRefetch = resolve;
        }),
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const refresh = refreshAfterOwnPrivacyChange(queryClient);
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(true));
      expect(observer.getCurrentResult().data).toEqual(['requester']);
      resolveRefetch([]);
      await refresh;
      expect(observer.getCurrentResult().data).toEqual([]);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('marks off-screen queries stale and keeps their data', async () => {
    const queryClient = new QueryClient();
    const offScreenKeys = [
      ['publicProfile', 'follower'],
      ['infiniteSearchClimbs', { boardName: 'kilter', layoutId: 1 }],
      ['someFutureQuery', 'id'],
    ];
    for (const key of offScreenKeys) queryClient.setQueryData(key, { shown: true });
    await refreshAfterOwnPrivacyChange(queryClient);
    for (const key of offScreenKeys) {
      const state = queryClient.getQueryState(key);
      expect(state?.data, JSON.stringify(key)).toEqual({ shown: true });
      expect(state?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    queryClient.clear();
  });

  it('leaves credentials, device-local state and static reference data alone', async () => {
    const queryClient = new QueryClient();
    const unaffectedKeys = [
      ['profile', 'viewer'],
      ['authToken'],
      ['wsAuthToken'],
      ['localPendingTicks'],
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
    for (const key of unaffectedKeys) queryClient.setQueryData(key, { kept: true });
    await refreshAfterOwnPrivacyChange(queryClient);
    for (const key of unaffectedKeys) {
      const state = queryClient.getQueryState(key);
      expect(state?.data, JSON.stringify(key)).toEqual({ kept: true });
      expect(state?.isInvalidated, JSON.stringify(key)).toBe(false);
    }
    queryClient.clear();
  });

  it('does not move the credential generation, so open drawers and queued work carry on', async () => {
    const queryClient = new QueryClient();
    const credential = getCredentialGeneration();
    const listener = vi.fn();
    const unsubscribe = subscribeToCredentialChanges(listener);
    try {
      await refreshAfterOwnPrivacyChange(queryClient);
      expect(getCredentialGeneration()).toBe(credential);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});
