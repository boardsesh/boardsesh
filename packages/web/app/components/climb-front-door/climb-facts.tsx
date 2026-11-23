import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { visuallyHidden } from '@mui/utils';
import { climbBoardForSearch } from '@/app/lib/seo/climb-display';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';
import { formatFirstAscentDate, formatQualityAverage } from './climb-facts-format';
import { normalizedQuality } from '@/app/lib/climb-quality';

type ClimbFactsProps = {
  climb: Climb;
  boardDetails: BoardRouteIdentity;
  angle: number;
  /** The row for the angle being viewed, when one exists — carries the FA and the quality. */
  currentAngleStats?: ClimbStatsForAngle;
};

// Two columns at every width: four short facts read as a 2×2 spec sheet, and
// one column on a phone would make them taller than the paragraph above.
const dlSx = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  columnGap: { xs: `${themeTokens.spacing[4]}px`, md: `${themeTokens.spacing[6]}px` },
  margin: `${themeTokens.spacing[5]}px 0 0`,
  padding: 0,
};

const itemSx = {
  paddingBlock: `${themeTokens.spacing[2]}px`,
  borderTop: '1px solid var(--separator)',
  minWidth: 0,
};

// --neutral-500: the public-page audit holds every glyph to 4.5:1, and 400 is 3.66:1.
const dtSx = {
  fontSize: themeTokens.typography.fontSize.sm,
  color: 'var(--neutral-500)',
  margin: 0,
};

// Every value sits in a 44px row, so the Setter link is a full tap target
// without reaching up over its label, and Board beside it lines up. The 4px
// above it is the room its 2px focus ring (2px out) needs to clear the label.
const ddSx = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 44,
  margin: `${themeTokens.spacing[1]}px 0 0`,
  fontSize: themeTokens.typography.fontSize.base,
  fontWeight: themeTokens.typography.fontWeight.medium,
  color: 'var(--neutral-800)',
  overflowWrap: 'anywhere' as const,
};

const mutedValueSx = { color: 'var(--neutral-500)' };

const starSx = { color: 'var(--color-amber)' };

// A 44px tap target filling its row. The public-page e2e taps this exact link.
const setterLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  maxWidth: '100%',
  overflowWrap: 'anywhere' as const,
};

/**
 * The climb's spec sheet as a compact `<dl>`: board, setter, first ascent and
 * the quality at this angle. Grade and sends live in the heading and the angle
 * table, so they are not repeated here. Server-rendered, so all of it is in the
 * HTML a crawler reads.
 *
 * Quality goes through `normalizedQuality`, the rule the heading's star and the
 * structured data use, so an Aurora 1-3 average is never printed out of 5.
 */
export default async function ClimbFacts({ climb, boardDetails, angle, currentAngleStats }: ClimbFactsProps) {
  const { t, locale } = await getServerTranslation('climbs');

  const setter = climb.setter_username?.trim();
  const quality = normalizedQuality(currentAngleStats);
  const faUsername = currentAngleStats?.fa_username?.trim();
  const faDate = formatFirstAscentDate(currentAngleStats?.fa_at, locale);
  const boardLabel = climbBoardForSearch(boardDetails.board_name, boardDetails.layout_name);
  const formattedQuality = quality ? formatQualityAverage(quality.average, locale) : null;

  return (
    <Box component="dl" sx={dlSx}>
      <Box sx={itemSx}>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.board')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {boardLabel}
        </Box>
      </Box>

      <Box sx={itemSx}>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.setter')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {setter ? (
            <MuiLink
              component={LocaleLink}
              href={`/setter/${encodeURIComponent(setter)}`}
              aria-label={t('frontDoor.setterLink', { setter })}
              sx={setterLinkSx}
            >
              {setter}
            </MuiLink>
          ) : (
            <Box component="span" sx={mutedValueSx}>
              {t('frontDoor.facts.unknown')}
            </Box>
          )}
        </Box>
      </Box>

      <Box sx={itemSx}>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.firstAscent', { angle })}
        </Box>
        <Box component="dd" sx={ddSx}>
          {faUsername && faDate ? (
            t('frontDoor.facts.firstAscentValue', { setter: faUsername, date: faDate })
          ) : (
            <Box component="span" sx={mutedValueSx}>
              {t('frontDoor.facts.firstAscentUnknown')}
            </Box>
          )}
        </Box>
      </Box>

      <Box sx={itemSx}>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.qualityAtAngle', { angle })}
        </Box>
        <Box component="dd" sx={ddSx}>
          {formattedQuality ? (
            <>
              <Box component="span" aria-hidden="true">
                <Box component="span" sx={starSx}>
                  ★
                </Box>{' '}
                {formattedQuality}
              </Box>
              <Box component="span" sx={visuallyHidden}>
                {t('frontDoor.hero.qualityAria', { quality: formattedQuality })}
              </Box>
            </>
          ) : (
            <Box component="span" sx={mutedValueSx}>
              {t('frontDoor.angles.notRated')}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
