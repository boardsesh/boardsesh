// One low-cardinality answer to "why did this board's fast download not finish?".
//
// The download funnel (issue #4316) could say THAT a scope failed and at which
// stage, but not why — so a board that never finished looked identical whether the
// artifact was corrupt, the phone went in a pocket, or SQLite refused the write.
// Diagnosing Sentry BOARDSESH-D7 took an hour of cross-referencing PostHog against
// Sentry for exactly that reason, and the answer ("a lock, on a path nobody
// suspected") was a single string the funnel could have carried all along.
//
// Deliberately a CLOSED union of coarse buckets, not a message passthrough: this
// rides on an analytics property, and error messages carry file paths, row counts
// and byte offsets — unbounded cardinality that would make the funnel unqueryable.
// The verbatim message still travels on the same event's `errorMessage`.
//
// Matched on `error.name` rather than `instanceof`, so this module stays free of a
// dependency on snapshot-bootstrap.ts (which imports the reporter type from here).
// The names are set explicitly in each class's constructor and are equally reliable
// across a `.cause` chain the platform rebuilt.

import { isNetworkError } from '../mutation-queue/error-classification';
import { classifySqliteLockError } from '../db/lock-errors';

export type SnapshotBootstrapFailureReason =
  /** A sign-out, or a local purge (removing ANY board), tore the cycle down. */
  | 'aborted-wipe'
  /** The app went to the background mid-cycle. Resumes on the next foreground. */
  | 'aborted-background'
  /** SQLITE_BUSY / SQLITE_LOCKED — contention, not a broken database. */
  | 'database-locked'
  /** The artifact predates this client's schema; tonight's export rebuilds it. */
  | 'schema-stale'
  /** The artifact's scoped watermark sits behind what this scope already crawled. */
  | 'watermark-regression'
  /** The source declared the artifact unusable on this device. */
  | 'permanent-miss'
  /** `quick_check` failed, `snapshot_meta` was missing/mismatched, or the row count did not add up. */
  | 'artifact-invalid'
  /** Offline, or the connection dropped. The normal state of a phone on a plane. */
  | 'network'
  /** Nothing above matched — the bucket that should stay near zero. */
  | 'unknown';

/** Substrings of the errors `verifySnapshotMeta` and the integrity check raise. */
const ARTIFACT_INVALID_MARKERS = [
  'quick_check failed',
  'snapshot_meta missing row',
  'format_version',
  'truncated artifact',
  'no shared',
];

/**
 * Bucket a bootstrap failure's cause.
 *
 * Order matters. The named error classes are checked first because they are exact;
 * the lock test comes before the message tests because a lock failure surfacing
 * through `finalizeAsync` carries no shape of its own; `network` comes last of the
 * positive tests because its matcher is the broadest.
 */
export function classifySnapshotBootstrapFailure(cause: unknown): SnapshotBootstrapFailureReason {
  const name = cause instanceof Error ? cause.name : null;
  if (name === 'SnapshotWipedError') return 'aborted-wipe';
  if (name === 'SnapshotSchemaStaleError') return 'schema-stale';
  if (name === 'SnapshotWatermarkRegressionError') return 'watermark-regression';
  if (name === 'SnapshotPermanentMissError') return 'permanent-miss';

  if (classifySqliteLockError(cause).locked) return 'database-locked';

  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (ARTIFACT_INVALID_MARKERS.some((marker) => message.includes(marker))) return 'artifact-invalid';

  if (isNetworkError(cause)) return 'network';
  return 'unknown';
}
