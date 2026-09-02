import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardDetails } from '@/app/lib/types';

type AngleCrossLinksProps = {
  boardDetails: BoardDetails;
  climbUuid: string;
  climbName: string;
  currentAngle: number;
  angleStats: ClimbStatsForAngle[];
};

// Matches the section rhythm the other `<h2>` bands use in `climb-front-door`.
const sectionSx = { mt: 4 };

const sectionHeadingSx = { fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 };

const listSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: `${themeTokens.spacing[2]}px`,
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const itemSx = {
  padding: `${themeTokens.spacing[1]}px ${themeTokens.spacing[3]}px`,
  borderRadius: `${themeTokens.borderRadius.full}px`,
  border: '1px solid var(--neutral-300)',
  fontSize: themeTokens.typography.fontSize.sm,
};

/**
 * The same climb at every angle it has stats for.
 *
 * The angle dimension is otherwise the front door's worst duplicate-content
 * problem — one climb, N near-identical pages. Linking them turns it into an
 * internal-link mesh instead, and gives a reader who cares about 25° a real
 * reason to click. The angle being viewed renders as text, not a self-link.
 */
export default async function AngleCrossLinks({
  boardDetails,
  climbUuid,
  climbName,
  currentAngle,
  angleStats,
}: AngleCrossLinksProps) {
  const { t } = await getServerTranslation('climbs');
  if (angleStats.length === 0) return null;

  return (
    <Box component="section" sx={sectionSx}>
      <Typography variant="h5" component="h2" sx={sectionHeadingSx}>
        {t('frontDoor.angles.heading')}
      </Typography>
      <Box component="ul" sx={listSx}>
        {angleStats.map((stats) => {
          const grade = stats.difficulty || t('frontDoor.facts.unknown');
          if (stats.angle === currentAngle) {
            return (
              <Box component="li" key={stats.angle} sx={itemSx}>
                <strong aria-current="page">{t('frontDoor.angles.current', { angle: stats.angle, grade })}</strong>
              </Box>
            );
          }
          return (
            <Box component="li" key={stats.angle} sx={itemSx}>
              <LocaleLink href={buildCanonicalClimbViewUrl(boardDetails, stats.angle, climbUuid, climbName)}>
                {t('frontDoor.angles.link', { angle: stats.angle, grade })}
              </LocaleLink>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
