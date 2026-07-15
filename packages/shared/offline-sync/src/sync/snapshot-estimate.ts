// Pre-download size estimate for a board scope (issue #3616): "how big is the
// thing I'm about to download?", answered before the user commits to it.
//
// The manifest already carries every number this needs (`bytes` per artifact,
// `rowCount` per table) — the hard part is knowing WHEN that number is the truth.
// A scope only downloads an artifact if the snapshot bootstrap would actually run
// for it, and `runBootstrapPhase` (pull-client.ts) is the authority on that. The
// rules are duplicated nowhere: `findSnapshotEntry` is shared with the engine, and
// the checkpoint/attempt gates below mirror its eligibility check one-for-one.
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
import { MAX_BOOTSTRAP_ATTEMPTS } from './snapshot-bootstrap';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';

export type SnapshotDownloadEstimate =
  /**
   * The scope would bootstrap from `entry`, so `bytes` is exactly what comes down
   * the wire. Artifacts are per-(boardType, layoutId) and downloaded whole
   * regardless of which size is enabled, so this is the honest download figure
   * even for a size-scoped board — but it is a DOWNLOAD size, not a storage one:
   * the import keeps only the enabled size's rows.
   *
   * NOTE: `bytes` is the stored object size. Today artifacts are identity-encoded
   * so stored == wire == on-disk. If the export ever ships `--gzip`, this stays
   * right about data usage and becomes an undercount of the file on disk.
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
 * - `hasExistingCheckpoint`: the scope already pulled rows, so it is permanently
 *   past bootstrap eligibility and resumes as a delta.
 * - attempts at the cap: the engine has given up on the snapshot for this scope.
 * - no entry for the layout: not exported yet.
 * - schema-stale entry: rejected before the download (`isSnapshotEntryUsable`).
 */
export function estimateScopeDownload(input: {
  manifest: SnapshotManifest | null;
  boardType: string;
  layoutId: number;
  hasExistingCheckpoint: boolean;
  bootstrapAttempts: number;
}): SnapshotDownloadEstimate {
  const { manifest, boardType, layoutId, hasExistingCheckpoint, bootstrapAttempts } = input;
  if (!manifest) return { kind: 'unknown' };
  if (hasExistingCheckpoint) return { kind: 'unknown' };
  if (bootstrapAttempts >= MAX_BOOTSTRAP_ATTEMPTS) return { kind: 'unknown' };

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
