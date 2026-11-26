'use client';

import { useTranslation } from 'react-i18next';
import { MarketingPreviewSwitchControl } from './marketing-preview-switch-control';

/**
 * The iOS / Android toggle for the marketing screenshots, desktop only.
 *
 * Its own module so a page that shows screenshots without the toggle (the
 * climb page's app module) does not ship `ToggleButtonGroup` or the
 * `marketing` namespace to the browser.
 */
export function MarketingPreviewSwitch() {
  const { t } = useTranslation('marketing');
  return (
    <MarketingPreviewSwitchControl
      labels={{ label: t('preview.label'), ios: t('preview.ios'), android: t('preview.android') }}
    />
  );
}
