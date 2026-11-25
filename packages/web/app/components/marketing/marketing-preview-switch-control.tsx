'use client';

import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import SelectedCheck from '@/app/components/ui/selected-check';
import { useMarketingPreview } from './marketing-preview-provider';
import styles from './marketing-screenshot.module.css';

export function MarketingPreviewSwitchControl({ labels }: { labels: { label: string; ios: string; android: string } }) {
  const preview = useMarketingPreview();
  if (!preview?.browser.desktop) return null;
  return (
    <ToggleButtonGroup
      className={styles.switch}
      value={preview.platform}
      exclusive
      size="small"
      aria-label={labels.label}
      onChange={(_event, platform: unknown) => {
        if (platform === 'ios' || platform === 'android') preview.selectPlatform(platform);
      }}
    >
      <ToggleButton value="ios">
        {preview.platform === 'ios' && <SelectedCheck />}
        {labels.ios}
      </ToggleButton>
      <ToggleButton value="android">
        {preview.platform === 'android' && <SelectedCheck />}
        {labels.android}
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
