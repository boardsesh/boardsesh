# Mobile Auth Flow

## Overview

The mobile auth flow lets React Native (Expo) clients authenticate with the Boardsesh backend. React Native cannot share the NextAuth session cookie used by the web app because there is no embedded WebView hosting the Next.js origin. Instead, the mobile app completes OAuth in a system browser, receives a short-lived transfer token from the web callback, and exchanges it for a long-lived JWT + refresh token pair via the backend.

## Token exchange flow

1. The mobile app opens the OAuth provider (Google/Apple) in a system browser via `expo-web-browser`'s `openAuthSessionAsync(url, 'com.boardsesh.app://auth/callback')` (`packages/mobile/src/lib/auth.ts`).
2. The OAuth callback on the Next.js web app creates a **transfer token** -- an HMAC-SHA256 signed payload containing the authenticated `userId`, `iat`, and `exp`. The token is valid for 120 seconds.
3. The web app redirects to `com.boardsesh.app://auth/callback?transferToken=...`. How that callback reaches the app differs by platform -- see [Callback delivery](#callback-delivery-ios-vs-android) below.
4. The mobile app sends the transfer token to `POST /auth/native/exchange`.
5. The backend verifies the HMAC signature and expiry, checks for replay, then issues a JWT + refresh token pair.
6. The mobile app stores both tokens in `expo-secure-store` and uses the JWT for all authenticated requests.

## Callback delivery (iOS vs Android)

The redirect to the `com.boardsesh.app://auth/callback` scheme is **not** uniformly delivered as a deep link:

- **iOS:** `openAuthSessionAsync` uses `ASWebAuthenticationSession`, which _consumes_ the redirect and returns it as the function's result: `{ type: 'success', url: 'com.boardsesh.app://auth/callback?transferToken=...' }`. The OS never delivers the URL to the app as a deep link, so expo-router never routes it. The login screen (`packages/mobile/app/auth/login.tsx`) must parse `result.url` (via `parseAuthCallbackParams` in `packages/mobile/src/lib/auth-callback-url.ts`) and route the token to the `/auth/callback` screen itself.
- **Android:** `openAuthSessionAsync` is polyfilled with a Custom Tab plus a `Linking` URL listener. The redirect arrives as a real deep link, which expo-router _also_ routes -- so `/auth/callback` can mount twice for the same token: once from expo-router's own deep-link handling and once from the login screen's explicit navigation.

Because transfer tokens are one-time use, `app/auth/callback.tsx` deduplicates the exchange with a module-level `Set` of already-exchanged tokens. The duplicate mount shows the spinner until `AuthProvider` redirects out of the auth group; without the dedup, the second exchange would hit the replay guard (`409`) and flash an error after a successful login. The set grows by one short string per login attempt for the process lifetime, which is negligible.

A `?error=...` query param on the callback (e.g. `session_missing`, `token_issue_failed`) means the web side could not issue a token; the login screen surfaces it as a translated error.

## Token format

### JWT (access token)

- **Algorithm:** HS256
- **Signing key:** `NEXTAUTH_SECRET` (raw bytes via `TextEncoder`)
- **Claims:**
  - `sub` -- user ID
  - `iss` -- `"boardsesh"`
  - `aud` -- `"boardsesh-mobile"`
  - `iat` -- issued-at (Unix seconds)
  - `exp` -- expiration (Unix seconds)
- **Lifetime:** 7 days
- **Header:** `{ "alg": "HS256", "typ": "JWT" }`

### Refresh token

- Opaque 256-bit hex string (`crypto.randomBytes(32).toString('hex')`)
- Stored in the database as a SHA-256 hash (`mobileRefreshTokens` table)
- **Lifetime:** 90 days from issuance

## Refresh token rotation

Every refresh request atomically revokes the presented refresh token and issues a new JWT + refresh token pair. The `WHERE ... AND revoked_at IS NULL` clause in the update query prevents TOCTOU races: if two concurrent requests present the same token, only one gets the row back.

If a revoked or expired refresh token is presented, the backend returns `401` and does not issue new tokens.

## Dual token validation

The backend accepts both NextAuth web tokens and mobile JWTs on the same WebSocket and HTTP endpoints. It distinguishes them by segment count:

| Token type         | Format | Segments (split on `.`) |
| ------------------ | ------ | ----------------------- |
| NextAuth JWE (web) | JWE    | 5                       |
| Mobile JWS         | JWT    | 3                       |

`validateToken()` in `packages/backend/src/middleware/auth.ts` dispatches to the correct verifier based on this heuristic. Both paths cache results in an in-process map (60s TTL) to avoid repeated cryptographic operations.

## Rate limiting

Both `/auth/native/exchange` and `/auth/native/refresh` share an IP-based rate limiter:

- **Limit:** 10 requests per minute per IP
- **Window:** 60 seconds (sliding reset per IP)
- **Response when exceeded:** `429` with `Retry-After` header
- **Map bounds:** 50,000 entries max. If the map is full after eviction, the endpoint returns `503`.

Expired entries are cleaned up every 60 seconds.

The `/auth/native/revoke` endpoint is exempt from rate limiting because it requires a valid refresh token (a secret) and exempting it prevents aggressive retry loops from locking a user out of sign-out.

> **Note:** Rate limiting is per-instance. With N backend instances behind a load balancer, the effective limit is 10 x N requests per minute per IP. The high-risk replay prevention path uses Redis and is multi-instance safe.

## Transfer token replay prevention

After a transfer token is verified, its signature is stored in an in-memory `Map<string, number>` keyed by the base64url signature portion of the token, with the consumption timestamp as the value.

- **TTL:** 125 seconds (slightly longer than the 120s token lifetime so replays within the validity window are always caught)
- **Eviction:** stale entries are cleaned every 60 seconds
- **Map bounds:** 10,000 entries max. An early eviction pass runs when the limit is reached. If still full, the endpoint returns `503`.

A replayed token receives a `409` response with the body `{ "error": "Transfer token has already been used" }`.

## Client-side behavior

### Token storage

Tokens are stored in `expo-secure-store` under three keys:

| Key                          | Value                  |
| ---------------------------- | ---------------------- |
| `boardsesh_jwt`              | JWT access token       |
| `boardsesh_refresh_token`    | Refresh token (UUID)   |
| `boardsesh_token_expires_at` | ISO 8601 expiry string |

### Proactive refresh

`isTokenExpiringSoon()` returns `true` when the JWT is within 24 hours of expiry. `ensureFreshToken()` is called before every authenticated request and triggers a refresh if needed.

### 401 retry with deduplication

If a request returns `401`, `authenticatedFetch()` triggers a token refresh and retries the request once with the new JWT. Concurrent refresh attempts are deduplicated via a shared `refreshPromise` -- only one network call is made regardless of how many requests hit `401` simultaneously.

If the refresh itself fails, all tokens are cleared and the user is signed out.

## Endpoint reference

### POST /auth/native/exchange

Exchange a transfer token for a JWT + refresh token pair.

**Request:**

```json
{
  "transferToken": "<payload>.<signature>"
}
```

**Success response (200):**

```json
{
  "jwt": "<signed-jwt>",
  "refreshToken": "<uuid>",
  "expiresAt": "2026-06-22T12:00:00.000Z"
}
```

**Error responses:**

| Status | Body                                                  | Condition                        |
| ------ | ----------------------------------------------------- | -------------------------------- |
| 400    | `{ "error": "transferToken is required" }`            | Missing or empty `transferToken` |
| 401    | `{ "error": "Invalid or expired transfer token" }`    | Bad signature or expired         |
| 409    | `{ "error": "Transfer token has already been used" }` | Replay of a consumed token       |
| 429    | `{ "error": "Rate limit exceeded..." }`               | IP rate limit hit                |
| 503    | `{ "error": "Service temporarily overloaded" }`       | Internal map capacity exceeded   |

### POST /auth/native/refresh

Rotate a refresh token for a new JWT + refresh token pair.

**Request:**

```json
{
  "refreshToken": "<uuid>"
}
```

**Success response (200):**

```json
{
  "jwt": "<signed-jwt>",
  "refreshToken": "<uuid>",
  "expiresAt": "2026-06-22T12:00:00.000Z"
}
```

**Error responses:**

| Status | Body                                            | Condition                        |
| ------ | ----------------------------------------------- | -------------------------------- |
| 400    | `{ "error": "refreshToken is required" }`       | Missing or empty `refreshToken`  |
| 401    | `{ "error": "Invalid refresh token" }`          | Unknown or already-revoked token |
| 401    | `{ "error": "Refresh token expired" }`          | Token past 90-day expiry         |
| 429    | `{ "error": "Rate limit exceeded..." }`         | IP rate limit hit                |
| 503    | `{ "error": "Service temporarily overloaded" }` | Internal map capacity exceeded   |

### POST /auth/native/revoke

Revoke all refresh tokens for the user associated with the submitted token (full sign-out).

**Request:**

```json
{
  "refreshToken": "<uuid>"
}
```

**Success response (200):**

```json
{
  "revoked": true
}
```

**Error responses:**

| Status | Body                                      | Condition                        |
| ------ | ----------------------------------------- | -------------------------------- |
| 400    | `{ "error": "refreshToken is required" }` | Missing or empty `refreshToken`  |
| 401    | `{ "error": "Invalid refresh token" }`    | Unknown or already-revoked token |

## Known limitations

- **JWTs cannot be revoked before expiry (7-day window).** Once issued, a JWT is valid until it expires. If a JWT is stolen, it can be used for up to 7 days. Mitigation: short lifetime (7 days instead of 30) combined with refresh token rotation means the window is bounded and a revoke call invalidates future refreshes immediately.
- **Token validation results are cached for up to 60 seconds.** Successful validation results are cached in-process for up to 60 seconds. A revoked JWT may continue to authenticate for up to 60 seconds after revocation. This is standard for JWT-based systems and is the trade-off for avoiding cryptographic verification on every request. Failed validations are not cached, so transient errors (e.g. secret unset during restart) resolve as soon as the underlying issue is fixed.
- **Rate limiting is per-instance when not behind a single proxy.** The IP-based rate limiter uses an in-memory map, so each backend instance maintains its own counters. In a multi-instance deployment without a shared proxy, an attacker could spread requests across instances to exceed the intended limit. Mitigation: Redis-backed replay prevention covers the highest-risk path (transfer token exchange), and refresh token rotation is inherently safe against replay.
