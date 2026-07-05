// Pure derivation of a board's offline download state from the settings + live
// sync status. Kept renderer-free so the My Boards screen can compute one state
// per row without each row subscribing to the sync store, and so it can be tested.

export type BoardDownloadState =
  | 'off' // not made available offline
  | 'pending' // enabled but not yet pulled (e.g. enabled while offline)
  | 'downloading' // the pull is fetching this exact board right now
  | 'downloaded'; // a sync cycle has completed since it was enabled

export type BoardDownloadStateInput = {
  /** Encoded scope key of the board ("boardType:layoutId:sizeId"). */
  scopeKey: string;
  /** Whether this scope key is in syncEnabledBoards. */
  enabled: boolean;
  /** From useSyncStatus(): a cycle is mid-flight. */
  isSyncing: boolean;
  /**
   * Whether THIS scope's own download checkpoint exists (its data has landed) —
   * a per-scope signal (getDownloadedScopeKeys), not the global lastSyncedAt, so a
   * second board doesn't read as "downloaded" the instant the first finishes.
   */
  downloaded: boolean;
  /** From useSyncStatus().progress: the table:scope label being pulled, or null. */
  currentTable: string | null;
};

/**
 * A board is "downloading" only while the pull is on one of its two per-board
 * tables — matched exactly so a sibling scope (e.g. kilter:1:50 vs kilter:1:5)
 * can't cross-trigger. "downloaded" is driven by this scope's own checkpoint, so a
 * board enabled after another already synced shows "pending" (not a false
 * "downloaded") until its own data lands.
 */
export function boardDownloadState(input: BoardDownloadStateInput): BoardDownloadState {
  if (!input.enabled) return 'off';

  const isCurrentBoard =
    input.currentTable === `board_climbs:${input.scopeKey}` ||
    input.currentTable === `board_climb_stats:${input.scopeKey}`;
  if (input.isSyncing && isCurrentBoard) return 'downloading';

  if (input.downloaded) return 'downloaded';
  return 'pending';
}
