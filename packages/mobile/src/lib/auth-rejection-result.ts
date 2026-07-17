/**
 * Status returned by `recoverAuthRejection` after the server rejects a
 * credential. Native exchanges a stored refresh token for a new JWT; web
 * revalidates the HttpOnly session — so each platform reports a different
 * success/rejection label. The shared type is the union of both, letting the
 * GraphQL-WS transport (packages/mobile/src/lib/graphql/ws-client-core.ts)
 * treat `refreshed`/`authenticated`/`unavailable` as retryable and the rest as
 * fatal without knowing which platform produced the result.
 */
export type AuthRejectionResult =
  | 'refreshed' // native: refresh-token exchange minted a new JWT
  | 'authenticated' // web: HttpOnly session confirmed still signed in
  | 'rejected' // native: refresh token was revoked or expired
  | 'anonymous' // web: session confirmed signed out
  | 'unavailable' // either: refresh endpoint unreachable — keep the session
  | 'superseded'; // either: credential generation changed mid-flight
