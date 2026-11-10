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

/**
 * A sign-in counts only if it is this much later than the last password write.
 * The sign-in time comes from a web server's clock and the write time from the
 * database's, so a cookie minted just before a reset on a fast clock could
 * otherwise look newer than the reset.
 */
export const PASSWORD_CHANGE_CLOCK_TOLERANCE_MS = 60_000;

/**
 * Whether a sign-in at `authTimeSeconds` clearly followed the climber's last
 * password write (`user_credentials.updated_at`, read as UTC). With no password
 * row there is nothing to follow. A cookie from before a reset never passes, so
 * a reset ends what an old cookie can approve or link.
 */
export function signedInAfterPasswordChange(authTimeSeconds: number, passwordChangedAt: Date | null): boolean {
  if (passwordChangedAt === null) return true;
  return authTimeSeconds * 1000 - PASSWORD_CHANGE_CLOCK_TOLERANCE_MS > passwordChangedAt.getTime();
}

/**
 * Written beside `auth_time`, set to `true`, only by a sign-in the web made
 * while it guarded OAuth account links (its `PARTNER_OAUTH_MODE` not `off`). A
 * sign-in time minted while that guard was off may have been bought by linking a
 * provider account into an old session, so partner consent accepts only a
 * sign-in that carries this claim.
 */
export const LINK_GUARDED_CLAIM = 'link_guarded';

/** Whether a decoded session carries the claim. Only the literal `true` counts. */
export function isLinkGuardedSignIn(claims: Record<string, unknown>): boolean {
  return claims[LINK_GUARDED_CLAIM] === true;
}

export interface PartnerConsentSignIn {
  /** From `auth_time`, already read with `readAuthTimeClaim`; null when unknown. */
  authTimeSeconds: number | null;
  /** The session carries `link_guarded: true`. */
  linkGuarded: boolean;
  /** `user_credentials.updated_at`, or null with no password. */
  passwordChangedAt: Date | null;
}

/**
 * The one rule for "this sign-in may approve a partner app, or link a provider
 * that could later do so": known, under 30 days old, made while links were
 * guarded, and clearly after the last password write. The backend applies it
 * before consent, and the web before linking a provider into a live session,
 * since a link writes a fresh `auth_time`.
 */
export function isSignInGoodForPartnerConsent(signIn: PartnerConsentSignIn, nowMs: number): boolean {
  return (
    signIn.authTimeSeconds !== null &&
    signIn.linkGuarded &&
    isRecentSignIn(signIn.authTimeSeconds, nowMs) &&
    signedInAfterPasswordChange(signIn.authTimeSeconds, signIn.passwordChangedAt)
  );
}
