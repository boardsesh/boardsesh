/**
 * Host constants for Kilter Grips' three planes: the OIDC identity provider
 * (Keycloak), the REST portal, and the PowerSync stream. All three accept
 * the same Keycloak access token in `Authorization: Bearer …`.
 *
 * Override per-environment via env vars so we can point a dev build at a
 * sandbox without recompiling.
 *
 * Defence in depth against a misconfigured or hostile env: in production
 * each host MUST sit in the `kiltergrips.com` zone. A typo or attacker-
 * set env var would otherwise quietly reroute every bearer token we
 * mint to a third party. Non-prod sandboxes can still point anywhere
 * (with a warning) so dev/staging stays flexible.
 */
const KILTER_HOST_PATTERN = /^[a-z0-9.-]+\.kiltergrips\.com$/;

function validateKilterHost(name: string, value: string): string {
  if (!KILTER_HOST_PATTERN.test(value)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${name} must match ${KILTER_HOST_PATTERN}; got ${JSON.stringify(value)}`);
    }
    // Non-prod sandboxes are allowed any value but log a warning so it
    // shows up in dev console.
    console.warn(`[kilter-sync] ${name} not in kiltergrips.com zone — ${value}. Allowed in non-prod.`);
  }
  return value;
}

export const KILTER_IDP_HOST = validateKilterHost(
  'KILTER_IDP_HOST',
  process.env.KILTER_IDP_HOST ?? 'idp.kiltergrips.com',
);
export const KILTER_PORTAL_HOST = validateKilterHost(
  'KILTER_PORTAL_HOST',
  process.env.KILTER_PORTAL_HOST ?? 'portal.kiltergrips.com',
);
export const KILTER_SYNC_HOST = validateKilterHost(
  'KILTER_SYNC_HOST',
  process.env.KILTER_SYNC_HOST ?? 'sync1.kiltergrips.com',
);

/**
 * Keycloak realm — standard OIDC; the realm name is part of the configured
 * IDP and can move with the env var too.
 */
export const KILTER_OIDC_REALM = process.env.KILTER_OIDC_REALM ?? 'kilter';

export const KILTER_OAUTH_AUTH_URL = `https://${KILTER_IDP_HOST}/realms/${KILTER_OIDC_REALM}/protocol/openid-connect/auth`;
export const KILTER_OAUTH_TOKEN_URL = `https://${KILTER_IDP_HOST}/realms/${KILTER_OIDC_REALM}/protocol/openid-connect/token`;
export const KILTER_POWERSYNC_STREAM_URL = `https://${KILTER_SYNC_HOST}/sync/stream`;

/**
 * The aurora-sync codebase types this as `'kilter' | 'tension'` but the
 * compile-time-known board for this package is always 'kilter'. Kept as a
 * constant so callers don't have to remember.
 */
export const KILTER_BOARD_TYPE = 'kilter' as const;

export type KilterBoardType = typeof KILTER_BOARD_TYPE;
