import { describe, expect, it, vi } from 'vitest';

// The store is plain TypeScript; the component beside it pulls the native render
// hook in, which this test has no use for.
vi.mock('../ClimbListThumbnail', () => ({ ClimbListThumbnailPrewarm: () => null }));

import { createLastVisibleRowStore } from '../ClimbListScrollAhead';

describe('createLastVisibleRowStore', () => {
  it('starts at the top of the list', () => {
    expect(createLastVisibleRowStore().get()).toBe(0);
  });

  it('notifies subscribers only when the row actually changes', () => {
    const store = createLastVisibleRowStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(7);
    store.set(7);
    expect(store.get()).toBe(7);
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createLastVisibleRowStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set(12);
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(12);
  });

  it('keeps separate lists separate', () => {
    const first = createLastVisibleRowStore();
    const second = createLastVisibleRowStore();
    first.set(40);
    expect(second.get()).toBe(0);
  });
});
