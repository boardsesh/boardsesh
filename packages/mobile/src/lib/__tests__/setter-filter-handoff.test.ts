import { describe, it, expect, vi } from 'vitest';
import { emitSetterFilterSelection, subscribeToSetterFilterSelection } from '../setter-filter-handoff';
import { createFilterPickerHandoffId } from '../filter-picker-handoff-id';

describe('setter-filter-handoff', () => {
  it('delivers the emitted setter selection to a subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSetterFilterSelection('sheet-a', listener);

    const setters = ['alice', 'bob'];
    emitSetterFilterSelection({ handoffId: 'sheet-a', setters });

    expect(listener).toHaveBeenCalledTimes(1);
    // No options given → an empty options object, so listeners never null-check.
    expect(listener).toHaveBeenCalledWith(setters, {});
    unsubscribe();
  });

  it('passes the apply option through to the subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSetterFilterSelection('sheet-a', listener);

    emitSetterFilterSelection({ handoffId: 'sheet-a', setters: ['alice'], apply: true });

    expect(listener).toHaveBeenCalledWith(['alice'], { apply: true });
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSetterFilterSelection('sheet-a', listener);
    unsubscribe();

    emitSetterFilterSelection({ handoffId: 'sheet-a', setters: ['carol'] });

    expect(listener).not.toHaveBeenCalled();
  });

  it('fans out a single emit to every subscriber under the same id', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeToSetterFilterSelection('sheet-a', first);
    const unsubSecond = subscribeToSetterFilterSelection('sheet-a', second);

    const setters = ['dave'];
    emitSetterFilterSelection({ handoffId: 'sheet-a', setters, apply: true });

    expect(first).toHaveBeenCalledWith(setters, { apply: true });
    expect(second).toHaveBeenCalledWith(setters, { apply: true });
    unsubFirst();
    unsubSecond();
  });

  it('only the kept subscriber receives the emit after the other unsubscribes', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const unsubKept = subscribeToSetterFilterSelection('sheet-a', kept);
    const unsubDropped = subscribeToSetterFilterSelection('sheet-a', dropped);
    unsubDropped();

    emitSetterFilterSelection({ handoffId: 'sheet-a', setters: ['erin'] });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    unsubKept();
  });

  it('reaches only the subscriber with the same id', () => {
    const mine = vi.fn();
    const other = vi.fn();
    const unsubMine = subscribeToSetterFilterSelection('sheet-a', mine);
    const unsubOther = subscribeToSetterFilterSelection('sheet-b', other);

    emitSetterFilterSelection({ handoffId: 'sheet-a', setters: ['frank'] });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    unsubMine();
    unsubOther();
  });

  it('reaches no one for an empty handoff id, even a subscriber under an empty id', () => {
    const named = vi.fn();
    const empty = vi.fn();
    const unsubNamed = subscribeToSetterFilterSelection('sheet-a', named);
    const unsubEmpty = subscribeToSetterFilterSelection('', empty);

    emitSetterFilterSelection({ handoffId: '', setters: ['gina'] });

    expect(named).not.toHaveBeenCalled();
    expect(empty).not.toHaveBeenCalled();
    unsubNamed();
    unsubEmpty();
  });
});

describe('createFilterPickerHandoffId', () => {
  it('returns a distinct, non-empty id on every call', () => {
    const ids = [createFilterPickerHandoffId(), createFilterPickerHandoffId(), createFilterPickerHandoffId()];

    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^filter-picker-\d+$/);
  });
});
