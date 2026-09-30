import { sql, type SQL } from 'drizzle-orm';
import { auroraCredentials } from '../../schema/auth/mappings';

/**
 * Per-credential exponential backoff shared by both sync runners (aurora-sync
 * and kilter-sync). A credential that keeps failing must not burn a daemon
 * cycle on every rotation, and — critically — must not wedge the
 * single-user-per-cycle queue by sorting to the front every cycle. After N
 * consecutive failures a credential is skipped from selection until
 * `last_sync_attempt_at + backoff(N)` has elapsed; it stays in the candidate
 * set (still `pending`/`active`/`error`) and resumes on its next eligible turn.
 *
 * Backoff schedule: base 2 min, doubling per consecutive failure, capped at 6 h.
 *   1 failure → 2m, 2 → 4m, 3 → 8m, 4 → 16m, 5 → 32m, 6 → 64m, 7 → 128m,
 *   8 → 256m, 9+ → 6h (cap).
 *
 * The daemon already cycles every 1–15 min doing one credential at a time, so
 * this backoff is about not RE-picking a doomed credential ahead of healthy
 * ones — the attempt-clock ordering rotates a failure to the back, and the
 * backoff additionally keeps it out of selection until its window elapses.
 */
export const CREDENTIAL_BACKOFF_BASE_MS = 2 * 60 * 1000;
export const CREDENTIAL_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
// Cap the doubling exponent so `2 ** n` can't overflow into Infinity for a
// credential with a pathological failure count; base·2^20 already dwarfs the
// 6 h cap, so anything past 20 is clamped by CAP anyway.
const MAX_BACKOFF_DOUBLINGS = 20;

/** Backoff window in ms for a credential with `consecutiveFailures` failures. */
export function credentialBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const doublings = Math.min(consecutiveFailures - 1, MAX_BACKOFF_DOUBLINGS);
  return Math.min(CREDENTIAL_BACKOFF_BASE_MS * 2 ** doublings, CREDENTIAL_BACKOFF_CAP_MS);
}

/**
 * True when a credential is still inside its backoff window (should be skipped).
 * Mirrors {@link credentialRetryReadySql}; used for in-process decisions/tests.
 */
export function isCredentialInBackoff(
  now: Date,
  lastSyncAttemptAt: Date | null,
  consecutiveFailures: number,
  providerRetryAfterUntil: Date | null = null,
): boolean {
  // The provider's Retry-After and the failure backoff each hold the
  // credential on their own; it is ready once the later of the two has passed.
  if (providerRetryAfterUntil !== null && now.getTime() < providerRetryAfterUntil.getTime()) return true;
  if (consecutiveFailures <= 0 || lastSyncAttemptAt === null) return false;
  return now.getTime() < lastSyncAttemptAt.getTime() + credentialBackoffMs(consecutiveFailures);
}

/**
 * SQL predicate for `getNextCredentialToSync`: TRUE when the credential is
 * eligible for another attempt: past the provider's Retry-After
 * (`provider_retry_after_until`) AND outside its failure backoff window. Two
 * independent holds, so the credential waits for the later of the two and
 * never their sum. Keep in lockstep
 * with {@link credentialBackoffMs}. Postgres interval arithmetic mirrors the JS:
 * base 2 min · 2^min(n-1, 20), capped at 6 h.
 *
 * The exponent is `GREATEST(n - 1, 0)` so it can never go negative. The
 * `consecutive_failures <= 0` branch already short-circuits the healthy case,
 * but the GREATEST keeps the SQL honest under a data inconsistency
 * (consecutive_failures = 0 alongside a non-null last_sync_attempt_at): without
 * it `power(2, -1) = 0.5` would compute a bogus 1-minute window, disagreeing
 * with the JS mirror, which returns ready-immediately for zero failures.
 */
export function credentialRetryReadySql(): SQL {
  return sql`(
    (
      ${auroraCredentials.providerRetryAfterUntil} IS NULL
      OR ${auroraCredentials.providerRetryAfterUntil} <= now()
    )
    AND (
      ${auroraCredentials.consecutiveFailures} <= 0
      OR ${auroraCredentials.lastSyncAttemptAt} IS NULL
      OR ${auroraCredentials.lastSyncAttemptAt} + LEAST(
           interval '2 minutes' * power(2, LEAST(GREATEST(${auroraCredentials.consecutiveFailures} - 1, 0), ${MAX_BACKOFF_DOUBLINGS})),
           interval '6 hours'
         ) <= now()
    )
  )`;
}
