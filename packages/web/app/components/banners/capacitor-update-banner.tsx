'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Paper from '@mui/material/Paper';
import Fade from '@mui/material/Fade';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { getPlatform, isNativeApp } from '@/app/lib/ble/capacitor-utils';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { storeSchemeUrlForPlatform } from '@/app/lib/store-urls';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { CAPACITOR_UPDATE_BANNER_FLAG } from '@/app/flags';
import { isUpdateBannerSnoozed, snoozeUpdateBanner } from '@/app/lib/capacitor-update-banner-db';
import styles from './capacitor-update-banner.module.css';

type BannerBodyProps = {
  onDismiss: () => void;
  onUpdate: () => void;
  titleId: string;
};

const CapacitorUpdateBannerBody: React.FC<BannerBodyProps> = ({ onDismiss, onUpdate, titleId }) => {
  const { t } = useTranslation('common');

  return (
    <Paper elevation={1} className={styles.banner} role="region" aria-labelledby={titleId}>
      <IconButton
        aria-label={t('capacitorUpdateBanner.dismiss')}
        onClick={onDismiss}
        className={styles.closeButton}
        size="small"
      >
        <CloseOutlined fontSize="small" />
      </IconButton>
      <Typography id={titleId} variant="subtitle1" component="h2" className={styles.title}>
        {t('capacitorUpdateBanner.title')}
      </Typography>
      <Typography variant="body2" className={styles.description}>
        {t('capacitorUpdateBanner.description')}
      </Typography>
      <Button variant="contained" color="primary" onClick={onUpdate} className={styles.cta}>
        {t('capacitorUpdateBanner.cta')}
      </Button>
    </Paper>
  );
};

/**
 * Nudges users still running the legacy Capacitor app to install the React
 * Native rewrite. Renders only inside the Capacitor WebView, behind the
 * `capacitor-update-banner` PostHog flag (off by default), and snoozes for a
 * week when dismissed. It never appears in a normal browser or in the RN app
 * (which doesn't render the web UI), so it can't affect non-Capacitor users.
 */
export const CapacitorUpdateBanner: React.FC = () => {
  const flagEnabled = useFeatureFlag(CAPACITOR_UPDATE_BANNER_FLAG) === true;
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!flagEnabled || !isNativeApp()) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    void isUpdateBannerSnoozed().then((snoozed) => {
      if (!cancelled && !snoozed) setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [flagEnabled]);

  const dismiss = useCallback(() => {
    setOpen(false);
    void snoozeUpdateBanner();
  }, []);

  const openStore = useCallback(() => {
    openExternalUrl(storeSchemeUrlForPlatform(getPlatform()));
  }, []);

  // mountOnEnter defers the body (and useTranslation) until first shown, matching
  // FeedbackPromptBanner — this banner is mounted at the app root.
  return (
    <Fade in={open} mountOnEnter unmountOnExit>
      <div>
        <CapacitorUpdateBannerBody onDismiss={dismiss} onUpdate={openStore} titleId={titleId} />
      </div>
    </Fade>
  );
};
