// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
    // Unknown error shape — fail CLOSED to "permanent". A non-KilterApiError
    // (a TypeError, a parser bug, a raw DB error) is NOT a known-retryable
    // condition, so classifying it transient hid the live kilter outage:
    // syncStatus stayed 'active', no error was recorded, and the daemon
    // re-attempted the same broken cycle forever with nothing user-visible
    // to show for it. Returning false now escalates to syncStatus='error'
    // with an observable last_sync_error — but the credential is NOT
    // abandoned: 'error' stays in the runner's candidate set, so it is still
    // retried, just on the exponential per-credential backoff (see
    // credentialRetryReadySql). A real programming bug therefore surfaces
    // loudly and self-heals once fixed, instead of failing silently.
    return false;
  }

  switch (err.code) {
    case 'rate_limited':
    case 'network':
    case 'timeout':
    case 'powersync':
      return true;
    case 'invalid_client':
      // Operator-config fault, not a per-user fault. `invalid_client` means
      // the OAuth client credentials (KILTER_OAUTH_CLIENT_ID/SECRET) are
      // wrong or unknown to Keycloak — identical for every credential the
      // daemon walks. Classifying it permanent would flip EVERY user to
      // syncStatus = 'error' as the runner iterates. Treat it as transient
      // so the daemon retries (and keeps erroring loudly) until the operator
      // fixes the env, instead of mass-disabling user credentials.
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
    case 'unknown':
      return false;
    default: {
      const _exhaustive: never = err.code;
      return _exhaustive;
    }
  }
}
