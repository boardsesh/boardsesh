import React from 'react';
import Box from '@mui/material/Box';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardDetails, Climb } from '@/app/lib/types';

type ClimbFactsProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  /** The row for the angle being viewed, when one exists — carries the FA. */
  currentAngleStats?: ClimbStatsForAngle;
};

const dlSx = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: `${themeTokens.spacing[3]}px`,
  margin: `${themeTokens.spacing[4]}px 0`,
  padding: 0,
};

const dtSx = {
  fontSize: themeTokens.typography.fontSize.xs,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  color: 'var(--neutral-400)',
  margin: 0,
};

const ddSx = {
  fontSize: themeTokens.typography.fontSize.base,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  margin: 0,
};

/** Formats an FA timestamp for display; the raw column is a date string. */
function formatFirstAscentDate(rawDate: string | null): string | null {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * The climb's numbers as a `<dl>` — grade, quality, sends, angle, board, setter
 * and first ascent. Server-rendered, so all of it is in the HTML a crawler
 * reads and none of it waits on a client fetch.
 */
export default async function ClimbFacts({ climb, boardDetails, angle, currentAngleStats }: ClimbFactsProps) {
  const { t } = await getServerTranslation('climbs');

  const setter = climb.setter_username?.trim();
  const quality = Number(climb.quality_average ?? 0);
  const faUsername = currentAngleStats?.fa_username?.trim();
  const faDate = formatFirstAscentDate(currentAngleStats?.fa_at ?? null);
  const boardLabel = [boardDetails.board_name, boardDetails.layout_name].filter(Boolean).join(' · ');

  return (
    <Box component="dl" sx={dlSx}>
      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.grade')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {climb.difficulty || t('frontDoor.facts.unknown')}
        </Box>
      </div>

      <div>
        <Box component="dt" sx={dtSx}>
          {t('frontDoor.facts.ascents')}
        </Box>
        <Box component="dd" sx={ddSx}>
          {climb.ascensionist_count ?? 0}
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
            <LocaleLink href={`/setter/${encodeURIComponent(setter)}`}>
              {t('frontDoor.setterLink', { setter })}
            </LocaleLink>
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
