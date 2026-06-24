import { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import ResetPasswordContent from './reset-password-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.resetPassword.title'),
    description: t('metadata.resetPassword.description'),
    path: '/auth/reset-password',
    locale,
  });
}

export default async function ResetPasswordPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth']}>
      <Suspense fallback={null}>
        <ResetPasswordContent />
      </Suspense>
    </I18nProvider>
  );
}
