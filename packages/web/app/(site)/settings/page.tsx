import React from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import { wwwProviderSecurityStaged } from '@/app/lib/auth/provider-security-command-client.server';
import SettingsPageContent from '@/app/settings/settings-page-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('settings');
  return createNoIndexMetadata({
    title: t('metadata.settings.title'),
    description: t('metadata.settings.description'),
    path: '/settings',
    locale,
  });
}

export default async function SettingsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['settings']}>
      {/* The sign-in methods card needs the browser session mode and www's provider security (#7596 B5e2). */}
      <SettingsPageContent
        signInMethods={browserSessionRouteMode().kind === 'better-auth' && wwwProviderSecurityStaged()}
      />
    </I18nProvider>
  );
}
