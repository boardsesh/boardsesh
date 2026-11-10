import React from 'react';
import { parsePartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { searchParamsFromRecord } from '@/app/lib/partner-oauth/authorization-query';
import { decidePartnerConsent } from '@/app/lib/partner-oauth/page-views';
import { readPartnerPageSession } from '@/app/lib/partner-oauth/sign-in-session.server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { PartnerOAuthShell } from '../partner-oauth-layout';
import PartnerConsentContent from './partner-consent-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('oauth');
  return createNoIndexMetadata({
    title: t('metadata.consent.title'),
    description: t('metadata.consent.description'),
    path: '/oauth/consent',
    locale,
  });
}

type PartnerConsentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function PartnerConsentPage({ searchParams }: PartnerConsentPageProps) {
  const [locale, record, session] = await Promise.all([getLocale(), searchParams, readPartnerPageSession()]);
  const view = decidePartnerConsent({
    mode: parsePartnerOAuthMode(process.env.PARTNER_OAUTH_MODE),
    search: searchParamsFromRecord(record),
    session,
    nowMs: Date.now(),
  });

  return (
    <I18nProvider locale={locale} namespaces={['oauth']}>
      <PartnerOAuthShell>
        <PartnerConsentContent view={view} />
      </PartnerOAuthShell>
    </I18nProvider>
  );
}
