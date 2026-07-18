import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SignOutContent from './signout-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.signOut.title'),
    description: t('metadata.signOut.description'),
    path: '/auth/signout',
    locale,
  });
}

export default async function SignOutPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <SignOutContent />
      </Suspense>
    </I18nProvider>
  );
}
