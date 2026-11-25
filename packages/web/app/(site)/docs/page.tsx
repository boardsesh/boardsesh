import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import DocsClientPage from '@/app/docs/docs-client';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.docs.title'),
    description: t('metadata.docs.description'),
    path: '/docs',
    locale,
  });
}

export default async function DocsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']} resourceKeys={{ marketing: ['docs'] }}>
      <DocsClientPage developerDocsState={getDeveloperDocsState()} />
    </I18nProvider>
  );
}
