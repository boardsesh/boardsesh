'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import styles from './help-breadcrumb.module.css';

/**
 * Home › Help › this topic.
 *
 * Every topic page carries it, which is also how each one keeps its crawlable
 * link back up to the hub without spending a line of body copy on it.
 */
export default function HelpBreadcrumb({ current }: { current: string }) {
  const { t } = useTranslation('marketing');
  return (
    <Box component="nav" aria-label={t('help.nav.label')} className={styles.trail}>
      <MuiLink component={LocaleLink} href="/" underline="hover" className={styles.crumb}>
        {t('help.nav.home')}
      </MuiLink>
      <Box component="span" aria-hidden="true" className={styles.divider}>
        ›
      </Box>
      <MuiLink component={LocaleLink} href="/help" underline="hover" className={styles.crumb}>
        {t('help.nav.help')}
      </MuiLink>
      <Box component="span" aria-hidden="true" className={styles.divider}>
        ›
      </Box>
      <Box component="span" aria-current="page">
        {current}
      </Box>
    </Box>
  );
}
