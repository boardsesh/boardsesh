import { timingSafeEqual } from 'node:crypto';

/** Cron credentials grant job access only, never a signed-in user identity. */
export function authenticateCronBearer(authHeader: string | null): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret?.trim() || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const actual = Buffer.from(authHeader);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
