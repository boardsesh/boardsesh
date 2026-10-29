'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { SUPPORT_BANNER_DISMISSED_KEY, SUPPORT_BANNER_HREF, isSupportBannerWindow } from './support-banner-window';
import styles from './home-support-banner.module.css';

const CTA_SX = brandCtaSx({ size: 'medium' });

/**
 * The December ask on `/`, and only there: `app/page.tsx` is its one caller,
 * and it renders this only inside the window. Nothing the app opens (`/b/`,
 * `/gym/`, `/help/`, `/join/`, climb pages) shows it.
 *
 * It stays hidden until IndexedDB answers, so a visitor who closed it never
 * sees it flash back. Closing writes the preference; nothing else does.
 */
export default function HomeSupportBanner() {
  const { t } = useTranslation('marketing');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // The browser's own clock, again: a page held in a cache past 31 Dec
    // must not show it.
    if (!isSupportBannerWindow(new Date())) return;
    let cancelled = false;
    void getPreference(SUPPORT_BANNER_DISMISSED_KEY).then((dismissed) => {
      if (!cancelled && dismissed !== true) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setVisible(false);
    void setPreference(SUPPORT_BANNER_DISMISSED_KEY, true);
  };

  return (
    <Collapse in={visible} unmountOnExit>
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
    </Collapse>
  );
}
