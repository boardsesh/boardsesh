import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { climbBoardForSearch } from '@/app/lib/seo/climb-display';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';
import { buildAboutSentences, joinAboutSentences } from './about-sentences';
import ClimbFacts from './climb-facts';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';

type AboutClimbProps = {
  climb: Climb;
  boardDetails: BoardRouteIdentity;
  angle: number;
  /** Every angle the climb has stats for, already loaded for the angle table. */
  angleStats: ClimbStatsForAngle[];
  /** The row for the angle being viewed, when one exists. */
  currentAngleStats?: ClimbStatsForAngle;
};

const paragraphSx = {
  margin: 0,
  maxWidth: '62ch',
  color: 'var(--neutral-800)',
  lineHeight: 1.65,
};

/**
 * "About this climb": a short factual paragraph, then the spec list.
 *
 * The paragraph is prose a crawler can quote, but it invents nothing: every
 * sentence comes from data this page already shows (`buildAboutSentences`), and
 * a sentence whose data is missing is left out rather than filled in.
 */
export default async function AboutClimb({
  climb,
  boardDetails,
  angle,
  angleStats,
  currentAngleStats,
}: AboutClimbProps) {
  const { t, locale } = await getServerTranslation('climbs');
  // The heading's name, translated for an unnamed climb, so the paragraph never
  // opens on a different name from the `<h1>`.
  const climbName =
    climb.name?.trim() || t('frontDoor.hero.unnamedClimb', { board: formatBoardDisplayName(boardDetails.board_name) });
  const sentences = buildAboutSentences(
    {
      climbName,
      difficulty: climb.difficulty,
      boardLabel: climbBoardForSearch(boardDetails.board_name, boardDetails.layout_name),
      angle,
      setter: climb.setter_username,
      firstAscentClimber: currentAngleStats?.fa_username,
      firstAscentAt: currentAngleStats?.fa_at,
      // The same count the heading's proof line prints.
      sendsHere: climb.ascensionist_count,
      angleStats,
    },
    t,
    locale,
  );

  return (
    <Box component="section" aria-labelledby="about-climb-heading">
      <Typography variant="h5" component="h2" id="about-climb-heading" sx={frontDoorSectionHeadingSx}>
        {t('frontDoor.about.heading')}
      </Typography>
      <Typography variant="body1" component="p" sx={paragraphSx}>
        {joinAboutSentences(sentences, locale)}
      </Typography>
      <ClimbFacts climb={climb} boardDetails={boardDetails} angle={angle} currentAngleStats={currentAngleStats} />
    </Box>
  );
}
