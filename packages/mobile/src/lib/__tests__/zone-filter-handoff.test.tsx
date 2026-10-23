// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { renderHook } from '@testing-library/react';
import type { ZoneBoxInput, ZoneMatchMode, HoldsFilter } from '@boardsesh/shared-schema';
import {
  emitZoneFilterSelection,
  subscribeToZoneFilterSelection,
  type ZoneFilterSelection,
} from '../zone-filter-handoff';

const ZONE_BOX: ZoneBoxInput = { edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 };
const ALL_HOLDS: ZoneMatchMode = 'allHolds';

describe('zone-filter-handoff', () => {
  it('delivers the emitted zone selection to a subscriber', () => {
    const listener = vi.fn<(selection: ZoneFilterSelection) => void>();
    const unsubscribe = subscribeToZoneFilterSelection('sheet-a', listener);

    const holdsFilter: HoldsFilter = { '12': { HAND: 'include' } };
    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS, holdsFilter });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS, holdsFilter });
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToZoneFilterSelection('sheet-a', listener);
    unsubscribe();

    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: null, zoneMode: ALL_HOLDS });

    expect(listener).not.toHaveBeenCalled();
  });

  it('reaches only the subscriber with the same id', () => {
    const mine = vi.fn();
    const other = vi.fn();
    const unsubMine = subscribeToZoneFilterSelection('sheet-a', mine);
    const unsubOther = subscribeToZoneFilterSelection('sheet-b', other);

    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });

    expect(mine).toHaveBeenCalledWith({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });
    expect(other).not.toHaveBeenCalled();
    unsubMine();
    unsubOther();
  });

  it('reaches no one for an empty handoff id, even a subscriber under an empty id', () => {
    const named = vi.fn();
    const empty = vi.fn();
    const unsubNamed = subscribeToZoneFilterSelection('sheet-a', named);
    const unsubEmpty = subscribeToZoneFilterSelection('', empty);

    emitZoneFilterSelection({ handoffId: '', zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });

    expect(named).not.toHaveBeenCalled();
    expect(empty).not.toHaveBeenCalled();
    unsubNamed();
    unsubEmpty();
  });

  // The ClimbFilterSheet subscribes in a useEffect whose cleanup returns the
  // unsubscribe (ClimbFilterSheet.tsx ~line 188). This reproduces that exact
  // wiring and asserts the subscription is torn down on unmount — so a sheet
  // that opens and closes repeatedly doesn't leak a growing listener set that
  // would re-apply a stale handoff to an unmounted sheet.
  it('cleans up the subscription when the subscribing component unmounts', () => {
    const onSelection = vi.fn<(selection: ZoneFilterSelection) => void>();

    function useZoneFilterSubscription() {
      useEffect(() => subscribeToZoneFilterSelection('sheet-a', onSelection), []);
    }

    const { unmount } = renderHook(() => useZoneFilterSubscription());

    // While mounted, an emit reaches the subscriber.
    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });
    expect(onSelection).toHaveBeenCalledTimes(1);

    unmount();

    // After unmount, the effect cleanup must have removed the listener.
    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: null, zoneMode: ALL_HOLDS });
    expect(onSelection).toHaveBeenCalledTimes(1);
  });

  it('does not leave a dangling listener after repeated mount/unmount cycles', () => {
    const onSelection = vi.fn();

    function useZoneFilterSubscription() {
      useEffect(() => subscribeToZoneFilterSelection('sheet-a', onSelection), []);
    }

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { unmount } = renderHook(() => useZoneFilterSubscription());
      unmount();
    }

    // Every cycle's listener was the same fn; if any unmount failed to clean up,
    // this emit would still call it. None remain, so the fn is never invoked.
    emitZoneFilterSelection({ handoffId: 'sheet-a', zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });
    expect(onSelection).not.toHaveBeenCalled();
  });
});
