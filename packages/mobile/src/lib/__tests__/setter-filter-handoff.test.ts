import { describe, it, expect, vi } from 'vitest';
import { emitSetterFilterSelection, subscribeToSetterFilterSelection } from '../setter-filter-handoff';

describe('setter-filter-handoff', () => {
  it('delivers the emitted setter selection to a subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSetterFilterSelection(listener);

    const setters = ['alice', 'bob'];
    emitSetterFilterSelection(setters);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(setters);
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSetterFilterSelection(listener);
    unsubscribe();

    emitSetterFilterSelection(['carol']);

    expect(listener).not.toHaveBeenCalled();
  });

  it('fans out a single emit to every active subscriber', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeToSetterFilterSelection(first);
    const unsubSecond = subscribeToSetterFilterSelection(second);

    const setters = ['dave'];
    emitSetterFilterSelection(setters);

    expect(first).toHaveBeenCalledWith(setters);
    expect(second).toHaveBeenCalledWith(setters);
    unsubFirst();
    unsubSecond();
  });

  it('only the kept subscriber receives the emit after the other unsubscribes', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const unsubKept = subscribeToSetterFilterSelection(kept);
    const unsubDropped = subscribeToSetterFilterSelection(dropped);
    unsubDropped();

    emitSetterFilterSelection(['erin']);

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    unsubKept();
  });
});
