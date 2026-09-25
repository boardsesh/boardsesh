// One-time recovery of the sends #5295 threw away (issue #5335).
//
// Before the classifier fix, two transport failures resolved as "non-retryable"
// and dead-lettered a queued send on attempt 0 of 10. Roughly 17 climbers have a
// `pending_mutations` row at `status = 'dead_letter'` holding a send they logged
// and believe is recorded. The classifier fix stops new losses; it does not give
// those rows back.
//
// The predicate below is the whole safety argument, so it matches on the RECORDED
// ERROR and nothing else — not age, not table, not retry_count. A row a server
// permanently rejected (a 400) must come out of this untouched, or the recovery
// stops being "give back the two shapes we misjudged" and becomes "replay
// everything in the bin", which is a different, unapproved decision.
//
// Both literals below are the exact `last_error` values off the production rows
// (Sentry BOARDSESH-HT and BOARDSESH-H8): the drainer stores `error.message`
// verbatim, so what is compared here is what was written.

import type { SqlExecutor } from '../database';
import { getDeadLetters, retryDeadLetter } from './queue';

/**
 * whatwg-fetch's `xhr.ontimeout` rejection (`fetch.umd.js:573`) — the sibling of
 * "Network request failed" at :567, and a `TypeError` whose message is this
 * string and nothing else. Matched by EQUALITY rather than containment on
 * purpose: a graphql-request `ClientError` message embeds the whole request,
 * variables included, so a climber who typed this phrase into a tick comment
 * would otherwise be able to spell a 400 rejection into a requeue.
 */
export const FETCH_TIMEOUT_LAST_ERROR = 'Network request timed out';

/**
 * graphql-request's `ClientError.extractMessage` fallback for a 404 whose body
 * carries no GraphQL `errors` array — the shape Railway's edge served for 6m30s
 * on 2026-09-02 (`{"code":404,"message":"Application not found"}` with
 * `x-railway-fallback: true`). Anchored to the START of the message, again so a
 * request payload echoed further along the string can never fabricate a match.
 *
 * The status is in the prefix, so a `GraphQL Error (Code: 400)` — a real server
 * verdict on the payload — does not match, which is precisely the row this
 * migration must leave where it is.
 */
export const EDGE_404_LAST_ERROR_PREFIX = 'GraphQL Error (Code: 404)';

/**
 * Was this dead letter caused by one of the two transport failures #5295
 * misclassified? Any other recorded error — including a null one, which proves
 * nothing about why the row is here — is left alone.
 */
export function isRecoverableTransportDeadLetter(lastError: string | null | undefined): boolean {
  if (typeof lastError !== 'string') return false;
  const recorded = lastError.trim();
  if (recorded === FETCH_TIMEOUT_LAST_ERROR) return true;
  return recorded.startsWith(EDGE_404_LAST_ERROR_PREFIX);
}

/**
 * Moves every dead letter matching `isRecoverableTransportDeadLetter` back to
 * `pending` with a fresh retry budget, and answers how many moved.
 *
 * The per-row transition is `retryDeadLetter` — the same statement More → Sync
 * issues → Retry has always used — rather than a bespoke bulk UPDATE, so this
 * recovery cannot drift from the manual one.
 *
 * The caller runs this inside a transaction (the schema-migration runner does),
 * which is what keeps a killed app from leaving a row in a third state: either
 * every matched row is `pending` and the migration is stamped, or nothing moved
 * and it runs again next launch. Running it a second time finds nothing —
 * `retryDeadLetter` clears `last_error` and the rows are no longer dead letters.
 */
export async function requeueTransportDeadLetters(db: SqlExecutor): Promise<number> {
  const deadLetters = await getDeadLetters(db);
  let requeued = 0;
  for (const deadLetter of deadLetters) {
    if (!isRecoverableTransportDeadLetter(deadLetter.last_error)) continue;
    await retryDeadLetter(db, deadLetter.id);
    requeued += 1;
  }
  return requeued;
}

/**
 * The `sync_meta` key holding "this device requeued N sends and has not told the
 * climber yet". Written by the migration only when N >= 1, so its absence is the
 * ordinary case and no launch has to reason about a zero.
 *
 * It lives in `sync_meta` rather than in memory because the migration and the
 * modal are separated by a whole app startup: the requeue happens before React
 * mounts, and a launch that dies in between must still owe the climber a notice.
 * The sign-out wipe (`deleteAllSyncMeta`) clears it, which is correct — that
 * wipe removes the queued rows the notice would be describing.
 */
export const DEAD_LETTER_RECOVERY_NOTICE_KEY = 'dead-letter-recovery-notice';

/** Records that `requeued` sends are owed a notice. Overwrites, never accumulates. */
export async function setDeadLetterRecoveryNotice(db: SqlExecutor, requeued: number): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    DEAD_LETTER_RECOVERY_NOTICE_KEY,
    String(requeued),
  ]);
}

/**
 * How many recovered sends this device still owes the climber a notice about, or
 * `null` when it owes none. A stored value that isn't a positive integer is read
 * as "none" rather than crashing a launch on a corrupt row.
 */
export async function readDeadLetterRecoveryNotice(db: SqlExecutor): Promise<number | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    DEAD_LETTER_RECOVERY_NOTICE_KEY,
  ]);
  if (!row) return null;
  const requeued = Number(row.value);
  if (!Number.isInteger(requeued) || requeued < 1) return null;
  return requeued;
}

/** Clears the notice, so it is shown once and never again on a later launch. */
export async function clearDeadLetterRecoveryNotice(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [DEAD_LETTER_RECOVERY_NOTICE_KEY]);
}
