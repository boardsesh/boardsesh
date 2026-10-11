import React from 'react';
import { decode } from 'next-auth/jwt';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SupportContent from './support-content';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_SUPPORT_PAGE, type GetSupportPageResponse } from '@boardsesh/graphql/operations/support';
import { resolveStripeDonateUrl } from './stripe-donate-url';

export const dynamic = 'force-dynamic';

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
  const authToken = await getServerAuthToken();
  let initialUserId: string | null = null;
  if (authToken && process.env.NEXTAUTH_SECRET) {
    try {
      const principal = await decode({ token: authToken, secret: process.env.NEXTAUTH_SECRET });
      initialUserId = typeof principal?.sub === 'string' && principal.sub.trim() ? principal.sub : null;
    } catch {
      // Invalid cookies cannot own server-rendered supporter state.
    }
  }
  let supportPage: GetSupportPageResponse = {
    supportConfiguration: {
      enabled: false,
      currency: 'USD',
      minimumAmount: 100,
      maximumAmount: 50_000,
      legacyDonateUrl: resolveStripeDonateUrl(),
    },
    mySupporterStatus: {
      linked: false,
      hasSupported: false,
      showPublicly: false,
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    },
  };
  const anonymousSupporterStatus = supportPage.mySupporterStatus;
  try {
    supportPage = await createGraphQLHttpClient(initialUserId ? authToken : undefined).request<GetSupportPageResponse>(
      GET_SUPPORT_PAGE,
    );
  } catch {
    // Keep the support page usable during a backend deploy or local setup.
  }
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <SupportContent
        configuration={{
          ...supportPage.supportConfiguration,
          legacyDonateUrl: supportPage.supportConfiguration.legacyDonateUrl ?? resolveStripeDonateUrl(),
        }}
        initialStatus={initialUserId ? supportPage.mySupporterStatus : anonymousSupporterStatus}
        initialUserId={initialUserId}
        locale={locale}
      />
    </I18nProvider>
  );
}
