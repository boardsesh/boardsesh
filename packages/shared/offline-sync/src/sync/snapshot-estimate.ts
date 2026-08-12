// Pre-download size estimate for a board scope (issue #3616): "how big is the
// thing I'm about to download?", answered before the user commits to it.
//
// The manifest already carries every number this needs (`bytes` per artifact,
// `rowCount` per table) — the hard part is knowing WHEN that number is the truth.
// A scope only downloads an artifact if the snapshot bootstrap would actually run
// for it, so this CALLS the engine's own gate (`evaluateBootstrapEligibility`)
// rather than re-stating it. It used to carry a copy of the checkpoint/attempt
// rules with a comment promising they mirrored `runBootstrapPhase` one-for-one;
// heal-over-partial (issue #4313) made both of those rules wrong at once, which
// is why the mirror is now a literal shared call.
//
// Getting this wrong is worse than showing nothing. A board that was downloaded
// once and toggled off keeps its rows + checkpoints on purpose (see
// mobile's use-offline-board.ts), so re-enabling it pulls a small delta — quoting
// the full 270 MB artifact size there would be a plain lie. Every uncertain case
// returns `unknown` and the caller falls back to copy that promises no number.
//
// Pure: no I/O, no clock. The caller supplies the manifest (however it fetched
// and cached it) and the scope's local checkpoint/attempt state.

import type { SnapshotManifest, SnapshotManifestEntry } from './snapshot-manifest';
import { evaluateBootstrapEligibility, type BootstrapRetryState } from './bootstrap-retry';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';

export type SnapshotDownloadEstimate =
  /**
   * The scope would bootstrap from `entry`, so `bytes` is exactly what comes down
   * the wire. Artifacts are per-(boardType, layoutId) and downloaded whole
   * regardless of which size is enabled, so this is the honest download figure
   * even for a size-scoped board — but it is a DOWNLOAD size, not a storage one:
   * the import keeps only the enabled size's rows.
   *
   * NOTE: `bytes` is the stored object size, which under `--gzip` (what the
   * fleet reads today) is the WIRE figure and an undercount of the file on disk
   * — the manifest carries the decoded size separately as `uncompressedBytes`.
   * Wire is deliberately the scale quoted here: it is the honest number for a
   * cellular-data prompt, and it is the same scale the download progress row
   * renders (issue #4311), so the dialog and the bar can never disagree.
   */
  | { kind: 'snapshot'; bytes: number; climbCount: number; builtAt: string }
  /** No trustworthy number — say nothing rather than guess. */
  | { kind: 'unknown' };

/**
 * The manifest entry for a layout, or null when it hasn't been exported yet.
 * Shared with `runBootstrapPhase` so the UI can never disagree with the engine
 * about which artifact a scope would download.
 */
export function findSnapshotEntry(
  manifest: SnapshotManifest,
  boardType: string,
  layoutId: number,
): SnapshotManifestEntry | null {
  return (
    manifest.entries.find((candidate) => candidate.boardType === boardType && candidate.layoutId === layoutId) ?? null
  );
}

/**
 * True when an artifact is safe to import: an artifact built against a client
 * schema OLDER than ours would NULL-fill the columns that migration added and
 * then stamp the resume cursor past those rows, which the strict `>` delta pull
 * would never backfill. Newer is fine — the import intersects columns.
 * Mirrors the pre-download gate in `runBootstrapPhase`.
 */
export function isSnapshotEntryUsable(entry: SnapshotManifestEntry): boolean {
  return entry.schemaVersion >= LATEST_SCHEMA_VERSION;
}

/**
 * What a scope would actually download if enabled right now.
 *
 * Returns `unknown` — meaning "don't quote a number" — for every case where the
 * paged crawl runs instead of a snapshot import, because the crawl has no byte
 * total at all:
 *
 * - `manifest` is null: not fetched yet, unreachable, unparseable, or the
 *   snapshot path is switched off entirely (flag/base URL) so nothing is downloaded.
 * - the engine's gate says no: a scope that already serves the full catalog, one
 *   that already imported an artifact, one mid-cooldown, one whose budgets are
 *   spent, and a mid-crawl scope with no snapshot failures behind it all resume
 *   as a delta or a crawl instead of downloading.
 * - no entry for the layout: not exported yet.
 * - schema-stale entry: rejected before the download (`isSnapshotEntryUsable`).
 *
 * `userRequested` is the "Try the fast download again" path: the user has asked
 * for the artifact explicitly, so the size must be quoted from the entry even
 * though the scope's persisted state is currently terminal — restoring the
 * budget is the action the dialog is confirming.
 */
export function estimateScopeDownload(input: {
  manifest: SnapshotManifest | null;
  boardType: string;
  layoutId: number;
  retryState: BootstrapRetryState;
  hasBoardCheckpoint: boolean;
  isScopeComplete: boolean;
  isBootstrapDone: boolean;
  now: number;
  userRequested?: boolean;
}): SnapshotDownloadEstimate {
  const { manifest, boardType, layoutId, userRequested } = input;
  if (!manifest) return { kind: 'unknown' };
  if (!userRequested && !evaluateBootstrapEligibility(input).eligible) return { kind: 'unknown' };
  // Even a user-requested retry cannot download over a catalog that is already
  // complete or already snapshot-warmed — the engine would refuse it too.
  if (userRequested && (input.isScopeComplete || input.isBootstrapDone)) return { kind: 'unknown' };

  const entry = findSnapshotEntry(manifest, boardType, layoutId);
  if (!entry) return { kind: 'unknown' };
  if (!isSnapshotEntryUsable(entry)) return { kind: 'unknown' };

  return {
    kind: 'snapshot',
    bytes: entry.bytes,
    climbCount: entry.tables.board_climbs.rowCount,
    builtAt: entry.builtAt,
  };
}
