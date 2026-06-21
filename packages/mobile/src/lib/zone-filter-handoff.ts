import type { HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';

/**
 * Hands the edited board-region (zone) filter back from the standalone
 * route-based board sub-screen. The climb filter sheet uses a stacked modal
 * editor instead.
 *
 * The zone screen can also prune out-of-zone hold filters (the `allHolds`
 * backend filter discards a climb if any hold is outside the box), so it hands
 * the possibly-pruned `holdsFilter` back alongside the zone — `undefined` means
 * "leave the sheet's holds filter untouched".
 */
export type ZoneFilterSelection = {
  zoneBox: ZoneBoxInput | null;
  zoneMode: ZoneMatchMode;
  holdsFilter?: HoldsFilter;
};

type ZoneFilterListener = (selection: ZoneFilterSelection) => void;

const zoneFilterListeners = new Set<ZoneFilterListener>();

export function emitZoneFilterSelection(selection: ZoneFilterSelection): void {
  for (const listener of zoneFilterListeners) {
    listener(selection);
  }
}

export function subscribeToZoneFilterSelection(listener: ZoneFilterListener): () => void {
  zoneFilterListeners.add(listener);
  return () => {
    zoneFilterListeners.delete(listener);
  };
}
