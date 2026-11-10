import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { DEVELOPER_CONSOLE_FLAG } from '@/app/flags';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';

/**
 * The gate in front of every developer page (`/developers/apps`,
 * `/developers/terms`): the server flag `developer-console`, which fails
 * closed. Signing in comes first, because a flag can only be asked about a
 * person; with the flag off, or PostHog unreachable, the page is a 404. The
 * backend gates every operation again (PARTNER_OAUTH_MODE and its developer
 * allowlist).
 *
 * The session is read directly rather than through `getPosthogDistinctId`,
 * which reads a credential-authority outage as "signed out": here that would
 * send a signed-in developer to sign in again. The outage throws instead, and
 * the error page says so.
 */
export async function requireDeveloperConsoleAccess(path: string, locale: Locale): Promise<void> {
  const session = await getAdmittedServerSession();
  // `users.id`, the id PostHog knows the developer by (see getPosthogDistinctId).
  const distinctId = session?.user?.id ?? null;
  if (!distinctId) {
    redirect(`${localeHref('/auth/login', locale)}?callbackUrl=${encodeURIComponent(localeHref(path, locale))}`);
  }
  if (!(await getServerFeatureFlag(DEVELOPER_CONSOLE_FLAG, { distinctId }))) notFound();
}
