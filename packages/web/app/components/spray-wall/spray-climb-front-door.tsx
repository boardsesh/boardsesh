import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getDisplayDescription } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import SprayBoardArt from '@/app/components/spray-wall/spray-board-art';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { buildSprayLitHoldMarks, resolveSprayPhotoFrame } from '@/app/lib/spray/spray-climb-view';
import type { SprayWallPageData } from '@/app/lib/spray/spray-wall-render-data.server';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { Climb } from '@/app/lib/types';

type SprayClimbFrontDoorProps = {
  climb: Climb;
  wallData: SprayWallPageData;
  /** The photograph to draw, already chosen by visibility. Null when there is none to show. */
  photoUrl: string | null;
  angle: number;
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

const setterNotesSx = { whiteSpace: 'pre-line', margin: 0 };

const sectionSx = { mt: 4 };

const sectionHeadingSx = { fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 };

/**
 * The server-rendered page for one climb on a spray wall.
 *
 * Its own component rather than a branch inside `ClimbFrontDoor`, because
 * almost nothing that page renders exists on a wall. There is no catalogue
 * `BoardDetails` to build a `/render/board` URL from, no angle cross-links (a
 * wall's angle is fixed for its life), no similar-climbs or beta sections
 * pointed at a configuration tuple, and no `/list` front door to breadcrumb
 * back to. What is left is the climb, the photograph with the holds on it, and
 * links a crawler can follow.
 *
 * No client component anywhere in the tree: the picture of the wall is the
 * page's LCP and the first HTML byte has to carry it, for a reader on a slow
 * connection and for a crawler that runs no JavaScript.
 */
export default async function SprayClimbFrontDoor({ climb, wallData, photoUrl, angle }: SprayClimbFrontDoorProps) {
  const { t } = await getServerTranslation('climbs');

  const climbName = resolveClimbDisplayName(climb.name, 'spray');
  const wallName = wallData.wall.name;
  const grade = climb.difficulty || t('spray.unknownGrade');
  const setter = climb.setter_username;
  // The setter's own words: the one piece of genuinely unique prose on the
  // page. User-written, so it renders verbatim and never through `t()`.
  const setterNotes = getDisplayDescription(climb.description);

  const frame = resolveSprayPhotoFrame({
    photoWidth: wallData.photo.width,
    photoHeight: wallData.photo.height,
    boardWidth: wallData.boardWidth,
    boardHeight: wallData.boardHeight,
  });
  const marks = buildSprayLitHoldMarks({
    holds: wallData.holds,
    homography: wallData.homography,
    frames: climb.frames,
  });

  return (
    <Box component="main" sx={containerSx}>
      <Typography variant="h1" sx={{ fontSize: '1.75rem', fontWeight: themeTokens.typography.fontWeight.bold, mb: 1 }}>
        {t('spray.heading', { climbName, grade })}
      </Typography>

      <Typography variant="body1" sx={{ mb: 2, color: themeTokens.neutral[700] }}>
        {t('spray.summary', { wallName, angle, holdCount: wallData.wall.holdCount })}
      </Typography>

      {photoUrl ? (
        <SprayBoardArt
          photoUrl={photoUrl}
          photoAlt={t('spray.photoAlt', { climbName, grade, wallName })}
          frameWidth={frame.width}
          frameHeight={frame.height}
          marks={marks}
        />
      ) : (
        // A public wall whose photo copy has not been made yet, or an unlisted
        // one whose signature could not be minted. Say so rather than shipping a
        // broken image: the rest of the page is still the climb.
        <Typography variant="body2" sx={{ color: themeTokens.neutral[700] }}>
          {t('spray.noPhoto')}
        </Typography>
      )}

      <Typography variant="body1" sx={{ mt: 2 }}>
        {setter
          ? t('spray.setterLine', { setter, ascents: climb.ascensionist_count ?? 0 })
          : t('spray.ascentsLine', { ascents: climb.ascensionist_count ?? 0 })}
      </Typography>

      {setterNotes ? (
        <Box sx={sectionSx}>
          <Typography variant="h2" sx={{ ...sectionHeadingSx, fontSize: '1.25rem' }}>
            {t('spray.setterNotesHeading')}
          </Typography>
          <Typography variant="body1" component="p" sx={setterNotesSx}>
            {setterNotes}
          </Typography>
        </Box>
      ) : null}

      <Box sx={sectionSx}>
        <Typography variant="h2" sx={{ ...sectionHeadingSx, fontSize: '1.25rem' }}>
          {t('spray.keepLookingHeading')}
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 3, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {setter ? (
            <li>
              <MuiLink component={LocaleLink} href={`/setter/${encodeURIComponent(setter)}`} underline="hover">
                {t('spray.setterLink', { setter })}
              </MuiLink>
            </li>
          ) : null}
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
    </Box>
  );
}
