import { describe, it, expect, vi } from 'vitest';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import { emitHoldsFilterSelection, subscribeToHoldsFilterSelection } from '../hold-filter-handoff';

describe('hold-filter-handoff', () => {
  it('delivers the emitted holds filter to a subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHoldsFilterSelection(listener);

    const holdsFilter: HoldsFilter = { '12': { HAND: 'include' } };
    emitHoldsFilterSelection(holdsFilter);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(holdsFilter);
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHoldsFilterSelection(listener);
    unsubscribe();

    emitHoldsFilterSelection({ '3': { FOOT: 'exclude' } });

    expect(listener).not.toHaveBeenCalled();
  });

  it('fans out a single emit to every active subscriber', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeToHoldsFilterSelection(first);
    const unsubSecond = subscribeToHoldsFilterSelection(second);

    const holdsFilter: HoldsFilter = { '7': { ANY: 'include' } };
    emitHoldsFilterSelection(holdsFilter);

    expect(first).toHaveBeenCalledWith(holdsFilter);
    expect(second).toHaveBeenCalledWith(holdsFilter);
    unsubFirst();
    unsubSecond();
  });

  it('only one of two subscribers receives the emit after the other unsubscribes', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const unsubKept = subscribeToHoldsFilterSelection(kept);
    const unsubDropped = subscribeToHoldsFilterSelection(dropped);
    unsubDropped();

    emitHoldsFilterSelection({ '9': { STARTING: 'include' } });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    unsubKept();
  });
});
