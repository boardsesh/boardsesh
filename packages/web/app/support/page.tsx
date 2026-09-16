import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SupportContent from './support-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.support.title'),
    description: t('metadata.support.description'),
    path: '/support',
    locale,
  });
}

export default async function SupportPage() {
  const locale = await getLocale();
  // Unset in most environments today: the one-time donation rail stays hidden
  // until a Stripe Payment Link exists, rather than rendering a dead button.
  const stripeDonateUrl = process.env.NEXT_PUBLIC_STRIPE_DONATE_URL;
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <SupportContent stripeDonateUrl={stripeDonateUrl} />
    </I18nProvider>
  );
}
