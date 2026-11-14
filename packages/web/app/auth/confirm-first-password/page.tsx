import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import ConfirmFirstPasswordContent from './confirm-first-password-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('settings');
  return createNoIndexMetadata({
    title: t('firstPassword.title'),
    description: t('firstPassword.description'),
    path: '/auth/confirm-first-password',
    locale,
  });
}
/** Utility/auth route: noindex, no sitemap entry. GET performs no mutation. */
export default async function ConfirmFirstPasswordPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['settings']}>
      <ConfirmFirstPasswordContent />
    </I18nProvider>
  );
}
