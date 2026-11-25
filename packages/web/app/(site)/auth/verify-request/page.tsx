import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import VerifyRequestContent from '@/app/auth/verify-request/verify-request-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.verifyRequest.title'),
    description: t('metadata.verifyRequest.description'),
    path: '/auth/verify-request',
    locale,
  });
}

export default async function VerifyRequestPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <VerifyRequestContent />
      </Suspense>
    </I18nProvider>
  );
}
