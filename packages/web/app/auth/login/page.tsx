import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AuthPageContent from './auth-page-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.login.title'),
    description: t('metadata.login.description'),
    path: '/auth/login',
    locale,
  });
}

function AuthPageFallback() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--semantic-background)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          border: '3px solid var(--neutral-200)',
          borderTopColor: 'var(--color-primary)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }}
      />
    </div>
  );
}

export default async function AuthPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['auth', 'marketing']} resourceKeys={{ marketing: ['home.hero'] }}>
      <Suspense fallback={<AuthPageFallback />}>
        <AuthPageContent />
      </Suspense>
    </I18nProvider>
  );
}
