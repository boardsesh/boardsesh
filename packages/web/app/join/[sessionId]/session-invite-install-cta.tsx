'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InstallMobileOutlined from '@mui/icons-material/InstallMobileOutlined';
import { trackBeforeNavigation } from '@/app/lib/analytics';
import {
  APP_INSTALL_CLICK_EVENT,
  buildAppInstallClickProperties,
  type AppInstallPlatform,
  type AppInstallSource,
} from '@/app/lib/app-install-event';
import { buildStoreUrl, type StoreLinkInput } from '@/app/lib/store-links';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';

/** `utm_campaign` of every store link on a session invite page. */
export const SESSION_INVITE_CAMPAIGN = 'session-invite';

type SessionInviteInstallCtaProps = {
  /**
   * The session the invite is for. It rides in the Google Play link id
   * (`join-page.<session id>`), so an install can be traced to the invite that
   * caused it. Pass it only for an id that names a real session.
   */
  sessionId?: string;
  /** Store button labels, already translated by the server page. */
  googlePlayLabel: string;
  appStoreLabel: string;
};

/**
 * The store pair on the session invite page.
 *
 * BOTH stores render, always, as real anchors: someone who was sent an invite
 * and has no app needs a way in that works before hydration and without
 * guessing their platform. Same two visual rules as the gym page's CTA (no
 * manufacturer glyph, identical variants).
 *
 * The click never calls `preventDefault`. It fires `App Install Click` through
 * `trackBeforeNavigation`, which flushes at once: on a phone a store link often
 * replaces the tab even with `target="_blank"`, and the batch queue would lose
 * the event with it.
 */
export default function SessionInviteInstallCta({
  sessionId,
  googlePlayLabel,
  appStoreLabel,
}: SessionInviteInstallCtaProps) {
  const inboundCampaign = useInboundCampaign();
  const storeLink: StoreLinkInput = {
    placement: 'join-page',
    campaign: SESSION_INVITE_CAMPAIGN,
    linkDetail: sessionId,
    inbound: inboundCampaign,
  };

  const trackClick = (platform: AppInstallPlatform, source: AppInstallSource) => {
    void trackBeforeNavigation(
      APP_INSTALL_CLICK_EVENT,
      buildAppInstallClickProperties({ platform, source, placement: 'join-page', sessionId }),
    );
  };

  return (
    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
      <Button
        component="a"
        href={buildStoreUrl('android', storeLink)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackClick('android', 'google-play')}
        variant="contained"
        size="large"
        startIcon={<InstallMobileOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {googlePlayLabel}
      </Button>
      <Button
        component="a"
        href={buildStoreUrl('ios', storeLink)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackClick('ios', 'app-store')}
        variant="contained"
        size="large"
        startIcon={<InstallMobileOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {appStoreLabel}
      </Button>
    </Box>
  );
}
