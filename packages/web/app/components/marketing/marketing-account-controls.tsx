'use client';

import React from 'react';
import { navLinkClicked } from '@boardsesh/analytics';
import { trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import Box from '@mui/material/Box';
import LocaleLink from '../i18n/locale-link';
import { useMarketingSession } from './marketing-session-store';

type AccountLabels = { signIn: string; profile: string; settings: string };

/** A usable link is present before account code resolves; the slot keeps its width. */
export default function MarketingAccountControls({
  labels,
  placement = 'header',
}: {
  labels: AccountLabels;
  placement?: 'header' | 'header-menu';
}) {
  const { session } = useMarketingSession();
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        width: 132,
        flexShrink: 0,
        minHeight: 44,
      }}
    >
      {session.status === 'authenticated' ? (
        <>
          <IconButton
            component={LocaleLink}
            href={`/profile/${session.data.user.id}`}
            aria-label={labels.profile}
            onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked(placement, 'profile'))}
            color="inherit"
            size="small"
          >
            <PersonOutlined />
          </IconButton>
          <IconButton
            component={LocaleLink}
            href="/settings"
            onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked(placement, '/settings'))}
            aria-label={labels.settings}
            color="inherit"
            size="small"
          >
            <SettingsOutlined />
          </IconButton>
        </>
      ) : (
        <Button
          component={LocaleLink}
          href="/auth/login"
          onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked(placement, '/auth/login'))}
          color="inherit"
          size="small"
        >
          {labels.signIn}
        </Button>
      )}
    </Box>
  );
}
