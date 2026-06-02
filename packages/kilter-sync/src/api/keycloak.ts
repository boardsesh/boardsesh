import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { KILTER_IDP_HOST, KILTER_OAUTH_TOKEN_URL, KILTER_OIDC_REALM } from './types';
import { KilterApiError } from './errors';

/**
 * Standard OIDC token-endpoint responses. Keycloak uses the OpenID Connect
 * `application/x-www-form-urlencoded` request shape; the response is JSON.
 */
export type KeycloakTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_expires_in?: number;
  refresh_token?: string;
  token_type: string; // 'Bearer'
  id_token?: string;
  'not-before-policy'?: number;
  session_state?: string;
  scope?: string;
};

export type KeycloakClientConfig = {
  clientId: string;
  /**
   * Public PKCE clients omit the secret. If our Keycloak realm requires a
   * confidential client we set this; otherwise we send only `code_verifier`
   * + PKCE on the token exchange.
   */
  clientSecret?: string;
};

const REQUEST_TIMEOUT_MS = 30_000;

async function tokenRequest(body: URLSearchParams, config: KeycloakClientConfig): Promise<KeycloakTokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (config.clientSecret) {
    // Confidential client: send client_id + client_secret in the body
    // (Keycloak also accepts Basic auth; body works in both flows).
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  } else {
    body.set('client_id', config.clientId);
  }

  let response: Response;
  try {
    response = await fetch(KILTER_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new KilterApiError('timeout', `Keycloak token request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new KilterApiError('network', `Keycloak token request failed: ${(err as Error).message ?? err}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // Standard OIDC error envelope: { error: 'invalid_grant', error_description: '…' }
    let oidcError: { error?: string; error_description?: string } = {};
    try {
      oidcError = JSON.parse(text) as { error?: string; error_description?: string };
    } catch {
      // Non-JSON body — fall back to status text below.
    }

    if (oidcError.error === 'invalid_grant') {
      throw new KilterApiError('invalid_grant', oidcError.error_description ?? 'Refresh token rejected by Keycloak');
    }
    if (oidcError.error === 'invalid_client' || response.status === 401) {
      throw new KilterApiError('invalid_client', oidcError.error_description ?? 'Keycloak rejected client credentials');
    }
    if (response.status === 429) {
      throw new KilterApiError('rate_limited', 'Keycloak rate-limited the token endpoint', 429);
    }
    throw new KilterApiError(
      'http',
      `Keycloak token request returned ${response.status}: ${oidcError.error_description ?? text.slice(0, 200)}`,
      response.status,
    );
  }

  return (await response.json()) as KeycloakTokenResponse;
}

/**
 * Exchange a PKCE authorization code for tokens. Called once per user on
 * the OAuth callback — see packages/web/app/api/auth/kilter/callback/route.ts.
 */
export async function exchangeAuthorizationCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  client: KeycloakClientConfig;
}): Promise<KeycloakTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  return tokenRequest(body, args.client);
}

/**
 * Mint a fresh access token from a stored refresh token. Called once per
 * sync cycle by the daemon — access tokens TTL is typically 5–15 min, so
 * we don't bother caching across cycles.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  client: KeycloakClientConfig;
}): Promise<KeycloakTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
  });
  return tokenRequest(body, args.client);
}

/**
 * Threat model for JWT verification:
 *
 * `KILTER_IDP_HOST` is env-driven so we can point a dev build at a
 * sandbox. That same flexibility means a misconfigured or hostile env
 * var could point the runner at attacker-controlled infra — at which
 * point the access_token / id_token we receive is whatever the attacker
 * wanted us to believe. "We got it over TLS" only proves we talked to
 * whoever the env vars sent us to.
 *
 * Verifying the JWT signature against Keycloak's published JWKS — and
 * checking `iss` matches the realm URL we expect — closes that gap:
 * tokens minted by anyone other than the legitimate realm key fail to
 * verify, no matter what the env vars say. The host-allowlist on
 * KILTER_IDP_HOST (see types.ts) is the other half of this defence:
 * together they prevent an env-set host from silently rerouting our
 * bearer tokens.
 *
 * `iss` is always required. `aud` is checked when the caller passes
 * `expectedAudience` (Keycloak's id_token sets `aud=<client_id>`; access
 * tokens vary by realm setup, so we leave that to the caller). `exp` is
 * enforced unconditionally by jose.
 */
