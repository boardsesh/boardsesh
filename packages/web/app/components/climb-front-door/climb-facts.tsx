import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { climbBoardForSearch, climbGradeForSearch } from '@/app/lib/seo/climb-display';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';

type ClimbFactsProps = {
  climb: Climb;
  boardDetails: BoardRouteIdentity;
  angle: number;
  /** The row for the angle being viewed, when one exists — carries the FA. */
  currentAngleStats?: ClimbStatsForAngle;
};

const dlSx = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: `${themeTokens.spacing[3]}px`,
  margin: `${themeTokens.spacing[4]}px 0`,
  padding: 0,
};

const dtSx = {
  fontSize: themeTokens.typography.fontSize.xs,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  color: 'var(--neutral-500)',
  margin: 0,
};

const ddSx = {
  fontSize: themeTokens.typography.fontSize.base,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  margin: 0,
  overflowWrap: 'anywhere' as const,
};

const setterLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  maxWidth: '100%',
  overflowWrap: 'anywhere' as const,
};

/** Formats an FA timestamp for display; the raw column is a date string. */
function formatFirstAscentDate(rawDate: string | null, locale: string): string | null {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    parsed,
  );
}

/**
 * The climb's numbers as a `<dl>` — grade, quality, sends, angle, board, setter
 * and first ascent. Server-rendered, so all of it is in the HTML a crawler
 * reads and none of it waits on a client fetch.
 */
export default async function ClimbFacts({ climb, boardDetails, angle, currentAngleStats }: ClimbFactsProps) {
  const { t, locale } = await getServerTranslation('climbs');

  const setter = climb.setter_username?.trim();
  const quality = Number(climb.quality_average ?? 0);
  const faUsername = currentAngleStats?.fa_username?.trim();
  const faDate = formatFirstAscentDate(currentAngleStats?.fa_at ?? null, locale);
  const boardLabel = climbBoardForSearch(boardDetails.board_name, boardDetails.layout_name);

  return (
    <Box component="dl" sx={dlSx}>
      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.grade')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {climb.difficulty ? climbGradeForSearch(climb.difficulty) : t('frontDoor.facts.unknown')}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.ascents')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {new Intl.NumberFormat(locale).format(climb.ascensionist_count ?? 0)}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.quality')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {quality > 0 ? t('frontDoor.facts.qualityValue', { quality: quality.toFixed(1) }) : '—'}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.angle')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {t('frontDoor.facts.angleValue', { angle })}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.board')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {boardLabel}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.setter')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {setter ? (
            <MuiLink component={LocaleLink} href={`/setter/${encodeURIComponent(setter)}`} sx={setterLinkSx}>
              {t('frontDoor.setterLink', { setter })}
            </MuiLink>
          ) : (
            t('frontDoor.facts.unknown')
          )}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.firstAscent')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {faUsername && faDate
            ? t('frontDoor.facts.firstAscentValue', { setter: faUsername, date: faDate })
            : t('frontDoor.facts.firstAscentUnknown')}
        </Box>
      </div>
    </Box>
  );
}
