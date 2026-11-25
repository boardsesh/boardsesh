import React, { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import { safeCallbackUrl } from '@/app/auth/signout/safe-callback-url';
import ReauthenticateContent, { type ReauthenticationOutcome } from '@/app/auth/reauthenticate/reauthenticate-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.reauthenticate.title'),
    description: t('metadata.reauthenticate.description'),
    path: '/auth/reauthenticate',
    locale,
  });
}

type ReauthenticatePageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * The one forced re-sign-in entry point (#7655 item 6) for Settings, the
 * developer console and partner pages, under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (404 otherwise). It is a real sign-in of the account already signed in: its
 * password, or Google with a forced fresh prompt. Either is a login, so the
 * backend issues a session whose sign-in time is now (Google only with a
 * signed `auth_time` under five minutes old). Both sign-ins come back through
 * `/api/auth/reauthenticate/return`, which forwards to the same-origin
 * `callbackUrl` only when the same account came back (the sealed
 * `startedAs`); otherwise this page says so (`outcome=other_account`). A
 * silent sign-in can never satisfy it.
 */
export default async function ReauthenticatePage({ searchParams }: ReauthenticatePageProps) {
  if (browserSessionRouteMode().kind !== 'better-auth') notFound();
  const { callbackUrl, outcome } = await searchParams;
  // Only the return route sends these; either one only changes what the page says.
  const shownOutcome: ReauthenticationOutcome | undefined =
    outcome === 'other_account' || outcome === 'expired' ? outcome : undefined;
  const returnTo = safeCallbackUrl(typeof callbackUrl === 'string' ? callbackUrl : undefined);
  const session = await getAdmittedServerSession();
  const email = session?.user?.email;
  if (!session?.user?.id || !email) {
    const here = `/auth/reauthenticate?${new URLSearchParams({ callbackUrl: returnTo }).toString()}`;
    redirect(`/auth/login?${new URLSearchParams({ callbackUrl: here }).toString()}`);
  }
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <ReauthenticateContent email={email} callbackUrl={returnTo} outcome={shownOutcome} />
      </Suspense>
    </I18nProvider>
  );
}
