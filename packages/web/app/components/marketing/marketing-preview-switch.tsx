'use client';

import React from 'react';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useTranslation } from 'react-i18next';
import SelectedCheck from '@/app/components/ui/selected-check';
import { useMarketingPreview } from './marketing-preview-provider';
import styles from './marketing-screenshot.module.css';

/**
 * The iOS / Android toggle for the marketing screenshots, desktop only.
 *
 * Its own module so a page that shows screenshots without the toggle (the
 * climb page's app module) does not ship `ToggleButtonGroup` or the
 * `marketing` namespace to the browser.
 */
export function MarketingPreviewSwitch() {
  const { t } = useTranslation('marketing');
  const preview = useMarketingPreview();
  if (!preview?.browser.desktop) return null;

  return (
    <ToggleButtonGroup
      className={styles.switch}
      value={preview.platform}
      exclusive
      size="small"
      aria-label={t('preview.label')}
      onChange={(_event, platform: unknown) => {
        if (platform === 'ios' || platform === 'android') preview.selectPlatform(platform);
      }}
    >
      {/* The selected platform leads with a check, its non-colour cue next to
          the tonal ground; ToggleButton's aria-pressed announces it. */}
      <ToggleButton value="ios">
        {preview.platform === 'ios' && <SelectedCheck />}
        {t('preview.ios')}
      </ToggleButton>
      <ToggleButton value="android">
        {preview.platform === 'android' && <SelectedCheck />}
        {t('preview.android')}
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
