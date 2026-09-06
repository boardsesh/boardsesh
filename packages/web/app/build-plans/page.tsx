import React from 'react';
import type { Metadata } from 'next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import BuildPlansContent from './build-plans-content';
import Configurator from './configurator/configurator';
import { CNC_FLAG_OFF_METADATA, fetchCncCatalog, isCncPacksEnabled, requireCncPacksFlag } from './build-plans-page';
import styles from './build-plans.module.css';

/**
 * `noindex, follow` while `cnc-packs` is flagged off.
 *
 * TODO(launch): swap `createNoIndexMetadata` for `createPageMetadata` and add
 * `/build-plans` to a sitemap shard when the flag reaches 100% — this is a
 * search surface (people look for "kilter homewall plans"), and it is only
 * kept out of the index because the manufacturing licence still ships marked
 * DRAFT pending the Australian IP review. Note the gate is BOTH: the page also
 * 404s while the flag is off, because noindex alone would leave a publicly
 * reachable shop.
 */
export async function generateMetadata(): Promise<Metadata> {
  // Same gate as the page body, via the same helper. While the flag is off the
  // route 404s, so its metadata says nothing about what lives here.
  if (!(await isCncPacksEnabled())) return CNC_FLAG_OFF_METADATA;

  const { t, locale } = await getServerTranslation('cnc');
  return createNoIndexMetadata({
    title: t('metadata.buildPlans.title'),
    description: t('metadata.buildPlans.description'),
    path: '/build-plans',
    locale,
  });
}

export default async function BuildPlansPage() {
  await requireCncPacksFlag();

  const { t, locale } = await getServerTranslation('cnc');
  const catalog = await fetchCncCatalog();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
      <Box component="main" className={styles.page}>
        <BuildPlansContent catalog={catalog} locale={locale} />
        {catalog && catalog.entries.length > 0 ? (
          <Configurator catalog={catalog} locale={locale} />
        ) : (
          // The hero above is fully server-rendered and still tells the story;
          // only the part that needs live prices is missing, so say that rather
          // than replacing the whole page with an error.
          <Alert severity="warning" sx={{ mt: 4 }}>
            {t('errors.CNC_WORKER_UNAVAILABLE')}
          </Alert>
        )}
      </Box>
    </I18nProvider>
  );
}
