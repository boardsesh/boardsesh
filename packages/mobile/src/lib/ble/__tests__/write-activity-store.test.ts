import { describe, expect, it, vi } from 'vitest';
import { createBleWriteActivityStore } from '../write-activity-store';

describe('createBleWriteActivityStore', () => {
  it('notifies only on boolean busy-state edges across overlapping tokens', () => {
    const store = createBleWriteActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const releaseFirst = store.begin();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    const releaseSecond = store.begin();
    expect(listener).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(store.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('makes releases idempotent and unsubscribe effective', () => {
    const store = createBleWriteActivityStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const release = store.begin();

    release();
    release();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.begin();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('resets the old epoch without letting a late release clear a new write', () => {
    const store = createBleWriteActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const releaseOldWrite = store.begin();

    store.reset();
    expect(store.getSnapshot()).toBe(false);

    const releaseNewWrite = store.begin();
    releaseOldWrite();
    expect(store.getSnapshot()).toBe(true);

    releaseNewWrite();
    expect(store.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('does not notify for a reset while already idle', () => {
    const store = createBleWriteActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();

    expect(listener).not.toHaveBeenCalled();
  });
});
