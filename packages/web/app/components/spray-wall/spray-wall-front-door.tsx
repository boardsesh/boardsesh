import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import SprayBoardArt from '@/app/components/spray-wall/spray-board-art';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { resolveSprayPhotoFrame } from '@/app/lib/spray/spray-climb-view';
import type { SprayWallPageData } from '@/app/lib/spray/spray-wall-render-data.server';
import { themeTokens } from '@/app/theme/theme-config';

type SprayWallFrontDoorProps = {
  wallData: SprayWallPageData;
  /** The photograph to draw, already chosen by visibility. Null when there is none. */
  photoUrl: string | null;
  angle: number;
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

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
 */
export default async function SprayWallFrontDoor({ wallData, photoUrl, angle }: SprayWallFrontDoorProps) {
  const { t } = await getServerTranslation('climbs');
  const wallName = wallData.wall.name;

  const frame = resolveSprayPhotoFrame({
    photoWidth: wallData.photo.width,
    photoHeight: wallData.photo.height,
    boardWidth: wallData.boardWidth,
    boardHeight: wallData.boardHeight,
  });

  return (
    <Box component="main" sx={containerSx}>
      <Typography variant="h1" sx={{ fontSize: '1.75rem', fontWeight: themeTokens.typography.fontWeight.bold, mb: 1 }}>
        {wallName}
      </Typography>

      <Typography variant="body1" sx={{ mb: 2, color: themeTokens.neutral[700] }}>
        {t('spray.wall.summary', { angle, holdCount: wallData.wall.holdCount })}
      </Typography>

      {photoUrl ? (
        <SprayBoardArt
          photoUrl={photoUrl}
          photoAlt={t('spray.wall.photoAlt', { wallName })}
          frameWidth={frame.width}
          frameHeight={frame.height}
          marks={[]}
        />
      ) : (
        <Typography variant="body2" sx={{ color: themeTokens.neutral[700] }}>
          {t('spray.noPhoto')}
        </Typography>
      )}

      <Typography variant="body1" sx={{ mt: 2 }}>
        {t('spray.wall.openInApp')}
      </Typography>

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
