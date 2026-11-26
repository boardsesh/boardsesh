import { toBoardImageDetails } from '@/app/lib/board-image-details';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import React, { Suspense } from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getDisplayDescription } from '@boardsesh/shared-schema';
import { boardTypeProperty } from '@boardsesh/analytics';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import SimilarClimbsList, { ClimbPreviewRows } from '@/app/components/similar-climbs/similar-climbs-list';
import LocaleLink from '@/app/components/i18n/locale-link';
import PublicClimbBetaList from '@/app/components/beta-videos/public-climb-beta-list';
import { buildBoardArtLayers } from '@/app/components/board-renderer/util';
import { buildCanonicalClimbListUrl, buildCanonicalClimbViewUrl, constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { formatBoardDisplayName, resolveClimbDisplayName } from '@/app/lib/string-utils';
import { climbBoardForSearch, climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { buildClimbSearchDescription } from '@/app/lib/seo/search-description';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { FrontDoorSection, FrontDoorSimilarClimbs } from '@/app/lib/data/front-door-data.server';
import type { BetaLink } from '@/app/lib/beta-video-url';
import type { BoardImageDetails, BoardName, Climb } from '@/app/lib/types';
import AboutClimb from './about-climb';
import AngleTable from './angle-table';
import ClimbAppShowcase from './climb-app-showcase';
import ClimbBoardStage from './climb-board-stage';
import ClimbCreativeWorkJsonLd from './climb-creative-work-json-ld';
import ClimbHeroCta from './climb-hero-cta';
import type { HandoffTree } from './climb-handoff-cta';
import FrontDoorBreadcrumb from './front-door-breadcrumb';
import HoldLegend from './hold-legend';
import QrLandingTracker from './qr-landing-tracker';
import StickyInstallBar from './sticky-install-bar';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './climb-front-door.module.css';

type ClimbFrontDoorProps = {
  climb: Climb;
  boardDetails: BoardImageDetails;
  boardSlug?: string;
  angle: number;
  canonicalAngle: number;
  angleStats: ClimbStatsForAngle[];
  /**
   * Both sections carry their own provenance rather than a bare array, so the
   * page can tell "nobody has filmed this" apart from "the backend did not
   * answer in three seconds" and say the true one. See `FrontDoorSection`.
   */
  similarClimbs: FrontDoorSimilarClimbs;
  betaLinks: FrontDoorSection<BetaLink>;
  /**
   * The pathname the hand-off opens in the browser app and the QR code carries
   * to a phone — the URL the reader is actually on. Deliberately NOT the page's
   * canonical: on `/b/{slug}` the canonical points into the config-tuple tree
   * (A1) while the hand-off keeps the board context the reader arrived with.
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

// Setters type notes with line breaks; keep them rather than collapsing the
// whole thing onto one line.
const setterNotesSx = {
  whiteSpace: 'pre-line',
  margin: 0,
};

// One rhythm for every full-width `<h2>` band below the hero, so the page reads
// as a stack of sections rather than a run of UA-default headings. The bands in
// the hero's details column are spaced by `.details` instead.
const sectionSx = { mt: { xs: 6, md: 9 } };

// The similar-climbs heading with the way to the whole board list beside it on
// a laptop, under it on a phone.
const similarHeadSx = {
  display: 'flex',
  flexDirection: { xs: 'column', md: 'row' },
  alignItems: { xs: 'flex-start', md: 'baseline' },
  justifyContent: 'space-between',
  columnGap: 2,
  mb: 1.5,
};

const similarHeadingSx = { ...frontDoorSectionHeadingSx, mb: 0 };

const boardListLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  fontWeight: themeTokens.typography.fontWeight.semibold,
};

// Shared by the "nothing here yet" and the "this did not load" lines. Same
// muted weight for both: a degraded read is not an error the reader caused, and
// shouting about a supplementary section would be louder than the climb.
const emptySectionSx = { m: 0, color: 'var(--neutral-500)' };

/**
 * The SSR climb page: everything a reader (or a crawler) needs about one climb,
 * with one primary action per screen (`ClimbHeroCta`): the store on a phone,
 * which almost never has the app when it reads this page, and the browser app
 * plus a QR code for the phone on a laptop.
 *
 * Three deliberate absences:
 *
 *  1. **No board renderer.** The board art (`ClimbBoardStage`) is a plain
 *     `<img>` pointing at the Railway `/render/board` overlay, with explicit
 *     dimensions so it reserves its box before it loads. `BoardRenderer` and
 *     `BoardImageLayers` are both hook-bearing client components; this image is
 *     the page's LCP and has to be in the first HTML byte-for-byte.
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
  boardSlug,
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
  // The list a reader navigates to: on `/b/{slug}` it keeps their board.
  const navigationBoardListUrl = boardSlug
    ? constructBoardSlugListUrl(encodeURIComponent(boardSlug), angle)
    : boardListUrl;
  const boardDisplayName = formatBoardDisplayName(boardDetails.board_name);
  const climbName = resolveClimbDisplayName(climb.name, boardDetails.board_name);
  // The breadcrumb's leaf is the page's CANONICAL, not `handoffPath`: on `/b`
  // those differ, and the JSON-LD has to name the URL the page claims.
  const canonicalClimbUrl = buildCanonicalClimbViewUrl(boardDetails, canonicalAngle, climb.uuid, climbName, climb);
  const isCanonicalAngle = angle === canonicalAngle;
  const emitJsonLd = !noindex && climb.is_hidden !== true && isCanonicalAngle;
  // Board photo layers (Woods only) and the holds render, split as `ClimbBoardStage`
  // documents.
  const { backgroundUrls, overlayUrl } = buildBoardArtLayers(boardDetails, climb.frames, false);
  // The setter's own words about the climb — the one genuinely unique piece of
  // indexable prose on this page. User-written, so it renders verbatim (never
  // through `t()`) and stays out of the JSON-LD `description` below, which is
  // the synthesised catalogue string. Empty when the setter wrote nothing, or
  // only Aurora's "No match" marker.
  const setterNotes = getDisplayDescription(climb.description);
  const currentAngleStats = angleStats.find((stats) => stats.angle === angle);
  const layoutName = boardDetails.layout_name ?? '';
  const nearbyClimbs = similarClimbs.status === 'loaded' && similarClimbs.items.length === 0 && similarClimbs.nearby;
  const showNearbyClimbs = nearbyClimbs && (nearbyClimbs.status === 'unavailable' || nearbyClimbs.items.length > 0);
  // The meta description `generateMetadata` builds, by the same rule: no rating
  // unless the angle's quality is honest, no sends sentence at zero.
  const jsonLdDescription = buildClimbSearchDescription({
    t,
    locale,
    climbName,
    grade: climbGradeForSearch(climb.difficulty || ''),
    layoutName: climbBoardForSearch(boardDetails.board_name, boardDetails.layout_name),
    angle,
    setter: climb.setter_username,
    ascents: climb.ascensionist_count,
    angleStats: currentAngleStats,
  });

  return (
    <Box component="main" className={styles.page}>
      {/* A phone that scanned the desktop QR code lands here: count it once. */}
      <QrLandingTracker kind="climb" boardType={boardTypeProperty(boardDetails.board_name).boardType} />
      <FrontDoorBreadcrumb
        boardName={boardDisplayName}
        angle={angle}
        boardListUrl={boardListUrl}
        navigationBoardListUrl={boardSlug ? navigationBoardListUrl : undefined}
        leaf={{ label: climbName, url: canonicalClimbUrl }}
        emitJsonLd={emitJsonLd}
      />
      {emitJsonLd ? (
        <ClimbCreativeWorkJsonLd
          climb={climb}
          climbName={climbName}
          canonicalClimbUrl={canonicalClimbUrl}
          boardDetails={boardDetails}
          canonicalAngle={canonicalAngle}
          angleStats={angleStats}
          description={jsonLdDescription}
        />
      ) : null}

      <Box className={styles.hero}>
        <Box className={styles.title}>
          <ClimbViewSeoFragment
            climb={climb}
            boardDetails={boardDetails}
            angle={angle}
            currentAngleStats={currentAngleStats}
          />
        </Box>

        {overlayUrl ? (
          <Box className={styles.stage}>
            <ClimbBoardStage
              backgroundUrls={backgroundUrls}
              overlayUrl={overlayUrl}
              boardWidth={boardDetails.boardWidth}
              boardHeight={boardDetails.boardHeight}
              alt={t('frontDoor.boardImageAlt', {
                climbName,
                boardName: boardDetails.board_name,
                layoutName,
                angle,
              })}
            >
              <HoldLegend board={boardDetails.board_name} frames={climb.frames} />
            </ClimbBoardStage>
          </Box>
        ) : null}

        <Box className={styles.cta}>
          <ClimbHeroCta
            climbName={climbName}
            climbUuid={climb.uuid}
            layoutId={boardDetails.layout_id}
            angle={angle}
            boardName={boardDetails.board_name}
            layoutName={boardDetails.layout_name}
            handoffPath={handoffPath}
            tree={tree}
          />
        </Box>

        <Box className={styles.details}>
          <AngleTable
            climbUuid={climb.uuid}
            boardDetails={boardDetails}
            boardSlug={boardSlug}
            climbName={climbName}
            currentAngle={angle}
            angleStats={angleStats}
          />

          <AboutClimb
            angle={angle}
            climb={climb}
            boardDetails={boardDetails}
            angleStats={angleStats}
            currentAngleStats={currentAngleStats}
          />

          {setterNotes ? (
            <Box component="section">
              <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
                {t('frontDoor.setterNotes.heading')}
              </Typography>
              <Typography variant="body1" component="p" sx={setterNotesSx}>
                {setterNotes}
              </Typography>
            </Box>
          ) : null}

          <Box component="section">
            <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
              {betaLinks.status === 'loaded' && !betaLinks.hasMore && betaLinks.items.length > 0
                ? t('frontDoor.beta.headingCount', { count: betaLinks.items.length })
                : t('frontDoor.beta.heading')}
            </Typography>
            {/* Three states, not two. `frontDoor.beta.empty` says nobody has filmed
              this climb, which is a claim about the climb — it may only be
              rendered when the backend actually answered. This section has no
              client-side query to recover it, so the degraded copy asks for the
              one thing that does. */}
            {betaLinks.status === 'unavailable' ? (
              <Typography variant="body2" component="p" sx={emptySectionSx}>
                {t('frontDoor.beta.unavailable')}
              </Typography>
            ) : betaLinks.items.length > 0 ? (
              <>
                <PublicClimbBetaList links={betaLinks.items} />
                {betaLinks.hasMore ? (
                  <MuiLink href={buildAppHandoffUrl(handoffPath)} sx={boardListLinkSx}>
                    {t('frontDoor.cta.openInBrowser')}
                  </MuiLink>
                ) : null}
              </>
            ) : (
              <Typography variant="body2" component="p" sx={emptySectionSx}>
                {t('frontDoor.beta.empty')}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      {/* Below the climb: what the app adds. Streamed, so the hero never waits
          on it; nothing in it depends on who is asking. */}
      <Suspense fallback={null}>
        <ClimbAppShowcase
          board={boardDetails.board_name}
          betaLinks={betaLinks.status === 'loaded' ? betaLinks.items : []}
        />
      </Suspense>

      <Box component="section" sx={sectionSx} aria-labelledby="climb-similar-heading">
        <Box sx={similarHeadSx}>
          <Typography variant="h5" component="h2" id="climb-similar-heading" sx={similarHeadingSx}>
            {showNearbyClimbs
              ? t('frontDoor.similar.nearbyHeading', {
                  layout: climbBoardForSearch(boardDetails.board_name, layoutName),
                  grade: climbGradeForSearch(nearbyClimbs.grade),
                  angle,
                })
              : t('frontDoor.similar.heading')}
          </Typography>
          <MuiLink component={LocaleLink} href={navigationBoardListUrl} sx={boardListLinkSx}>
            {t('frontDoor.similar.allAtAngle', { board: boardDisplayName, angle })}
          </MuiLink>
        </Box>
        {showNearbyClimbs && nearbyClimbs.status === 'loaded' ? (
          <ClimbPreviewRows
            climbs={nearbyClimbs.items}
            boardType={boardDetails.board_name as BoardName}
            boardSlug={boardSlug}
            viewerBoardDetails={toBoardImageDetails(boardDetails)}
          />
        ) : showNearbyClimbs ? (
          <Typography variant="body2" component="p" sx={emptySectionSx}>
            {t('frontDoor.similar.nearbyUnavailable')}
          </Typography>
        ) : (
          <SimilarClimbsList
            boardType={boardDetails.board_name as BoardName}
            boardSlug={boardSlug}
            viewerBoardDetails={toBoardImageDetails(boardDetails)}
            climbs={similarClimbs.status === 'loaded' ? similarClimbs.items : undefined}
            pendingMessage={similarClimbs.status === 'unavailable' ? t('frontDoor.similar.unavailable') : undefined}
            emptyMessage={t('similarClimbs.emptyOnLayout')}
          />
        )}
      </Box>

      {/* Last in `<main>`: its end marker is what tells the bar the content is over. */}
      <StickyInstallBar
        markUrl={resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp')}
        qrLanding="climb"
        labels={{
          free: t('frontDoor.stickyBar.free'),
          cta: t('frontDoor.stickyBar.cta'),
          dismiss: t('frontDoor.stickyBar.dismiss'),
          ctaAria: { ios: t('frontDoor.stickyBar.ctaAriaIos'), android: t('frontDoor.stickyBar.ctaAriaAndroid') },
        }}
      />
    </Box>
  );
}
