import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { localeHref } from '@/app/lib/i18n/locale-href';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import FirstPasswordContent from '@/app/settings/first-password/first-password-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('settings');
  return createNoIndexMetadata({
    title: t('metadata.firstPassword.title'),
    description: t('metadata.firstPassword.description'),
    path: '/settings/first-password',
    locale,
  });
}

/**
 * A first password for an account with none, signed in through Google or Apple (#7596 B5e2),
 * under `AUTH_BROWSER_SESSION_MODE=better-auth` only (404 otherwise). The
 * climber asks for an email; its link, opened in this browser, lets this same
 * session choose the password.
 */
export default async function FirstPasswordPage() {
  if (browserSessionRouteMode().kind !== 'better-auth') notFound();
  const locale = await getLocale();
  const session = await getAdmittedServerSession();
  if (!session?.user?.id) {
    const here = localeHref('/settings/first-password', locale);
    redirect(`${localeHref('/auth/login', locale)}?${new URLSearchParams({ callbackUrl: here }).toString()}`);
  }
  return (
    <I18nProvider locale={locale} namespaces={['settings']}>
      <FirstPasswordContent email={session.user.email ?? ''} />
    </I18nProvider>
  );
}
