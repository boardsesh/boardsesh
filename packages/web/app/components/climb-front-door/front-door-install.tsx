import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import StoreInstallButtons, {
  type StoreButtonAppearance,
  type StoreButtonLabels,
} from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { themeTokens } from '@/app/theme/theme-config';

type FrontDoorInstallProps = {
  placement: AppInstallPlacement;
  /** One line saying who the badges are for, already translated. */
  helperText: string;
  labels: StoreButtonLabels;
  /** Which kind of code lands on this page; the link id names the code after a scan. See `StoreInstallButtons`. */
  qrLanding?: QrLandingKind;
  /**
   * How the update button looks, for a visitor still in the retired Capacitor
   * app; installs are always the badges. `plain` (outlined) under a filled
   * hand-off, the default. `brand` where the store IS the primary action: a
   * Spraywall's page, which a poster scan reaches mostly on phones with no app.
   */
  appearance?: StoreButtonAppearance;
};

const wrapperSx = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[2]}px`,
  mt: `${themeTokens.spacing[2]}px`,
};

const helperSx = { color: 'var(--neutral-500)' };

/**
 * The store badges under a front door's hand-off (#6027).
 *
 * "Climb this" opens the app, which is no use to the reader these pages are
 * built for: someone who searched a climb's name and has never installed
 * Boardsesh. In the eight days measured before this, 64 people reached a climb
 * page, 39 of them from Google, and none could reach a store from it.
 *
 * It stays secondary. The official store badges (black, never a filled
 * button) under the page's primary action, a line of text that says who they
 * are for, and its own event (`App Install Click`), so the hand-off funnel
 * reads exactly as it did. `appearance` styles only the "Update the app" button
 * a visitor still in the retired Capacitor app gets instead.
 *
 * These pages are stored at the edge and handed to everyone, so the
 * badges are rendered `sharedHtml`: both stores in the HTML, one after mount.
 *
 * No hooks and no data here: the wrapper is plain markup a server component can
 * render, and the only client code is the `StoreInstallButtons` island.
 */
export default function FrontDoorInstall({
  placement,
  helperText,
  labels,
  qrLanding,
  appearance = 'plain',
}: FrontDoorInstallProps) {
  return (
    <Box sx={wrapperSx}>
      <Typography variant="body2" sx={helperSx}>
        {helperText}
      </Typography>
      <StoreInstallButtons
        placement={placement}
        labels={labels}
        appearance={appearance}
        align="start"
        sharedHtml
        qrLanding={qrLanding}
      />
    </Box>
  );
}
