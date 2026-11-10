/**
 * The `auth_time` claim the web session cookie carries: epoch seconds of the
 * sign-in that produced it, written only by a completed sign-in (never by a
 * cookie rotation or a native transfer). Web and backend read it through these
 * two functions so they agree on what counts as a recent sign-in.
 */

/** How far ahead of the reader's clock a sign-in time may sit before it is treated as unknown. */
export const AUTH_TIME_CLOCK_SKEW_SECONDS = 60;

/** Decision 19: approving a partner app, like other sensitive actions, needs a sign-in in the last 30 days. */
export const RECENT_SIGN_IN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The claim as epoch seconds, or null when it cannot be one: missing, not a
 * whole number, zero or negative, or further in the future than clock skew
 * explains. Null means "age unknown", which every reader treats as stale.
 */
export function readAuthTimeClaim(claim: unknown, nowMs: number): number | null {
  if (typeof claim !== 'number' || !Number.isSafeInteger(claim) || claim <= 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  if (claim * 1000 > nowMs + AUTH_TIME_CLOCK_SKEW_SECONDS * 1000) return null;
  return claim;
}

/** Whether a sign-in at `authTimeSeconds` is under 30 days old. An unknown time never is. */
export function isRecentSignIn(authTimeSeconds: number | null, nowMs: number): boolean {
  if (authTimeSeconds === null || !Number.isFinite(nowMs)) return false;
  return nowMs - authTimeSeconds * 1000 < RECENT_SIGN_IN_MAX_AGE_SECONDS * 1000;
}
