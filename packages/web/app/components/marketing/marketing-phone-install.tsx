'use client';

import { useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useStoreBadgeOnScreen } from '@/app/hooks/use-store-badge-on-screen';
import { resolveHeroInstall } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import styles from '@/app/components/site-chrome/marketing-header.module.css';

/** The store handoff watches only the page's badges, never account state. */
export default function MarketingPhoneInstall({ label }: { label: string }) {
  const headerRef = useRef<HTMLElement | null>(null);
  const { platform, nativeStore } = useInstallPlatform();
  const inbound = useInboundCampaign();
  const badgeOnScreen = useStoreBadgeOnScreen(headerRef);
  const install = resolveHeroInstall(platform, nativeStore);
  const store = install.stores[0];
  return (
    <Box
      component="span"
      sx={{ display: 'contents' }}
      ref={(element: HTMLSpanElement | null) => {
        headerRef.current = element?.closest('header') ?? null;
      }}
    >
      <Button
        className={styles.phoneInstall}
        data-store-badge-on-screen={badgeOnScreen === null ? undefined : badgeOnScreen ? 'yes' : 'no'}
        href={buildStoreUrl(store, { placement: 'header', inbound })}
        target="_blank"
        rel="noopener noreferrer"
        variant="outlined"
        sx={brandCtaOutlinedSx({ size: 'small' })}
        onClick={() =>
          trackAppInstallClick({
            platform: store,
            source: store === 'ios' ? 'app-store' : 'google-play',
            placement: 'header',
            mode: install.mode,
          })
        }
      >
        {label}
      </Button>
    </Box>
  );
}
