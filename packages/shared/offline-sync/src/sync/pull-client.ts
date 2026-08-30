import type { OfflineDatabase, QueryInvalidator, SqlValue } from '../database';
import type { SyncCursorInput, SyncResult, SyncDeletionsResult } from '../types';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './table-config';
import {
  getCheckpoint,
  setCheckpoint,
  getCheckpointKey,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  markScopeDownloadStarted,
  isScopeDownloadStarted,
  ensureScopeDownloadStartedAt,
  SCOPE_DOWNLOAD_START_MAX_AGE_MS,
  DELETIONS_CHECKPOINT_KEY,
} from './checkpoints';
import { markUserDataComplete } from './local-user-owner';
import {
  bootstrapScopeFromSnapshot,
  bootstrapScopeGradesFromSnapshot,
  getGradesBootstrapAttempts,
  recordGradesBootstrapAttempt,
  MAX_GRADES_BOOTSTRAP_ATTEMPTS,
  markBootstrapDone,
  isBootstrapDone,
  wasBootstrapHealed,
  getReusedImportFailure,
  recordReusedImportFailure,
  clearReusedImportFailure,
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
  type SnapshotSource,
  type SnapshotArtifactHandle,
  type SnapshotBootstrapErrorReport,
  type SnapshotBootstrapErrorReporter,
} from './snapshot-bootstrap';
import { classifySnapshotBootstrapFailure, type SnapshotBootstrapFailureReason } from './bootstrap-failure-reason';
import { createDownloadFunnelGuard } from './download-funnel-guard';
import { noteScopeDownloadTerminal } from './download-terminal-registry';
import {
  classifyBootstrapFailure,
  clearBootstrapPagedFallback,
  clearTransportFailures,
  deferHeal,
  evaluateBootstrapEligibility,
  isTerminal,
  markBootstrapPagedFallback,
  nextRetryState,
  readBootstrapRetryState,
  rearmForNewArtifact,
  recordBackgroundPause,
  shouldSkipPagedPull,
  spendUserRequest,
  writeBootstrapRetryState,
  type BootstrapFailureKind,
  type BootstrapRetryState,
} from './bootstrap-retry';
import {
  parseSnapshotManifest,
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from './snapshot-manifest';
import { findSnapshotEntry, isSnapshotEntryUsable } from './snapshot-estimate';
import {
  createDownloadFractionAnchor,
  createSnapshotProgressThrottle,
  resolveDownloadFraction,
  toWireProgress,
  type DownloadFractionAnchor,
  type SnapshotBootstrapProgress,
} from './snapshot-progress';
import {
  evaluateDeletionsCoverage,
  getDeletionsCoverageAt,
  setDeletionsCoverageAt,
  resetUserDataForLostCoverage,
} from './deletions-coverage';
import { applyBusyTimeout } from '../db/pragmas';
import { classifySqliteLockError } from '../db/lock-errors';
import { getPendingCount } from '../mutation-queue/queue';
import { isNetworkError } from '../mutation-queue/error-classification';
import {
  isSigningOut,
  isBackgrounded,
  onTeardown,
  capturePurgeToken,
  getWipeEpoch,
  hasPurgeLanded,
  type PurgeToken,
} from '../mutation-queue/drainer';
import {
  parseOfflineBoardKey,
  purgeNamespaceKey,
  purgeNamespaceForScopeKey,
  type OfflineBoardScope,
} from '../offline-board-key';

/**
 * Telemetry hook for schema drift: a sync document carried a column the local
 * allowlist doesn't know. The app adapter reports it (mobile → Sentry, tags
 * source: 'offline-sync', kind: 'schema-drift'); tests and headless callers omit it.
 */
export type SchemaDriftReporter = (drift: { tableName: string; column: string }) => void;

/**
 * What a report site inside the bootstrap phase supplies. `reason` and `aborted`
 * are filled in by the wrapper in `runBootstrapPhase`, so an arm with nothing
 * special to say about either simply leaves them out.
 */
type BootstrapErrorInput = Omit<SnapshotBootstrapErrorReport, 'reason' | 'aborted'> &
  Partial<Pick<SnapshotBootstrapErrorReport, 'reason' | 'aborted'>>;

export type SyncProgress = {
  phase: 'bootstrap' | 'user_data' | 'board_data' | 'deletions' | 'idle';
  currentTable: string | null;
  documentsProcessed: number;
  /**
   * Rows processed for the current table only (resets per table), so a per-board
   * download can show its own live count. Undefined for phases without a table.
   */
  currentTableProcessed?: number;
  /**
   * Set on the terminal idle frame the SCHEDULER emits after a cycle threw —
   * it still clears the in-flight UI state, but must not stamp lastSyncedAt
   * (the cycle did not complete). pullSync's own success idle omits it.
   */
  failed?: boolean;
  /**
   * Set when an expected lifecycle guard ended the cycle (background, sign-out,
   * purge, or lost connectivity). Like `failed`, it clears live UI without
   * claiming the cycle reached the sync tail.
   */
  interrupted?: boolean;
  /**
   * Live snapshot download/import detail (issue #4311). Only ever attached to a
   * `phase: 'bootstrap'` frame whose `currentTable` IS the scope key it
   * describes, so a row matches it exactly the way it already matches the
   * bootstrapping flag. Never present on the phase's own `currentTable: null`
   * frame, nor on the terminal idle frame, and the throttle behind it is
   * cancelled before the phase ends — so no late frame can re-light a row whose
   * download already finished.
   */
  snapshot?: SnapshotBootstrapProgress;
};

/**
 * Where a board scope's initial download actually spent its time, split by
 * phase, so `Offline Board Download Completed` can answer "is the 100 MB
 * artifact the problem, or the paged crawl behind it?" (issue #4310) without
 * minting a second event.
 *
 * SCOPED TO THE CYCLE THAT COMPLETED THE DOWNLOAD. `durationMs` spans cycles
 * (it is persisted), the breakdown does not: a scope whose artifact imported on
 * Monday and whose delta pull finished on Tuesday reports Tuesday's crawl time
 * with zeros for manifest/download/import. Read the phases as "where this
 * cycle's time went", not as a partition of `durationMs`.
 *
 * The ROW COUNTS below are OPTIONAL rather than zeroed for exactly that reason
 * (issue #4393): a timing this cycle did not spend really is 0ms of this cycle's
 * time, but a row count this cycle cannot vouch for is not 0 rows — it is
 * unknown, and a fabricated 0 reads as "this board has no grades".
 */
export type ScopeDownloadPhaseBreakdown = {
  /** Resolving the manifest. 0 for every scope after the first in a cycle (it is cached per run). */
  manifestMs: number;
  /** Fetching the artifact. 0 when it was reused from disk or shared with another size of the layout. */
  downloadMs: number;
  /**
   * ATTACH + verify + reconcile + the row batches + the checkpoint transaction.
   *
   * NOT A LOCK HOLD, and never was: most of it is autocommit work — the ATTACH,
   * `PRAGMA quick_check` over the whole artifact, `verifySnapshotMeta`'s two full
   * `COUNT(*)` truncation checks, and the scoped watermark reads. Two in-repo
   * retry ladders were once sized as if this number were a lock hold; see
   * db/write-retry.ts. `importLockMaxMs` is the hold.
   */
  importMs: number;
  /** Stored (possibly gzip) size of the artifact this scope imported; 0 when none. */
  artifactBytes: number;
  /** The artifact came off disk from an earlier cycle — no bytes crossed the network. */
  artifactReused: boolean;
  /** Paged GraphQL crawl time per board table, the term the artifact does NOT cover. */
  climbsPullMs: number;
  statsPullMs: number;
  gradesPullMs: number;
  /**
   * Rows the PAGED grades crawl consumed this cycle — the denominator for
   * `gradesPullMs`. Present iff this cycle's crawl started from a cursor no
   * EARLIER cycle advanced: either no grades checkpoint existed, or the only one
   * that existed was stamped by this cycle's own grades artifact.
   *
   * ABSENT (never 0) when the crawl resumed from an earlier cycle's checkpoint.
   * The rows those cycles wrote are not counted here, so any number would be a
   * silent under-report — the same reason `downloadMs`/`importMs` go absent on
   * a completion whose import landed in an earlier cycle.
   *
   * Known imprecision on a HEALED scope (#4313 — an artifact imported over a
   * partly-crawled catalog): both arms can be true at once, so this counts only
   * this cycle's crawl above the artifact watermark while earlier cycles' grade
   * rows go unreported. `bootstrapHealed` is the filter for that population.
   */
  gradesRows?: number;
  /**
   * Rows this cycle's grades-artifact import wrote (`INSERT OR REPLACE`
   * changes). Absent when no grades artifact imported this cycle: no
   * `entry.grades` in the manifest, no `source.downloadGradesArtifact`, an
   * unusable or attempt-exhausted artifact, or the import landed in an earlier
   * cycle.
   *
   * This is what makes a `gradesRows: 0` readable. The artifact stamps the
   * grades checkpoint mid-cycle, so the delta crawl behind it legitimately
   * consumes 0 rows: `gradesRows: 0` next to `gradesArtifactRows: 41232` means
   * the artifact did the work, while `gradesRows: 0` with no
   * `gradesArtifactRows` means the scope genuinely has no grade rows. Grade rows
   * landed this cycle = `(gradesArtifactRows ?? 0) + (gradesRows ?? 0)`,
   * meaningful only when at least one of the two is present.
   */
  gradesArtifactRows?: number;
  /**
   * The whole-layout import, split (issue #4310). ABSENT — never 0 — on any
   * cycle that ran no import, which is most of them: a completion whose artifact
   * landed in an EARLIER cycle did not spend this time, and a fabricated 0 next
   * to the absent-when-unknown `importMs` would read as a real measurement of a
   * fast import. events.ts states the rule outright ("Read a missing value as
   * UNKNOWN, never as 0") and names #4393's `gradesRows: 0` as the precedent.
   * Every query over THESE SIX must filter on `importMs IS NOT NULL`;
   * unfiltered, the p90 is dominated by the cycles that imported nothing. That
   * filter does NOT extend to the three `grades*` fields below — see their doc.
   *
   *  - `importVerifyMs`    ATTACH + quick_check + meta verify + watermarks, all
   *                        in autocommit holding no lock.
   *  - `importReconcileMs` the (still unbatched) reconcile transaction, MINUS
   *                        its lock-acquisition wait.
   *  - `importRowsMs`      the batch loop end to end, keyset probes included,
   *                        MINUS the batches' lock-acquisition waits.
   *  - `importLockMaxMs`   THE METRIC. The longest SINGLE exclusive hold —
   *                        reconcile, any row batch, or the checkpoint
   *                        transaction — i.e. the worst case a concurrent user
   *                        write has to survive (#4314). Stamped from after
   *                        `BEGIN EXCLUSIVE` succeeds, so it is a hold and never
   *                        a wait. Its tail includes the WAL autocheckpoint some
   *                        batches pay inside their COMMIT; see
   *                        SNAPSHOT_IMPORT_BATCH_ROWS.
   *  - `importLockWaitMs`  the other side of that: total time spent waiting for
   *                        `BEGIN EXCLUSIVE` (busy_timeout blocking plus the
   *                        retry ladder's sleeps). Non-zero means the import met
   *                        real contention in the field.
   */
  importVerifyMs?: number;
  importReconcileMs?: number;
  importRowsMs?: number;
  importLockMaxMs?: number;
  importLockWaitMs?: number;
  /** Exclusive transactions the row import committed. Absent when no import ran. */
  importBatches?: number;
  /**
   * The grades artifact's own transfer and import, previously invisible to this
   * breakdown entirely — `importGradesForScope` runs its own download and its
   * own exclusive transaction and neither added to `downloadMs`/`importMs`,
   * which is most of the ~11s p50 residual between `durationMs` and the sum of
   * the other phases. Same absent-when-unknown rule: no grades artifact imported
   * this cycle means no key, not a zero.
   *
   * `gradesLockMs` is the grades import's exclusive hold. It is still ONE
   * unbatched transaction, so it is reported next to `importLockMaxMs` rather
   * than folded into it.
   *
   * DO NOT filter these three on `importMs IS NOT NULL`. `importGradesForScope`
   * has a second call site — the retrofit path for a scope that is already
   * bootstrapped or complete but holds no grades checkpoint — which downloads and
   * imports grades in a cycle where no whole-layout import ran, so `importMs` is
   * absent and these three are present. That is exactly the still-crawling
   * population #4719 exists to characterise, so the `importMs` filter would
   * exclude the cycles `gradesLockMs` is most needed for. Each of the three is
   * absent-when-unknown on its own, so its own `IS NOT NULL` is the filter.
   */
  gradesDownloadMs?: number;
  gradesVerifyMs?: number;
  gradesLockMs?: number;
};

/**
 * A zeroed breakdown: what a scope reports before any phase has run.
 * `gradesRows`, `gradesArtifactRows` and every `import*` / `grades*Ms` timing are
 * deliberately ABSENT rather than 0 — see their docs.
 */
export function emptyScopeDownloadPhases(): ScopeDownloadPhaseBreakdown {
  return {
    manifestMs: 0,
    downloadMs: 0,
    importMs: 0,
    artifactBytes: 0,
    artifactReused: false,
    climbsPullMs: 0,
    statsPullMs: 0,
    gradesPullMs: 0,
  };
}

/**
 * Fired once a board scope's initial download completes this cycle (every
 * BOARD_DATA_TABLES entry reached its tail — the same gate as
 * `markScopeDownloadComplete`). Lets the app compare the two download paths in
 * the field: `method` is `'snapshot'` when a bootstrap warm-up ever succeeded
 * for this scope (the persisted `isBootstrapDone` marker — the import and the
 * completing delta pull may land in different cycles when connectivity drops
 * between them), `'paged'` otherwise (fresh paged crawl, a resumed mid-crawl
 * scope, or bootstrap unavailable/exhausted).
 * `durationMs` is measured from when this pullSync cycle FIRST touched the
 * scope — a snapshot-eligible scope is stamped at its bootstrap eligibility
 * check (so the duration includes its manifest/download/import time, not just
 * the trailing delta pull), a paged-only scope at its turn in the board-data
 * loop. Per-scope stamping keeps a multi-board cycle honest: scope B's
 * duration never includes scope A's download time, so `'snapshot'` vs
 * `'paged'` percentiles stay apples-to-apples.
 *
 * Since issue #4310 the start stamp is PERSISTED in sync_meta rather than held
 * in a per-run Map, so a download spanning several cycles reports its whole
 * lifetime instead of only the final cycle's slice. Two consequences worth
 * knowing before reading the series: durations recorded before that change are
 * systematic under-reports and are not comparable to later ones, and a stamp
 * older than SCOPE_DOWNLOAD_START_MAX_AGE_MS yields `durationMs: null` (a
 * device that was simply closed for a week is not a week-long download).
 */
export type ScopeDownloadCompleteInfo = {
  scopeKey: string;
  method: 'snapshot' | 'paged';
  /**
   * NOTE for path comparisons: a scope that was HEALED (an artifact imported
   * over a partly-crawled catalog, issue #4313) reports `method: 'snapshot'` but
   * a duration that EXCLUDES the paged work earlier cycles already did. Filter on
   * `bootstrapHealed` before comparing snapshot-vs-paged percentiles.
   *
   * null when the persisted start stamp is too old to be a plausible duration.
   */
  durationMs: number | null;
  /** The snapshot import landed on a scope that had already crawled some rows. */
  bootstrapHealed?: boolean;
  /**
   * Wire size of the artifact this scope imported, and the rows it actually
   * wrote (issue #4316) — what a slow download has to be normalised against
   * before "Kilter is slow" means anything.
   *
   * All four are ABSENT rather than faked when the completing delta pull lands
   * in a LATER cycle than the import (the dropped-connection tail), because this
   * run has no record of work it did not do. That biases these props toward the
   * healthy population; `durationMs`, `method`, and the Started→Completed ratio
   * itself are unaffected.
   */
  bytes?: number;
  rowCount?: number;
  downloadMs?: number;
  importMs?: number;
  /** Where this cycle's time went. See ScopeDownloadPhaseBreakdown. */
  phases: ScopeDownloadPhaseBreakdown;
};
export type ScopeDownloadCompleteReporter = (info: ScopeDownloadCompleteInfo) => void;

/**
 * Fired ONCE EVER per board scope, the first time any cycle starts pulling it —
 * the missing anchor that makes abandonment measurable (issue #4316). Guarded by
 * a durable `scope-started:` marker, the mirror of the `scope-complete:` one, so
 * a retrying snapshot cannot emit twice and a multi-cycle paged crawl cannot be
 * skipped. Both markers are cleared by scope teardown, so removing and re-adding
 * a board starts a fresh funnel.
 *
 * `pathIntent` is an INTENT decided from cheap local facts at emission time, not
 * an outcome: a scope that looks snapshot-eligible can still fall back to the
 * paged crawl after the manifest resolves. Funnel splits by resolved path must
 * use Completed's `method`; reading `pathIntent` as ground truth would overstate
 * the snapshot population.
 *
 * `artifactBytes` is the wire size of the artifact about to be downloaded, and
 * is null on the paged path (a crawl has no byte total at all). It is on Started
 * precisely because an ABANDONED download never emits Completed — without it,
 * the size of the downloads people give up on is unknowable.
 */
export type ScopeDownloadStartInfo = {
  scopeKey: string;
  pathIntent: 'snapshot' | 'paged';
  artifactBytes: number | null;
};
export type ScopeDownloadStartReporter = (info: ScopeDownloadStartInfo) => void;

/**
 * Fired after one bootstrap scope reaches a coherent persisted decision (or is
 * found ineligible because an existing checkpoint already made that decision).
 * The callback runs before the next scope begins, so a UI can refresh scope A
 * while a slower scope B is still in the bootstrap phase instead of reusing the
 * cycle's pre-run metadata.
 */
export type BootstrapMetadataChangedInfo = { scopeKey: string };
export type BootstrapMetadataChangedReporter = (info: BootstrapMetadataChangedInfo) => void;

/**
 * Fired when the deletions-coverage guard forced a from-scratch user-data
 * resync (issue #3474) — the device went longer than the tombstone retention
 * window without completing a deletions pull, so tombstones it never saw may
 * already be pruned server-side.
 *
 * This is an EXPECTED operational event, not an error: its rate across the
 * fleet is the only thing anyone will ask about, which is why the mobile
 * adapter routes it to `track()` rather than Sentry. `markerAgeDays` is the age
 * of the coverage marker that tripped the guard, `rowsCleared` the number of
 * local user-data rows dropped, and `pendingMutations` the outbox depth at that
 * moment (which the reset leaves untouched — a non-zero value here is normal,
 * not a loss).
 */
export type CoverageResetInfo = {
  markerAgeDays: number;
  rowsCleared: number;
  pendingMutations: number;
};
export type CoverageResetReporter = (info: CoverageResetInfo) => void;

/**
 * Every deletions-coverage evaluation, not just the ones that force a reset.
 *
 * The reset event alone is a censored instrument. `enforceDeletionsCoverage`
 * returns early on `coverageAt === null`, and the marker only exists after a
 * COMPLETED deletions pull — so a device that can never finish one (the paged
 * crawl stranded in #4313, say) stays `unknown` forever and emits nothing. The
 * reset-only view therefore samples exactly the devices healthy enough not to
 * be at risk. Reporting the verdict for every cycle makes `unknown` a
 * first-class value and turns "zero resets" into evidence rather than a shrug.
 *
 * `markerAgeDays` is a number only for `fresh` and `stale`. It is null for
 * `unknown` (no marker at all, or one below the epoch floor — a phone that
 * booted to 1970) and for `future` (a marker dated after now, i.e. a clock
 * corrected backwards): the arithmetic still produces a value for those two,
 * but it is ~20,000 days or a negative number, and either would poison an
 * average over this property. `outcome: 'probe_failed'` is the reachability
 * probe rejecting on a stale device, which today vanishes into a dev-only
 * console.warn.
 */
export type CoverageEvaluatedInfo = {
  verdict: 'unknown' | 'future' | 'fresh' | 'stale';
  markerAgeDays: number | null;
  outcome: 'evaluated' | 'reset' | 'probe_failed';
};
export type CoverageEvaluatedReporter = (info: CoverageEvaluatedInfo) => void;

/**
 * Fired when a bootstrap failure schedules the scope's next snapshot attempt
 * (issue #4313). Operational, not an error — `onSnapshotBootstrapError` still
 * carries the failure itself at its existing severity. `terminal` means the
 * budget this failure spent is exhausted, so the scope has settled onto the paged
 * crawl until the user asks for a retry or removes the board.
 */
export type BootstrapRetryScheduledInfo = {
  scopeKey: string;
  boardType: string;
  stage: 'manifest' | 'download' | 'import';
  failureKind: BootstrapFailureKind;
  /** Milliseconds until the scheduled retry; 0 when the scope went terminal. */
  retryAfterMs: number;
  transportFailures: number;
  /**
   * Lock-contention import failures spent (issue #4310). Its own budget, so a
   * lost write-lock race can neither be laundered away by a retained artifact's
   * zero-byte "download" nor strand the board on two strikes as a bad artifact
   * would. Non-zero here is the field signal that batching made the import a
   * real contender for the write lock.
   */
  lockFailures: number;
  structuralFailures: number;
  terminal: boolean;
};
export type BootstrapRetryScheduledReporter = (info: BootstrapRetryScheduledInfo) => void;

/**
 * Internal scheduler signal for the absolute time at which a snapshot retry is
 * due. Unlike `BootstrapRetryScheduledInfo`, this is a lifecycle hook rather
 * than analytics: it is also emitted when a persisted cooldown is observed on
 * launch, so the scheduler can wake without waiting for foreground/reconnect.
 */
export type BootstrapRetryWakeInfo = {
  scopeKey: string;
  retryAt: number;
};
export type BootstrapRetryWakeReporter = (info: BootstrapRetryWakeInfo) => void;

/**
 * Fired when a scope that had previously failed the snapshot path gets back on
 * it — the measurement that tells us whether #4313's recovery actually reaches
 * stranded installs.
 */
export type BootstrapPathRecoveredInfo = {
  scopeKey: string;
  boardType: string;
  trigger: 'cooldown' | 'new-artifact' | 'legacy-migration' | 'user-request';
  /** True when this is a heal over a partly-crawled catalog, not a fresh scope. */
  hadBoardCheckpoint: boolean;
};
export type BootstrapPathRecoveredReporter = (info: BootstrapPathRecoveredInfo) => void;

export type SyncOptions = {
  /** Encoded board scope keys ("boardType:layoutId:sizeId") to download offline. */
  enabledBoards?: string[];
  /**
   * Connectivity probe, mirroring `DrainOptions.isOnline` (drainer.ts). A pull
   * that starts with no connection can only fail every request it makes, and
   * the snapshot bootstrap phase would report each enabled-but-undownloaded
   * scope's manifest failure as telemetry on the way (issue #4238).
   *
   * DEFAULTS TO `() => true`, so every existing caller — web included — behaves
   * exactly as it did before this seam existed. Only the mobile adapter injects
   * a real probe (React Query's onlineManager, wired to NetInfo).
   */
  isOnline?: () => boolean;
  onProgress?: (progress: SyncProgress) => void;
  onSchemaDrift?: SchemaDriftReporter;
  /**
   * Injected snapshot I/O. When present, an eligible fresh board scope is warmed
   * from a pre-built artifact before the paged crawl (see the bootstrap phase in
   * pullSync). Omitted → behaviour is identical to a pure paged pull.
   */
  snapshotSource?: SnapshotSource;
  /** Telemetry for a counted bootstrap failure (manifest/download/import). */
  onSnapshotBootstrapError?: SnapshotBootstrapErrorReporter;
  /** UI invalidation after each scope's persisted bootstrap decision settles. */
  onBootstrapMetadataChanged?: BootstrapMetadataChangedReporter;
  /** Telemetry for comparing the snapshot vs paged download paths. See ScopeDownloadCompleteInfo. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
  onScopeDownloadStart?: ScopeDownloadStartReporter;
  /** Telemetry for a forced deletions-coverage resync. See CoverageResetInfo. */
  onCoverageReset?: CoverageResetReporter;
  /**
   * Telemetry for EVERY deletions-coverage evaluation. Fires once per pullSync
   * cycle with no interval of its own — dedupe belongs in the platform binding,
   * so the engine seam stays deterministic and testable.
   */
  onCoverageEvaluated?: CoverageEvaluatedReporter;
  /** Telemetry for a scheduled snapshot retry (issue #4313). */
  onBootstrapRetryScheduled?: BootstrapRetryScheduledReporter;
  /** Scheduler lifecycle hook; may repeat and must not be treated as analytics. */
  onBootstrapRetryDue?: BootstrapRetryWakeReporter;
  /** Clears a stale scheduler deadline once a scope no longer has a cooldown. */
  onBootstrapRetryCleared?: (scopeKey: string) => void;
  /** Telemetry for a scope getting back onto the snapshot path (issue #4313). */
  onBootstrapPathRecovered?: BootstrapPathRecoveredReporter;
  /**
   * Whether the device is on an unmetered link. Consulted for ONE decision: the
   * automatic heal of a partly-crawled scope, which is a ~100 MB download the
   * user did not ask for today. A fresh bootstrap (they just enabled the board,
   * behind a size-disclosing confirm) and a user-requested retry both ignore it.
   *
   * May be async: a platform whose connectivity read is a promise (React
   * Native's NetInfo) would otherwise have to answer from a listener that has
   * not fired yet on a cold launch, and answer "unmetered" for the very first
   * cycle — the one that starts a ~100 MB heal over cellular.
   *
   * DEFAULTS TO `() => true`, so web and every existing caller are unchanged.
   */
  isOnUnmeteredNetwork?: () => boolean | Promise<boolean>;
  /**
   * Wall clock for the bootstrap retry ladder and progress throttle. Injected so
   * both schedules are testable without fake timers fighting the SQLite double.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /** Jitter source for the retry ladder. Defaults to `Math.random`. */
  random?: () => number;
};

/** A per-board download target: the parsed scope plus its encoded key. */
type BoardScope = OfflineBoardScope & { scopeKey: string };

const PAGE_LIMIT = 500;

// One schema-drift report per (table, column) per app launch — a 500-row page
// must not emit 500 identical telemetry events.
const reportedUnknownSyncColumns = new Set<string>();

function buildSyncQuery(queryName: string, isPerBoard: boolean): string {
  // Per-board pulls carry the board type plus optional layout/size scope so a
  // downloaded board is a fixed (boardType, layout, size) superset — all sets.
  // layoutId/sizeId are nullable server-side, so passing them undefined is a no-op.
  const boardScopeParam = isPerBoard ? '$boardType: String!, $layoutId: Int, $sizeId: Int, ' : '';
  const boardScopeArg = isPerBoard ? 'boardType: $boardType, layoutId: $layoutId, sizeId: $sizeId, ' : '';
  return `
    query ${queryName[0].toUpperCase()}${queryName.slice(1)}(${boardScopeParam}$cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
      ${queryName}(${boardScopeArg}cursor: $cursor, limit: $limit) {
        documents
        cursor {
          updatedAt
          syncSeq
        }
        hasMore
      }
    }
  `;
}

const SYNC_DELETIONS_QUERY = `
  query SyncDeletions($cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
    syncDeletions(cursor: $cursor, limit: $limit) {
      deletions {
        tableName
        recordId
        deletedAt
      }
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

// SQLite's default compile-time limit on bound parameters per statement
// (SQLITE_MAX_VARIABLE_NUMBER's pre-3.32 default, still the safe floor across
// the SQLite builds we run on — bundled iOS/Android sqlite3, node:sqlite).
// Batching must never bind more than this per INSERT.
const SQLITE_MAX_BIND_VARIABLES = 999;

/**
 * Coerces a synced document value to what the SQLite bridge accepts:
 * booleans as 0/1 (SQLite has no BOOLEAN type), Date values as ISO strings,
 * objects/arrays as their JSON string (frames, characteristics, etc. are stored
 * as TEXT), null/undefined as NULL (undefined means "document omitted this
 * column" — same bind as an explicit null), everything else passed through
 * unchanged. Exported so the snapshot export job can reuse the exact same
 * coercion off the same synced documents without re-deriving it.
 */
export function toSqliteValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SqlValue;
}

/**
 * How many rows fit in one multi-row `INSERT OR REPLACE ... VALUES (...),(...)`
 * statement without exceeding SQLite's bound-parameter ceiling. Always at
 * least 1 (a table wider than the ceiling still gets one row per statement —
 * it just can't batch).
 */
export function multiRowChunkSize(columnCount: number): number {
  return Math.max(1, Math.floor(SQLITE_MAX_BIND_VARIABLES / columnCount));
}

function buildMultiRowInsertSql(tableName: string, columns: readonly string[], rowCount: number): string {
  const columnList = columns.join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const valuesClause = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
  return `INSERT OR REPLACE INTO ${tableName} (${columnList}) VALUES ${valuesClause}`;
}

async function upsertDocuments(
  db: OfflineDatabase,
  tableName: string,
  documents: Record<string, unknown>[],
  allowedColumns: readonly string[],
  onSchemaDrift?: SchemaDriftReporter,
): Promise<void> {
  if (documents.length === 0) return;

  // Unknown columns are SKIPPED, not fatal: the backend deploys before OTA
  // clients update, so a newly-added server column must not brick every older
  // client's sync loop. SQL safety is unaffected — the statement's column list
  // below is derived from the allowlist intersection, never from document keys.
  // Drift still surfaces in telemetry (once per table+column per app launch),
  // so a resolver emitting a misnamed column stays observable.
  const allowedColumnSet = new Set(allowedColumns);
  for (const document of documents) {
    const unknownColumns = Object.keys(document).filter((column) => !allowedColumnSet.has(column));
    for (const unknownColumn of unknownColumns) {
      const driftKey = `${tableName}.${unknownColumn}`;
      if (reportedUnknownSyncColumns.has(driftKey)) continue;
      reportedUnknownSyncColumns.add(driftKey);
      onSchemaDrift?.({ tableName, column: unknownColumn });
    }
  }

  // Columns are the union of allowed columns present anywhere in the page (not
  // per-document) — this was already true before batching, since this filter
  // ran once over the whole `documents` array. Batching depends on it: every
  // row in a multi-row VALUES clause must bind the same column list. A
  // document missing a page-wide column binds NULL for it below, same as the
  // single-row INSERT OR REPLACE did (INSERT OR REPLACE still does a whole-row
  // replace, so this matches today's semantics, not just today's SQL shape).
  const columns = allowedColumns.filter((column) =>
    documents.some((document) => Object.prototype.hasOwnProperty.call(document, column)),
  );
  if (columns.length === 0) {
    throw new Error(`Sync document for ${tableName} did not contain any allowed columns`);
  }

  const chunkSize = multiRowChunkSize(columns.length);
  // At most two distinct row counts occur in a page (full chunks + a smaller
  // final chunk), so caching the built SQL by row count avoids rebuilding the
  // same multi-row VALUES string for every full chunk.
  const sqlByRowCount = new Map<number, string>();
  const sqlForRowCount = (rowCount: number): string => {
    let sql = sqlByRowCount.get(rowCount);
    if (!sql) {
      sql = buildMultiRowInsertSql(tableName, columns, rowCount);
      sqlByRowCount.set(rowCount, sql);
    }
    return sql;
  };

  // One exclusive transaction per page (≤ PAGE_LIMIT rows): a big board pull is
  // thousands of pages, and a per-50-row transaction multiplied every page's
  // commit overhead by 10 while giving the drainer no meaningful extra window —
  // it can interleave between pages either way.
  await db.withExclusiveTransactionAsync(async (transaction) => {
    // This page's insert runs on its own connection (busy_timeout defaults to 0);
    // wait for a held lock instead of losing the whole page to an instant SQLITE_BUSY.
    await applyBusyTimeout(transaction);
    for (let chunkStart = 0; chunkStart < documents.length; chunkStart += chunkSize) {
      const chunk = documents.slice(chunkStart, chunkStart + chunkSize);
      const values: SqlValue[] = [];
      for (const document of chunk) {
        for (const column of columns) {
          values.push(toSqliteValue(document[column]));
        }
      }
      await transaction.runAsync(sqlForRowCount(chunk.length), values);
    }
  });
}

async function syncTable(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  tableName: string,
  /** The purge token pullSync captured at CYCLE start — see `cycleAborted` there. */
  purgeToken: PurgeToken,
  boardScope?: BoardScope,
  onProgress?: (documentsProcessed: number) => void,
  onSchemaDrift?: SchemaDriftReporter,
): Promise<{ reachedTail: boolean; rowsProcessed: number; resumedFromCheckpoint: boolean }> {
  const config = TABLE_CONFIGS[tableName];
  if (!config) throw new Error(`No sync config for table: ${tableName}`);

  // Derived ONCE here rather than at each guard, and from `boardScope` rather
  // than from a caller argument, so there is exactly one place a board-scoped
  // call could forget it (a forgotten namespace degrades to global-only, i.e.
  // no abort). `undefined` for a user table is the correct answer, not an
  // omission: a board purge can never invalidate boardsesh_ticks.
  const purgeKey = boardScope ? purgeNamespaceKey(boardScope) : undefined;

  const checkpointKey = getCheckpointKey(tableName, boardScope?.scopeKey);
  const checkpoint = await getCheckpoint(db, checkpointKey);
  // Whether some earlier call already advanced this cursor, so the caller can
  // tell "these are all the rows" from "these are the tail of a crawl someone
  // else started" (issue #4393). Sound because `setCheckpoint` below only runs
  // after a NON-EMPTY page: a table that genuinely never had rows never leaves
  // a checkpoint behind.
  const resumedFromCheckpoint = checkpoint !== null;
  const query = buildSyncQuery(config.queryName, config.isPerBoard);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;

  // The signing-out boolean is only true for the milliseconds the wipe takes;
  // a page fetch in flight across that window sees `false` on both sides and
  // would write the old user's rows (and checkpoints!) back into the wiped DB
  // — a cross-account leak, plus checkpoints past the new user's data. The
  // epoch is monotonic, so comparing it catches a wipe that started AND
  // finished while we were awaiting the network.
  //
  // The token compared against is the CYCLE's, passed in — never one captured
  // here. Capturing locally would make each table re-baseline against the
  // post-purge value and carry on, so a purge would only ever abort whichever
  // table happened to be mid-flight (see `cycleAborted` in pullSync).

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || hasPurgeLanded(purgeToken, purgeKey) || isBackgrounded())
      return { reachedTail: false, rowsProcessed: totalProcessed, resumedFromCheckpoint };
    const variables: Record<string, unknown> = { cursor, limit: PAGE_LIMIT };
    if (config.isPerBoard && boardScope) {
      variables.boardType = boardScope.boardType;
      variables.layoutId = boardScope.layoutId;
      variables.sizeId = boardScope.sizeId;
    }

    const response = await graphqlFetch<Record<string, SyncResult>>(query, variables);
    const result = response[config.queryName];

    // Re-check after the await: the wipe (or this scope's purge) may have
    // started AND fully completed while this page was on the wire. This is the
    // check that discards an in-flight page.
    if (isSigningOut() || hasPurgeLanded(purgeToken, purgeKey) || isBackgrounded())
      return { reachedTail: false, rowsProcessed: totalProcessed, resumedFromCheckpoint };

    // An empty page would not advance the cursor; if the backend ever returns
    // documents:[] with hasMore:true we'd spin forever. Stop here (I2).
    if (result.documents.length === 0) break;

    await upsertDocuments(db, tableName, result.documents, config.localColumns, onSchemaDrift);
    await setCheckpoint(db, checkpointKey, result.cursor);

    totalProcessed += result.documents.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  // Only bust caches when this table actually changed. Sync runs on every
  // foreground + reconnect, and an unconditional invalidation here refetches
  // every active climb/logbook/playlist query over the network even when zero
  // rows moved (matching processDeletions, which only invalidates on arrivals).
  if (totalProcessed > 0) {
    for (const key of config.invalidateKeys) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }

  // Both loop exits here mean the server has nothing more for this cursor:
  // hasMore === false, or an empty page (the tail). Aborts return early above.
  return { reachedTail: true, rowsProcessed: totalProcessed, resumedFromCheckpoint };
}

async function processDeletions(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  /** The purge token pullSync captured at CYCLE start — see `cycleAborted` there. */
  purgeToken: PurgeToken,
  onProgress?: (documentsProcessed: number) => void,
): Promise<{ reachedTail: boolean }> {
  const checkpointKey = DELETIONS_CHECKPOINT_KEY;
  const checkpoint = await getCheckpoint(db, checkpointKey);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  const epochCursor: SyncCursorInput = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
  let totalProcessed = 0;

  class DeletionPageAbortedError extends Error {}

  // See syncTable: catch a wipe that ran while a page was on the wire, and why the
  // token is the cycle's rather than one captured here.
  //
  // GLOBAL, no namespace: the tombstone stream and its cursor are user-wide, and
  // removeBoardScopeData touches neither. A board removal must not stop this.

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || hasPurgeLanded(purgeToken) || isBackgrounded()) return { reachedTail: false };
    const response = await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, {
      cursor,
      limit: PAGE_LIMIT,
    });
    const result = response.syncDeletions;

    if (isSigningOut() || hasPurgeLanded(purgeToken) || isBackgrounded()) return { reachedTail: false };

    // Empty page can't advance the cursor; break to avoid an infinite loop if
    // the backend returns deletions:[] with hasMore:true (I2).
    if (result.deletions.length === 0) break;

    // Apply one fetched page and its cursor atomically. The old one-autocommit-
    // per-tombstone path made a large replay expensive and exposed a crash gap:
    // some rows could be deleted while the page checkpoint stayed behind. One
    // exclusive transaction gives SQLite one lock/commit per page and ensures a
    // failed tombstone rolls the entire page back for a clean retry.
    const pageInvalidatedKeys = new Set<string>();
    try {
      await db.withExclusiveTransactionAsync(async (transaction) => {
        await applyBusyTimeout(transaction);

        // Expo opens this wrapper with deferred BEGIN: entering the callback is
        // NOT writer-lock ownership. Re-writing the page's current cursor (or
        // creating the epoch cursor on page one) is the first real main-DB write,
        // so it waits behind a purge and then acquires SQLite's RESERVED writer
        // lock. If the purge won, the guard immediately rolls this write back.
        // If we won, a purge cannot finish until this transaction commits or
        // rolls back. This closes the queue gap where a stale page could otherwise
        // commit after a wipe that landed between callback entry and first DELETE.
        await setCheckpoint(transaction, checkpointKey, cursor ?? epochCursor);
        if (isSigningOut() || hasPurgeLanded(purgeToken) || isBackgrounded()) {
          throw new DeletionPageAbortedError();
        }

        for (const deletion of result.deletions) {
          const config = TABLE_CONFIGS[deletion.tableName];
          if (!config) continue;

          const pkColumns = config.primaryKeyColumns;

          // Resurrection guard: a tombstone must not delete a row NEWER than the
          // deletion (delete-then-re-add on another device — the re-added row and
          // the stale tombstone can arrive in the same pull). Rows the tombstone
          // post-dates are deleted; ties delete too (same-transaction recreate),
          // which converges because deletions are applied BEFORE the table pulls.
          const hasUpdatedAt = config.localColumns.includes('updated_at');
          const guardClause = hasUpdatedAt ? ' AND (updated_at IS NULL OR updated_at <= ?)' : '';
          const guardParams = hasUpdatedAt ? [deletion.deletedAt] : [];

          if (pkColumns.length === 1) {
            const deleteResult = await transaction.runAsync(
              `DELETE FROM ${deletion.tableName} WHERE ${pkColumns[0]} = ?${guardClause}`,
              [deletion.recordId, ...guardParams],
            );
            // Local cascade: the server's whole-playlist delete cascades
            // playlist_climbs in Postgres but deliberately emits NO child
            // tombstones (see 0144's NULL-parent guard), and the local SQLite has
            // no FK cascade — without this, a deleted playlist's climb rows would
            // accumulate as invisible orphans forever. Gated on the parent delete
            // actually removing a row so a resurrection-guarded (stale) playlist
            // tombstone doesn't strip a live playlist's climbs.
            if (deletion.tableName === 'playlists' && (deleteResult?.changes ?? 0) > 0) {
              await transaction.runAsync(`DELETE FROM playlist_climbs WHERE playlist_uuid = ?`, [deletion.recordId]);
            }
          } else {
            // Backend encodes composite PKs as exactly N colon-separated segments
            // matching primaryKeyColumns order (e.g. "kilter:uuid:40" for
            // board_climb_stats with PK [board_type, climb_uuid, angle]). The split
            // must produce exactly pkColumns.length parts — if not, skip the deletion
            // rather than silently deleting the wrong row.
            const recordIdParts = deletion.recordId.split(':');
            if (recordIdParts.length !== pkColumns.length) {
              console.warn(
                `[Sync] Skipping deletion: expected ${pkColumns.length} PK parts for ${deletion.tableName}, got ${recordIdParts.length} from "${deletion.recordId}"`,
              );
              continue;
            }
            const whereClause = pkColumns.map((col) => `${col} = ?`).join(' AND ');
            await transaction.runAsync(`DELETE FROM ${deletion.tableName} WHERE ${whereClause}${guardClause}`, [
              ...recordIdParts,
              ...guardParams,
            ]);
          }

          for (const key of config.invalidateKeys) {
            pageInvalidatedKeys.add(JSON.stringify(key));
          }
        }

        // A purge/background transition may start while we hold the writer lock.
        // Roll back before publishing the page cursor so the purge can take the
        // lock next; if it starts after this guard, it necessarily runs after our
        // commit and clears this cursor itself.
        if (isSigningOut() || hasPurgeLanded(purgeToken) || isBackgrounded()) {
          throw new DeletionPageAbortedError();
        }
        await setCheckpoint(transaction, checkpointKey, result.cursor);
      });
    } catch (error) {
      if (error instanceof DeletionPageAbortedError) return { reachedTail: false };
      throw error;
    }

    // Invalidate immediately after this page commits. Deferring all keys until
    // the stream tail meant page N could commit and advance its checkpoint,
    // then a later request could fail before those deleted rows were evicted
    // from React Query. The retry resumes after page N, so that stale UI would
    // otherwise survive for the rest of the app process.
    for (const serializedKey of pageInvalidatedKeys) {
      queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as string[] });
    }

    totalProcessed += result.deletions.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  // Both loop exits mean the server has nothing more past this cursor:
  // hasMore === false, or an empty page (the tail). Only THIS outcome licenses
  // stamping the coverage marker — the aborts above return false, because a
  // pull that was backgrounded on its first page has consumed nothing and must
  // not claim a full retention window of coverage (mirrors syncTable).
  return { reachedTail: true };
}

// The manifest is fetched at most once per pullSync run and its outcome cached
// across scopes. `absent` = the manifest is genuinely missing, or uses an
// unsupported format version → a permanent miss this cycle. `error` = the
// request failed or the current-format response was malformed. Manifest errors
// are global publication/transport failures, never per-scope budget failures;
// fresh scopes wait for the scheduler's short retry instead of stamping a
// page-one checkpoint. `ok` carries the parsed manifest.
type ManifestResolution =
  | { status: 'ok'; manifest: SnapshotManifest }
  | { status: 'absent' }
  | { status: 'error'; cause: unknown };

type ManifestResolutionCache = {
  value?: ManifestResolution;
  failurePolicy?: { failOpen: boolean };
};

// The manifest is only a few KB, so a short retry is cheap while still keeping
// a captive portal or transient CDN error from becoming a tight request loop.
const MANIFEST_RETRY_DELAY_MS = 30_000;
// A globally broken manifest must not leave every fresh board empty forever.
// Two short waits preserve the CDN fast path; the third cycle starts the paged
// crawl and keeps probing less aggressively so a partial scope can heal later.
const MAX_MANIFEST_WAIT_FAILURES = 2;
const MANIFEST_FAIL_OPEN_RETRY_DELAY_MS = 5 * 60_000;
const manifestFailureCounts = new WeakMap<OfflineDatabase, { wipeEpoch: number; count: number }>();

function isBackgroundTransferDecodeError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'SnapshotBackgroundTransferInterruptedError';
}

function settleManifestPublicationStateOnce(
  db: OfflineDatabase,
  resolution: ManifestResolution,
  cache: ManifestResolutionCache,
  options: { countError?: boolean } = {},
): { failOpen: boolean } {
  if (cache.failurePolicy) return cache.failurePolicy;

  if (resolution.status !== 'error') {
    manifestFailureCounts.delete(db);
    cache.failurePolicy = { failOpen: false };
    return cache.failurePolicy;
  }

  // A complete-scope grades retrofit may share this fetch with a later fresh
  // scope. Its error neither waits nor consumes the fresh board's two chances;
  // leave the cache unsettled so the eligible path can count it if reached.
  if (options.countError === false) return { failOpen: false };

  // Deliberately process-local rather than SQLite-backed. Persisting this
  // optional publication counter introduced a forbidden post-sign-out write:
  // the fetch could resume after the wipe and recreate global metadata for the
  // next owner. Two 30-second waits in one foreground session are enough to
  // protect the fast path; a relaunch safely gets the same small grace again.
  const wipeEpoch = getWipeEpoch();
  const previous = manifestFailureCounts.get(db);
  const failureCount = previous?.wipeEpoch === wipeEpoch ? previous.count + 1 : 1;
  manifestFailureCounts.set(db, { wipeEpoch, count: failureCount });
  cache.failurePolicy = { failOpen: failureCount > MAX_MANIFEST_WAIT_FAILURES };
  return cache.failurePolicy;
}

/**
 * Settle one bootstrap failure: burn the budget its KIND spends, schedule the
 * next attempt on that budget's ladder, and mirror the legacy markers.
 *
 * Two independent decisions come out of a failure, and #4313 is the story of
 * them having been fused. `expected` is purely a SEVERITY signal — a
 * transport-shaped cause (offline, DNS, TLS, timeout; `isNetworkError`, the same
 * predicate the drainer uses to keep a mutation off the dead-letter path) is
 * routine on a phone and the mobile reporter downgrades it to a warning. Which
 * budget it spends is `classifyBootstrapFailure`'s call, and a transport failure
 * now spends the transport budget instead of the structural one.
 *
 * The MANIFEST stage stays entirely free of per-scope budgets (issue #4238):
 * it is one small global object, so charging every enabled scope for one bad
 * publish could terminal the whole device. A separate global counter bounds
 * how long fresh scopes wait before failing open to the paged crawl. Failures
 * after manifest resolution — a short artifact or disk-full device — are charged.
 */
async function settleBootstrapFailure(
  db: OfflineDatabase,
  scopeKey: string,
  input: {
    state: BootstrapRetryState;
    cause: unknown;
    stage: 'manifest' | 'download' | 'import';
    builtAt: string | null;
    now: number;
    random: () => number;
  },
): Promise<{
  state: BootstrapRetryState;
  failureKind: BootstrapFailureKind;
  expected: boolean;
  cause: unknown;
  /** False for the free manifest-transport case: nothing was written to sync_meta. */
  persisted: boolean;
}> {
  const { state, cause, stage, builtAt, now, random } = input;
  const failureKind = classifyBootstrapFailure({ cause, stage });
  const expected = isNetworkError(cause) || isBackgroundTransferDecodeError(cause);
  if (stage === 'manifest') {
    // The manifest is one global object shared by every scope in this cycle.
    // Charging a per-scope budget for a bad response can terminal every board
    // on a device from one broken publish. Keep all manifest failures cap- and
    // cooldown-exempt; the scheduler supplies the bounded-frequency retry.
    return { state, failureKind, expected, cause, persisted: false };
  }
  const scheduled = nextRetryState({ state, failureKind, builtAt, now, random });
  const written = await writeBootstrapRetryState(db, scopeKey, scheduled);
  if (isTerminal(written)) {
    await markBootstrapPagedFallback(db, scopeKey);
  } else {
    // Preserve the prior fallback marker until the new attempt has a durable
    // outcome. Clearing it here avoids an abort window where the UI observes a
    // transient decision that this run never finished making.
    await clearBootstrapPagedFallback(db, scopeKey);
  }
  return { state: written, failureKind, expected, cause, persisted: true };
}

async function resolveManifestOnce(
  source: SnapshotSource,
  cache: ManifestResolutionCache,
): Promise<ManifestResolution> {
  if (cache.value) return cache.value;
  let raw: unknown;
  try {
    raw = await source.fetchManifest();
  } catch (error) {
    cache.value = { status: 'error', cause: error };
    return cache.value;
  }
  if (raw == null) {
    cache.value = { status: 'absent' };
    return cache.value;
  }
  const manifest = parseSnapshotManifest(raw);
  if (manifest) {
    cache.value = { status: 'ok', manifest };
    return cache.value;
  }
  // A client cannot consume an older/newer contract, so fail open to the paged
  // path. A malformed response claiming THIS contract is different: it may be
  // a truncated CDN/proxy body, and must get a short retry rather than turning
  // the first 500-row page into a durable slow-path choice.
  const formatVersion =
    typeof raw === 'object' && raw !== null && 'formatVersion' in raw
      ? (raw as { formatVersion?: unknown }).formatVersion
      : undefined;
  if (typeof formatVersion === 'number' && formatVersion !== SNAPSHOT_MANIFEST_FORMAT_VERSION) {
    cache.value = { status: 'absent' };
    return cache.value;
  }
  cache.value = {
    status: 'error',
    cause: new Error('snapshot manifest has an invalid current-format payload'),
  };
  return cache.value;
}

/**
 * Snapshot-bootstrap phase (runs BEFORE deletions). For each enabled scope the
 * shared eligibility gate vouches for, warm it from a pre-built artifact instead
 * of paging the whole catalog. Returns the scope keys whose paged board-table
 * pull must be SKIPPED this cycle. Whether an import was a HEAL over a
 * partly-crawled catalog is persisted on the `bootstrap-done:` marker instead of
 * returned, because the scope's completion event usually fires cycles later (see
 * ScopeDownloadCompleteInfo.bootstrapHealed).
 *
 * ELIGIBILITY lives in `bootstrap-retry.ts`'s `evaluateBootstrapEligibility`,
 * which `estimateScopeDownload` calls too so the size the UI quotes can never
 * disagree with what this function does. Two kinds pass it:
 *   - `fresh` — no checkpoint on either board table (the original rule).
 *   - `heal-over-partial` — a scope that HAS checkpoints but never finished its
 *     crawl. This includes retry victims and scopes whose first 500-row page ran
 *     before snapshot I/O was available on cold launch. Their board data is a
 *     fraction of the catalog and finishing via GraphQL is 400+ serial trips.
 *     A `scope-complete:` scope is never healed — it already serves the whole
 *     catalog locally, so an artifact buys it nothing.
 *
 * FAILURE ACCOUNTING is `classifyBootstrapFailure` + `nextRetryState` (same
 * module). Per stage:
 *   - manifest `absent` (404 or unsupported format version) → permanent miss,
 *     NO burn → normal paged pull.
 *   - manifest `error` (network, HTTP, malformed current-format payload) → NO
 *     per-scope burn; SKIP paged pull and wake the scheduler again in 30s. The
 *     third consecutive global failure starts the paged crawl and probes again
 *     after 5m, so a broken publication cannot leave fresh boards empty forever.
 *   - manifest `ok` but no entry for (boardType, layoutId) → permanent miss, NO
 *     burn → normal paged pull (layout not exported yet).
 *   - download fails/returns null, TRANSPORT-shaped → transport burn + the
 *     2 min → 15 min → 2 h ladder. THIS is what #4313 changed: it used to burn
 *     the same 2-slot counter a corrupt artifact does, so two bad-reception
 *     launches condemned the board to the crawl for the life of the install.
 *   - download fails otherwise → structural-device burn (6 h → 24 h ladder), and
 *     a device-side fault is never re-armed by a nightly rebuild.
 *   - download throws SnapshotPermanentMissError → structural-device burn, and
 *     the paged pull runs THIS cycle (never skipped). The bytes are already down
 *     the wire — mobile only raises this after a full artifact turns out to be
 *     undecoded gzip — and a heal-eligible scope would otherwise re-download the
 *     same unusable artifact on every cycle, forever.
 *   - import throws → structural-artifact burn. The bytes are on disk and
 *     provably bad, so tonight's export MIGHT fix it: a terminal scope of this
 *     one kind consults the manifest again and a differently-built artifact
 *     re-arms its budget exactly once per scope, ever.
 *   - import throws SnapshotSchemaStaleError → permanent miss, NO burn: the next
 *     cycle's manifest pre-check filters the rebuilt entry out before any bytes
 *     move, so nothing can loop on it.
 *   - import throws SnapshotWatermarkRegressionError → structural-artifact burn,
 *     same as any other import failure. The artifact's scoped watermark is behind
 *     what this scope already crawled; importing would lower a checkpoint (and the
 *     global deletions cursor) below local progress, so nothing was written.
 *     Charging it is what stops the loop: the refusal is deterministic for that
 *     artifact, and before #4313's fix the scope stayed eligible and pulled the
 *     whole ~100 MB again every cycle, forever. Reported at full severity because
 *     it means the export's scope filter and the client's disagree.
 *   - success → mark done, rewind deletions to the artifact's conservative
 *     export-transaction boundary (or min scoped watermarks for old artifacts),
 *     clear the consecutive-transport counter; the paged pull runs normally,
 *     now a ~1-day delta from the scoped watermark checkpoints.
 *
 * WORST-CASE LIFETIME SPEND per scope: 3 transport + 2 structural + 2 for the
 * single re-armed structural round = 7 artifact downloads, each separated by at
 * least one cooldown rung. A test pins that count.
 *
 * SKIPPING THE PAGED PULL is now a grace window, not all-or-nothing: only a
 * FRESH, non-terminal scope whose retry is within 30 minutes waits for it. A
 * scope that already holds rows always crawls, so a failed heal can never stall
 * progress that was already being made.
 *
 * A wipe detected mid-phase bails the whole phase with no burn (mirrors
 * syncTable). One artifact is downloaded per (boardType, layoutId) and reused
 * across that layout's sizes; every download is handed back in a finally through
 * `releaseArtifact`, which keeps an UNIMPORTED file when the source supports
 * retention and deletes it otherwise (issue #4310).
 *
 * Snapshot attribution for ScopeDownloadCompleteInfo.method and .bootstrapHealed
 * is NOT threaded through here — both read the persisted `bootstrap-done:` marker
 * (its presence, and whether its value records a heal), because the completing
 * delta pull can land cycles after the import.
 */
async function runBootstrapPhase(params: {
  db: OfflineDatabase;
  queryClient: QueryInvalidator;
  source: SnapshotSource;
  scopes: BoardScope[];
  /** The purge token pullSync captured at CYCLE start — see `cycleAborted` there. */
  purgeToken: PurgeToken;
  /** Once-ever Started emitter, shared with the board-data loop (issue #4316). */
  emitScopeDownloadStartOnce: (info: ScopeDownloadStartInfo) => Promise<void>;
  /** Per-scope download/import timings + payload size, read back by the Completed event. */
  bootstrapTimings: Map<string, { bytes: number; downloadMs?: number; importMs?: number; rowCount?: number }>;
  stampScopeStart: (scopeKey: string) => Promise<void>;
  phaseTimings: (scopeKey: string) => ScopeDownloadPhaseBreakdown;
  options: SyncOptions | undefined;
  now: () => number;
  random: () => number;
}): Promise<{ skipPagedPull: Set<string>; cycleInterrupted: boolean }> {
  const {
    db,
    queryClient,
    source,
    scopes,
    purgeToken,
    stampScopeStart,
    phaseTimings,
    emitScopeDownloadStartOnce,
    bootstrapTimings,
    options,
    now,
    random,
  } = params;
  const onProgress = options?.onProgress;
  const onSchemaDrift = options?.onSchemaDrift;
  const rawSnapshotBootstrapError = options?.onSnapshotBootstrapError;

  /**
   * `kind: 'cycle'` — nothing in this cycle may continue (break).
   * `kind: 'scope'`  — only THIS scope's namespace was purged (continue), so
   * every other board keeps its download (issue #4370).
   */
  type TeardownVerdict = { reason: SnapshotBootstrapFailureReason; kind: 'cycle' | 'scope' };

  /**
   * Why the phase — or just this scope — is being torn down, or null when it is
   * not. Read at each of the bail-out points below, which used to
   * `break`/`return` in silence: the reason `Offline Board Download Started`
   * could be followed by nothing at all.
   *
   * The ordering is load-bearing and unchanged: sign-out/global wipe first,
   * backgrounding second, scope purge last. That is what keeps a backgrounded
   * phone reporting `aborted-background` rather than `aborted-wipe`. An
   * unparseable scopeKey yields global-only checks — a malformed key is never
   * laundered as a scope purge, because we cannot prove which namespace it is in.
   */
  const teardownVerdict = (scopeKey: string): TeardownVerdict | null => {
    if (isSigningOut() || hasPurgeLanded(purgeToken)) return { reason: 'aborted-wipe', kind: 'cycle' };
    if (isBackgrounded()) return { reason: 'aborted-background', kind: 'cycle' };
    const namespace = purgeNamespaceForScopeKey(scopeKey);
    if (namespace !== undefined && hasPurgeLanded(purgeToken, namespace)) {
      return { reason: 'aborted-wipe', kind: 'scope' };
    }
    return null;
  };

  // The terminal-event invariant, enforced structurally rather than site by site
  // (issue #4316). Armed at the Started emission below and closed from the
  // per-scope `finally`, so an exit nobody registered — a future `break`, a
  // `throw` from any of the awaited SQLite writes that sit outside the import's
  // own catch, a consumer callback blowing up — still closes the funnel. See
  // download-funnel-guard.ts for what counts as settled and why only a genuinely
  // unexplained exit reaches Sentry.
  //
  // Every report leaving this phase — the guard's own included — passes through
  // `recordTerminal` first, so the teardown that is about to delete this scope
  // knows a terminal event has already been spent on its removal (issue #4406).
  const recordTerminal = (report: SnapshotBootstrapErrorReport): void => {
    // Only the teardown-shaped reason: an ordinary failure ends this ATTEMPT but
    // leaves the download itself owed a terminal, which is exactly the case the
    // teardown must still report.
    if (report.reason === 'aborted-wipe') noteScopeDownloadTerminal(report.scopeKey);
    rawSnapshotBootstrapError?.(report);
  };
  const funnelGuard = createDownloadFunnelGuard({
    report: rawSnapshotBootstrapError ? recordTerminal : undefined,
    // Scope-aware: an unexplained exit that merely COINCIDES with another
    // board's removal is no longer laundered as `aborted-wipe`, so it still
    // reaches Sentry as `unknown-exit` (issue #4370).
    teardownReason: (scopeKey) => teardownVerdict(scopeKey)?.reason ?? null,
  });

  // Wrapped ONCE here rather than at each of the eight report sites: every one of
  // them already builds a payload with the cause in hand, so deriving `reason` and
  // defaulting `aborted` centrally keeps them untouched and makes it impossible for
  // a future arm to forget either field (issue #4314). The guard is settled from
  // the same place for the same reason: a report site cannot forget to mark itself
  // terminal if marking itself is not something it does.
  const onSnapshotBootstrapError = rawSnapshotBootstrapError
    ? (report: BootstrapErrorInput): void => {
        funnelGuard.settle(report.scopeKey);
        recordTerminal({
          ...report,
          reason: report.reason ?? classifySnapshotBootstrapFailure(report.cause),
          aborted: report.aborted ?? false,
        });
      }
    : undefined;

  /** Close the funnel for a scope whose work this cycle was cut short. */
  const reportBootstrapAbort = (
    scopeKey: string,
    stage: BootstrapErrorInput['stage'],
    reason: SnapshotBootstrapFailureReason,
    cause: unknown,
  ): void => {
    // `expected: true` keeps the severity story consistent with transport
    // failures; `aborted: true` is what a failure-rate query filters on.
    //
    // `attempt: 0` is the field's established meaning, NOT a placeholder: every
    // report site spells "nothing was burned" as zero — `reportSettledFailure`
    // sends `settled.persisted ? burned : 0`, and the schema-stale arm sends a
    // literal 0 for the same reason. A teardown spends no retry budget, so any
    // other number here would claim a scope had used up an attempt it still has.
    onSnapshotBootstrapError?.({ scopeKey, stage, attempt: 0, cause, expected: true, aborted: true, reason });
  };

  const onBootstrapMetadataChanged = options?.onBootstrapMetadataChanged;
  const onBootstrapRetryDue = options?.onBootstrapRetryDue;
  const onBootstrapRetryCleared = options?.onBootstrapRetryCleared;
  const isOnUnmeteredNetwork = options?.isOnUnmeteredNetwork ?? (() => true);

  const skipPagedPull = new Set<string>();
  let cycleInterrupted = false;
  const manifestCache: ManifestResolutionCache = {};
  type LayoutDownloadRecord = {
    file: SnapshotArtifactHandle | null;
    cause: unknown;
    permanentMiss: boolean;
    downloadMs: number;
    /** Set when THIS phase cancelled the transfer, so a cleared flag can't relabel it a failure. */
    abortedReason: SnapshotBootstrapFailureReason | null;
    /**
     * Telemetry only (issue #4390): the app went to the background at some
     * point during this transfer. Deliberately NOT part of the pause/failure
     * decision — see `suspensionWindowOpen` below for the narrow test that is.
     */
    backgroundedDuringTransfer: boolean;
  };
  // Absent = not yet attempted; `file: null` = download failed (with its cause).
  const downloadByLayout = new Map<string, LayoutDownloadRecord>();
  // filePath → whether any scope managed to import it. An artifact the phase
  // never consumed (backgrounded cycle, wipe, aborted transfer) is handed back
  // with `imported: false` so a retention-capable source can keep it.
  const artifactImported = new Map<string, boolean>();
  // Grades artifacts are tracked apart from `artifactImported` because they are
  // never retained: the retention seam above keeps an UNIMPORTED whole-layout
  // file for the next cycle, and its supersede sweep recognises a build by the
  // `<board>-<layout>` prefix in the filename — which a grades file, named from
  // its manifest key, does not have. A retained one would therefore never be
  // recognised as superseded and would sit in the cache directory forever, so
  // these are deleted outright in the finally below. Re-fetching a few MB next
  // cycle is the cheaper failure.
  const gradesArtifactPaths = new Set<string>();
  // Absent = not yet attempted for this layout; null = unavailable this cycle.
  const gradesDownloadByLayout = new Map<string, { filePath: string } | null>();

  /**
   * Import the layout's Boardsesh grades from its separate artifact, replacing
   * the paged crawl of `board_climb_grades` — the term the whole-layout
   * artifact never covered, and the reason a Kilter/Tension download takes ~6x
   * a MoonBoard layout of the same size (issue #4310).
   *
   * Called on two paths: straight after a successful whole-layout import, and
   * — for a scope that was bootstrapped before this shipped, or crashed between
   * the two transactions — whenever the grades checkpoint is ABSENT on a scope
   * whose climb catalog is already COMPLETE (`bootstrap-done` or
   * `scope-complete`). An absent grades checkpoint is proof no grade page was
   * ever consumed (`syncTable` checkpoints per page), so importing and stamping
   * at the artifact's watermark cannot skip a row the crawl already had; the
   * completeness gate is what stops the stamp landing above grade rows whose
   * climbs a half-finished crawl has not fetched yet.
   *
   * Every failure here is free: it never touches the whole-layout attempt
   * counter, and the worst case is that the scope crawls grades exactly as it
   * does today.
   */
  const importGradesForScope = async (
    scope: BoardScope,
    entry: SnapshotManifestEntry,
  ): Promise<TeardownVerdict['kind'] | null> => {
    const gradesArtifact = entry.grades;
    if (!gradesArtifact || !source.downloadGradesArtifact) return null;
    // A grades artifact built at an older client schema would NULL-fill columns
    // this app added and then stamp the cursor past them — same permanent-miss
    // rule the whole-layout artifact gets.
    if (!isSnapshotEntryUsable(gradesArtifact)) return null;
    if ((await getGradesBootstrapAttempts(db, scope.scopeKey)) >= MAX_GRADES_BOOTSTRAP_ATTEMPTS) return null;

    // One artifact serves every size of a layout, which is exactly why the purge
    // namespace is keyed the same way — the two must never drift.
    const layoutKey = purgeNamespaceKey(scope);
    let gradesDownload = gradesDownloadByLayout.get(layoutKey);
    if (gradesDownload === undefined) {
      const preDownloadVerdict = teardownVerdict(scope.scopeKey);
      if (preDownloadVerdict) return preDownloadVerdict.kind;

      // A background→foreground transition can complete before the native
      // promise rejects. Latch teardown only for a DEAD transfer; a successful
      // grades file may still be imported when the app is active again, just
      // like the retained whole-layout download above.
      let latchedDownloadVerdict: TeardownVerdict | null = null;
      const unsubscribeGradesTeardown = onTeardown(() => {
        latchedDownloadVerdict ??= teardownVerdict(scope.scopeKey);
      });
      let downloadCause: unknown = null;
      const gradesDownloadStartedAt = Date.now();
      try {
        gradesDownload = (await source.downloadGradesArtifact(gradesArtifact)) ?? null;
      } catch (error) {
        gradesDownload = null;
        downloadCause = error;
      } finally {
        unsubscribeGradesTeardown();
        // Closes half of the ~11s p50 residual between `durationMs` and the sum
        // of the other phases: this transfer never touched `phases.downloadMs`.
        // Charged on the failure path too — a grades transfer that timed out
        // spent that time just as surely as one that landed.
        const gradesPhases = phaseTimings(scope.scopeKey);
        gradesPhases.gradesDownloadMs = (gradesPhases.gradesDownloadMs ?? 0) + (Date.now() - gradesDownloadStartedAt);
      }
      // A NULL return counts exactly as a throw does. `SnapshotSource` lets a
      // source signal "unusable this cycle" either way (see downloadArtifact's
      // contract), and the whole-layout path settles a failure on both — so
      // leaving the null arm uncounted here would let a null-returning source
      // re-fetch the artifact on every cycle for the life of the install,
      // straight past MAX_GRADES_BOOTSTRAP_ATTEMPTS.
      if (!gradesDownload) {
        // A cycle that is being torn down did not fail — it was interrupted.
        // Charging a grades attempt here spent one of the three tries this
        // artifact ever gets on a pocketed phone, and three screen locks left a
        // Kilter board crawling grades over GraphQL for the life of the install
        // (issue #4390).
        // Scope-aware (issue #4370): another board's removal never charges this
        // layout a grades attempt, and never masks a real grades failure as an
        // abort either.
        const gradesTeardown = teardownVerdict(scope.scopeKey) ?? latchedDownloadVerdict;
        if (gradesTeardown) {
          reportBootstrapAbort(scope.scopeKey, 'grades-download', gradesTeardown.reason, downloadCause);
          gradesDownloadByLayout.set(layoutKey, null);
          return gradesTeardown.kind;
        }
        const attempt = await recordGradesBootstrapAttempt(db, scope.scopeKey);
        onSnapshotBootstrapError?.({
          scopeKey: scope.scopeKey,
          stage: 'grades-download',
          attempt,
          cause: downloadCause,
          expected: isNetworkError(downloadCause),
        });
      }
      gradesDownloadByLayout.set(layoutKey, gradesDownload);
      if (gradesDownload) gradesArtifactPaths.add(gradesDownload.filePath);
    }
    if (!gradesDownload) return null;
    const preImportVerdict = teardownVerdict(scope.scopeKey);
    if (preImportVerdict) {
      reportBootstrapAbort(scope.scopeKey, 'grades-download', preImportVerdict.reason, null);
      return preImportVerdict.kind;
    }

    try {
      const { rowsImported, gradesVerifyMs, gradesLockMs } = await bootstrapScopeGradesFromSnapshot({
        db,
        scope,
        scopeKey: scope.scopeKey,
        filePath: gradesDownload.filePath,
        onSchemaDrift,
      });
      // The artifact's own row count, reported alongside the paged crawl's
      // (issue #4393): it is what tells a truthful `gradesRows: 0` — the crawl
      // behind a fresh artifact has nothing left to fetch — apart from a board
      // that has no grades at all. Accumulating rather than assigning because
      // the two call sites (post-import and the retrofit path) are mutually
      // exclusive per scope today, and `+=` stays correct if that changes.
      const phases = phaseTimings(scope.scopeKey);
      phases.gradesArtifactRows = (phases.gradesArtifactRows ?? 0) + rowsImported;
      phases.gradesVerifyMs = (phases.gradesVerifyMs ?? 0) + gradesVerifyMs;
      // MAX, like importLockMaxMs: the question is the worst hold a concurrent
      // write met, which does not add up across scopes of the same layout.
      phases.gradesLockMs = Math.max(phases.gradesLockMs ?? 0, gradesLockMs);
      for (const key of TABLE_CONFIGS.board_climb_grades.invalidateKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    } catch (error) {
      // A wipe rolls the transaction back; no checkpoint, nothing to count.
      const importVerdict = teardownVerdict(scope.scopeKey);
      if (error instanceof SnapshotWipedError || importVerdict) {
        const resolvedVerdict = importVerdict ?? { reason: 'aborted-wipe' as const, kind: 'cycle' as const };
        reportBootstrapAbort(scope.scopeKey, 'grades-import', resolvedVerdict.reason, error);
        return resolvedVerdict.kind;
      }
      const attempt = await recordGradesBootstrapAttempt(db, scope.scopeKey);
      onSnapshotBootstrapError?.({
        scopeKey: scope.scopeKey,
        stage: 'grades-import',
        attempt,
        cause: error,
        expected: false,
      });
    }
    return null;
  };

  const reportSettledFailure = (
    scope: BoardScope,
    stage: 'manifest' | 'download' | 'import',
    settled: Awaited<ReturnType<typeof settleBootstrapFailure>>,
    evaluatedAt: number,
    retryDelayMs = MANIFEST_RETRY_DELAY_MS,
  ): void => {
    const burned =
      settled.failureKind === 'transport'
        ? settled.state.transportFailures
        : settled.failureKind === 'database-locked'
          ? settled.state.lockFailures
          : settled.state.structuralFailures;
    onSnapshotBootstrapError?.({
      scopeKey: scope.scopeKey,
      stage,
      attempt: settled.persisted ? burned : 0,
      cause: settled.cause,
      expected: settled.expected,
    });
    if (!settled.persisted) {
      onBootstrapRetryDue?.({ scopeKey: scope.scopeKey, retryAt: evaluatedAt + retryDelayMs });
      return;
    }
    const terminal = isTerminal(settled.state);
    options?.onBootstrapRetryScheduled?.({
      scopeKey: scope.scopeKey,
      boardType: scope.boardType,
      stage,
      failureKind: settled.failureKind,
      retryAfterMs:
        terminal || settled.state.retryAfter === null ? 0 : Math.max(0, settled.state.retryAfter - evaluatedAt),
      transportFailures: settled.state.transportFailures,
      lockFailures: settled.state.lockFailures,
      structuralFailures: settled.state.structuralFailures,
      terminal,
    });
    if (!terminal && settled.state.retryAfter !== null) {
      onBootstrapRetryDue?.({ scopeKey: scope.scopeKey, retryAt: settled.state.retryAfter });
    } else {
      onBootstrapRetryCleared?.(scope.scopeKey);
    }
  };

  try {
    for (const scope of scopes) {
      // Progress state belongs to one scope. Keeping the high-water mark or
      // throttle window across boards can make scope B inherit scope A's last
      // fraction if a future path omits one of today's explicit stage flushes.
      // Every emission is synchronous, so this pure state machine adds no await
      // boundary and cannot move a purge check.
      const progressThrottle = createSnapshotProgressThrottle({ now });
      const emitSnapshotFrame = (frame: SnapshotBootstrapProgress | null): void => {
        if (!frame) return;
        onProgress?.({
          phase: 'bootstrap',
          currentTable: frame.scopeKey,
          documentsProcessed: 0,
          snapshot: frame,
        });
      };
      let metadataSettled = false;
      try {
        const loopTopVerdict = teardownVerdict(scope.scopeKey);
        if (loopTopVerdict) {
          if (loopTopVerdict.kind === 'cycle') {
            cycleInterrupted = true;
            break;
          }
          continue;
        }

        // Duration telemetry starts here — before the eligibility check — so a
        // snapshot scope's durationMs covers its manifest/download/import work.
        await stampScopeStart(scope.scopeKey);
        const phases = phaseTimings(scope.scopeKey);

        const climbsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climbs', scope.scopeKey));
        const statsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climb_stats', scope.scopeKey));
        const hasBoardCheckpoint = climbsCheckpoint !== null || statsCheckpoint !== null;
        const isScopeComplete = await isScopeDownloadComplete(db, scope.scopeKey);
        const isAlreadyBootstrapped = await isBootstrapDone(db, scope.scopeKey);
        // ONE clock reading for this scope's whole decision: the cooldown
        // comparison, the ladder it schedules, and the reported retryAfterMs must
        // all be made against the same instant or a slow download would report a
        // delay it never waited.
        const evaluatedAt = now();
        const { state: migratedState, migratedFromLegacy } = await readBootstrapRetryState(
          db,
          scope.scopeKey,
          { now: evaluatedAt, random },
          hasBoardCheckpoint,
        );
        let retryState = migratedState;
        // Persist the derived state on first touch so the spread-out post-OTA
        // retryAfter is stable across launches instead of being re-rolled every
        // cycle. The legacy ROWS survive (a rolled-back bundle still finds them),
        // but this write does re-stamp `bootstrap-attempts:` down to the mirrored
        // value — the migration grants one clean pass, and the mirror has to say
        // so or a rollback would re-read the pre-migration count.
        if (migratedFromLegacy && retryState.hasPriorSnapshotFailure) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, retryState);
          metadataSettled = true;
        }

        const verdict = evaluateBootstrapEligibility({
          retryState,
          hasBoardCheckpoint,
          isScopeComplete,
          isBootstrapDone: isAlreadyBootstrapped,
          now: evaluatedAt,
        });
        if (!verdict.eligible && verdict.reason === 'cooling-down' && retryState.retryAfter !== null) {
          // This includes cooldowns restored from SQLite on a cold launch. The
          // analytics callback only fires when a failure is first settled, so a
          // separate lifecycle signal is what makes the retry survive remounts.
          onBootstrapRetryDue?.({ scopeKey: scope.scopeKey, retryAt: retryState.retryAfter });
        } else {
          onBootstrapRetryCleared?.(scope.scopeKey);
        }
        // A terminal scope whose last failure was the ARTIFACT's fault is the one
        // case worth spending a manifest request on: a differently-built artifact
        // re-arms it. Everything else terminal skips the fetch entirely, which is
        // cheaper than the pre-#4313 over-cap path that consulted it every cycle.
        const isRearmCandidate = !verdict.eligible && verdict.reason === 'terminal' && verdict.canRearm;
        if (!verdict.eligible && !isRearmCandidate) {
          if (verdict.reason === 'terminal') await markBootstrapPagedFallback(db, scope.scopeKey);
          // Set on BOTH not-eligible arms deliberately: the pre-#4313 bail did
          // the same for a checkpointed scope so My Boards re-reads the row even
          // though this run did not mutate its markers.
          metadataSettled = true;
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          // RETRO-FIT (issue #4310): a scope with a COMPLETE climb catalog but
          // NO grades checkpoint has never consumed a single grade page
          // (`syncTable` checkpoints per page), so it is still facing the full
          // crawl — every scope bootstrapped before grades artifacts existed is
          // in exactly this state. Import them from the artifact instead. Gated
          // on the local checkpoint read, so once a scope has grades this costs
          // nothing, and the manifest is only fetched for scopes that need it.
          //
          // COMPLETENESS IS THE GATE, not the mere presence of a board
          // checkpoint. The import filters the artifact's grade rows through
          // `main.board_climbs` and stamps the grades cursor at THAT subset's
          // watermark, so running it over a half-crawled catalog would stamp
          // past every grade row belonging to a climb the crawl has not fetched
          // yet — and the strict `>` delta never revisits them. `bootstrap-done`
          // (the artifact carried the whole layout, heal included) and
          // `scope-complete` (the paged crawl reached every table's tail) are
          // the two proofs of a whole catalog; a scope mid-crawl waits until it
          // has one, at which point this branch picks it up.
          //
          // Deliberately NOT run for a scope with no board data at all: that one
          // is either fresh (the eligible path below imports its grades right
          // after the whole-layout artifact) or serving a snapshot cooldown the
          // retry taxonomy imposed (#4313), and a cooldown means no artifact
          // bytes for this scope this cycle — grades included.
          if ((isAlreadyBootstrapped || isScopeComplete) && source.downloadGradesArtifact) {
            const gradesCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climb_grades', scope.scopeKey));
            if (!gradesCheckpoint) {
              const retrofitResolution = await resolveManifestOnce(source, manifestCache);
              const retrofitVerdict = teardownVerdict(scope.scopeKey);
              if (retrofitVerdict) {
                if (retrofitVerdict.kind === 'cycle') {
                  cycleInterrupted = true;
                  break;
                }
                continue;
              }
              settleManifestPublicationStateOnce(db, retrofitResolution, manifestCache, { countError: false });
              const retrofitEntry =
                retrofitResolution.status === 'ok'
                  ? findSnapshotEntry(retrofitResolution.manifest, scope.boardType, scope.layoutId)
                  : null;
              if (retrofitEntry) {
                const gradesVerdict = await importGradesForScope(scope, retrofitEntry);
                if (gradesVerdict === 'cycle') {
                  cycleInterrupted = true;
                  break;
                }
                if (gradesVerdict === 'scope') continue;
              }
            }
          }
          continue;
        }

        onProgress?.({ phase: 'bootstrap', currentTable: scope.scopeKey, documentsProcessed: 0 });
        // Stage 1 of 3. The manifest fetch is usually instant off the React
        // Query cache, but on a cold start behind a slow connection it is the
        // first thing the climber waits on, so it gets its own caption.
        emitSnapshotFrame(
          progressThrottle.flush({
            scopeKey: scope.scopeKey,
            stage: 'manifest',
            fraction: null,
            wireBytes: null,
            wireBytesDone: null,
          }),
        );

        const manifestStartedAt = Date.now();
        const resolution = await resolveManifestOnce(source, manifestCache);
        phases.manifestMs += Date.now() - manifestStartedAt;
        // Re-check after the manifest network await: every branch below either
        // writes to SQLite or leads to one further down.
        const manifestVerdict = teardownVerdict(scope.scopeKey);
        if (manifestVerdict) {
          if (manifestVerdict.kind === 'cycle') {
            cycleInterrupted = true;
            break;
          }
          continue;
        }
        // Manifest retry bookkeeping is intentionally deferred until AFTER the
        // network await's purge/sign-out check. The resolver itself is pure, so
        // a stale cycle cannot recreate global metadata after an account wipe.
        const manifestFailurePolicy = settleManifestPublicationStateOnce(db, resolution, manifestCache);

        // Shared with the pre-download size estimate (snapshot-estimate.ts) so the
        // UI can never quote a number for an artifact this phase would skip.
        const entry =
          resolution.status === 'ok' ? findSnapshotEntry(resolution.manifest, scope.boardType, scope.layoutId) : null;
        // Pre-check the manifest's schemaVersion so a schema-stale artifact is
        // skipped BEFORE the multi-MB download; verifySnapshotMeta re-checks the
        // authoritative value inside the file. Same permanent-miss semantics as
        // SnapshotSchemaStaleError: no burn, paged crawl runs this cycle, and
        // tonight's export rebuilds at the new schema.
        const isEntryUsable = entry !== null && isSnapshotEntryUsable(entry);

        if (isRearmCandidate) {
          // Only a genuinely DIFFERENT build is worth another round; the same
          // artifact would fail the same way.
          if (!isEntryUsable || entry.builtAt === retryState.failedBuiltAt) {
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            continue;
          }
          retryState = await writeBootstrapRetryState(
            db,
            scope.scopeKey,
            rearmForNewArtifact(retryState, entry.builtAt),
          );
          // The scope was carrying a paged-fallback marker that My Boards renders
          // as "using the slower download". It is back on the snapshot path as of
          // this line, and the download below can run for 18 minutes — leaving the
          // marker up would tell the climber the wrong story for the whole of it.
          // A later failure re-stamps it.
          await clearBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
        }

        if (resolution.status === 'absent') {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue; // permanent miss, no burn
        }
        if (resolution.status === 'error') {
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: resolution.cause,
            stage: 'manifest',
            builtAt: null,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          // A cap-exempt transport failure persists nothing, so there is no settled
          // decision for the UI to re-read — only a counted one changed sync_meta.
          metadataSettled = metadataSettled || settled.persisted;
          reportSettledFailure(
            scope,
            'manifest',
            settled,
            evaluatedAt,
            manifestFailurePolicy.failOpen ? MANIFEST_FAIL_OPEN_RETRY_DELAY_MS : MANIFEST_RETRY_DELAY_MS,
          );
          if (manifestFailurePolicy.failOpen) {
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
          } else if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          continue;
        }
        if (!entry) {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue; // layout not exported yet — permanent miss, no burn
        }
        if (!isEntryUsable) {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue;
        }

        // A re-arm makes a terminal scope eligible as of this cycle; its kind is
        // whatever it would have been had the budget never run out.
        const bootstrapKind = verdict.eligible
          ? verdict.kind
          : hasBoardCheckpoint
            ? ('heal-over-partial' as const)
            : ('fresh' as const);

        // The one path the climber DID ask for today: "Try the fast download
        // again", behind the same size-disclosing confirm the enable toggle
        // uses. It reads as consent for this one download, so it overrides the
        // metered defer below — without it the tap is a silent no-op on
        // cellular, because a settled scope always carries board checkpoints and
        // therefore always heals rather than bootstrapping fresh.
        const isUserRequested = retryState.userRequested;

        // The automatic heal is the one path that downloads ~100 MB for a board
        // the user enabled on some earlier day. Defer it on a metered link; a
        // fresh bootstrap (confirmed behind a size-disclosing dialog moments ago)
        // and a user-requested retry are consented and ignore the probe.
        if (bootstrapKind === 'heal-over-partial' && !isUserRequested && !(await isOnUnmeteredNetwork())) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, deferHeal(retryState, evaluatedAt));
          metadataSettled = true;
          if (retryState.retryAfter !== null) {
            onBootstrapRetryDue?.({ scopeKey: scope.scopeKey, retryAt: retryState.retryAfter });
          }
          continue;
        }

        // Spend the request BEFORE the download: one tap buys one artifact, so a
        // failure schedules an ordinary cooldown instead of leaving a standing
        // metered-link override that keeps pulling ~100 MB over cellular.
        if (isUserRequested) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, spendUserRequest(retryState));
          metadataSettled = true;
        }

        if (retryState.hasPriorSnapshotFailure) {
          options?.onBootstrapPathRecovered?.({
            scopeKey: scope.scopeKey,
            boardType: scope.boardType,
            trigger: isUserRequested
              ? 'user-request'
              : isRearmCandidate
                ? 'new-artifact'
                : migratedFromLegacy
                  ? 'legacy-migration'
                  : 'cooldown',
            hadBoardCheckpoint: hasBoardCheckpoint,
          });
        }

        // Started (issue #4316), the snapshot half. Emitted HERE — below every
        // `continue` that means this scope does no snapshot work this cycle, and
        // once the entry proved usable — so it can carry the artifact's wire
        // size, which is the one thing an ABANDONED download never gets to
        // report (it emits no Completed at all). The durable marker makes the
        // board-data loop's emission below a no-op for this scope; every path
        // that `continue`s above (including the metered heal defer) reaches that
        // one instead and is correctly attributed to the paged crawl.
        //
        // The guard is armed BEFORE the emission, not after: the emitter writes
        // the durable `scope-started:` marker, and a SQLite lock thrown between
        // that write and the event is the one window where a Started could be
        // owed a terminal event that no later cycle would ever emit (the marker
        // makes the emission once-ever).
        funnelGuard.arm(scope.scopeKey, 'download');
        await emitScopeDownloadStartOnce({
          scopeKey: scope.scopeKey,
          pathIntent: 'snapshot',
          artifactBytes: entry.bytes,
        });
        // Started fired on the line above, so a silent bail here is the tightest
        // possible dangling-Started window. Close it too (issue #4314).
        const preDownloadVerdict = teardownVerdict(scope.scopeKey);
        if (preDownloadVerdict) {
          reportBootstrapAbort(scope.scopeKey, 'download', preDownloadVerdict.reason, null);
          if (preDownloadVerdict.kind === 'cycle') {
            cycleInterrupted = true;
            break;
          }
          continue;
        }

        // Same key as the purge namespace, and the reason it is the namespace:
        // one artifact serves every size of a layout, so one purge maps 1:1 onto
        // the one native transfer that must die.
        const layoutKey = purgeNamespaceKey(scope);
        // The failure cause is cached alongside the result so a second size of the
        // same layout (which reuses this entry instead of re-downloading) still
        // reports the real error, not null.
        let cachedDownload = downloadByLayout.get(layoutKey);
        if (!cachedDownload) {
          // A const alias, not the `let` above: the teardown listener below
          // closes over it, and TypeScript widens a reassignable binding back to
          // `| undefined` inside a callback.
          const transfer: LayoutDownloadRecord = {
            file: null,
            cause: null,
            permanentMiss: false,
            downloadMs: 0,
            abortedReason: null,
            backgroundedDuringTransfer: false,
          };
          cachedDownload = transfer;
          // The rule this encodes (issue #4390): START new work only in the
          // foreground, NEVER kill work already in flight.
          //
          // A wipe / sign-out / board removal still cancels immediately — the
          // rows the artifact is for are being deleted, so its bytes are
          // worthless and a native session must not keep pulling ~100 MB for
          // them. A BACKGROUNDING does not: on iOS with a background URLSession
          // the transfer keeps running while the process is suspended, and on
          // Android the process simply stays alive. Cancelling here is what made
          // a 103 MB Kilter artifact restart from byte 0 on every screen lock.
          //
          // The decision is driven by the teardown EVENT, not by progress: a
          // stalled transfer emits no further progress, which is exactly the
          // case where cancelling matters most. The progress callback stays a
          // pure reporter apart from closing the suspension window below.
          const abortController = new AbortController();
          // LATCHED, unlike `isBackgrounded()` itself. The teardown flags are
          // live: a phone that woke, aborted a 100 MB transfer, and came back to
          // the foreground before the throw was handled read as "no teardown" at
          // the check below — and the download we cancelled ourselves was then
          // settled as a real transport failure, burning a bootstrap attempt and
          // scheduling a cooldown for a pocketed phone (review note on #4345).
          // Latching the reason at the moment we abort is what makes that race
          // unwinnable.
          let selfAbortedReason: SnapshotBootstrapFailureReason | null = null;
          // Open while an OS suspension might still be what kills this transfer.
          // CLOSED by the first byte delivered in the foreground: after that a
          // failure belongs to the network or the device, not to the pocket.
          // Without that closing rule, one screen lock during a nine-minute
          // Android transfer would launder every later wifi drop, HTTP 500 or
          // disk error into a free, cooldown-free 100 MB retry loop.
          let suspensionWindowOpen = false;
          // SCOPE-AWARE, and the single biggest user-visible win of #4370: a
          // purge of a DIFFERENT layout returns null here, so the multi-minute
          // transfer this board is in the middle of is not cancelled.
          const onTeardownNotice = (): void => {
            const verdict = teardownVerdict(scope.scopeKey);
            if (!verdict) return;
            if (verdict.reason === 'aborted-background') {
              transfer.backgroundedDuringTransfer = true;
              suspensionWindowOpen = true;
              return;
            }
            selfAbortedReason ??= verdict.reason;
            abortController.abort();
          };
          const unsubscribeTeardown = onTeardown(onTeardownNotice);
          // Covers a teardown that landed between the guard check above and the
          // subscription: the listener only sees transitions after this point.
          onTeardownNotice();
          // Stage 2 of 3, the multi-minute one. A second SIZE of the same layout
          // reuses this cache entry, so it never re-runs and never re-emits
          // download frames for bytes that already came down.
          let fractionAnchor: DownloadFractionAnchor = createDownloadFractionAnchor();
          const downloadStartedAt = Date.now();
          emitSnapshotFrame(
            progressThrottle.flush({
              scopeKey: scope.scopeKey,
              stage: 'download',
              fraction: 0,
              wireBytes: entry.bytes,
              wireBytesDone: 0,
            }),
          );
          try {
            cachedDownload.file =
              (await source.downloadArtifact(entry, {
                signal: abortController.signal,
                onProgress: ({ bytesWritten, totalBytes }) => {
                  // A byte arrived while nothing is tearing us down: this
                  // transfer demonstrably survived the pocket, so a later
                  // failure is not the suspension's doing (issue #4390).
                  if (suspensionWindowOpen && !teardownVerdict(scope.scopeKey)) suspensionWindowOpen = false;
                  const resolved = resolveDownloadFraction({
                    entry,
                    bytesWritten,
                    reportedTotalBytes: totalBytes,
                    anchor: fractionAnchor,
                  });
                  fractionAnchor = resolved.anchor;
                  emitSnapshotFrame(
                    progressThrottle.offer({
                      scopeKey: scope.scopeKey,
                      stage: 'download',
                      fraction: resolved.fraction,
                      ...toWireProgress(resolved.fraction, entry.bytes),
                    }),
                  );
                },
              })) ?? null;
          } catch (error) {
            cachedDownload.cause = error;
            cachedDownload.permanentMiss = error instanceof SnapshotPermanentMissError;
          } finally {
            unsubscribeTeardown();
          }
          // Only when the transfer actually died. A download that finished
          // despite a teardown landing late is still importable, and calling it
          // an abort here would throw away bytes that are already on disk.
          //
          // Two ways a dead transfer counts as a pause rather than a failure:
          // we cancelled it ourselves (a wipe — latched, so a cleared flag
          // cannot relabel it), or the OS suspension plausibly killed it. The
          // second test is deliberately narrow: the suspension window must still
          // be open (no byte since the app backgrounded) AND the cause must be
          // transport-shaped: either a network loss/timeout or iOS background
          // URLSession's exact response-decoding interruption. A disk-full,
          // HTTP 500, or programmer error still spends its real budget.
          if (!cachedDownload.file) {
            const suspensionKilledTransfer =
              suspensionWindowOpen &&
              (isNetworkError(cachedDownload.cause) || isBackgroundTransferDecodeError(cachedDownload.cause));
            cachedDownload.abortedReason =
              selfAbortedReason ?? (suspensionKilledTransfer ? 'aborted-background' : null);
          }
          cachedDownload.downloadMs = Date.now() - downloadStartedAt;
          downloadByLayout.set(layoutKey, cachedDownload);
          // Registered even on the reuse path: the phase still owns the file for
          // the rest of the cycle and must hand it back through releaseArtifact.
          if (cachedDownload.file) artifactImported.set(cachedDownload.file.filePath, false);
          if (cachedDownload.file) {
            bootstrapTimings.set(scope.scopeKey, {
              bytes: entry.bytes,
              downloadMs: cachedDownload.downloadMs,
            });
          }
        }
        // Only the scope that actually fetched it pays the download time; a
        // second size of the same layout reuses the file for free and its own
        // breakdown correctly shows downloadMs 0.
        phases.downloadMs += cachedDownload.downloadMs;
        cachedDownload.downloadMs = 0;
        // Re-check after the (potentially multi-MB) artifact download await, same
        // reason as the manifest check above.
        //
        // This is the bail that swallowed the field reports behind issue #4314: a
        // 100 MB Kilter transfer aborted by a board removal elsewhere in the app
        // landed here and returned nothing, so the funnel showed a Started with no
        // terminal event and the climber saw the download silently restart.
        //
        // `abortedReason` is the latched half: WE cancelled this transfer, so it
        // is an abort even if the flag that caused it has since cleared. Without
        // it a phone that unlocked at the wrong moment charged itself a transport
        // failure (and a 2-minute cooldown) for its own cancellation.
        //
        // A LATCHED self-abort whose flag has since cleared is treated as
        // `kind: 'cycle'` deliberately — conservative, and it cannot emit a
        // second terminal event for the same Started.
        const downloadVerdict =
          teardownVerdict(scope.scopeKey) ??
          (cachedDownload.abortedReason ? { reason: cachedDownload.abortedReason, kind: 'cycle' as const } : null);
        if (downloadVerdict) {
          const downloadTeardown = downloadVerdict.reason;
          // A transfer that FINISHED is never a pause — the file is on disk, the
          // source's sidecar is written, and the next foreground cycle reuses it
          // for free (issue #4310). Only a dead transfer costs anything.
          //
          // The free path is bounded (issue #4390). Before this, a self-aborted
          // background transfer was free with no bound at all: a device that can
          // never finish the unresumable GET re-fetched ~100 MB on every
          // foreground, forever. Three per scope stay free; the fourth is
          // charged to the TRANSPORT budget on its ladder, so the pattern
          // terminates at 3 free + 3 transport and the board still arrives via
          // the paged crawl.
          if (downloadTeardown === 'aborted-background' && !cachedDownload.file) {
            const pause = recordBackgroundPause({
              state: retryState,
              builtAt: entry.builtAt,
              now: evaluatedAt,
              random,
            });
            retryState = await writeBootstrapRetryState(db, scope.scopeKey, pause.state);
            metadataSettled = true;
            if (pause.charged) {
              // Still `aborted: true` — the climber's phone went in a pocket,
              // that is what happened — but `attempt` tells the truth about the
              // budget, exactly as reportSettledFailure spells it, and the retry
              // ladder now applies.
              onSnapshotBootstrapError?.({
                scopeKey: scope.scopeKey,
                stage: 'download',
                attempt: retryState.transportFailures,
                cause: cachedDownload.cause,
                expected: true,
                aborted: true,
                reason: 'aborted-background',
              });
              options?.onBootstrapRetryScheduled?.({
                scopeKey: scope.scopeKey,
                boardType: scope.boardType,
                stage: 'download',
                failureKind: 'transport',
                retryAfterMs:
                  isTerminal(retryState) || retryState.retryAfter === null
                    ? 0
                    : Math.max(0, retryState.retryAfter - evaluatedAt),
                transportFailures: retryState.transportFailures,
                lockFailures: retryState.lockFailures,
                structuralFailures: retryState.structuralFailures,
                terminal: isTerminal(retryState),
              });
              if (!isTerminal(retryState) && retryState.retryAfter !== null) {
                onBootstrapRetryDue?.({ scopeKey: scope.scopeKey, retryAt: retryState.retryAfter });
              } else {
                onBootstrapRetryCleared?.(scope.scopeKey);
              }
              if (isTerminal(retryState)) await markBootstrapPagedFallback(db, scope.scopeKey);
            } else {
              reportBootstrapAbort(scope.scopeKey, 'download', downloadTeardown, cachedDownload.cause);
            }
          } else {
            reportBootstrapAbort(scope.scopeKey, 'download', downloadTeardown, cachedDownload.cause);
          }
          // A purge of ONLY this scope's namespace stops this board and leaves
          // every other download in the cycle running (issue #4370).
          if (downloadVerdict.kind === 'cycle') {
            cycleInterrupted = true;
            break;
          }
          continue;
        }
        const download = cachedDownload.file;
        if (!download) {
          if (cachedDownload.permanentMiss) {
            // A permanent miss at the DOWNLOAD stage is not free the way a
            // missing manifest entry is: the ~100 MB is already down the wire
            // (mobile only raises it after the artifact lands and turns out to
            // still be gzip-compressed). Before heal-over-partial only a
            // checkpoint-free scope could reach this line, so the crawl's first
            // checkpoint ended the loop by itself. A checkpointed incomplete
            // scope is eligible again after cooldown, so leaving it uncharged
            // would re-download the same unusable artifact forever. It burns the
            // DEVICE budget — nothing about bytes already on disk is a network
            // problem, and a nightly rebuild cannot fix an HTTP stack that will
            // not decode them — but the crawl still runs this cycle, which is
            // what "permanent miss" has always meant.
            const settled = await settleBootstrapFailure(db, scope.scopeKey, {
              state: retryState,
              cause: cachedDownload.cause,
              stage: 'download',
              builtAt: entry.builtAt,
              now: evaluatedAt,
              random,
            });
            retryState = settled.state;
            // Overrides settleBootstrapFailure's non-terminal clear: this
            // decision is already durable — the crawl is what serves the scope
            // now — so My Boards should say so instead of waiting a cycle.
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            reportSettledFailure(scope, 'download', settled, evaluatedAt);
            continue;
          }
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: cachedDownload.cause,
            stage: 'download',
            builtAt: entry.builtAt,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          metadataSettled = true;
          reportSettledFailure(scope, 'download', settled, evaluatedAt);
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          continue;
        }

        // The artifact came down: the link works, so the consecutive-transport
        // counter (and any cooldown it scheduled) no longer describes anything.
        //
        // This runs for a RETAINED artifact too, where `download.reused` is true
        // and no bytes moved — which is precisely why a lock-contention import
        // failure gets its own `lockFailures` budget rather than riding transport
        // (issue #4310). On the transport budget this line would reset it every
        // cycle, so it could never reach its cap, the scope would never go
        // terminal, and `shouldSkipPagedPull` would keep skipping the crawl on
        // the ~2-minute cooldown — a board unreachable by both paths.
        const withTransportCleared = clearTransportFailures(retryState);
        if (withTransportCleared !== retryState) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, withTransportCleared);
          metadataSettled = true;
        }

        // Stage 3 of 3, and determinate since #4310: the import commits in
        // bounded batches, so there IS a safe place to emit from between them.
        // The guard moves first so anything thrown from here on — including the
        // progress consumer on the next line — is attributed to the import.
        funnelGuard.enterStage('import');
        // The denominator is the artifact's LAYOUT-wide row count, which is what
        // `verifySnapshotMeta` already read; a size-scoped Kilter scope therefore
        // tops out below 1 (around 0.97 for size 10, lower for a small size)
        // before the terminal frame below takes it to 1. The honest alternative
        // is two more full COUNT(*) scans over the artifact, inside the very
        // phase this PR exists to shrink. Clamped, so it can never exceed 1.
        const importRowsTotal = entry.tables.board_climbs.rowCount + entry.tables.board_climb_stats.rowCount;
        // Swallows, and that is load-bearing. Unlike the stage-entry frame below
        // — which sits OUTSIDE the import's try/catch and charges nothing — these
        // fire from INSIDE it, where an escaping throw from a progress consumer
        // would be indistinguishable from an import failure: a spent structural
        // budget slot and, on the retained-artifact path, a deleted ~103 MB file.
        // Same discipline as `runLocalWriteWithRetry`'s `onSettled` and the
        // drainer's `onMutationStatusError`.
        const emitImportFraction = (fraction: number | null): void => {
          try {
            emitSnapshotFrame(
              progressThrottle.offer({
                scopeKey: scope.scopeKey,
                stage: 'import',
                fraction,
                wireBytes: entry.bytes,
                wireBytesDone: null,
              }),
            );
          } catch {
            // A broken progress sink must never be reported as a failed import.
          }
        };
        const emitImportProgress = (rowsImported: number): void => {
          emitImportFraction(importRowsTotal > 0 ? Math.min(1, rowsImported / importRowsTotal) : null);
        };
        emitSnapshotFrame(
          progressThrottle.flush({
            scopeKey: scope.scopeKey,
            stage: 'import',
            fraction: importRowsTotal > 0 ? 0 : null,
            wireBytes: entry.bytes,
            wireBytesDone: null,
          }),
        );

        phases.artifactBytes = entry.bytes;
        phases.artifactReused = download.reused === true;
        const importStartedAt = Date.now();
        try {
          // Imports the scope's rows in bounded batches, then stamps both table
          // checkpoints and rewinds the global deletions cursor to the artifact's
          // safe deletion boundary (or the older scoped-table watermark for
          // legacy artifacts) — those three together in the FINAL transaction,
          // after every row batch has committed.
          //
          // Not one transaction any more (issue #4310), so a crash CAN leave rows
          // without markers. That direction is benign: the re-import is
          // idempotent and a teardown still removes them. The direction that is
          // unrecoverable — a stamped cursor the strict `>` delta pull will never
          // revisit, with no rows behind it — is what the checkpoints-last
          // ordering rules out, and the deletions rewind rides in the same
          // transaction so the tombstone-replay window can never be narrower
          // than the rows it must cover.
          const imported = await bootstrapScopeFromSnapshot({
            db,
            scope,
            scopeKey: scope.scopeKey,
            filePath: download.filePath,
            onSchemaDrift,
            // Arms the watermark-regression guard on the heal path: the artifact
            // may not stamp a checkpoint BELOW what this scope already crawled.
            existingCheckpoints: hasBoardCheckpoint
              ? { board_climbs: climbsCheckpoint ?? undefined, board_climb_stats: statsCheckpoint ?? undefined }
              : undefined,
            onBatch: ({ rowsImported }) => emitImportProgress(rowsImported),
          });
          // The bar tops out at the layout-wide denominator's ceiling, so close
          // it explicitly at the stage boundary rather than leaving a scoped
          // download parked at 0.31 while the grades transaction runs.
          emitImportFraction(1);
          const timings = bootstrapTimings.get(scope.scopeKey) ?? { bytes: entry.bytes };
          bootstrapTimings.set(scope.scopeKey, {
            ...timings,
            importMs: Date.now() - importStartedAt,
            rowCount: imported.climbsImported + imported.statsImported,
          });
          phases.importMs += Date.now() - importStartedAt;
          // Accumulated, not assigned, for the same reason `importMs` is: one
          // cycle can import several scopes of the same layout. `importLockMaxMs`
          // is a MAX rather than a sum — it answers "what is the worst hold a
          // concurrent write had to survive", which does not add up across scopes.
          phases.importVerifyMs = (phases.importVerifyMs ?? 0) + imported.importVerifyMs;
          phases.importReconcileMs = (phases.importReconcileMs ?? 0) + imported.importReconcileMs;
          phases.importRowsMs = (phases.importRowsMs ?? 0) + imported.importRowsMs;
          phases.importLockMaxMs = Math.max(phases.importLockMaxMs ?? 0, imported.importLockMaxMs);
          phases.importLockWaitMs = (phases.importLockWaitMs ?? 0) + imported.importLockWaitMs;
          phases.importBatches = (phases.importBatches ?? 0) + imported.importBatches;
          artifactImported.set(download.filePath, true);
          // The scope imported an artifact, so any free-round marker it carries
          // describes a build that no longer matters.
          await clearReusedImportFailure(db, scope.scopeKey);
          // The heal flag rides the persisted marker, not a per-cycle set: the
          // scope usually reaches completion in a LATER cycle (board_climb_grades
          // is not a snapshot table and still crawls), and an in-memory set
          // reports false for exactly the runs the flag exists to filter out.
          await markBootstrapDone(db, scope.scopeKey, { healed: hasBoardCheckpoint });
          metadataSettled = true;
          // The one settlement the guard cannot infer from a report: the scope's
          // terminal event is the Completed the board-data loop fires once the
          // delta pull reaches every table's tail — possibly cycles from now, on
          // Kilter usually after the grades crawl. Nothing failed, so nothing
          // should be reported.
          funnelGuard.settle(scope.scopeKey);
          // Bust the board-table query caches now: if the snapshot fully satisfies
          // the scope, the delta pull returns zero documents and syncTable's
          // arrivals-only invalidation never fires — an active search/detail query
          // would keep serving the pre-import (empty) result set.
          for (const tableName of ['board_climbs', 'board_climb_stats'] as const) {
            for (const key of TABLE_CONFIGS[tableName].invalidateKeys) {
              queryClient.invalidateQueries({ queryKey: key });
            }
          }
          // Grades ride a second, small artifact and a second short exclusive
          // transaction, right after the climbs/stats one. See
          // importGradesForScope — every failure here is free.
          const gradesVerdict = await importGradesForScope(scope, entry);
          if (gradesVerdict === 'cycle') {
            cycleInterrupted = true;
            break;
          }
          if (gradesVerdict === 'scope') continue;
          // Not skipped: the board-data phase delta-pulls from the watermark
          // checkpoints and fires markScopeDownloadComplete through the tail logic.
        } catch (error) {
          phases.importMs += Date.now() - importStartedAt;
          // A wipe mid-import rolls the transaction back and bails the phase — no
          // burn (the pull is being torn down, not failing). Reported all the
          // same, so the scope's Started is not left dangling (issue #4314).
          //
          // A SnapshotWipedError carries no kind, so derive it: the epoch is
          // monotonic, so a scope-purge-raised one still reads `kind: 'scope'`
          // at catch time. The `?? cycle` arm is the unreachable-conservative
          // default that matches the pre-#4370 `break`.
          const importVerdict =
            error instanceof SnapshotWipedError
              ? (teardownVerdict(scope.scopeKey) ?? { reason: 'aborted-wipe' as const, kind: 'cycle' as const })
              : teardownVerdict(scope.scopeKey);
          if (importVerdict) {
            reportBootstrapAbort(scope.scopeKey, 'import', importVerdict.reason, error);
            if (importVerdict.kind === 'cycle') {
              cycleInterrupted = true;
              break;
            }
            continue;
          }
          if (error instanceof SnapshotSchemaStaleError) {
            // Permanent miss for this run, no burn: the artifact predates this
            // client's schema and tonight's export rebuilds it at the new one, so
            // the next cycle's cheap manifest pre-check (isSnapshotEntryUsable)
            // filters it out before any bytes move. The scope's paged pull runs
            // NOW, which is always correct.
            //
            // The watermark regression deliberately does NOT land here — it is a
            // structural failure, charged below. Refusing without recording the
            // refusal left the scope exactly as eligible as it was, so the same
            // ~100 MB artifact came down again on every cycle, forever.
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            onSnapshotBootstrapError?.({
              scopeKey: scope.scopeKey,
              stage: 'import',
              attempt: 0,
              cause: error,
              expected: false,
            });
            continue;
          }
          // A RETAINED artifact that fails to import gets ONE round that spends
          // no budget. Retention keeps the same file across cycles, so charging
          // the first failure would spend the structural-artifact budget twice
          // against the same bad bytes and settle the scope onto the paged crawl
          // for good — recreating exactly the #4313 failure retention is meant to
          // prevent.
          //
          // The free round is granted at most once per (scope, artifact build),
          // and the marker is what bounds it. Deleting the file is best-effort on
          // every platform — mobile's `safeDeleteFile` swallows its errors — so
          // "the next cycle re-downloads fresh" is a hope, not a guarantee: a
          // file that survives with its sidecar comes back as `reused: true` and
          // would otherwise buy another free round every cycle, forever, with a
          // fresh scope skipping its paged pull each time. The second failure on
          // the same build falls through to the counted structural path below.
          // A lost lock race is not a bad artifact (issue #4310). Batching turned
          // one lock acquisition into ~143, so this arm — which DELETES the
          // ~103 MB file and spends the once-per-build free round — must not
          // fire for contention. `classifyBootstrapFailure` routes the same
          // failure to its own `lockFailures` budget below, which is bounded at
          // `MAX_BOOTSTRAP_LOCK_FAILURES` and, unlike transport, is NOT reset by
          // the next cycle's zero-byte reuse of this very file.
          const importLostTheLock = classifySqliteLockError(error).locked;
          if (
            !importLostTheLock &&
            download.reused &&
            (await getReusedImportFailure(db, scope.scopeKey)) !== entry.builtAt
          ) {
            await recordReusedImportFailure(db, scope.scopeKey, entry.builtAt);
            await source.deleteArtifact(download.filePath).catch(() => {});
            artifactImported.delete(download.filePath);
            downloadByLayout.delete(layoutKey);
            metadataSettled = true;
            onSnapshotBootstrapError?.({
              scopeKey: scope.scopeKey,
              stage: 'import',
              attempt: 0,
              cause: error,
              expected: false,
            });
            // Same grace-window rule as every other failure arm: only a fresh,
            // non-terminal scope waits a cycle for the retry. A scope that already
            // holds rows always crawls.
            if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
              skipPagedPull.add(scope.scopeKey);
            }
            continue;
          }
          // The bytes are already on disk, so nothing about this failure is a
          // network problem: it burns the structural budget, and a differently
          // built artifact is the only thing that can re-arm it. A watermark
          // regression is charged here too — the artifact on offer provably
          // cannot serve this scope, and only a rebuilt one (with a watermark
          // past the local checkpoint, or a fixed scope filter) can change that.
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: error,
            stage: 'import',
            builtAt: entry.builtAt,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          metadataSettled = true;
          reportSettledFailure(scope, 'import', settled, evaluatedAt);
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
        }
      } catch (error) {
        // Everything between the Started emission and the import's own try sits
        // OUTSIDE any catch: ~15 awaited SQLite writes (the retry-state writes,
        // the paged-fallback markers, `clearTransportFailures` right after a
        // 100 MB transfer lands) plus two consumer callbacks. A single
        // SQLITE_BUSY on any of them unwound the whole phase in silence — the
        // leading candidate for the device that emitted six Starteds and nothing
        // else. Reported, classified, then rethrown: the control flow is
        // unchanged, only the silence is gone.
        funnelGuard.settleUncaught(error);
        throw error;
      } finally {
        // A native callback may arrive after this scope has settled while the
        // phase is already working on another board. Cancel here so it cannot
        // re-light the old row or contaminate the next scope's progress state.
        progressThrottle.cancel();
        // Un-bypassable: a `break` or `continue` a future change adds below the
        // Started emission closes the funnel here whether or not it remembers to.
        funnelGuard.close();
        if (metadataSettled) onBootstrapMetadataChanged?.({ scopeKey: scope.scopeKey });
      }
    }
  } finally {
    // Hand every artifact back rather than deleting it outright. A source with
    // no retention support falls through to deleteArtifact and behaves exactly
    // as it did before #4310; a retention-capable one keeps the files the phase
    // never got to import, so a backgrounded cycle no longer costs 100 MB.
    for (const [filePath, imported] of artifactImported) {
      const release = source.releaseArtifact
        ? source.releaseArtifact(filePath, { imported })
        : source.deleteArtifact(filePath);
      await release.catch(() => {});
    }
    // Deleted, never released: see gradesArtifactPaths. Deterministic on every
    // exit path — imported, failed, or torn down — so a grades file can never
    // outlive the cycle that fetched it.
    for (const filePath of gradesArtifactPaths) {
      await source.deleteArtifact(filePath).catch(() => {});
    }
  }

  return { skipPagedPull, cycleInterrupted };
}

/**
 * Deletions-coverage guard: force a from-scratch user-data resync when this
 * device went longer than the tombstone retention window without completing a
 * deletions pull, so tombstones it never saw are already pruned server-side
 * (issue #3474).
 *
 * Three of the four verdicts do NOTHING AT ALL — no reset, and no stamp either.
 * The marker is written in exactly one place, after the deletions pull below
 * reaches its tail, because that is the only moment coverage is actually
 * established. Claiming it here would be a lie a failed or backgrounded first
 * pull could never take back:
 *  - `unknown` (no marker, or one below the plausibility floor): the key is new,
 *    so EVERY existing install lacks it on the first launch after the update,
 *    and there is no persisted last-sync wall clock to seed from (mobile's
 *    lastSyncedAt is an in-memory store that resets each launch). Treating
 *    absence as "stale" would detonate a fleet-wide reset on the rollout. A
 *    device that has ALREADY been away longer than the window therefore keeps
 *    its stale rows — status quo, not a regression, and the only design that
 *    cannot mass-wipe the fleet on rollout. It stays `unknown` until a pull
 *    actually completes, so a device that can never finish one never claims a
 *    window it did not have.
 *  - `future` (marker dated after now): a clock corrected backwards. The
 *    completed-pass stamp overwrites it with a real `now`, which unfreezes it
 *    without inventing coverage on a cycle that failed.
 *  - `fresh`: the common path — one sync_meta read and nothing else.
 *
 * A `stale` verdict PROBES the network before touching anything. pullSync runs
 * on every foreground, including offline ones; wiping first and only then
 * discovering there is no connection would leave the user staring at an empty
 * app until connectivity returns. The probe is a one-row syncDeletions request
 * whose result is discarded — it proves reachability AND the credential, so an
 * expired-token device can't wipe itself either. A throw propagates to the
 * scheduler's catch, which retries on the next trigger with local data intact.
 *
 * `beginGlobalPurge()` is deliberately NOT called: it bumps the global wipe
 * epoch, which would abort the very cycle that is supposed to rebuild. It isn't
 * needed here — the scheduler single-flights pullSync, so no other pull page is
 * on the wire, and the drainer writes only to pending_mutations, which this
 * reset never touches.
 */
async function enforceDeletionsCoverage(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  purgeToken: PurgeToken,
  options?: SyncOptions,
): Promise<void> {
  // Sign-out is (or is about to be) wiping local user data on its own terms;
  // don't write sync_meta into a DB mid-teardown, and don't spend a probe on an
  // account that is going away. Its deleteUserCheckpoints drops the coverage
  // marker and rewinds the deletions cursor to the epoch anyway, so the next
  // signed-in pull re-reads the whole retained tombstone window and re-stamps.
  if (isSigningOut()) return;

  // One clock reading for the whole decision. The probe below is a network
  // round-trip, so re-reading Date.now() after it would report a marker age
  // that isn't the one the verdict was made on.
  const evaluatedAt = Date.now();
  const coverageAt = await getDeletionsCoverageAt(db);
  const verdict = evaluateDeletionsCoverage(coverageAt, evaluatedAt);

  // floor, not round, everywhere this age is reported: a 79.6-day marker must
  // not read as 80 (the threshold value) when the decision was made on exact
  // milliseconds.
  //
  // Null for the two verdicts whose age is not a coverage age. That is a data
  // rule, not cosmetics: `future` is a marker dated after now (a clock
  // corrected backwards) and would report a NEGATIVE age, and `unknown` covers
  // both an absent marker AND one below DELETIONS_COVERAGE_EPOCH_FLOOR_MS (a
  // phone that booted to 1970 before NTP landed), which would report ~20,000
  // days. Either value poisons an average or a percentile over this property.
  const markerAgeDays =
    coverageAt === null || verdict === 'unknown' || verdict === 'future'
      ? null
      : Math.floor((evaluatedAt - coverageAt) / 86_400_000);

  // Reported BEFORE the early return below, so `unknown` and `future` are
  // first-class values rather than silence. That is the whole point: the
  // devices that never complete a deletions pull are the at-risk population,
  // and a reset-only instrument can never see them.
  options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'evaluated' });

  // Only 'stale' does anything. Keeping the explicit `coverageAt === null`
  // disjunct means an absent marker can never structurally reach the wipe below,
  // whatever the classifier is later taught to return — and it narrows
  // coverageAt to a number, so markerAgeDays needs no fallback for a case that
  // cannot happen.
  // (markerAgeDays is null for every verdict except `fresh` and `stale`;
  // naming it in the guard narrows it to a number for the reset report below.)
  if (coverageAt === null || markerAgeDays === null || verdict !== 'stale') return;

  // Reachability + auth probe. Its payload is irrelevant; only "did it resolve"
  // matters, so it asks for a single row. A rejection is reported and then
  // RETHROWN unchanged: the throw is what leaves local data intact and defers
  // to the next cycle, and swallowing it here would wipe a stale device's user
  // data without a verified connection — the exact catastrophe the probe exists
  // to prevent.
  try {
    await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, { cursor: undefined, limit: 1 });
  } catch (error) {
    options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'probe_failed' });
    throw error;
  }

  // Re-check the teardown flags after the network await — the probe may have
  // been in flight across a sign-out, a global wipe, or a backgrounding, and
  // none of them wants a multi-table DELETE dispatched at it.
  //
  // GLOBAL only (issue #4370). This used to compare a global epoch that a board
  // removal moved too, with the reasoning "a board removal is about to abort
  // this cycle at its first cycleAborted(), so a wipe here would clear user data
  // with no rebuild behind it". A board purge no longer aborts the cycle, so the
  // rebuild does happen — and a stale-coverage device stops skipping its reset
  // because somebody removed a board.
  if (isSigningOut() || isBackgrounded() || hasPurgeLanded(purgeToken)) return;

  const pendingMutations = await getPendingCount(db);
  // The STAMP is read fresh — it claims coverage as of the wipe itself, which is
  // after the probe. Only the reported age below uses the decision's clock.
  const { rowsCleared } = await resetUserDataForLostCoverage(db, Date.now());

  // Bust every user-data cache the wipe just invalidated. The rebuild below
  // cannot be relied on to do it: syncTable only invalidates when it pulled at
  // least one document and processDeletions only on arrivals, so a table the
  // user had emptied server-side re-pulls nothing and a mounted screen would
  // keep serving the pre-wipe react-query cache — the exact #3474 symptom
  // surviving the fix. Deduped by serialized key, same shape as processDeletions.
  const invalidatedKeys = new Set<string>();
  for (const tableName of USER_DATA_TABLES) {
    for (const key of TABLE_CONFIGS[tableName].invalidateKeys) {
      invalidatedKeys.add(JSON.stringify(key));
    }
  }
  for (const serializedKey of invalidatedKeys) {
    queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as string[] });
  }

  options?.onCoverageReset?.({ markerAgeDays, rowsCleared, pendingMutations });
  // Alongside the reset event, not instead of it: onCoverageReset stays the
  // dedicated "a wipe happened" signal, while the verdict stream carries the
  // denominator that makes its rate readable.
  options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'reset' });
}

export async function pullSync(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  options?: SyncOptions,
): Promise<void> {
  let totalDocuments = 0;
  const reportInterruptedCycle = (): undefined => {
    options?.onProgress?.({
      phase: 'idle',
      currentTable: null,
      documentsProcessed: totalDocuments,
      interrupted: true,
    });
    return undefined;
  };

  // Mirrors drainMutationQueue's entry guard: don't even start the snapshot
  // bootstrap phase below (which runs before the first cycleAborted() check)
  // when the app is already backgrounded.
  if (isBackgrounded()) return reportInterruptedCycle();

  // Offline: every request this cycle would make is already lost, and the
  // bootstrap phase would spend a Sentry event per enabled-but-undownloaded
  // scope announcing it (issue #4238). Skip; the scheduler's offline→online
  // edge and the next foreground both retrigger a cycle. Same posture as
  // drainMutationQueue's `if (!options.isOnline()) return`.
  const isOnline = options?.isOnline ?? (() => true);
  if (!isOnline()) return reportInterruptedCycle();

  // Captured ONCE for the whole cycle and threaded into every phase, so a wipe or a
  // purge aborts exactly the work it can invalidate rather than just whichever table
  // is mid-flight. The token carries the global epoch AND a copy of every
  // per-namespace purge epoch, so one capture answers for every scope this cycle
  // will touch (issue #4370).
  //
  // Capturing once matters because `enabledBoards` is a snapshot taken before the
  // cycle began. Removing a board (see removeBoardScopeData) drops it from that
  // setting and bumps that namespace's epoch — but this cycle is still iterating the
  // STALE list. If each table re-baselined its own token, every table after the one
  // that aborted would capture the post-bump value, sail through its guard, and
  // happily re-download the scope whose rows are being deleted right now, writing
  // checkpoints past them. The user taps Remove and the catalog comes back.
  //
  // Sign-out never hit this because `isSigningOut()` is a persistent flag that stays
  // true for every subsequent table; the epoch alone is not a substitute for it.
  //
  // Captured immediately after the entry guard and BEFORE the coverage phase's
  // awaits: that phase can spend a network probe plus a multi-table wipe, and a
  // purge landing inside that window must read as "not my token" rather than be
  // adopted as this cycle's own baseline.
  const purgeToken = capturePurgeToken();
  // GLOBAL: sign-out, a global wipe, backgrounding, or connectivity loss. A board
  // purge is deliberately absent — it cannot invalidate the user tables, the
  // deletions cursor, or another board's rows, so it ends that scope's work
  // (`scopePurged` below) and nothing else.
  //
  // Unlike the other two checks, isBackgrounded() and isOnline() are live, not latched —
  // a background dip (or a connectivity blip) that clears before the next check runs
  // won't abort a cycle it can no longer affect. Connectivity is checked between phases
  // rather than inside the bootstrap phase deliberately: an artifact that finished
  // downloading must still get imported, and re-downloading 272 MB because NetInfo
  // flapped during the import would be the worse failure.
  const cycleAborted = (): boolean => isSigningOut() || hasPurgeLanded(purgeToken) || isBackgrounded() || !isOnline();
  /** Was THIS scope's namespace purged since the cycle started? Then skip it, only it. */
  const scopePurged = (scope: BoardScope): boolean => hasPurgeLanded(purgeToken, purgeNamespaceKey(scope));

  // Phase -1: deletions-coverage guard (issue #3474). Runs BEFORE the bootstrap
  // phase, so the reset and the rebuild that follows belong to the same cycle.
  // See deletions-coverage.ts for the invariant and for exactly what the reset
  // does (and does not) clear.
  await enforceDeletionsCoverage(db, queryClient, graphqlFetch, purgeToken, options);
  // The phase can spend a probe and a multi-table wipe; the bootstrap phase below
  // starts downloading before the deletions phase's own cycleAborted(), so check
  // here rather than let a teardown that landed during it kick off a download.
  if (cycleAborted()) return reportInterruptedCycle();

  const enabledBoards = options?.enabledBoards ?? [];
  const onProgress = options?.onProgress;

  // Parse the enabled scope keys once; malformed keys are dropped (a stray value
  // can't crash the pull) so both the bootstrap phase and the paged board loop
  // iterate the same validated set.
  const boardScopes: BoardScope[] = [];
  for (const scopeKey of enabledBoards) {
    const scope = parseOfflineBoardKey(scopeKey);
    if (scope) boardScopes.push({ ...scope, scopeKey });
  }

  // Per-scope start timestamp for ScopeDownloadCompleteInfo.durationMs, stamped
  // when the cycle FIRST touches that scope (bootstrap eligibility check, or
  // its turn in the board-data loop) — NOT once at cycle start, which would
  // fold scope A's entire download time into scope B's duration whenever a
  // cycle processes several boards.
  //
  // PERSISTED (issue #4310), not just held here: a 100 MB Kilter artifact
  // routinely spans cycles — the phone backgrounds, the scheduler wakes again —
  // and a per-run Map made every one of those report only the final cycle's
  // work. The in-memory Map is now a read-through cache over the sync_meta
  // stamp so a cycle costs at most one extra SELECT per scope.
  const scopeStartedAt = new Map<string, number>();
  const stampScopeStart = async (scopeKey: string): Promise<void> => {
    if (scopeStartedAt.has(scopeKey)) return;
    scopeStartedAt.set(scopeKey, await ensureScopeDownloadStartedAt(db, scopeKey, Date.now()));
  };

  // Per-scope phase breakdown for ScopeDownloadCompleteInfo.phases, accumulated
  // across this cycle's bootstrap phase and board-data loop.
  const phasesByScope = new Map<string, ScopeDownloadPhaseBreakdown>();
  const phaseTimings = (scopeKey: string): ScopeDownloadPhaseBreakdown => {
    let phases = phasesByScope.get(scopeKey);
    if (!phases) {
      phases = emptyScopeDownloadPhases();
      phasesByScope.set(scopeKey, phases);
    }
    return phases;
  };

  // Download-funnel Started (issue #4316). Once ever per scope, guarded by the
  // durable `scope-started:` marker rather than by anything cycle-local, so a
  // snapshot that fails and retries emits one event and a paged crawl that spans
  // cycles is not skipped. Both are how the naive in-cycle version broke.
  const emitScopeDownloadStartOnce = async (info: ScopeDownloadStartInfo): Promise<void> => {
    if (await isScopeDownloadStarted(db, info.scopeKey)) return;
    await markScopeDownloadStarted(db, info.scopeKey);
    // BACKFILL, NOT A START. A scope whose download already completed — every
    // board on a device that upgrades into this build — is not starting one now,
    // and it can never emit Completed again either (that event is guarded by the
    // `scope-complete:` marker it already carries). Emitting here would give the
    // funnel one unmatched Started per already-downloaded board on the first
    // cycle after release: a phantom abandonment spike, in exactly the window
    // the baseline is read from. Write the marker (so this is still once-ever)
    // and stay silent.
    if (await isScopeDownloadComplete(db, info.scopeKey)) return;
    options?.onScopeDownloadStart?.(info);
  };
  // Per-scope payload size and stage timings, recorded by the bootstrap phase and
  // read back by Completed below. Run-local on purpose: a cycle that did not do
  // the import has nothing honest to report (see ScopeDownloadCompleteInfo).
  const bootstrapTimings = new Map<
    string,
    { bytes: number; downloadMs?: number; importMs?: number; rowCount?: number }
  >();

  // Phase 0: snapshot bootstrap (BEFORE deletions). Only when an adapter injected
  // snapshot I/O; otherwise this is a pure paged pull, byte-identical to before.
  let skipBootstrapPagedPull: Set<string> = new Set();
  if (options?.snapshotSource && boardScopes.length > 0) {
    onProgress?.({ phase: 'bootstrap', currentTable: null, documentsProcessed: 0 });
    const bootstrapPhase = await runBootstrapPhase({
      db,
      queryClient,
      source: options.snapshotSource,
      scopes: boardScopes,
      purgeToken,
      stampScopeStart,
      emitScopeDownloadStartOnce,
      bootstrapTimings,
      phaseTimings,
      options,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    });
    skipBootstrapPagedPull = bootstrapPhase.skipPagedPull;
    // The bootstrap phase latches lifecycle teardown across its long native
    // awaits. If the app foregrounds again before the rejected download is
    // handled, the live outer guard is already clear; do not let that stale
    // cycle continue into deletions or paged pulls.
    if (bootstrapPhase.cycleInterrupted) return reportInterruptedCycle();
  }

  // Deletions FIRST, table pulls second. This ordering is what makes a
  // delete-then-recreate on the server converge: the tombstone removes the old
  // local row, then the same cycle's table pull upserts the recreated one.
  // Applied after the pulls, a tombstone sharing the recreated row's timestamp
  // would delete data this cycle just wrote, and the strict > cursor would
  // never fetch it again.
  if (cycleAborted()) return reportInterruptedCycle();
  onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
  const deletionsResult = await processDeletions(db, queryClient, graphqlFetch, purgeToken, (deletionsProcessed) => {
    totalDocuments = deletionsProcessed;
    onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: totalDocuments });
  });
  // The coverage marker advances ONLY on a completed pass. An aborted one (sign-out,
  // purge, backgrounding) consumed an unknown prefix of the stream, so claiming a
  // fresh retention window off it would hide a real gap. See deletions-coverage.ts.
  if (deletionsResult.reachedTail) await setDeletionsCoverageAt(db, Date.now());

  let allUserTablesReachedTail = true;
  for (const tableName of USER_DATA_TABLES) {
    if (cycleAborted()) return reportInterruptedCycle();
    onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
    const baseCount = totalDocuments;
    const userTableResult = await syncTable(
      db,
      queryClient,
      graphqlFetch,
      tableName,
      purgeToken,
      undefined,
      (tableProcessed) => {
        totalDocuments = baseCount + tableProcessed;
        onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
      },
      options?.onSchemaDrift,
    );
    if (!userTableResult.reachedTail) allUserTablesReachedTail = false;
  }

  // Only now are the user tables complete enough for a local reader to serve
  // from — a checkpoint alone proves the first page landed, and a logbook built
  // from a fraction of the rows reads as "you never climbed that". Mirrors
  // markScopeDownloadComplete for board scopes. Cleared on sign-out for free:
  // the key is `checkpoint:`-prefixed, so deleteUserCheckpoints takes it.
  //
  // Guarded, symmetric to the scope-complete block below: the last user table's
  // in-page check is one await back, so a global wipe landing in that window
  // would otherwise stamp `user_data_complete` over data that is being deleted.
  if (cycleAborted()) return reportInterruptedCycle();
  if (allUserTablesReachedTail) await markUserDataComplete(db);

  // Each enabled board is a "boardType:layoutId:sizeId" scope key (already parsed
  // into boardScopes). currentTable carries the full scope key so a per-board UI
  // can match itself.
  for (const boardScope of boardScopes) {
    // boardScopes is the pre-cycle snapshot of the enabled set. A GLOBAL teardown
    // makes every remaining entry suspect, so it stops the cycle. A per-namespace
    // purge only invalidates its own scope — the one being deleted right now,
    // which is still in this stale list — so it skips that scope and lets every
    // other board finish (issue #4370).
    //
    // NONE of the exits below reports a terminal event, and that is deliberate
    // (issue #4406). A board-data crawl legitimately spans cycles — a 40k-climb
    // layout is hundreds of pages, and the durable `scope-started:` marker keeps
    // ONE Started open across all of them — so a Failed per interrupted cycle
    // would turn every normal multi-cycle download into a stream of failures.
    // The one exit that ends a download for good is the removal these purge
    // checks are dodging, and `removeBoardScopeData` reports it from the other
    // side: it is the last code that can still see the Started marker before
    // deleting it, and it de-dups against the bootstrap phase's own
    // `aborted-wipe` through the purge generation.
    if (cycleAborted()) return reportInterruptedCycle();
    if (scopePurged(boardScope)) continue;
    const scopeKey = boardScope.scopeKey;
    // No-op when the bootstrap phase already stamped this scope; the paged-only
    // path (no snapshotSource) starts its duration clock here.
    await stampScopeStart(scopeKey);
    // `scope-download-started:` is a sync_meta write the teardown deletes and no
    // other path can clear, so a purge landing across that await must not leave
    // one behind for rows that are gone.
    if (scopePurged(boardScope)) continue;
    const phases = phaseTimings(scopeKey);
    // Started (issue #4316), the paged half — and the catch-all. Every scope
    // reaches this line on every path: a build with no snapshot source, a scope
    // the bootstrap phase found ineligible or unexportable, and the resumed
    // multi-cycle crawl the checkpoint gate above skips. A scope the bootstrap
    // phase already announced is a no-op here thanks to the durable marker, so
    // it keeps its 'snapshot' intent and its artifact size.
    await emitScopeDownloadStartOnce({ scopeKey, pathIntent: 'paged', artifactBytes: null });
    if (cycleAborted()) return reportInterruptedCycle();
    if (scopePurged(boardScope)) continue;
    // A scope whose bootstrap failed this cycle (with attempts still left) skips
    // its paged pull: a first-page checkpoint would permanently disqualify the
    // snapshot path, so the next cycle retries the snapshot instead.
    if (skipBootstrapPagedPull.has(scopeKey)) continue;
    let allTablesReachedTail = true;
    for (const tableName of BOARD_DATA_TABLES) {
      if (cycleAborted()) return reportInterruptedCycle();
      if (scopePurged(boardScope)) {
        // Not `continue` on the OUTER loop's terms: clearing the flag is what
        // stops the completion block below from being reached through this
        // loop's normal exit. It was never sufficient on its own — see the
        // guards there.
        allTablesReachedTail = false;
        break;
      }
      const tableLabel = `${tableName}:${scopeKey}`;
      onProgress?.({
        phase: 'board_data',
        currentTable: tableLabel,
        documentsProcessed: totalDocuments,
        currentTableProcessed: 0,
      });
      const baseCount = totalDocuments;
      // Timed per table, not per scope: the whole point of the #4310
      // measurement is telling the artifact's tables (climbs, stats — imported
      // in one shot) apart from board_climb_grades, which the artifact does not
      // carry at all and which therefore crawls page by page every time.
      const tableStartedAt = Date.now();
      const { reachedTail, rowsProcessed, resumedFromCheckpoint } = await syncTable(
        db,
        queryClient,
        graphqlFetch,
        tableName,
        purgeToken,
        boardScope,
        (tableProcessed) => {
          totalDocuments = baseCount + tableProcessed;
          onProgress?.({
            phase: 'board_data',
            currentTable: tableLabel,
            documentsProcessed: totalDocuments,
            currentTableProcessed: tableProcessed,
          });
        },
        options?.onSchemaDrift,
      );
      const tableMs = Date.now() - tableStartedAt;
      if (tableName === 'board_climbs') phases.climbsPullMs += tableMs;
      else if (tableName === 'board_climb_stats') phases.statsPullMs += tableMs;
      else if (tableName === 'board_climb_grades') {
        // gradesPullMs accumulates unconditionally — it is a real measurement of
        // this cycle either way. The row count is absent-when-unknown (#4393): a
        // crawl that resumed from an EARLIER cycle's checkpoint consumed only a
        // tail, so no number here is the import, and the 0 this used to emit read
        // as "this board has no grades" in the #4310 analysis. A checkpoint THIS
        // cycle's own grades artifact stamped is not an earlier cycle: the crawl
        // behind it really did consume these rows, and gradesArtifactRows (set by
        // importGradesForScope) says where the rest went.
        phases.gradesPullMs += tableMs;
        if (!resumedFromCheckpoint || phases.gradesArtifactRows !== undefined) {
          phases.gradesRows = (phases.gradesRows ?? 0) + rowsProcessed;
        }
      }
      if (!reachedTail) allTablesReachedTail = false;
    }
    // Gate for local-first reads: only a scope whose climbs, stats AND grades
    // (every BOARD_DATA_TABLES entry) have all pulled to the tail may serve
    // searches — a first-page checkpoint would otherwise serve a sliver of the
    // catalog as if it were everything.
    //
    // `scope-complete:` is the marker scope-teardown.ts's invariant #1 calls
    // unrecoverable when it outlives its rows, and this block is the ONLY place
    // that writes it. The last table's in-page guard (syncTable) is three awaits
    // back — an upsert, a checkpoint write, and the read below — and
    // removeBoardScopeData holds an exclusive transaction for seconds, so a purge
    // landing in that window would queue this write BEHIND the delete. The
    // table-loop's `allTablesReachedTail = false` never runs after the FINAL
    // table, so it cannot cover this.
    if (cycleAborted()) return reportInterruptedCycle();
    if (scopePurged(boardScope)) continue;
    if (allTablesReachedTail) {
      const wasScopeComplete = await isScopeDownloadComplete(db, scopeKey);
      // Checked again after the read, so the window between the decision and the
      // write is one statement rather than one await.
      if (cycleAborted()) return reportInterruptedCycle();
      if (scopePurged(boardScope)) continue;
      // Clears the persisted start stamp as well as writing the complete marker.
      await markScopeDownloadComplete(db, scopeKey);
      if (wasScopeComplete) continue;
      const startedAt = scopeStartedAt.get(scopeKey);
      // Should be unreachable because stampScopeStart runs at the top of this
      // loop for every scope. If that invariant breaks, skip telemetry rather
      // than emit a misleading 0ms duration.
      if (startedAt === undefined) continue;
      // A stamp older than the plausibility window is a stamp nobody cleared,
      // not a download that ran for days (a crash between stamp and completion,
      // or an app the user simply did not open). Report the event with a null
      // duration rather than poisoning the percentiles with it.
      const elapsedMs = Date.now() - startedAt;
      const durationMs = elapsedMs >= 0 && elapsedMs <= SCOPE_DOWNLOAD_START_MAX_AGE_MS ? elapsedMs : null;
      // Both attributions read the persisted marker, not this run's bootstrap
      // work: the import and the completing delta pull can land in different
      // cycles (connectivity drop between them, or the grades crawl still
      // running), and this event fires exactly once per scope — misreporting
      // that one event would permanently skew the rollout comparison.
      const timings = bootstrapTimings.get(scopeKey);
      options?.onScopeDownloadComplete?.({
        scopeKey,
        method: (await isBootstrapDone(db, scopeKey)) ? 'snapshot' : 'paged',
        durationMs,
        // A healed scope's duration excludes the paged work earlier cycles did,
        // so it must be filtered out of snapshot-vs-paged comparisons.
        bootstrapHealed: await wasBootstrapHealed(db, scopeKey),
        // Spread rather than set explicitly: absent when this cycle did not do
        // the import, which is the honest answer (see ScopeDownloadCompleteInfo).
        ...timings,
        phases,
      });
    }
  }

  onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: totalDocuments });
}
