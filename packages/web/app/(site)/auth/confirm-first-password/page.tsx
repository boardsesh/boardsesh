import React, { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import ConfirmFirstPasswordContent from '@/app/auth/confirm-first-password/confirm-first-password-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.confirmFirstPassword.title'),
    description: t('metadata.confirmFirstPassword.description'),
    path: '/auth/confirm-first-password',
    locale,
  });
}

/**
 * Where the first-password email's link lands (#7596 B5e2), under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` only (404 otherwise). The link's
 * token and operation key ride in the fragment, so this GET changes nothing
 * and the server never sees them; the page checks the link belongs to this
 * browser and session, and the password is chosen with a POST from here.
 */
export default async function ConfirmFirstPasswordPage() {
  if (browserSessionRouteMode().kind !== 'better-auth') notFound();
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <ConfirmFirstPasswordContent />
      </Suspense>
    </I18nProvider>
  );
}
