import { timingSafeEqual } from 'node:crypto';

/**
 * Authenticates Boardsesh's own trusted server-side data layer — specifically
 * `executeGraphQLInternal` (packages/web/app/lib/graphql/server-cached-client.ts),
 * the `server-only` helper every SSR/data-cache read goes through.
 *
 * Why this exists (issue #5291): a server-side render has no visitor identity
 * of its own. Before this, the anonymous per-IP rate-limit bucket
 * (`applyRateLimit`, keyed off `resolveWebSocketClientIp`) silently collapsed
 * onto one shared key for every SSR caller once the web tier started reaching
 * the backend over Railway's private network (`BACKEND_INTERNAL_URL`, no
 * Cloudflare hop in between, so no per-visitor IP survives) — one 30/min
 * bucket served every anonymous climb-page render on the planet at once.
 *
 * This grants trusted-SERVICE status only — never a signed-in user identity,
 * and never a bypass of rate limiting altogether. `applyRateLimit` gives an
 * `isInternalService` caller its own fleet-wide, deliberately generous
 * ceiling (see `INTERNAL_SERVICE_RATE_LIMIT_FLOOR`/`_MULTIPLIER` in
 * `graphql/resolvers/shared/helpers.ts`) instead of either the per-visitor
 * bucket (the wrong identity for a server-to-server call) or no limit at all
 * (no backstop against a bug in our own code hammering the backend).
 *
 * Not spoofable by a header a browser client controls: the secret is read
 * only from `process.env.INTERNAL_SERVICE_SECRET` on the server, is never
 * shipped to any client bundle (`server-cached-client.ts` is `server-only`),
 * and is compared with `timingSafeEqual`, exactly like `authenticateCronBearer`.
 * Deliberately a distinct secret from `CRON_SECRET`: that credential grants
 * job-trigger access to `/api/internal/*` routes, a different trust boundary —
 * rotating one must not silently rotate the other.
 */
export function authenticateInternalServiceSecret(authHeader: string | null): boolean {
  const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET;
  if (!internalServiceSecret?.trim() || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${internalServiceSecret}`);
  const actual = Buffer.from(authHeader);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
