import React from 'react';
import Box from '@mui/material/Box';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import ClimbSocialSection from '@/app/components/social/climb-social-section';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';
import { buildOverlayUrl } from '@/app/components/board-renderer/util';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BetaLink } from '@/app/lib/beta-video-url';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
import AngleCrossLinks from './angle-cross-links';
import ClimbFacts from './climb-facts';
import ClimbHandoffCta, { type HandoffTree } from './climb-handoff-cta';
import FrontDoorBreadcrumb from './front-door-breadcrumb';

type ClimbFrontDoorProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  angleStats: ClimbStatsForAngle[];
  similarClimbs: SimilarClimb[];
  betaLinks: BetaLink[];
  /** This page's own canonical path. Doubles as the CTA's hand-off pathname. */
  canonicalPath: string;
  tree: HandoffTree;
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

/**
 * The SSR climb page: everything a reader (or a crawler) needs about one climb,
 * with exactly one action — open it in the app.
 *
 * Three deliberate absences:
 *
 *  1. **No board renderer.** The board art is a plain `<img>` pointing at the
 *     `/api/internal/board-render` overlay, with explicit dimensions so it
 *     reserves its box before it loads. `BoardRenderer` and `BoardImageLayers`
 *     are both hook-bearing client components; this image is the page's LCP and
 *     has to be in the first HTML byte-for-byte.
 *  2. **No logbook, no ascent badges.** `middleware.ts` puts a shared
 *     `Vercel-CDN-Cache-Control: s-maxage` on every climb-view URL with no
 *     session split, on the premise that the page is personalization-free.
 *     Server-rendering one viewer's ticks would cache them for everyone,
 *     Googlebot included. `ascent-status.tsx` documents the same contract from
 *     the other end: anonymous SSR renders no badge at all.
 *  3. **No Boardsesh-grade section.** That flag is a live staged PostHog
 *     rollout, and SSR-ing the section would end it for every visitor and
 *     crawler in a single deploy. The decision is recorded on the QA gate
 *     (#4359).
 */
export default async function ClimbFrontDoor({
  climb,
  boardDetails,
  angle,
  angleStats,
  similarClimbs,
  betaLinks,
  canonicalPath,
  tree,
}: ClimbFrontDoorProps) {
  const { t, locale } = await getServerTranslation('climbs');

  const boardListUrl = buildCanonicalClimbListUrl(boardDetails, angle);
  const overlayUrl = climb.frames ? buildOverlayUrl(boardDetails, climb.frames, false) : null;
  const currentAngleStats = angleStats.find((stats) => stats.angle === angle);
  const layoutName = boardDetails.layout_name ?? '';

  return (
    <Box component="main" sx={containerSx}>
      <FrontDoorBreadcrumb
        boardName={boardDetails.board_name}
        angle={angle}
        boardListUrl={boardListUrl}
        currentLabel={climb.name}
      />

      <ClimbViewSeoFragment climb={climb} boardDetails={boardDetails} />

      {overlayUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element -- the overlay route
           is already an optimised render endpoint; next/image would add a second
           proxy hop in front of the page's LCP element for no gain. */
        <img
          src={overlayUrl}
          alt={t('frontDoor.boardImageAlt', {
            climbName: climb.name,
            boardName: boardDetails.board_name,
            layoutName,
            angle,
          })}
          width={boardDetails.boardWidth}
          height={boardDetails.boardHeight}
          fetchPriority="high"
          decoding="async"
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      ) : null}

      <ClimbFacts climb={climb} boardDetails={boardDetails} angle={angle} currentAngleStats={currentAngleStats} />

      <ClimbHandoffCta
        pathname={canonicalPath}
        label={t('frontDoor.cta.climbThis')}
        ariaLabel={t('frontDoor.cta.ariaLabel', { climbName: climb.name })}
        helperText={t('frontDoor.cta.helper')}
        surface="climb_front_door"
        tree={tree}
        boardName={boardDetails.board_name}
        layoutId={boardDetails.layout_id}
        angle={angle}
        climbUuid={climb.uuid}
        locale={locale}
      />

      <AngleCrossLinks
        boardDetails={boardDetails}
        climbUuid={climb.uuid}
        climbName={climb.name}
        currentAngle={angle}
        angleStats={angleStats}
      />

      <Box component="section">
        <Box component="h2">{t('frontDoor.beta.heading')}</Box>
        {betaLinks.length > 0 ? (
          <BoardseshBetaList links={betaLinks} isLoading={false} source="drawer" />
        ) : (
          <p>{t('frontDoor.beta.empty')}</p>
        )}
      </Box>

      <Box component="section">
        <Box component="h2">{t('frontDoor.similar.heading')}</Box>
        <SimilarClimbsList
          boardType={boardDetails.board_name as BoardName}
          layoutId={boardDetails.layout_id}
          viewerBoardDetails={boardDetails}
          climbUuid={climb.uuid}
          angle={angle}
          threshold={0.5}
          limit={10}
          initialClimbs={similarClimbs}
          emptyMessage={t('similarClimbs.emptyOnLayout')}
        />
      </Box>

      <Box component="section">
        <Box component="h2">{t('frontDoor.community.heading')}</Box>
        <ClimbSocialSection
          climbUuid={climb.uuid}
          boardType={boardDetails.board_name}
          angle={angle}
          currentClimbDifficulty={climb.difficulty}
          boardName={boardDetails.board_name}
        />
      </Box>
    </Box>
  );
}
