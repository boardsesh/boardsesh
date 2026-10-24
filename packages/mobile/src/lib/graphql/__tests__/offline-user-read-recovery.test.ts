import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { invalidatePrivacySnapshots } from '../../privacy/privacy-cache';
import {
  bindOfflineUserReadRecovery,
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
  invalidatePrivacySnapshots('credential');
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
    invalidatePrivacySnapshots('credential');
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
});
