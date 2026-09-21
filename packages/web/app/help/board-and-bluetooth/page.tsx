import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import BoardAndBluetoothContent from './board-and-bluetooth-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpBoardAndBluetooth.title'),
    description: t('metadata.helpBoardAndBluetooth.description'),
    path: '/help/board-and-bluetooth',
    locale,
  });
}

export default async function HelpBoardAndBluetoothPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <BoardAndBluetoothContent />
    </I18nProvider>
  );
}
