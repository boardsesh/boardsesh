import React from 'react';
import type { Metadata } from 'next';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageShell } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { DEVELOPER_CONSOLE_PATH as CONSOLE_PATH } from '@/app/lib/developer-apps/sign-in-again';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { requireDeveloperConsoleAccess } from '@/app/developers/developer-console-access.server';
import DeveloperAppsContent from '@/app/developers/apps/developer-apps-content';

export const dynamic = 'force-dynamic';

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
 * The developer console (docs/integrations/integration-platform.md, "Self-service
 * registration"). A utility page: noindex, and behind the server flag
 * `developer-console` (`requireDeveloperConsoleAccess`). The backend gates
 * every operation again (PARTNER_OAUTH_MODE, then the same flag), and the page
 * says which of those refused, or that the flag could not be checked.
 */
export default async function DeveloperAppsPage() {
  const { t, locale } = await getServerTranslation('developers');
  await requireDeveloperConsoleAccess(CONSOLE_PATH, locale);

  return (
    <I18nProvider locale={locale} namespaces={['developers']}>
      <PageShell eyebrow={t('page.eyebrow')} title={t('page.title')} lead={t('page.lead')}>
        <DeveloperAppsContent />
      </PageShell>
    </I18nProvider>
  );
}
