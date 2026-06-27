import type { HoldsFilter } from '@boardsesh/shared-schema';

// Hands the edited hold filter back from the route-based board sub-screen. The
// climb filter sheet suspends and pushes that route, then merges the result into
// its draft when the route hands it back on pop.
type HoldsFilterListener = (holdsFilter: HoldsFilter) => void;

const holdsFilterListeners = new Set<HoldsFilterListener>();

export function emitHoldsFilterSelection(holdsFilter: HoldsFilter): void {
  for (const listener of holdsFilterListeners) {
    listener(holdsFilter);
  }
}

export function subscribeToHoldsFilterSelection(listener: HoldsFilterListener): () => void {
  holdsFilterListeners.add(listener);
  return () => {
    holdsFilterListeners.delete(listener);
  };
}
