import { describe, it, expect, vi } from 'vitest';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import { emitHoldsFilterSelection, subscribeToHoldsFilterSelection } from '../hold-filter-handoff';

describe('hold-filter-handoff', () => {
  it('delivers the emitted holds filter to a subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHoldsFilterSelection('sheet-a', listener);

    const holdsFilter: HoldsFilter = { '12': { HAND: 'include' } };
    emitHoldsFilterSelection({ handoffId: 'sheet-a', holdsFilter });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(holdsFilter);
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHoldsFilterSelection('sheet-a', listener);
    unsubscribe();

    emitHoldsFilterSelection({ handoffId: 'sheet-a', holdsFilter: { '3': { FOOT: 'exclude' } } });

    expect(listener).not.toHaveBeenCalled();
  });

  it('fans out a single emit to every subscriber under the same id', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeToHoldsFilterSelection('sheet-a', first);
    const unsubSecond = subscribeToHoldsFilterSelection('sheet-a', second);

    const holdsFilter: HoldsFilter = { '7': { ANY: 'include' } };
    emitHoldsFilterSelection({ handoffId: 'sheet-a', holdsFilter });

    expect(first).toHaveBeenCalledWith(holdsFilter);
    expect(second).toHaveBeenCalledWith(holdsFilter);
    unsubFirst();
    unsubSecond();
  });

  it('only one of two subscribers receives the emit after the other unsubscribes', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const unsubKept = subscribeToHoldsFilterSelection('sheet-a', kept);
    const unsubDropped = subscribeToHoldsFilterSelection('sheet-a', dropped);
    unsubDropped();

    emitHoldsFilterSelection({ handoffId: 'sheet-a', holdsFilter: { '9': { STARTING: 'include' } } });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    unsubKept();
  });

  it('reaches only the subscriber with the same id', () => {
    const mine = vi.fn();
    const other = vi.fn();
    const unsubMine = subscribeToHoldsFilterSelection('sheet-a', mine);
    const unsubOther = subscribeToHoldsFilterSelection('sheet-b', other);

    emitHoldsFilterSelection({ handoffId: 'sheet-a', holdsFilter: { '1': { HAND: 'include' } } });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    unsubMine();
    unsubOther();
  });

  it('reaches no one for an empty handoff id, even a subscriber under an empty id', () => {
    const named = vi.fn();
    const empty = vi.fn();
    const unsubNamed = subscribeToHoldsFilterSelection('sheet-a', named);
    const unsubEmpty = subscribeToHoldsFilterSelection('', empty);

    emitHoldsFilterSelection({ handoffId: '', holdsFilter: { '1': { HAND: 'include' } } });

    expect(named).not.toHaveBeenCalled();
    expect(empty).not.toHaveBeenCalled();
    unsubNamed();
    unsubEmpty();
  });
});
