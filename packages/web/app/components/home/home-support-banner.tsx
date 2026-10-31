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
  SUPPORT_BANNER_CLOSED_MONTH_KEY,
  SUPPORT_BANNER_HREF,
  SUPPORT_BANNER_SUPPORTER_KEY,
  isSupportBannerWindow,
  supportBannerMonth,
} from './support-banner-window';
import styles from './home-support-banner.module.css';

const CTA_SX = brandCtaSx({ size: 'medium' });
// Under the consent banner (tooltip) and MUI dialogs (modal sits lower, but a
// dialog's backdrop covers the page anyway), over the page content.
const STRIP_SX = { zIndex: (theme: { zIndex: { snackbar: number } }) => theme.zIndex.snackbar } as const;

/**
 * The monthly ask on `/`, and only there: `app/page.tsx` is its one caller,
 * and it renders this only inside the window (days 1 to 7 of each month) and
 * only once a monthly Payment Link is configured. Nothing the app opens (`/b/`,
 * `/gym/`, `/help/`, `/join/`, climb pages) shows it.
 *
 * It is a strip fixed to the bottom of the viewport that slides in, not a block
 * in the page flow: it only appears after hydration and an IndexedDB read, and
 * a block above the hero would push the hero down after first paint.
 *
 * It stays hidden until IndexedDB answers, so a visitor who closed it never
 * sees it flash back. A close hides it for the rest of that month; it comes back
 * on the 1st of the next. The thank-you page (`/support?thanks=1`) hides it for
 * good in that browser.
 */
export default function HomeSupportBanner() {
  const { t } = useTranslation('marketing');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // The browser's own clock, again: a page held in a cache past the 7th
    // must not show it.
    const now = new Date();
    if (!isSupportBannerWindow(now)) return;
    let cancelled = false;
    void Promise.all([
      getPreference(SUPPORT_BANNER_SUPPORTER_KEY),
      getPreference(SUPPORT_BANNER_CLOSED_MONTH_KEY),
    ]).then(([supporter, closedMonth]) => {
      if (cancelled || supporter === true || closedMonth === supportBannerMonth(now)) return;
      setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setVisible(false);
    void setPreference(SUPPORT_BANNER_CLOSED_MONTH_KEY, supportBannerMonth(new Date()));
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
