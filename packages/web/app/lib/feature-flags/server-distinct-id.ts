import 'server-only';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';

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
  try {
    const session = await getAdmittedServerSession();
    return session?.user?.id ?? null;
  } catch (error) {
    // This only picks an analytics label, so an outage must not fail the page.
    if (error instanceof CredentialAuthorityUnavailable) return null;
    throw error;
  }
}
