/**
 * Code samples for the public developer docs. Never translated: they are
 * requests a developer copies. Every value comes from docs/partner-api.md and
 * is checked against the backend (token lifetimes, scope names, limits).
 */

export const API_HOST = 'https://api.boardsesh.com';
export const OPENAPI_URL = `${API_HOST}/v1/openapi.json`;
export const SUPPORT_EMAIL = 'support@boardsesh.com';

/** Early-access caps per app (docs/integration-platform.md, "Rules enforced without a human"). */
export const EARLY_ACCESS_LIVE_CLIMBERS = 25;
export const EARLY_ACCESS_NEW_PER_DAY = 20;

export const AUTHORIZE_SAMPLE = `GET ${API_HOST}/api/auth/oauth2/authorize
    ?response_type=code
    &client_id=bsk_4Rk2PzQ8mW1xTb7nYc3vLd
    &redirect_uri=com.example.app%3A%2Foauth%2Fboardsesh
    &scope=logbook%3Aread%20profile%3Aread%20offline_access
    &resource=https%3A%2F%2Fapi.boardsesh.com%2Fv1
    &state=8f3c...
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    &code_challenge_method=S256`;

export const TOKEN_SAMPLE = `curl -X POST ${API_HOST}/api/auth/oauth2/token \\
  -d grant_type=authorization_code \\
  -d code=SplxlOBeZQQYbYS6WxSbIA \\
  -d redirect_uri=com.example.app%3A%2Foauth%2Fboardsesh \\
  -d client_id=bsk_4Rk2PzQ8mW1xTb7nYc3vLd \\
  -d code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk \\
  -d resource=https%3A%2F%2Fapi.boardsesh.com%2Fv1`;

export const TOKEN_RESPONSE_SAMPLE = `{
  "token_type": "Bearer",
  "access_token": "2YotnFZFEjr1zCsicMWpAA...",
  "expires_in": 3600,
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIA...",
  "scope": "logbook:read profile:read offline_access"
}`;

export const SYNC_SAMPLE = `curl "${API_HOST}/v1/logbook/changes?limit=100" \\
  -H "Authorization: Bearer 2YotnFZFEjr1zCsicMWpAA..."

{
  "changes": [
    { "type": "tick", "tick": { "id": "0d6c4a2e-...", "status": "send", "attempts": 3 } },
    { "type": "tick.deleted", "id": "9a1f7c3d-..." }
  ],
  "cursor": "c3.eyJraW5kIjo...",
  "hasMore": true
}`;

export const SCOPES = [
  { scope: 'logbook:read', key: 'logbook' },
  { scope: 'profile:read', key: 'profile' },
  { scope: 'offline_access', key: 'offline' },
] as const;

/** Statuses and error codes the API answers, in the order the page lists them. */
export const ERRORS = [
  { status: '401', code: 'invalid_token', key: 'invalidToken' },
  { status: '403', code: 'insufficient_scope', key: 'insufficientScope' },
  { status: '410', code: 'cursor_expired', key: 'cursorExpired' },
  { status: '429', code: 'rate_limited', key: 'rateLimited' },
  { status: '503', code: 'Retry-After', key: 'busy' },
] as const;
