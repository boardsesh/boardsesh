import { timingSafeEqual } from 'node:crypto';

/**
 * Verify the server-only web GraphQL client's service credential (#5291).
 * Railway SSR calls share the web service's socket IP, so the ordinary anonymous
 * bucket would limit the entire site. This identity permits per-read service
 * buckets in applyRateLimit; it never grants user or cron access.
 *
 * INTERNAL_SERVICE_SECRET must match on web and backend and stay distinct from
 * CRON_SECRET. Missing/invalid credentials retain ordinary anonymous limits.
 * Equal-length candidates are compared with timingSafeEqual.
 */
export function authenticateInternalServiceSecret(authHeader: string | null): boolean {
  const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET;
  if (!internalServiceSecret?.trim() || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${internalServiceSecret}`);
  const actual = Buffer.from(authHeader);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
