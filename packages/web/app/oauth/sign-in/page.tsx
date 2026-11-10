import React from 'react';
import { redirect } from 'next/navigation';
import { parsePartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { applyLocale } from '@/app/lib/i18n/locale-href';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { searchParamsFromRecord } from '@/app/lib/partner-oauth/authorization-query';
import { decidePartnerSignIn } from '@/app/lib/partner-oauth/page-views';
import { readPartnerPageSession } from '@/app/lib/partner-oauth/sign-in-session.server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { PartnerOAuthShell } from '../partner-oauth-layout';
import PartnerSignInContent from './partner-sign-in-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('oauth');
  return createNoIndexMetadata({
    title: t('metadata.signIn.title'),
    description: t('metadata.signIn.description'),
    path: '/oauth/sign-in',
    locale,
  });
}

type PartnerSignInPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function PartnerSignInPage({ searchParams }: PartnerSignInPageProps) {
  const [locale, record, session] = await Promise.all([getLocale(), searchParams, readPartnerPageSession()]);
  const decision = decidePartnerSignIn({
    mode: parsePartnerOAuthMode(process.env.PARTNER_OAUTH_MODE),
    search: searchParamsFromRecord(record),
    session,
    nowMs: Date.now(),
  });
  // Back from a sign-in this page started: authorize decides again.
  if (decision.kind === 'forward') redirect(decision.url);
  const view =
    decision.kind === 'sign-in' ? { ...decision, returnPath: applyLocale(decision.returnPath, locale) } : decision;

  return (
    <I18nProvider locale={locale} namespaces={['oauth', 'auth']}>
      <PartnerOAuthShell>
        <PartnerSignInContent view={view} />
      </PartnerOAuthShell>
    </I18nProvider>
  );
}
