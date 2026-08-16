import 'server-only';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';

/**
 * The distinct id PostHog knows the current visitor by, or `null` when nobody
 * is signed in.
 *
 * `session.user.id` is `users.id`, and it is the value
 * `reconcileAnalyticsIdentity` hands to `identify()` — so a server-side flag
 * evaluation keyed on it lands on the same PostHog person the dashboard shows.
 * Anything else (a generated uuid, the email, the anonymous party-profile id)
 * evaluates person-property targeting to `false` while looking perfectly
 * healthy, which is the whole reason this helper exists instead of each caller
 * inventing an id.
 *
 * Reading the session makes the calling route dynamic. That is correct here:
 * the answer is per-person by construction.
 */
export async function getPosthogDistinctId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}
