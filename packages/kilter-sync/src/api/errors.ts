/**
 * Errors the runner uses to decide between "back off, retry later" and
 * "mark this credential errored, escalate to the user". The aurora-sync
 * runner has the same split — both daemons share the "transient = retry,
 * permanent = stop trying" policy.
 */

export type KilterErrorCode =
  | 'invalid_grant' // Keycloak refresh token expired / revoked → user re-auth
  | 'invalid_client'
  | 'unauthorized'
  | 'rate_limited'
  | 'http' // generic 5xx
  | 'network'
  | 'timeout'
  | 'powersync' // stream-level failure
  | 'unknown';

export class KilterApiError extends Error {
  constructor(
    public readonly code: KilterErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'KilterApiError';
  }
}

/**
 * Returns true if the runner should treat this as transient (retry next
 * cycle, leave syncStatus unchanged) rather than escalating to syncStatus
 * = 'error'. `invalid_grant` is the canonical "user must re-auth" signal
 * and is the only Keycloak failure we treat as permanent.
 */
export function isTransientKilterError(err: unknown): boolean {
  if (!(err instanceof KilterApiError)) {
    // Unknown error shape — fail open to "transient" so we don't permanently
    // disable a credential on a TypeError or a parser bug.
    //
    // Caveat: there's no error counter or circuit breaker here, so a
    // persistent programming bug (e.g. a TypeError that throws every
    // cycle inside syncKilterUserData) will silently burn daemon
    // cycles without ever flipping syncStatus to 'error'. The
    // operational signal in that case is Sentry / the daemon's onError
    // log path — the daemon visibly logs every error per cycle, and
    // Sentry deduplicates on the exception fingerprint. Adding a real
    // circuit breaker is tracked as a follow-up; aurora-sync has the
    // same gap.
    return true;
  }

  switch (err.code) {
    case 'rate_limited':
    case 'network':
    case 'timeout':
    case 'powersync':
      return true;
    case 'http':
      return err.httpStatus !== undefined && err.httpStatus >= 500;
    case 'unauthorized':
      // A 401 is treated as transient on purpose. Keycloak occasionally
      // returns 401 for race conditions during token refresh or brief
      // realm-config reloads; the next sync cycle will re-acquire a
      // fresh access token from the still-valid refresh token. Only
      // `invalid_grant` (refresh token genuinely expired/revoked) is
      // the "user must re-auth" terminal state — that flag flows
      // through `invalid_grant` below, not here.
      return true;
    case 'invalid_grant':
    case 'invalid_client':
    case 'unknown':
      return false;
    default: {
      const _exhaustive: never = err.code;
      return _exhaustive;
    }
  }
}
