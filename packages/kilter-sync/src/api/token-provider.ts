import { decrypt } from '@boardsesh/crypto';

import { passwordGrant, refreshAccessToken, type KeycloakClientConfig } from './keycloak';

/**
 * A token provider mints a fresh Kilter access token on demand. The
 * catalog runner holds one and calls it at the start of a sync and again
 * if a REST call comes back 401 mid-run — a full-catalog pull can outlast
 * a 5–15 min access-token TTL, so we never cache the token, we re-mint.
 *
 * Both shapes below produce the same `() => Promise<string>` so the runner
 * doesn't care whether the token came from a stored refresh token (prod /
 * piggyback) or a username+password (local test only).
 */
export type KilterTokenProvider = () => Promise<string>;

/**
 * Production / piggyback provider: decrypt the stored refresh token and
 * exchange it for an access token. Keycloak rotates the refresh token on
 * every refresh; `onRotatedRefreshToken` lets the caller persist the new
 * one (re-encrypted) so the stored credential stays valid for next time.
 */
export function refreshTokenProvider(args: {
  encryptedRefreshToken: string;
  client: KeycloakClientConfig;
  onRotatedRefreshToken?: (newRefreshToken: string) => Promise<void> | void;
}): KilterTokenProvider {
  return async () => {
    const refreshToken = decrypt(args.encryptedRefreshToken);
    const tokens = await refreshAccessToken({ refreshToken, client: args.client });
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      await args.onRotatedRefreshToken?.(tokens.refresh_token);
    }
    return tokens.access_token;
  };
}

/**
 * Local-validation provider: ROPC password grant. Gated by the caller to
 * `KILTER_TEST_USERNAME` / `KILTER_TEST_PASSWORD`; never used in prod.
 */
export function passwordTokenProvider(args: {
  username: string;
  password: string;
  client: KeycloakClientConfig;
}): KilterTokenProvider {
  return async () => {
    const tokens = await passwordGrant(args);
    return tokens.access_token;
  };
}
