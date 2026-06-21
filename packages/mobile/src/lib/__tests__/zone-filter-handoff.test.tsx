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
    const unsubscribe = subscribeToZoneFilterSelection(listener);

    const holdsFilter: HoldsFilter = { '12': { HAND: 'include' } };
    emitZoneFilterSelection({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS, holdsFilter });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS, holdsFilter });
    unsubscribe();
  });

  it('stops delivering after the subscriber unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToZoneFilterSelection(listener);
    unsubscribe();

    emitZoneFilterSelection({ zoneBox: null, zoneMode: ALL_HOLDS });

    expect(listener).not.toHaveBeenCalled();
  });

  // The ClimbFilterSheet subscribes in a useEffect whose cleanup returns the
  // unsubscribe (ClimbFilterSheet.tsx ~line 188). This reproduces that exact
  // wiring and asserts the subscription is torn down on unmount — so a sheet
  // that opens and closes repeatedly doesn't leak a growing listener set that
  // would re-apply a stale handoff to an unmounted sheet.
  it('cleans up the subscription when the subscribing component unmounts', () => {
    const onSelection = vi.fn<(selection: ZoneFilterSelection) => void>();

    function useZoneFilterSubscription() {
      useEffect(() => subscribeToZoneFilterSelection(onSelection), []);
    }

    const { unmount } = renderHook(() => useZoneFilterSubscription());

    // While mounted, an emit reaches the subscriber.
    emitZoneFilterSelection({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });
    expect(onSelection).toHaveBeenCalledTimes(1);

    unmount();

    // After unmount, the effect cleanup must have removed the listener.
    emitZoneFilterSelection({ zoneBox: null, zoneMode: ALL_HOLDS });
    expect(onSelection).toHaveBeenCalledTimes(1);
  });

  it('does not leave a dangling listener after repeated mount/unmount cycles', () => {
    const onSelection = vi.fn();

    function useZoneFilterSubscription() {
      useEffect(() => subscribeToZoneFilterSelection(onSelection), []);
    }

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { unmount } = renderHook(() => useZoneFilterSubscription());
      unmount();
    }

    // Every cycle's listener was the same fn; if any unmount failed to clean up,
    // this emit would still call it. None remain, so the fn is never invoked.
    emitZoneFilterSelection({ zoneBox: ZONE_BOX, zoneMode: ALL_HOLDS });
    expect(onSelection).not.toHaveBeenCalled();
  });
});
