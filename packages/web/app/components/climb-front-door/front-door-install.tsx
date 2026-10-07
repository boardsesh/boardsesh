import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import StoreInstallButtons, { type StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import { themeTokens } from '@/app/theme/theme-config';

type FrontDoorInstallProps = {
  placement: Extract<AppInstallPlacement, 'climb-view' | 'climb-list' | 'spray-climb'>;
  /** One line saying who the button is for, already translated. */
  helperText: string;
  labels: StoreButtonLabels;
};

const wrapperSx = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[2]}px`,
  mt: `${themeTokens.spacing[2]}px`,
};

const helperSx = { color: 'var(--neutral-400)' };

/**
 * The store button under a front door's hand-off (#6027).
 *
 * "Climb this" opens the app, which is no use to the reader these pages are
 * built for: someone who searched a climb's name and has never installed
 * Boardsesh. In the eight days measured before this, 64 people reached a climb
 * page, 39 of them from Google, and none could reach a store from it.
 *
 * It stays secondary. Outlined buttons under a filled primary, a line of text
 * that says who it is for, and its own event (`App Install Click`), so the
 * hand-off funnel reads exactly as it did.
 *
 * These three pages are stored at the edge and handed to everyone, so the
 * buttons are rendered `sharedHtml`: both stores in the HTML, one after mount.
 *
 * No hooks and no data here: the wrapper is plain markup a server component can
 * render, and the only client code is the `StoreInstallButtons` island.
 */
export default function FrontDoorInstall({ placement, helperText, labels }: FrontDoorInstallProps) {
  return (
    <Box sx={wrapperSx}>
      <Typography variant="body2" sx={helperSx}>
        {helperText}
      </Typography>
      <StoreInstallButtons placement={placement} labels={labels} appearance="plain" align="start" sharedHtml />
    </Box>
  );
}
