import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ANGLES } from '@/app/lib/board-data';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { buildCanonicalClimbListUrl, constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardImageDetails, BoardName } from '@/app/lib/types';

type ListAngleRailProps = {
  boardDetails: BoardImageDetails;
  /** Set on `/b/{slug}`: the rail stays on the board the reader arrived through, like the pagination. */
  boardSlug?: string;
  currentAngle: number;
  /** The board's name as the page heading says it ("Kilter Board Original"), for each link's accessible name. */
  boardLabel: string;
};

const RAIL_LABEL_ID = 'list-angle-rail-label';

const labelSx = {
  margin: 0,
  marginBottom: `${themeTokens.spacing[2]}px`,
  color: 'var(--neutral-700)',
  fontSize: themeTokens.typography.fontSize.sm,
};

const railSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: `${themeTokens.spacing[2]}px`,
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

// Every stop is a 44px target, and wraps rather than scrolls: fifteen angles fit
// in three rows on a 320px phone, so nothing is hidden off the side.
const stopSx = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box' as const,
  minWidth: 56,
  minHeight: 44,
  paddingInline: `${themeTokens.spacing[3]}px`,
  borderRadius: `${themeTokens.borderRadius.full}px`,
  border: '1px solid var(--control-border)',
  fontSize: themeTokens.typography.fontSize.base,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontVariantNumeric: 'tabular-nums',
  textDecoration: 'none',
};

// The other angles: grey outlined stops, the label ink on the page with the
// opaque control edge, and the button state layer on hover.
const linkSx = {
  ...stopSx,
  color: 'var(--neutral-900)',
  '&:hover': {
    backgroundColor: 'var(--semantic-button-hover)',
  },
};

// The angle being read: text, not a self-link, on the tonal selected container
// with its own ink (9.89:1). Its edge is the container itself, so the stop keeps
// the same size as its neighbours without a violet ring.
const currentSx = {
  ...stopSx,
  color: 'var(--semantic-on-selected)',
  borderColor: 'var(--semantic-selected)',
  backgroundColor: 'var(--semantic-selected)',
};

/**
 * The angles this board config can be read at, in order, from the board's angle
 * table (`ANGLES` in `@boardsesh/board-config`): no query, the same list every
 * angle picker offers. A page at an angle the table does not carry (any whole
 * angle from 0° to 90° routes) gets its own stop in order, so the reader always
 * sees where they are.
 */
export function listRailAngles(boardName: BoardName, currentAngle: number): number[] {
  const tableAngles = ANGLES[boardName] ?? [];
  if (tableAngles.includes(currentAngle)) return tableAngles;
  return [...tableAngles, currentAngle].sort((left, right) => left - right);
}

/**
 * The same board config at every other angle: a rail of real links under the
 * board list's call to action.
 *
 * Each stop is a plain `<a href>`, so a crawler walks one config's lists as a
 * mesh rather than through the sitemap alone. The current angle is text marked
 * `aria-current="page"`, not a link to the page it is on. Each link's
 * accessible name says which list it opens ("25°, Kilter Board Original
 * climbs") and starts with the visible "25°", so a voice user can say what
 * they see.
 */
export default async function ListAngleRail({ boardDetails, boardSlug, currentAngle, boardLabel }: ListAngleRailProps) {
  const { t } = await getServerTranslation('climbs');
  const angles = listRailAngles(boardDetails.board_name, currentAngle);
  if (angles.length < 2) return null;

  return (
    <Box component="nav" aria-labelledby={RAIL_LABEL_ID}>
      <Typography component="p" id={RAIL_LABEL_ID} sx={labelSx}>
        {t('list.frontDoor.angles.label')}
      </Typography>
      <Box component="ul" sx={railSx}>
        {angles.map((angle) => (
          <Box component="li" key={angle}>
            {angle === currentAngle ? (
              <Box component="span" aria-current="page" sx={currentSx}>
                {t('list.frontDoor.angles.stop', { angle })}
              </Box>
            ) : (
              <Box
                component={LocaleLink}
                href={
                  boardSlug
                    ? constructBoardSlugListUrl(encodeURIComponent(boardSlug), angle)
                    : buildCanonicalClimbListUrl(boardDetails, angle)
                }
                aria-label={t('list.frontDoor.angles.linkAria', { boardName: boardLabel, angle })}
                sx={linkSx}
              >
                {t('list.frontDoor.angles.stop', { angle })}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
