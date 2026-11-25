import React from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('admin');
  return createNoIndexMetadata({
    title: t('metadata.admin.title'),
    description: t('metadata.admin.description'),
    path: '/admin',
    locale,
  });
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      {children}
    </I18nProvider>
  );
}
