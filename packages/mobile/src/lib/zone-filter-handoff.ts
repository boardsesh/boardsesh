import type { HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';

/**
 * Hands the edited board-region (zone) filter back from the route-based board
 * sub-screen to the filter sheet that pushed it. The sheet suspends and pushes
 * that route with its `handoffId` (lib/filter-picker-handoff-id.ts), then merges
 * the result into its draft when the route hands it back to that id on pop.
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

export type AddressedZoneFilterSelection = ZoneFilterSelection & {
  /** The sheet the zone goes back to. Empty for a route opened without one: nobody gets it. */
  handoffId: string;
};

type ZoneFilterListener = (selection: ZoneFilterSelection) => void;

const zoneFilterListeners = new Set<{ handoffId: string; listener: ZoneFilterListener }>();

export function emitZoneFilterSelection({ handoffId, ...selection }: AddressedZoneFilterSelection): void {
  if (!handoffId) return;
  for (const subscription of zoneFilterListeners) {
    if (subscription.handoffId === handoffId) subscription.listener(selection);
  }
}

/** Listens for the zone handed back to `handoffId` only. */
export function subscribeToZoneFilterSelection(handoffId: string, listener: ZoneFilterListener): () => void {
  const subscription = { handoffId, listener };
  zoneFilterListeners.add(subscription);
  return () => {
    zoneFilterListeners.delete(subscription);
  };
}
