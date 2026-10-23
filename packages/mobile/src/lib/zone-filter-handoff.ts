import type { HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';
import { createAddressedHandoff } from './addressed-handoff';

/**
 * Hands the edited board-region (zone) filter back from the route-based board
 * sub-screen to the filter sheet that pushed it. The sheet suspends and pushes
 * that route with its `handoffId` (lib/filter-picker-handoff-id.ts), then merges
 * the result into its draft when the route hands it back to that id on pop
 * (lib/addressed-handoff.ts).
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

const zoneHandoff = createAddressedHandoff<ZoneFilterSelection>();

export function emitZoneFilterSelection({ handoffId, ...selection }: AddressedZoneFilterSelection): void {
  zoneHandoff.emit(handoffId, selection);
}

/** Listens for the zone handed back to `handoffId` only. */
export function subscribeToZoneFilterSelection(
  handoffId: string,
  listener: (selection: ZoneFilterSelection) => void,
): () => void {
  return zoneHandoff.subscribe(handoffId, listener);
}
