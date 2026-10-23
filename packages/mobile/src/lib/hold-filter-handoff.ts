import type { HoldsFilter } from '@boardsesh/shared-schema';
import { createAddressedHandoff } from './addressed-handoff';

// Hands the edited hold filter back from the route-based board sub-screen to the
// filter sheet that pushed it. The sheet suspends and pushes that route with its
// `handoffId` (lib/filter-picker-handoff-id.ts), then merges the result into its
// draft when the route hands it back to that id on pop (lib/addressed-handoff.ts).
export type HoldsFilterSelection = {
  /** The sheet the filter goes back to. Empty for a route opened without one: nobody gets it. */
  handoffId: string;
  holdsFilter: HoldsFilter;
};

const holdsHandoff = createAddressedHandoff<HoldsFilter>();

export function emitHoldsFilterSelection({ handoffId, holdsFilter }: HoldsFilterSelection): void {
  holdsHandoff.emit(handoffId, holdsFilter);
}

/** Listens for the hold filter handed back to `handoffId` only. */
export function subscribeToHoldsFilterSelection(
  handoffId: string,
  listener: (holdsFilter: HoldsFilter) => void,
): () => void {
  return holdsHandoff.subscribe(handoffId, listener);
}
