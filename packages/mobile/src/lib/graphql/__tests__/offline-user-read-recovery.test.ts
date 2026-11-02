import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusManager, onlineManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { invalidateCredentialSnapshots } from '../../privacy/privacy-cache';
import {
  bindOfflineUserReadRecovery,
  beginPlaylistMembershipWrite,
  getUserReadRefreshEpoch,
  recordLocalUserRead,
} from '../offline-user-read-recovery';

let client: QueryClient;
let stop: () => void;
beforeEach(() => {
  onlineManager.setOnline(false);
  focusManager.setFocused(false);
  client = new QueryClient();
  stop = bindOfflineUserReadRecovery(client);
  invalidateCredentialSnapshots();
});
afterEach(() => {
  stop();
  client.clear();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

describe('offline user read recovery', () => {
  it('removes every affected Infinity logbook cache while retaining other boards', () => {
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [{ uuid: 'local', upvotes: 0 }]);
    client.setQueryData(['logbook', 'kilter', 'fetched-climb-uuids'], new Set(['climb']));
    client.setQueryData(['logbook', 'kilter', 'fetch', 'climb'], []);
    client.setQueryData(['logbook', 'tension', 'accumulated'], [{ uuid: 'server', upvotes: 8 }]);
    recordLocalUserRead('logbook', 'kilter');
    onlineManager.setOnline(true);
    expect(client.getQueriesData({ queryKey: ['logbook', 'kilter'] })).toEqual([]);
    expect(client.getQueryData(['logbook', 'tension', 'accumulated'])).toEqual([{ uuid: 'server', upvotes: 8 }]);
  });

  it('refreshes query caches and state-based playlist and favorite readers once', () => {
    const playlistEpoch = getUserReadRefreshEpoch('playlists');
    const favoriteEpoch = getUserReadRefreshEpoch('favorites');
    for (const root of [
      'userPlaylists',
      'playlist',
      'playlistClimbs',
      'playlistSetters',
      'playlistsForClimb',
      'favoriteStatus',
    ]) {
      client.setQueryData([root, 'example'], []);
    }
    recordLocalUserRead('playlists', 'all');
    recordLocalUserRead('playlists', 'kilter');
    recordLocalUserRead('favorites', 'kilter');
    onlineManager.setOnline(true);
    expect(getUserReadRefreshEpoch('playlists')).toBe(playlistEpoch + 1);
    expect(getUserReadRefreshEpoch('favorites')).toBe(favoriteEpoch + 1);
    for (const query of client.getQueryCache().getAll()) expect(query.state.isInvalidated).toBe(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    expect(getUserReadRefreshEpoch('playlists')).toBe(playlistEpoch + 1);
  });

  it("does not carry the previous account's recovery into the next account", () => {
    recordLocalUserRead('logbook', 'kilter');
    invalidateCredentialSnapshots();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [{ uuid: 'next-account' }]);
    onlineManager.setOnline(true);
    expect(client.getQueryData(['logbook', 'kilter', 'accumulated'])).toEqual([{ uuid: 'next-account' }]);
  });

  it('recovers a network-error rescue on the next online focus', () => {
    onlineManager.setOnline(true);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    recordLocalUserRead('logbook', 'kilter');
    focusManager.setFocused(true);
    expect(client.getQueryData(['logbook', 'kilter', 'accumulated'])).toBeUndefined();
  });

  it('stops observing connectivity when the provider unmounts', () => {
    recordLocalUserRead('logbook', 'kilter');
    client.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    stop();
    onlineManager.setOnline(true);
    expect(client.getQueryData(['logbook', 'kilter', 'accumulated'])).toEqual([]);
  });

  it('keeps optimistic memberships until every pending toggle settles, then refreshes once', async () => {
    onlineManager.setOnline(true);
    const membershipKey = ['playlistsForClimb', 'kilter', 1, 'climb'];
    let serverMemberships: string[] = [];
    const readMemberships = vi.fn(async () => serverMemberships);
    const observer = new QueryObserver<string[]>(client, {
      queryKey: membershipKey,
      queryFn: readMemberships,
      initialData: [],
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    let stopObserver = observer.subscribe(() => {});
    const releaseFirst = beginPlaylistMembershipWrite(client, membershipKey);
    const releaseSecond = beginPlaylistMembershipWrite(client, membershipKey);
    try {
      recordLocalUserRead('playlists', 'kilter');
      await client.cancelQueries({ queryKey: membershipKey });
      client.setQueryData(membershipKey, ['first-playlist', 'second-playlist']);
      focusManager.setFocused(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(readMemberships).not.toHaveBeenCalled();
      expect(client.getQueryData(membershipKey)).toEqual(['first-playlist', 'second-playlist']);
      expect(client.getQueryState(membershipKey)?.isInvalidated).toBe(false);

      // The picker unmounts when returning to the reaction menu. Reopening it
      // during the mutation must not use recovery's stale bit to start a GET.
      stopObserver();
      const remountedObserver = new QueryObserver<string[]>(client, {
        queryKey: membershipKey,
        queryFn: readMemberships,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      });
      stopObserver = remountedObserver.subscribe(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(readMemberships).not.toHaveBeenCalled();

      serverMemberships = ['first-playlist'];
      releaseFirst();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(readMemberships).not.toHaveBeenCalled();
      expect(client.getQueryData(membershipKey)).toEqual(['first-playlist', 'second-playlist']);

      serverMemberships = ['first-playlist', 'second-playlist'];
      releaseSecond();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(readMemberships).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(membershipKey)).toEqual(serverMemberships);
      expect(client.getQueryState(membershipKey)?.isInvalidated).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      stopObserver();
    }
  });

  it('does not flush a retired account’s deferred membership refresh', async () => {
    onlineManager.setOnline(true);
    const membershipKey = ['playlistsForClimb', 'kilter', 1, 'climb'];
    const readMemberships = vi.fn(async () => ['old-account-playlist']);
    const observer = new QueryObserver<string[]>(client, {
      queryKey: membershipKey,
      queryFn: readMemberships,
      initialData: [],
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    const stopObserver = observer.subscribe(() => {});
    const release = beginPlaylistMembershipWrite(client, membershipKey);
    try {
      recordLocalUserRead('playlists', 'kilter');
      focusManager.setFocused(true);
      invalidateCredentialSnapshots();
      client.setQueryData(membershipKey, ['new-account-playlist']);
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(readMemberships).not.toHaveBeenCalled();
      expect(client.getQueryData(membershipKey)).toEqual(['new-account-playlist']);
    } finally {
      release();
      stopObserver();
    }
  });
});
