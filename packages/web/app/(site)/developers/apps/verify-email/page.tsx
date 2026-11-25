import React from 'react';
import type { Metadata } from 'next';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageShell } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import VerifyDeveloperEmail from '@/app/developers/apps/verify-email/verify-developer-email';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('developers');
  return createNoIndexMetadata({
    title: t('emailVerification.title'),
    description: t('emailVerification.lead'),
    path: '/developers/apps/verify-email',
    locale,
  });
}

export default async function VerifyDeveloperEmailPage() {
  const { t, locale } = await getServerTranslation('developers');
  return (
    <I18nProvider locale={locale} namespaces={['developers']}>
      <PageShell title={t('emailVerification.title')} lead={t('emailVerification.lead')}>
        <VerifyDeveloperEmail />
      </PageShell>
    </I18nProvider>
  );
}
