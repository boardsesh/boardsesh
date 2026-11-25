import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { headers } from 'next/headers';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import { readReauthenticationCookie } from '@/app/lib/auth/reauthentication-cookie.server';
import AuthErrorContent from '@/app/auth/error/auth-error-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.error.title'),
    description: t('metadata.error.description'),
    path: '/auth/error',
    locale,
  });
}

/** The return path of a forced re-sign-in in progress in this browser, under `better-auth` only. */
async function reauthenticationReturnTo(): Promise<string | undefined> {
  const mode = browserSessionRouteMode();
  if (mode.kind !== 'better-auth') return undefined;
  return readReauthenticationCookie((await headers()).get('cookie'), mode.cookies)?.returnTo;
}

export default async function AuthErrorPage() {
  const locale = await getLocale();
  const returnTo = await reauthenticationReturnTo();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <AuthErrorContent reauthenticationReturnTo={returnTo} />
      </Suspense>
    </I18nProvider>
  );
}
