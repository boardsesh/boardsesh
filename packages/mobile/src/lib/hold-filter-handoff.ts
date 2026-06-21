import type { HoldsFilter } from '@boardsesh/shared-schema';

// Hands the edited hold filter back from the standalone route-based board
// sub-screen. The climb filter sheet uses a stacked modal editor instead.
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
