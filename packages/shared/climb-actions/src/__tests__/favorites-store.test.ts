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
