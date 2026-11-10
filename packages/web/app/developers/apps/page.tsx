import React from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { DEVELOPER_CONSOLE_FLAG } from '@/app/flags';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageShell } from '@/app/components/ui/page-shell';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import DeveloperAppsContent from './developer-apps-content';

export const dynamic = 'force-dynamic';

const CONSOLE_PATH = '/developers/apps';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('developers');
  return createNoIndexMetadata({
    title: t('metadata.title'),
    description: t('metadata.description'),
    path: CONSOLE_PATH,
    locale,
  });
}

/**
 * The developer console (docs/integration-platform.md, "Self-service
 * registration"). A utility page: noindex, and behind the server flag
 * `developer-console`, which fails closed. Signing in comes first, because a
 * flag can only be asked about a person; with the flag off, or PostHog
 * unreachable, the page is a 404. The backend gates every operation again
 * (PARTNER_OAUTH_MODE and its developer allowlist), and the page says which
 * of those refused.
 */
export default async function DeveloperAppsPage() {
  const [{ t, locale }, distinctId] = await Promise.all([getServerTranslation('developers'), getPosthogDistinctId()]);
  if (!distinctId) {
    const returnPath = localeHref(CONSOLE_PATH, locale);
    redirect(`${localeHref('/auth/login', locale)}?callbackUrl=${encodeURIComponent(returnPath)}`);
  }
  if (!(await getServerFeatureFlag(DEVELOPER_CONSOLE_FLAG, { distinctId }))) notFound();

  return (
    <I18nProvider locale={locale} namespaces={['developers']}>
      <PageShell eyebrow={t('page.eyebrow')} title={t('page.title')} lead={t('page.lead')}>
        <DeveloperAppsContent />
      </PageShell>
    </I18nProvider>
  );
}
