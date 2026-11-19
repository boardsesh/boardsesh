import React from 'react';
import { I18nProvider as ClientI18nProvider } from '@/app/lib/i18n/client';
import { selectI18nResources } from '@/app/lib/i18n/select-resources';
import { loadServerResources } from '@/app/lib/i18n/server';
import { ROOT_NAMESPACES, type Locale, type SeedNamespace } from '@/app/lib/i18n/config';

export default async function I18nProvider({
  locale,
  namespaces = ROOT_NAMESPACES,
  children,
  resourceKeys,
}: {
  locale: Locale;
  namespaces?: readonly SeedNamespace[];
  children: React.ReactNode;
  resourceKeys?: Readonly<Partial<Record<SeedNamespace, readonly string[]>>>;
}) {
  const resources = await loadServerResources(locale, namespaces);
  return (
    <ClientI18nProvider locale={locale} resources={selectI18nResources(resources, resourceKeys)}>
      {children}
    </ClientI18nProvider>
  );
}
