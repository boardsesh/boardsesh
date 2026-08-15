'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Image from 'next/image';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { getPlatform } from '@/app/lib/ble/capacitor-utils';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { storeHttpsUrlForPlatform, storeSchemeUrlForPlatform } from '@/app/lib/store-urls';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';
import styles from './capacitor-retirement-screen.module.css';

/**
 * The dead end shown to the retired Capacitor app. Rendered only by
 * CapacitorRetirementGate, which owns the detection and unmounts the rest of
 * the app before mounting this.
 */
export const CapacitorRetirementScreen: React.FC = () => {
  const { t } = useTranslation('common');

  const openStoreApp = useCallback(() => {
    const platform = getPlatform();
    track(APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties({ platform, source: 'capacitor-retirement' }));
    // Scheme URL lands in the real App Store / Play Store app rather than an
    // in-WebView listing page — same hand-off requestInAppReview() uses.
    openExternalUrl(storeSchemeUrlForPlatform(platform));
  }, []);

  // Escape hatch: if the OS refuses the scheme hand-off there is no other way
  // out of a blocking screen, so offer the plain https listing too.
  const openStorePage = useCallback(() => {
    const platform = getPlatform();
    track(
      APP_INSTALL_CLICK_EVENT,
      buildAppInstallClickProperties({ platform, source: 'capacitor-retirement-fallback' }),
    );
    openExternalUrl(storeHttpsUrlForPlatform(platform));
  }, []);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="capacitor-retirement-title">
      <div className={styles.panel}>
        <Image src="/brand/boardsesh-mark.png" width={72} height={72} alt="" className={styles.mark} priority />
        <Typography id="capacitor-retirement-title" variant="h5" component="h1" className={styles.title}>
          {t('capacitorRetirement.title')}
        </Typography>
        <Typography variant="body1" className={styles.description}>
          {t('capacitorRetirement.description')}
        </Typography>
        {/* autoFocus so a keyboard or screen-reader user lands on the only way
            forward — the app they were in has just been unmounted. */}
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={openStoreApp}
          className={styles.cta}
          autoFocus
        >
          {t('capacitorRetirement.cta')}
        </Button>
        <Button variant="text" size="small" onClick={openStorePage} className={styles.fallback}>
          {t('capacitorRetirement.fallbackCta')}
        </Button>
      </div>
    </div>
  );
};

export default CapacitorRetirementScreen;
