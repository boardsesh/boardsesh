// Re-export the canonical shared-schema types so the rest of the frontend has
// a single import path for board-history shapes.
export type { BoardHistoryEntry, BoardHistorySource, BoardHistoryEvent } from '@boardsesh/shared-schema';

import type { BoardHistoryEntry } from '@boardsesh/shared-schema';

/**
 * Public surface of the `useBoardHistory()` hook. MVP only consumes
 * `latestEntry`; `history` is exposed for forward-compatible features
 * (e.g. a "recent on this board" feed) but is bounded by the initial
 * query window plus the live subscription.
 */
export type BoardHistoryContextValue = {
  history: BoardHistoryEntry[];
  latestEntry: BoardHistoryEntry | null;
  /** Effective board serial driving the subscription. Null when no BLE
   * board is connected and no route fallback resolves a saved board. */
  boardSerial: string | null;
  isLoading: boolean;
  isSubscribed: boolean;
};
