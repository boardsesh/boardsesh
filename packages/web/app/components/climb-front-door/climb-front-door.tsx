import React from 'react';
import Box from '@mui/material/Box';
import { getDisplayDescription, type SimilarClimb } from '@boardsesh/shared-schema';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import ClimbSocialSection from '@/app/components/social/climb-social-section';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';
import { buildBoardArtLayers, toDarkArtUrl } from '@/app/components/board-renderer/util';
import boardArtStyles from '@/app/components/board-renderer/board-art-theme.module.css';
import { buildCanonicalClimbListUrl, buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BetaLink } from '@/app/lib/beta-video-url';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
import AngleCrossLinks from './angle-cross-links';
import ClimbCreativeWorkJsonLd from './climb-creative-work-json-ld';
import ClimbFacts from './climb-facts';
import ClimbHandoffCta, { type HandoffTree } from './climb-handoff-cta';
import FrontDoorBreadcrumb from './front-door-breadcrumb';

type ClimbFrontDoorProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  canonicalAngle: number;
  angleStats: ClimbStatsForAngle[];
  similarClimbs: SimilarClimb[];
  betaLinks: BetaLink[];
  /**
   * The pathname the "Climb this" CTA hands to the app — the URL the reader is
   * actually on. Deliberately NOT the page's canonical: on `/b/{slug}` the
   * canonical points into the config-tuple tree (A1) while the hand-off keeps
   * the board context the reader arrived with.
   */
  handoffPath: string;
  tree: HandoffTree;
  /**
   * True when the page is asking Google not to index it — today only `/b/{slug}`
   * on an unlisted or non-public board.
   *
   * It gates the `CreativeWork` payload, and the reason is the same one that
   * makes that page pass no `path` to `createPageMetadata`: a noindex URL that
   * names an indexable twin is a conflicting signal Google can resolve by
   * propagating the noindex, deindexing a public config-tuple climb page because
   * one private board happens to share its configuration. `url` is the field
   * Google uses for page association, so emitting it here would walk straight
   * around the guard the metadata puts up.
   */
  noindex?: boolean;
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

// The board photo and the holds render are separate images on a themed board, so they stack
// in one CSS grid cell. Grid rather than absolute positioning, matching BoardImageLayers:
// absolutely positioned images inside an aspect-ratio container hit iOS 18.x WebKit bugs.
const boardArtSx = {
  display: 'grid',
  '& > img': { gridArea: '1 / 1' },
};

const boardLayerStyle: React.CSSProperties = {
  maxWidth: '100%',
  height: 'auto',
  width: '100%',
};

// Setters type notes with line breaks; keep them rather than collapsing the
// whole thing onto one line.
const setterNotesSx = {
  whiteSpace: 'pre-line',
  margin: 0,
};

/**
 * The SSR climb page: everything a reader (or a crawler) needs about one climb,
 * with exactly one action — open it in the app.
 *
 * Three deliberate absences:
 *
 *  1. **No board renderer.** The board art is a plain `<img>` pointing at the
 *     Railway `/render/board` overlay, with explicit dimensions so it
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
 *     crawler in a single deploy. Recorded as a comment on the QA gate (#4359):
 *     this PR holds the section out and the rollout continues unchanged. The
 *     call to SSR it for everyone stays with the maintainer at gate-signing.
 */