const KILTER_REALM_ISSUER = `https://${KILTER_IDP_HOST}/realms/${KILTER_OIDC_REALM}`;
const KILTER_JWKS_URL = new URL(`${KILTER_REALM_ISSUER}/protocol/openid-connect/certs`);

// Cache the remote JWKS instance at module scope — jose's
// createRemoteJWKSet handles refresh internally (re-fetches on
// signature-key miss, caches by `kid`).
//
// Scope note: this is *module-scope* caching, which means the lifetime
// equals the lifetime of the JS module instance. In a long-lived
// process (kilter-sync backend daemon) the cache persists across
// requests; in Next.js serverless route handlers (the OAuth callback)
// every cold start re-initialises module scope and the cache is fresh
// per cold start. That's fine — jose still issues a single JWKS GET
// per cold start regardless, so the cache adds a per-instance dedup
// rather than cross-instance sharing. If we ever care about
// cross-instance sharing we'd need an external store (Redis), which is
// over-kill for a JWKS hit that costs <50ms.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks === null) {
    cachedJwks = createRemoteJWKSet(KILTER_JWKS_URL);
  }
  return cachedJwks;
}

export async function verifyKeycloakToken(
  jwt: string,
  opts: { expectedIssuer?: string; expectedAudience?: string } = {},
): Promise<{ sub: string; preferredUsername?: string; payload: JWTPayload }> {
  const expectedIssuer = opts.expectedIssuer ?? KILTER_REALM_ISSUER;
  try {
    const { payload } = await jwtVerify(jwt, getJwks(), {
      issuer: expectedIssuer,
      audience: opts.expectedAudience,
      // jose enforces `exp` by default; nothing extra needed here.
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new KilterApiError('unauthorized', 'Keycloak JWT missing sub');
    }
    const preferredUsername = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
    return { sub: payload.sub, preferredUsername, payload };
  } catch (err) {
    if (err instanceof KilterApiError) throw err;
    throw new KilterApiError('unauthorized', `Keycloak JWT verification failed: ${(err as Error).message ?? err}`);
  }
}

/**
 * Revoke a refresh token via Keycloak's logout endpoint. Called on
 * `/disconnect` so even with a leaked encrypted refresh_token (from a
 * pg_dump, backup, Sentry payload, …) the token can't be used to mint
 * fresh access tokens.
 *
 * Failure is intentionally swallowed (logged via the callback if
 * provided): a Keycloak outage must not block local credential cleanup.
 * Worst case is the refresh_token remains live until its TTL expires
 * (~7 days default) — better than leaving stale local rows because
 * Keycloak was down.
 */
export async function revokeRefreshToken(
  refreshToken: string,
  client: KeycloakClientConfig,
  opts: { onError?: (err: unknown) => void } = {},
): Promise<void> {
  const body = new URLSearchParams({ refresh_token: refreshToken });
  if (client.clientSecret) {
    body.set('client_id', client.clientId);
    body.set('client_secret', client.clientSecret);
  } else {
    body.set('client_id', client.clientId);
  }

  const logoutUrl = `https://${KILTER_IDP_HOST}/realms/${KILTER_OIDC_REALM}/protocol/openid-connect/logout`;
  try {
    const response = await fetch(logoutUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      opts.onError?.(
        new KilterApiError(
          'http',
          `Keycloak logout returned ${response.status}: ${text.slice(0, 200)}`,
          response.status,
        ),
      );
    }
  } catch (err) {
    opts.onError?.(err);
  }
}
