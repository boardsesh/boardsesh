import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import ForgotPasswordContent from './forgot-password-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.forgotPassword.title'),
    description: t('metadata.forgotPassword.description'),
    path: '/auth/forgot-password',
    locale,
  });
}

export default async function ForgotPasswordPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <ForgotPasswordContent />
    </I18nProvider>
  );
}
