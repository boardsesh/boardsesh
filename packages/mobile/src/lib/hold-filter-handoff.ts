import type { HoldsFilter } from '@boardsesh/shared-schema';

// Hands the edited hold filter back from the route-based board sub-screen to the
// filter sheet that pushed it. The sheet suspends and pushes that route with its
// `handoffId` (lib/filter-picker-handoff-id.ts), then merges the result into its
// draft when the route hands it back to that id on pop.
export type HoldsFilterSelection = {
  /** The sheet the filter goes back to. Empty for a route opened without one: nobody gets it. */
  handoffId: string;
  holdsFilter: HoldsFilter;
};

type HoldsFilterListener = (holdsFilter: HoldsFilter) => void;

const holdsFilterListeners = new Set<{ handoffId: string; listener: HoldsFilterListener }>();

export function emitHoldsFilterSelection({ handoffId, holdsFilter }: HoldsFilterSelection): void {
  if (!handoffId) return;
  for (const subscription of holdsFilterListeners) {
    if (subscription.handoffId === handoffId) subscription.listener(holdsFilter);
  }
}

/** Listens for the hold filter handed back to `handoffId` only. */
export function subscribeToHoldsFilterSelection(handoffId: string, listener: HoldsFilterListener): () => void {
  const subscription = { handoffId, listener };
  holdsFilterListeners.add(subscription);
  return () => {
    holdsFilterListeners.delete(subscription);
  };
}
