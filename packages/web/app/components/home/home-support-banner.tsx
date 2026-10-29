'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Slide from '@mui/material/Slide';
import Typography from '@mui/material/Typography';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import {
  SUPPORT_BANNER_DISMISSED_KEY,
  SUPPORT_BANNER_HREF,
  SUPPORT_BANNER_MAX_VIEWS,
  SUPPORT_BANNER_VIEWS_KEY,
  isSupportBannerWindow,
} from './support-banner-window';
import styles from './home-support-banner.module.css';

const CTA_SX = brandCtaSx({ size: 'medium' });
// Under the consent banner (tooltip) and MUI dialogs (modal sits lower, but a
// dialog's backdrop covers the page anyway), over the page content.
const STRIP_SX = { zIndex: (theme: { zIndex: { snackbar: number } }) => theme.zIndex.snackbar } as const;

/**
 * The December ask on `/`, and only there: `app/page.tsx` is its one caller,
 * and it renders this only inside the window. Nothing the app opens (`/b/`,
 * `/gym/`, `/help/`, `/join/`, climb pages) shows it.
 *
 * It is a strip fixed to the bottom of the viewport that slides in, not a block
 * in the page flow: it only appears after hydration and an IndexedDB read, and
 * a block above the hero would push the hero down after first paint.
 *
 * It stays hidden until IndexedDB answers, so a visitor who closed it never
 * sees it flash back. It shows on at most `SUPPORT_BANNER_MAX_VIEWS` page loads
 * per browser for the whole campaign, and never again after a close or after
 * the thank-you page (`/support?thanks=1`) has run.
 */
export default function HomeSupportBanner() {
  const { t } = useTranslation('marketing');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // The browser's own clock, again: a page held in a cache past 31 Dec
    // must not show it.
    if (!isSupportBannerWindow(new Date())) return;
    let cancelled = false;
    void Promise.all([getPreference(SUPPORT_BANNER_DISMISSED_KEY), getPreference(SUPPORT_BANNER_VIEWS_KEY)]).then(
      ([dismissed, views]) => {
        if (cancelled || dismissed === true) return;
        const seen = typeof views === 'number' && Number.isFinite(views) ? views : 0;
        if (seen >= SUPPORT_BANNER_MAX_VIEWS) return;
        setVisible(true);
        void setPreference(SUPPORT_BANNER_VIEWS_KEY, seen + 1);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setVisible(false);
    void setPreference(SUPPORT_BANNER_DISMISSED_KEY, true);
  };

  return (
    <Slide direction="up" in={visible} mountOnEnter unmountOnExit>
      <Box className={styles.strip} sx={STRIP_SX}>
        <Box component="aside" className={styles.banner} data-testid="home-support-banner">
          <Typography variant="body1" component="p" className={styles.text}>
            {t('home.supportBanner.text')}
          </Typography>
          <Box className={styles.actions}>
            <Button variant="contained" component={LocaleLink} href={SUPPORT_BANNER_HREF} sx={CTA_SX}>
              {t('home.supportBanner.cta')}
            </Button>
            <IconButton aria-label={t('home.supportBanner.close')} onClick={close} className={styles.close}>
              <CloseOutlined />
            </IconButton>
          </Box>
        </Box>
      </Box>
    </Slide>
  );
}
