import { describe, expect, it, vi } from 'vitest';

// The store is plain TypeScript; the component beside it pulls the native render
// hook in, which this test has no use for.
vi.mock('../ClimbListThumbnail', () => ({ ClimbListThumbnailPrewarm: () => null }));

import { createVisibleRowsStore } from '../ClimbListScrollAhead';

describe('createVisibleRowsStore', () => {
  it('starts at the top of the list', () => {
    const store = createVisibleRowsStore();
    expect(store.getFirst()).toBe(0);
    expect(store.getLast()).toBe(0);
  });

  it('notifies subscribers only when a visible row actually changes', () => {
    const store = createVisibleRowsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(2, 7);
    store.set(2, 7);
    expect(store.getFirst()).toBe(2);
    expect(store.getLast()).toBe(7);
    expect(listener).toHaveBeenCalledTimes(1);

    // Either end moving counts: a scroll up changes the first row first.
    store.set(1, 7);
    expect(listener).toHaveBeenCalledTimes(2);
    store.set(1, 6);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createVisibleRowsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set(6, 12);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getLast()).toBe(12);
  });

  it('keeps separate lists separate', () => {
    const first = createVisibleRowsStore();
    const second = createVisibleRowsStore();
    first.set(34, 40);
    expect(second.getLast()).toBe(0);
  });
});
