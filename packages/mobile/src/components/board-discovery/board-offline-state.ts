// Pure derivation of a board's offline download state from the settings + live
// sync status. Kept renderer-free so the My Boards screen can compute one state
// per row without each row subscribing to the sync store, and so it can be tested.

import { MAX_BOOTSTRAP_ATTEMPTS, type SyncProgress } from '@boardsesh/offline-sync';

export type BoardDownloadState =
  | 'off' // not made available offline
  | 'pending' // enabled but not yet pulled (e.g. enabled while offline)
  | 'downloading' // the pull is fetching this exact board right now
  | 'downloaded'; // a sync cycle has completed since it was enabled

/**
 * A persisted explanation for an in-progress offline download. This is kept
 * separate from BoardDownloadState: the download still has the same pending /
 * downloading lifecycle, but a failed snapshot bootstrap changes what the user
 * should expect next.
 */
export type BoardDownloadNotice = 'snapshot-retrying' | 'paged-fallback' | null;

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
  /**
   * From useSyncStatus().progress?.phase: which pull phase is running. Only
   * matters for distinguishing the snapshot-bootstrap warm-up (currentTable is
   * the bare scope key, not a `table:scope` label) from the paged crawl.
   * Undefined/null is treated as "not bootstrapping" — the paged-crawl match
   * below still applies.
   */
  phase?: SyncProgress['phase'] | null;
};

/**
 * True when the live progress frame is the snapshot-bootstrap warm-up for
 * THIS scope. The bootstrap phase reports `currentTable` as the bare scope key
 * (pull-client.ts's `runBootstrapPhase`), unlike the paged board_data phase's
 * `table:scope` label — so this is a distinct match, not a prefix variant.
 */
function isBootstrappingThisScope(
  input: Pick<BoardDownloadStateInput, 'scopeKey' | 'phase' | 'currentTable'>,
): boolean {
  return input.phase === 'bootstrap' && input.currentTable === input.scopeKey;
}

/**
 * A board is "downloading" while the pull is on one of its per-board data
 * tables (matched exactly so a sibling scope, e.g. kilter:1:50 vs kilter:1:5,
 * can't cross-trigger) OR while it's being warmed from a snapshot artifact.
 * "downloaded" is driven by this scope's own checkpoint, so a board enabled
 * after another already synced shows "pending" (not a false "downloaded")
 * until its own data lands.
 */
export function boardDownloadState(input: BoardDownloadStateInput): BoardDownloadState {
  if (!input.enabled) return 'off';

  const isCurrentBoard =
    isBootstrappingThisScope(input) ||
    input.currentTable === `board_climbs:${input.scopeKey}` ||
    input.currentTable === `board_climb_stats:${input.scopeKey}` ||
    input.currentTable === `board_climb_grades:${input.scopeKey}`;
  if (input.isSyncing && isCurrentBoard) return 'downloading';

  if (input.downloaded) return 'downloaded';
  return 'pending';
}

/**
 * Whether THIS row's `'downloading'` state is the snapshot-bootstrap warm-up
 * rather than the paged crawl. The bootstrap phase carries no per-row climb
 * count (unlike the paged crawl's `currentTableProcessed`), so the UI needs a
 * distinct caption ("Downloading board…") instead of "Downloading N climbs".
 */
export function boardIsBootstrapping(input: BoardDownloadStateInput): boolean {
  return input.isSyncing && isBootstrappingThisScope(input);
}

export type BoardDownloadNoticeInput = Pick<BoardDownloadStateInput, 'enabled' | 'downloaded'> & {
  /** Snapshot I/O is actually injected for this build and feature-flag state. */
  snapshotSourceAvailable: boolean;
  /** Persisted count of transient snapshot-bootstrap failures for this scope. */
  bootstrapAttempts: number;
  /** Persisted once an artifact import succeeded for this scope. */
  isBootstrapDone: boolean;
  /** Persisted when the latest bootstrap decision selected the paged crawl. */
  isPagedFallback: boolean;
  /** A board-table checkpoint makes snapshot bootstrap ineligible after restart. */
  hasBoardCheckpoint: boolean;
  /** Durable per-scope completion, included in the same metadata batch. */
  isScopeComplete: boolean;
  /** Live snapshot import for this exact scope; it outranks any stale marker. */
  isBootstrapping: boolean;
  /** Live ordinary board-data pull for this exact scope. */
  isPagedDownloadActive: boolean;
};

/**
 * Explain a slow fresh download from durable SQLite facts, not transient progress
 * frames. A prior failed attempt must not survive a later successful snapshot
 * import or a completed paged download; likewise stale markers are irrelevant
 * when this build has no snapshot source and always uses the ordinary crawl.
 */
export function boardDownloadNotice(input: BoardDownloadNoticeInput): BoardDownloadNotice {
  if (
    !input.enabled ||
    input.downloaded ||
    input.isScopeComplete ||
    !input.snapshotSourceAvailable ||
    input.isBootstrapDone ||
    input.isBootstrapping
  )
    return null;
  if (
    input.isPagedFallback ||
    input.bootstrapAttempts >= MAX_BOOTSTRAP_ATTEMPTS ||
    ((input.hasBoardCheckpoint || input.isPagedDownloadActive) && input.bootstrapAttempts > 0)
  )
    return 'paged-fallback';
  return input.bootstrapAttempts > 0 ? 'snapshot-retrying' : null;
}
