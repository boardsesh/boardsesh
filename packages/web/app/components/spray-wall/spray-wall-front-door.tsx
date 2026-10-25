import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import SprayBoardArt from '@/app/components/spray-wall/spray-board-art';
import SprayWallScanAgainNote from '@/app/components/spray-wall/spray-wall-scan-again-note';
import FrontDoorInstall from '@/app/components/climb-front-door/front-door-install';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { resolveSprayWallDrawing, type SprayWallArtChoice } from '@/app/lib/spray/spray-climb-view';
import type { SprayWallPageData } from '@/app/lib/spray/spray-wall-render-data.server';
import { themeTokens } from '@/app/theme/theme-config';

type SprayWallFrontDoorProps = {
  wallData: SprayWallPageData;
  /** The photograph to draw, already chosen by visibility. Null when there is none. */
  photoUrl: string | null;
  /** The owner's generated look, when the backend has it ready; null draws the photo. */
  art: SprayWallArtChoice | null;
  /** The stable path the generated look is served at, or null with no art. */
  artUrl: string | null;
  angle: number;
  /**
   * The app's own link to this wall (`buildNativeBoardListUrl`), with the
   * `?wall=` capability when the page was opened with one.
   */
  appLink: string;
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

const actionsSx = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[2]}px`,
  mt: `${themeTokens.spacing[4]}px`,
};

const haveAppRowSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  gap: `${themeTokens.spacing[1]}px`,
  mt: `${themeTokens.spacing[2]}px`,
};

const haveAppTextSx = { color: 'var(--neutral-400)' };

/**
 * Where a wall's share link lands: the wall itself, with nothing lit on it.
 *
 * This is the page `buildSprayWallShareUrl` points at — `/b/{slug}/{angle}/list`,
 * with `?wall=<uuid>` when the wall is unlisted. It is not a climb list. The
 * climbs of a wall are read in the app, and the list machinery every other board
 * uses is built around a catalogue tuple a wall does not have. What somebody
 * following a shared link needs is to see that they have the right wall.
 *
 * No marks over the photograph: `SprayBoardArt` takes an empty set of them, which
 * is the honest drawing for a page about the wall rather than about one climb.
 *
 * It is also where the wall's printed QR lands (#4415), mostly on a phone with
 * no app: with the app installed, the code's universal link opens the app and
 * never reaches this page. So the store button comes first and is the filled
 * one (`spray-wall`, which says `spray-wall.board` after a scan), then, after a
 * scan only, a line telling a fresh install to scan again, and last a quiet
 * "Already have Boardsesh?" row with the Open link (the scheme link, which
 * keeps `?wall=`). A scheme link with no app behind it is an error page, so it
 * must not be the first thing a climber taps. The scan itself is counted by
 * `BoardQrLandingTracker` on the page.
 */
export default async function SprayWallFrontDoor({
  wallData,
  photoUrl,
  art,
  artUrl,
  angle,
  appLink,
}: SprayWallFrontDoorProps) {
  const [{ t }, storeButtonLabels] = await Promise.all([getServerTranslation('climbs'), getStoreButtonLabels()]);
  const wallName = wallData.wall.name;

  const drawing = resolveSprayWallDrawing({
    photoUrl,
    artUrl,
    art,
    photoWidth: wallData.photo.width,
    photoHeight: wallData.photo.height,
    boardWidth: wallData.boardWidth,
    boardHeight: wallData.boardHeight,
    homography: wallData.homography,
    darkFieldColor: BOARD_FIELD_COLORS.dark,
  });

  return (
    <Box component="main" sx={containerSx}>
      <Typography variant="h1" sx={{ fontSize: '1.75rem', fontWeight: themeTokens.typography.fontWeight.bold, mb: 1 }}>
        {wallName}
      </Typography>

      <Typography variant="body1" sx={{ mb: 2, color: themeTokens.neutral[700] }}>
        {t('spray.wall.summary', { angle, holdCount: wallData.wall.holdCount })}
      </Typography>

      {drawing ? (
        <SprayBoardArt
          imageUrl={drawing.imageUrl}
          fieldColor={drawing.fieldColor}
          photoAlt={t('spray.wall.photoAlt', { wallName })}
          frameWidth={drawing.frame.width}
          frameHeight={drawing.frame.height}
          marks={[]}
        />
      ) : (
        <Typography variant="body2" sx={{ color: themeTokens.neutral[700] }}>
          {t('spray.noPhoto')}
        </Typography>
      )}

      <Box sx={actionsSx}>
        <Typography variant="body1">{t('spray.wall.openInApp')}</Typography>
        <FrontDoorInstall
          placement="spray-wall"
          helperText={t('spray.wall.install.helper')}
          labels={storeButtonLabels}
          appearance="brand"
          qrLanding
        />
        <SprayWallScanAgainNote text={t('spray.wall.install.scanAgain')} />
        <Box sx={haveAppRowSx}>
          <Typography variant="body2" sx={haveAppTextSx}>
            {t('spray.wall.haveApp')}
          </Typography>
          <Button component="a" href={appLink} variant="text" size="small">
            {t('spray.wall.openButton')}
          </Button>
        </Box>
      </Box>

      <Box component="ul" sx={{ mt: 3, mb: 0, pl: 3, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <li>
          <MuiLink component={LocaleLink} href="/gyms" underline="hover">
            {t('spray.gymsLink')}
          </MuiLink>
        </li>
        <li>
          <MuiLink component={LocaleLink} href="/" underline="hover">
            {t('spray.homeLink')}
          </MuiLink>
        </li>
      </Box>
    </Box>
  );
}
