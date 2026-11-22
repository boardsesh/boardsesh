import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import { buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity } from '@/app/lib/types';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';

type AngleCrossLinksProps = {
  boardDetails: BoardRouteIdentity;
  boardSlug?: string;
  climbUuid: string;
  climbName: string;
  currentAngle: number;
  angleStats: ClimbStatsForAngle[];
};

// Matches the section rhythm the other `<h2>` bands use in `climb-front-door`.
const sectionSx = { mt: 4 };

const listSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: `${themeTokens.spacing[2]}px`,
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const itemSx = {
  '& a, & strong': {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 44,
    padding: `0 ${themeTokens.spacing[3]}px`,
    textDecoration: 'none',
  },
  borderRadius: `${themeTokens.borderRadius.full}px`,
  border: '1px solid var(--control-border)',
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
  boardSlug,
  climbUuid,
  climbName,
  currentAngle,
  angleStats,
}: AngleCrossLinksProps) {
  const { t } = await getServerTranslation('climbs');
  if (angleStats.length === 0) return null;
  const sortedStats = [...angleStats].sort((left, right) => left.angle - right.angle);
  const insertionIndex = sortedStats.findIndex((stats) => stats.angle >= currentAngle);
  const center = insertionIndex < 0 ? sortedStats.length - 1 : insertionIndex;
  const nearbyStats = sortedStats.slice(Math.max(0, center - 4), center + 5);
  const nearbyAngles = new Set(nearbyStats.map((stats) => stats.angle));
  const otherStats = sortedStats.filter((stats) => !nearbyAngles.has(stats.angle));

  return (
    <Box component="section" sx={sectionSx}>
      <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
        {t('frontDoor.angles.heading')}
      </Typography>
      <Box component="ul" sx={listSx}>
        {nearbyStats.map((stats) => {
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
              <LocaleLink
                href={
                  boardSlug
                    ? constructBoardSlugViewUrl(encodeURIComponent(boardSlug), stats.angle, climbUuid, climbName)
                    : buildCanonicalClimbViewUrl(boardDetails, stats.angle, climbUuid, climbName)
                }
              >
                {t('frontDoor.angles.link', { angle: stats.angle, grade })}
              </LocaleLink>
            </Box>
          );
        })}
      </Box>
      {otherStats.length > 0 && (
        <Box component="details" sx={{ mt: 2 }}>
          <Box
            component="summary"
            sx={{
              minHeight: 44,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--color-primary)',
            }}
          >
            {t('frontDoor.angles.all')}
          </Box>
          <Box component="ul" sx={listSx}>
            {otherStats.map((stats) => (
              <Box component="li" key={stats.angle} sx={itemSx}>
                <LocaleLink
                  href={
                    boardSlug
                      ? constructBoardSlugViewUrl(encodeURIComponent(boardSlug), stats.angle, climbUuid, climbName)
                      : buildCanonicalClimbViewUrl(boardDetails, stats.angle, climbUuid, climbName)
                  }
                >
                  {t('frontDoor.angles.link', {
                    angle: stats.angle,
                    grade: stats.difficulty || t('frontDoor.facts.unknown'),
                  })}
                </LocaleLink>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
