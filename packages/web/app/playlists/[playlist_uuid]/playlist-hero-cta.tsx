import React from 'react';
import Box from '@mui/material/Box';
import {
  desktopBlockSx,
  HandoffLabels,
  handoffSx,
  heroCtaBlockSx,
  MobileInstallBlock,
} from '@/app/components/climb-front-door/front-door-cta-parts';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { themeTokens } from '@/app/theme/theme-config';
import PlaylistHandoffButton from './playlist-handoff-button';

/** Every word the block shows, already translated. */
export type PlaylistHeroCtaLabels = {
  /** The badges' own words and the page's language. */
  store: StoreButtonLabels;
  /** The line under the phone's store badge. */
  storeHelper: string;
  /** "Or open the playlist in your browser": the phone's text link. */
  handoffMobile: string;
  /** "Open in your browser": the laptop's filled button. */
  handoffDesktop: string;
};

type PlaylistHeroCtaProps = {
  playlistUuid: string;
  boardType: string;
  layoutId: number | null | undefined;
  isPublic: boolean;
  locale: string;
  labels: PlaylistHeroCtaLabels;
  /** The playlist's own controls (pin, share, the owner's menu), on the hand-off's row. */
  actions?: React.ReactNode;
  /**
   * The laptop's QR card, rendered by the server page (`PhoneQrCard`) so its
   * code ships as plain SVG and `qrcode.react` stays out of the client bundle.
   * Null for a private playlist, whose link a stranger's phone cannot open.
   */
  qrCard?: React.ReactNode;
};

// The hand-off and the playlist's icon buttons share one wrapping row, so on a
// phone the icons drop below the link instead of crowding it.
const handoffRowSx = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: { xs: 'center', md: 'flex-start' },
  gap: `${themeTokens.spacing[2]}px`,
};

/**
 * The playlist page's call to action, the climb page's split by screen width
 * (`FrontDoorHeroCta`): below md the phone's store badge is the primary action,
 * with the hand-off as "Or open the playlist in your browser"; from md the
 * hand-off is the filled button and the QR card carries the playlist to a phone.
 *
 * A phone reading a shared playlist link almost never has the app: one with it
 * opens `/playlists/{uuid}` straight in the app. The split is CSS only, so the
 * HTML is the same for every reader.
 */
export default function PlaylistHeroCta({
  playlistUuid,
  boardType,
  layoutId,
  isPublic,
  locale,
  labels,
  actions,
  qrCard,
}: PlaylistHeroCtaProps) {
  return (
    <Box sx={heroCtaBlockSx}>
      <MobileInstallBlock placement="playlist" qrLanding="playlist" labels={labels.store} helper={labels.storeHelper} />

      <Box sx={handoffRowSx}>
        <PlaylistHandoffButton
          playlistUuid={playlistUuid}
          boardType={boardType}
          layoutId={layoutId}
          isPublic={isPublic}
          locale={locale}
          ctaName="handoff"
          sx={handoffSx}
        >
          <HandoffLabels mobile={labels.handoffMobile} desktop={labels.handoffDesktop} />
        </PlaylistHandoffButton>
        {actions}
      </Box>

      {qrCard ? <Box sx={desktopBlockSx}>{qrCard}</Box> : null}
    </Box>
  );
}
