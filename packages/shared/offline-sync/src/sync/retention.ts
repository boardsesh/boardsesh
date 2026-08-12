// Tombstone retention — the ONE number the server prune job and the client
// staleness guard must agree on (issue #3474).
//
// The backend hard-deletes `sync_deletions` rows older than
// SYNC_DELETIONS_RETENTION_DAYS (packages/backend/src/services/sync-deletions-prune.ts,
// run daily from server.ts). The sync resolver pages tombstones on a strict `>`
// keyset, so a client whose deletions coverage predates the prune cutoff can
// never be served the tombstones that were removed in between: rows deleted
// server-side stay on that device forever (a hard-deleted record is never
// re-upserted, so nothing else clears it).
//
// The client half of the contract lives in deletions-coverage.ts. This file is
// imported by BOTH sides — the backend depends on @boardsesh/offline-sync
// already (packages/backend/package.json), and this package depends on nothing
// outside @boardsesh/shared-schema, so there is no cycle.

/**
 * sync_meta key holding the epoch-ms of the last completed deletions pull.
 *
 * Lives here, in the dependency-free module, because both deletions-coverage.ts
 * (which owns the semantics) and checkpoints.ts (which clears it on sign-out)
 * need it, and deletions-coverage.ts already imports checkpoints.ts.
 *
 * Deliberately NOT under the `checkpoint:` prefix, for the same reason
 * SCOPE_COMPLETE_PREFIX isn't: it describes client wall-clock coverage, not a
 * server cursor.
 */
export const DELETIONS_COVERAGE_KEY = 'deletions-coverage';

/**
 * How long a tombstone stays queryable before the daily prune job deletes it.
 * Lowering this shortens the window a stale device has to catch up.
 */
export const SYNC_DELETIONS_RETENTION_DAYS = 90;

/**
 * Slack between "the client believes it is covered" and "the server has actually
 * pruned". It absorbs prune-job lag (the job runs daily, not continuously), the
 * duration of a long sync cycle, and modest device clock skew — a device would
 * need to jump more than 10 days for the margin alone to flip the verdict.
 */
export const DELETIONS_COVERAGE_MARGIN_DAYS = 10;

/**
 * The client's staleness threshold: once its coverage marker is older than this,
 * tombstones it never saw may already be pruned and the only recovery is a
 * from-scratch user-data resync.
 *
 * WHY `Offline Sync Coverage Reset Forced` has never fired once, and why that is
 * arithmetic rather than breakage (issue #4315): the guard only acts on verdict
 * `stale`, which needs a `deletions-coverage` marker older than this constant —
 * 90 − 10 = 80 days. The marker is stamped in TWO places, both claiming coverage
 * only for work that actually completed: after a completed deletions pull
 * (pull-client.ts) and inside resetUserDataForLostCoverage
 * (deletions-coverage.ts) as the post-wipe re-seed. It first shipped in
 * cb4210c5c on 2026-08-01 (#4048), so no device can hold an 80-day-old marker
 * before roughly 2026-10-20. Zero events is the predicted value, and
 * deletions-coverage.test.ts pins the 80 so a retention or margin edit that
 * moves that date fails CI rather than quietly moving a dashboard.
 *
 * `Offline Sync Coverage Evaluated` reports the verdict on EVERY cycle, which
 * makes that prediction falsifiable — and its `unknown` bucket is the
 * population the reset event structurally cannot see: devices that have never
 * completed a deletions pull at all.
 *
 * NOTE: the client's copy of these numbers only refreshes with the OTA bundle.
 * Lowering SYNC_DELETIONS_RETENTION_DAYS on the backend does NOT reach older
 * clients — they keep comparing against the value they shipped with, and the
 * window between the two values is unguarded until they update. Raise the margin
 * (or ship the OTA first) before shortening the server window.
 */
export const DELETIONS_COVERAGE_MAX_AGE_MS =
  (SYNC_DELETIONS_RETENTION_DAYS - DELETIONS_COVERAGE_MARGIN_DAYS) * 24 * 60 * 60 * 1000;

/**
 * Earliest epoch-ms a coverage marker can plausibly hold. Boardsesh shipped no
 * offline sync before 2025, so a marker below this is never an old device — it
 * is a garbage clock (a phone that cold-boots to 1970/2001 before NTP lands and
 * re-stamps the marker with its bogus "now") or a garbled row. Both read as
 * decades stale, and wiping user data off a device that has been syncing daily
 * is the regression this guard exists to avoid, so the classifier treats them as
 * "no marker" and re-seeds instead.
 */
export const DELETIONS_COVERAGE_EPOCH_FLOOR_MS = Date.parse('2025-01-01T00:00:00Z');
