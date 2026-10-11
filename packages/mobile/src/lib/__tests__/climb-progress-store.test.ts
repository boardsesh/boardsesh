import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { LogbookEntry } from '@boardsesh/board-react';
import { createClimbProgressStore, climbProgressKey } from '../climb-progress-store';
import { createClimbProgressCacheScope } from '../climb-progress-cache-scope';

const tick = (climbUuid: string, angle = 40): LogbookEntry => ({
  uuid: `tick-${climbUuid}`,
  climb_uuid: climbUuid,
  angle,
  is_mirror: false,
  tries: 2,
  quality: null,
  difficulty: null,
  comment: '',
  climbed_at: '2026-10-10T12:00:00Z',
  is_ascent: true,
  status: 'send',
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
});

describe('indexed climb progress store', () => {
  it('separates the same UUID by board and angle', () => {
    const store = createClimbProgressStore(0, () => 0);
    const original = tick('shared');
    const steeper = tick('shared', 50);
    store.publish('kilter', [original, steeper]);
    store.publish('tension', [tick('shared')]);
    expect(store.getSnapshot(climbProgressKey('kilter', 'shared', 40))).toEqual([original]);
    expect(store.getSnapshot(climbProgressKey('kilter', 'shared', 50))).toEqual([steeper]);
    expect(store.getSnapshot(climbProgressKey('tension', 'shared', 50))).toEqual([]);
  });
  it('notifies only the changed bucket and preserves other snapshot identities', () => {
    const store = createClimbProgressStore(0, () => 0);
    const first = tick('first');
    const second = tick('second');
    store.publish('kilter', [first, second]);
    const key = climbProgressKey('kilter', 'first', 40);
    const snapshot = store.getSnapshot(key);
    const listener = vi.fn();
    store.subscribe(key, listener);
    store.publish('kilter', [first, { ...second, tries: 3 }]);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot(key)).toBe(snapshot);
    store.publish('kilter', [second]);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot(key)).toEqual([]);
  });
  it('withdraws old credentials synchronously and rejects late publication', () => {
    let generation = 1;
    const store = createClimbProgressStore(generation, () => generation);
    const key = climbProgressKey('kilter', 'first', 40);
    store.publish('kilter', [tick('first')]);
    generation = 2;
    expect(store.getSnapshot(key)).toEqual([]);
    store.publish('kilter', [tick('first')]);
    expect(store.getSnapshot(key)).toEqual([]);
    const accountB = createClimbProgressStore(generation, () => generation);
    accountB.publish('kilter', [tick('second')]);
    expect(accountB.getSnapshot(key)).toEqual([]);
  });
});

describe('shared logbook cache credential ownership', () => {
  it('fences retained account A caches until auth cleanup removes them', () => {
    const client = new QueryClient();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('first')]);
    const scope = createClimbProgressCacheScope(client, 1);
    expect(scope.belongsToCurrentScope('kilter')).toBe(true);
    scope.setGeneration(2);
    // Native auth is still true while SecureStore/SQLite cleanup awaits.
    expect(scope.belongsToCurrentScope('kilter')).toBe(false);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('late-account-a')]);
    expect(scope.belongsToCurrentScope('kilter')).toBe(false);
    client.removeQueries({ queryKey: ['logbook'] });
    expect(scope.belongsToCurrentScope('kilter')).toBe(true);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('account-b')]);
    expect(scope.belongsToCurrentScope('kilter')).toBe(true);
    scope.unsubscribe();
  });
  it('keeps ordinary token refresh and board changes usable', () => {
    const client = new QueryClient();
    const scope = createClimbProgressCacheScope(client, 1);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('first')]);
    scope.setGeneration(1); // storeTokensForGeneration preserves the credential owner.
    expect(scope.belongsToCurrentScope('kilter')).toBe(true);
    expect(scope.belongsToCurrentScope('tension')).toBe(true);
    scope.unsubscribe();
  });
  it('lets login fill the disabled anonymous accumulator without replacing its query', () => {
    const client = new QueryClient();
    const scope = createClimbProgressCacheScope(client, 1);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    client.setQueryData(['logbook', 'kilter', 'fetch', ''], []);
    client.setQueryData(['logbook', 'kilter', 'fetched-climb-uuids'], new Set());
    const anonymousQuery = client.getQueryCache().find({ queryKey: ['logbook', 'kilter', 'accumulated'] });
    scope.setGeneration(2);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('signed-in')]);
    expect(client.getQueryCache().find({ queryKey: ['logbook', 'kilter', 'accumulated'] })).toBe(anonymousQuery);
    expect(scope.belongsToCurrentScope('kilter')).toBe(true);
    scope.unsubscribe();
  });
  it('does not transfer an empty accumulator with a pending account-A fetch to B', () => {
    const client = new QueryClient();
    const scope = createClimbProgressCacheScope(client, 1);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    client.getQueryCache().build(client, { queryKey: ['logbook', 'kilter', 'fetch', 'first'] });
    scope.setGeneration(2);
    expect(scope.belongsToCurrentScope('kilter')).toBe(false);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('late-account-a')]);
    expect(scope.belongsToCurrentScope('kilter')).toBe(false);
    scope.unsubscribe();
  });
});
