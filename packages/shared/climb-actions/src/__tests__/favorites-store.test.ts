import { describe, it, expect, vi } from 'vitest';
import { FavoritesStore } from '../favorites-store';

describe('FavoritesStore', () => {
  it('notifies listeners when the favorites set actually changes', () => {
    const store = new FavoritesStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setFavorites(new Set(['a']));
    expect(listener).toHaveBeenCalledTimes(1);

    // Same contents (different Set instance) — no notification.
    store.setFavorites(new Set(['a']));
    expect(listener).toHaveBeenCalledTimes(1);

    store.setFavorites(new Set(['a', 'b']));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns primitive boolean from getIsFavorited so useSyncExternalStore can compare with Object.is', () => {
    const store = new FavoritesStore();
    store.setFavorites(new Set(['a']));

    expect(store.getIsFavorited('a')).toBe(true);
    expect(store.getIsFavorited('b')).toBe(false);
  });

  it('only notifies on meta change when values actually differ', () => {
    const store = new FavoritesStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setMeta(true, false);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setMeta(true, false);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setMeta(false, true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('mergeFavorites adds the favorited subset and clears the rest of the batch', () => {
    const store = new FavoritesStore();
    store.setFavorites(new Set(['a']));

    store.mergeFavorites(['a', 'b'], ['b']);

    expect(store.getIsFavorited('a')).toBe(false);
    expect(store.getIsFavorited('b')).toBe(true);
  });

  it('mergeFavorites leaves uuids outside the batch alone', () => {
    const store = new FavoritesStore();
    store.setFavorites(new Set(['earlier-page']));

    store.mergeFavorites(['a'], []);

    expect(store.getIsFavorited('earlier-page')).toBe(true);
  });

  it('mergeFavorites only notifies when something actually changed', () => {
    const store = new FavoritesStore();
    store.setFavorites(new Set(['a']));
    const listener = vi.fn();
    store.subscribe(listener);

    store.mergeFavorites(['a'], ['a']);
    expect(listener).not.toHaveBeenCalled();

    store.mergeFavorites(['a'], []);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setIsFavorited flips one uuid and notifies only on a real change', () => {
    const store = new FavoritesStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setIsFavorited('a', true);
    expect(store.getIsFavorited('a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setIsFavorited('a', true);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setIsFavorited('a', false);
    expect(store.getIsFavorited('a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('mergeFavorites leaves a climb toggled after the lookup was issued alone', () => {
    const store = new FavoritesStore();
    const startedAtStamp = store.getWriteStamp();

    // The user hearts the climb while the batch is still in flight.
    store.setIsFavorited('a', true);

    // The response reflects the pre-toggle server state; applying it would
    // clear the heart the user just set.
    store.mergeFavorites(['a', 'b'], [], startedAtStamp);

    expect(store.getIsFavorited('a')).toBe(true);
    expect(store.getIsFavorited('b')).toBe(false);
  });

  it('mergeFavorites still applies to climbs untouched since the lookup', () => {
    const store = new FavoritesStore();
    store.setIsFavorited('a', true);
    const startedAtStamp = store.getWriteStamp();

    store.mergeFavorites(['a'], [], startedAtStamp);

    expect(store.getIsFavorited('a')).toBe(false);
  });

  it('bumps the context epoch on reset so in-flight writers can tell', () => {
    const store = new FavoritesStore();
    const before = store.getContextEpoch();

    store.applyContext('kilter:40:1');

    expect(store.getContextEpoch()).not.toBe(before);
  });

  it('applyContext clears the set when the context changes, and reports it', () => {
    const store = new FavoritesStore();
    store.applyContext('kilter:40:1');
    store.setFavorites(new Set(['a']));

    expect(store.applyContext('kilter:40:1')).toBe(false);
    expect(store.getIsFavorited('a')).toBe(true);

    // A different angle is a different favourite key on the backend.
    expect(store.applyContext('kilter:25:1')).toBe(true);
    expect(store.getIsFavorited('a')).toBe(false);
  });

  it('applyContext treats a reset store as unscoped, so the same context re-applies', () => {
    const store = new FavoritesStore();
    store.applyContext('kilter:40:1');
    store.reset();

    // reset() forgets the context too — otherwise a caller that reset the store
    // would never be told to re-fetch the context it is still on.
    expect(store.applyContext('kilter:40:1')).toBe(true);
  });

  it('reset clears everything, and no-ops when already empty', () => {
    const store = new FavoritesStore();
    store.setFavorites(new Set(['a', 'b']));
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();
    expect(store.getIsFavorited('a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    store.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further notifications', () => {
    const store = new FavoritesStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setFavorites(new Set(['a']));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setFavorites(new Set(['a', 'b']));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