export default async function ClimbFrontDoor({
  climb,
  boardDetails,
  angle,
  canonicalAngle,
  angleStats,
  similarClimbs,
  betaLinks,
  handoffPath,
  tree,
  noindex = false,
}: ClimbFrontDoorProps) {
  const { t, locale } = await getServerTranslation('climbs');

  const boardListUrl = buildCanonicalClimbListUrl(boardDetails, angle);
  const climbName = resolveClimbDisplayName(climb.name, boardDetails.board_name);
  // The breadcrumb's leaf is the page's CANONICAL, not `handoffPath`: on `/b`
  // those differ, and the JSON-LD has to name the URL the page claims.
  const canonicalClimbUrl = buildCanonicalClimbViewUrl(boardDetails, canonicalAngle, climb.uuid, climbName);
  const isCanonicalAngle = angle === canonicalAngle;
  // Woods art has a white ground that glares in dark mode, so it ships a dark sibling. Rather
  // than render the whole composite twice — one WASM + sharp job per theme, per climb — the
  // board photo splits out as static layers the stylesheet picks between, and the holds
  // render once on top. See buildBoardArtLayers. The JSON-LD below keeps the overlay URL
  // either way: a crawler has no theme.
  const { backgroundUrls, overlayUrl } = buildBoardArtLayers(boardDetails, climb.frames, false);
  // The setter's own words about the climb — the one genuinely unique piece of
  // indexable prose on this page. User-written, so it renders verbatim (never
  // through `t()`) and stays out of the JSON-LD `description` below, which is
  // the synthesised catalogue string. Empty when the setter wrote nothing, or
  // only Aurora's "No match" marker.
  const setterNotes = getDisplayDescription(climb.description);
  const currentAngleStats = angleStats.find((stats) => stats.angle === angle);
  const layoutName = boardDetails.layout_name ?? '';
  // The same catalog string `generateMetadata` fills, but structured data omits
  // it unless the current angle has an honest five-star quality value. A missing
  // stats row must not become "Quality: 0/5", and an Aurora-scale 1-3 value must
  // not be labelled `/5`. Schema.org treats `description` as optional.
  const jsonLdDescription =
    climb.difficulty &&
    climb.setter_username &&
    currentAngleStats?.quality_normalized === true &&
    currentAngleStats.quality_average !== null
      ? t('metadata.view.description', {
          climbName,
          grade: climb.difficulty,
          setter: climb.setter_username,
          quality: currentAngleStats.quality_average,
          ascents: currentAngleStats.ascensionist_count,
        })
      : null;

  return (
    <Box component="main" sx={containerSx}>
      <FrontDoorBreadcrumb
        boardName={boardDetails.board_name}
        angle={angle}
        boardListUrl={boardListUrl}
        currentLabel={climbName}
        currentUrl={canonicalClimbUrl}
        emitJsonLd={!noindex && isCanonicalAngle}
      />

      {noindex || !isCanonicalAngle ? null : (
        <ClimbCreativeWorkJsonLd
          climb={climb}
          climbName={climbName}
          canonicalClimbUrl={canonicalClimbUrl}
          overlayUrl={overlayUrl}
          currentAngleStats={currentAngleStats}
          description={jsonLdDescription}
          locale={locale}
        />
      )}

      <ClimbViewSeoFragment climb={climb} boardDetails={boardDetails} />

      {overlayUrl ? (
        <Box sx={boardArtSx}>
          {backgroundUrls.map((backgroundUrl) => (
            <React.Fragment key={backgroundUrl}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={backgroundUrl}
                alt=""
                width={boardDetails.boardWidth}
                height={boardDetails.boardHeight}
                className={boardArtStyles.lightArt}
                fetchPriority="high"
                decoding="async"
                style={boardLayerStyle}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={toDarkArtUrl(backgroundUrl)}
                alt=""
                width={boardDetails.boardWidth}
                height={boardDetails.boardHeight}
                className={boardArtStyles.darkArt}
                fetchPriority="high"
                decoding="async"
                style={boardLayerStyle}
              />
            </React.Fragment>
          ))}
          {/* eslint-disable-next-line @next/next/no-img-element -- the overlay route
              is already an optimised render endpoint; next/image would add a second
              proxy hop in front of the page's LCP element for no gain. */}
          <img
            src={overlayUrl}
            alt={t('frontDoor.boardImageAlt', {
              climbName,
              boardName: boardDetails.board_name,
              layoutName,
              angle,
            })}
            width={boardDetails.boardWidth}
            height={boardDetails.boardHeight}
            fetchPriority="high"
            decoding="async"
            style={boardLayerStyle}
          />
        </Box>
      ) : null}

      <ClimbFacts climb={climb} boardDetails={boardDetails} angle={angle} currentAngleStats={currentAngleStats} />

      {setterNotes ? (
        <Box component="section">
          <Box component="h2">{t('frontDoor.setterNotes.heading')}</Box>
          <Box component="p" sx={setterNotesSx}>
            {setterNotes}
          </Box>
        </Box>
      ) : null}

      <ClimbHandoffCta
        pathname={handoffPath}
        label={t('frontDoor.cta.climbThis')}
        ariaLabel={t('frontDoor.cta.ariaLabel', { climbName })}
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
        climbName={climbName}
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
