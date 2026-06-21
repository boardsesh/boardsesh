import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import ImportBetaContent from './import-beta-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('feed');
  return createNoIndexMetadata({
    title: t('metadata.importBeta.title'),
    description: t('metadata.importBeta.description'),
    path: '/import-beta',
    locale,
  });
}

export default async function ImportBetaPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['feed']}>
      <ImportBetaContent />
    </I18nProvider>
  );
}
