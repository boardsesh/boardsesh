// Pure derivation of a board's offline download state from the settings + live
// sync status. Kept renderer-free so the My Boards screen can compute one state
// per row without each row subscribing to the sync store, and so it can be tested.

import type { SyncProgress } from '@boardsesh/offline-sync';

export type BoardDownloadState =
  | 'off' // not made available offline
  | 'pending' // enabled but not yet pulled (e.g. enabled while offline)
  | 'downloading' // the pull is fetching this exact board right now
  | 'finalizing' // snapshot imported; shared work is running before scope completion
  | 'downloaded'; // a sync cycle has completed since it was enabled

/**
 * A persisted explanation for an in-progress offline download. This is kept
 * separate from BoardDownloadState: the download still has the same pending /
 * downloading / finalizing lifecycle, but a failed snapshot bootstrap changes
 * what the user should expect next.
 */
export type BoardDownloadNotice = 'snapshot-retrying' | 'paged-fallback' | null;

export type BoardDownloadStateInput = {
  /** Encoded scope key of the board ("boardType:layoutId:sizeId"). */
  scopeKey: string;
  /** Whether this scope key is in syncEnabledBoards. */
  enabled: boolean;
  /** Durable marker set only after this scope's snapshot artifact imports successfully. */
  isBootstrapDone: boolean;
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
   * From useSyncStatus().progress?.phase: which pull phase is running. This
   * distinguishes the snapshot-bootstrap warm-up (currentTable is the bare
   * scope key) and active phases that are finalizing an imported sibling scope
   * from an idle or absent progress frame.
   * Undefined/null is treated as neither bootstrapping nor finalizing — the
   * paged-crawl match below still applies.
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
 * after another already synced never reads as downloaded before its own scope
 * completes. Once a snapshot has imported, work on the rest of the cycle is
 * surfaced as "finalizing" instead of making that download look queued again.
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
  if (input.isSyncing && input.isBootstrapDone && input.phase != null && input.phase !== 'idle') {
    return 'finalizing';
  }
  return 'pending';
}

/**
 * Which offline empty state a catalog screen should show for the active board.
 *
 * `null` means there is no offline story to tell — the catalog is here, or
 * there is no board to talk about — and the screen falls through to whatever
 * empty state it would have shown anyway.
 */
export type OfflineCatalogState =
  /** Nothing on the phone and nothing asked for: offer the download. */
  | 'missing'
  /** The user already asked; it lands on the next reconnect. */
  | 'queued'
  | null;

export type OfflineCatalogStateInput = {
  /** The active board's scope key, or `null` when there is no active board. */
  scopeKey: string | null;
  /** `getSetting('syncEnabledBoards')`. */
  enabledScopeKeys: readonly string[];
  /** `useDownloadedScopeKeys()`, still loading as `undefined`. */
  downloadedScopeKeys: readonly string[] | undefined;
};

/**
 * Derived from `boardDownloadState` with the same "no live sync frame" inputs
 * the nudge gate uses, and that agreement is the point: the download CTA hides
 * itself the moment the scope leaves `'off'`, so a screen that kept asking
 * "is it downloaded?" would show the offer-the-download copy with the offer
 * already gone — the dead end the CTA was added to remove, one tap later.
 */
export function offlineCatalogState(input: OfflineCatalogStateInput): OfflineCatalogState {
  if (input.scopeKey === null) return null;
  const state = boardDownloadState({
    scopeKey: input.scopeKey,
    enabled: input.enabledScopeKeys.includes(input.scopeKey),
    isBootstrapDone: false,
    downloaded: (input.downloadedScopeKeys ?? []).includes(input.scopeKey),
    isSyncing: false,
    currentTable: null,
  });
  if (state === 'downloaded') return null;
  return state === 'off' ? 'missing' : 'queued';
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

/**
 * What the downloading row should say, and how far to fill its bar (issue
 * #4311). Every byte figure here is WIRE scale — the same number the
 * enable-confirm dialog quoted — because the engine only ever puts wire-scale
 * numbers on the frame in the first place.
 */
export type BoardDownloadProgress = {
  stage: 'manifest' | 'download' | 'import';
  /** 0..1, or null when no honest denominator exists (byte counter, no bar). */
  fraction: number | null;
  /** Bytes downloaded so far, wire scale. Null before the first byte frame. */
  bytesDone: number | null;
  /** The artifact's wire size. Null while the manifest is still resolving. */
  bytesTotal: number | null;
};

export type BoardDownloadProgressInput = Pick<
  BoardDownloadStateInput,
  'scopeKey' | 'isSyncing' | 'phase' | 'currentTable'
> & {
  /** From useSyncStatus().progress?.snapshot — the live frame, whichever scope it names. */
  snapshot?: SyncProgress['snapshot'];
  /**
   * `useOfflineDownloadProgressEnabled()`. Required for compatibility with the
   * row API; the native hook is permanently true now that every snapshot uses a
   * progress-capable DownloadTask.
   */
  progressEnabled: boolean;
};

/**
 * Null for every row except the one actually downloading. Keyed on the frame's
 * OWN `scopeKey` as well as the phase/currentTable match, so a sibling size
 * (kilter:1:50 next to kilter:1:5) can never pick up its neighbour's numbers —
 * and so every other row's prop stays a stable `null` and its memo holds while
 * the downloading row re-renders.
 */
export function boardDownloadProgress(input: BoardDownloadProgressInput): BoardDownloadProgress | null {
  if (!input.progressEnabled) return null;
  if (!input.isSyncing) return null;
  if (!isBootstrappingThisScope(input)) return null;
  const frame = input.snapshot;
  if (!frame || frame.scopeKey !== input.scopeKey) return null;
  return {
    stage: frame.stage,
    fraction: frame.fraction,
    bytesDone: frame.wireBytesDone,
    bytesTotal: frame.wireBytes,
  };
}

export type BoardDownloadNoticeInput = Pick<BoardDownloadStateInput, 'enabled' | 'downloaded'> & {
  /** Snapshot I/O is actually injected for this build and feature-flag state. */
  snapshotSourceAvailable: boolean;
  /** Persisted count of snapshot-bootstrap failures for this scope (any kind). */
  bootstrapAttempts: number;
  /**
   * Both snapshot retry budgets are spent (issue #4313): this board is on the
   * slow crawl until the climber asks for another go or removes it.
   */
  isTerminal: boolean;
  /** Epoch ms of the next scheduled snapshot attempt, or null when none is pending. */
  retryAfter: number | null;
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
  // Once the ordinary crawl is visibly active, describe the work happening now
  // and let the row show its live count. Keeping a future snapshot-retry caption
  // here hid a real 500-row crawl behind a static spinner, making progress look
  // wedged even though rows were landing.
  if (
    input.isPagedDownloadActive &&
    (input.isTerminal || input.isPagedFallback || input.retryAfter !== null || input.bootstrapAttempts > 0)
  ) {
    return 'paged-fallback';
  }
  // A settled scope is the only permanent verdict now. Outside an active crawl,
  // a scheduled retry keeps the softer "we'll try the fast download again"
  // caption because that is exactly what will happen.
  if (input.isTerminal) return 'paged-fallback';
  if (input.retryAfter !== null) return 'snapshot-retrying';
  if (input.isPagedFallback) return 'paged-fallback';
  return input.bootstrapAttempts > 0 ? 'snapshot-retrying' : null;
}
