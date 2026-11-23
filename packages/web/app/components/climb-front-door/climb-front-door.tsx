import { toBoardImageDetails } from '@/app/lib/board-image-details';
import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { getDisplayDescription, type SimilarClimb } from '@boardsesh/shared-schema';
import { boardTypeProperty } from '@boardsesh/analytics';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import ClimbSocialSection from '@/app/components/social/climb-social-section';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';
import { buildBoardArtLayers } from '@/app/components/board-renderer/util';
import { buildCanonicalClimbListUrl, buildCanonicalClimbViewUrl, constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { formatBoardDisplayName, resolveClimbDisplayName } from '@/app/lib/string-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { FrontDoorSection } from '@/app/lib/data/front-door-data.server';
import type { BetaLink } from '@/app/lib/beta-video-url';
import type { BoardImageDetails, BoardName, Climb } from '@/app/lib/types';
import AngleCrossLinks from './angle-cross-links';
import ClimbBoardStage from './climb-board-stage';
import ClimbCreativeWorkJsonLd from './climb-creative-work-json-ld';
import ClimbFacts from './climb-facts';
import ClimbHeroCta from './climb-hero-cta';
import type { HandoffTree } from './climb-handoff-cta';
import FrontDoorBreadcrumb from './front-door-breadcrumb';
import HoldLegend from './hold-legend';
import QrLandingTracker from './qr-landing-tracker';
import StickyInstallBar from './sticky-install-bar';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';
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
  similarClimbs: FrontDoorSection<SimilarClimb>;
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

// One rhythm for every `<h2>` band below the board art, so the page reads as a
// stack of sections rather than a run of UA-default headings.
const sectionSx = { mt: 4 };

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
  const climbName = resolveClimbDisplayName(climb.name, boardDetails.board_name);
  // The breadcrumb's leaf is the page's CANONICAL, not `handoffPath`: on `/b`
  // those differ, and the JSON-LD has to name the URL the page claims.
  const canonicalClimbUrl = buildCanonicalClimbViewUrl(boardDetails, canonicalAngle, climb.uuid, climbName);
  const isCanonicalAngle = angle === canonicalAngle;
  // Board photo layers (Woods only) and the holds render, split as `ClimbBoardStage`
  // documents. The JSON-LD below keeps the overlay URL either way: a crawler has no theme.
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
          quality: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
            Number(currentAngleStats.quality_average),
          ),
          ascents: new Intl.NumberFormat(locale).format(Number(currentAngleStats.ascensionist_count)),
          layoutName: boardDetails.layout_name || formatBoardDisplayName(boardDetails.board_name),
          angle,
        })
      : null;

  return (
    <Box component="main" className={styles.page}>
      {/* A phone that scanned the desktop QR code lands here: count it once. */}
      <QrLandingTracker kind="climb" boardType={boardTypeProperty(boardDetails.board_name).boardType} />
      <FrontDoorBreadcrumb
        boardName={formatBoardDisplayName(boardDetails.board_name)}
        angle={angle}
        boardListUrl={boardListUrl}
        navigationBoardListUrl={boardSlug ? constructBoardSlugListUrl(encodeURIComponent(boardSlug), angle) : undefined}
        leaf={{ label: climbName, url: canonicalClimbUrl }}
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
        />
      )}

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
            boardName={boardDetails.board_name}
            layoutId={boardDetails.layout_id}
            layoutName={boardDetails.layout_name}
            angle={angle}
            handoffPath={handoffPath}
            tree={tree}
          />
        </Box>

        <Box className={styles.details}>
          <ClimbFacts climb={climb} boardDetails={boardDetails} angle={angle} currentAngleStats={currentAngleStats} />

          {setterNotes ? (
            <Box component="section" sx={sectionSx}>
              <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
                {t('frontDoor.setterNotes.heading')}
              </Typography>
              <Typography variant="body1" component="p" sx={setterNotesSx}>
                {setterNotes}
              </Typography>
            </Box>
          ) : null}

          <AngleCrossLinks
            boardDetails={boardDetails}
            boardSlug={boardSlug}
            climbUuid={climb.uuid}
            climbName={climbName}
            currentAngle={angle}
            angleStats={angleStats}
          />

          <Box component="section" sx={sectionSx}>
            <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
              {t('frontDoor.beta.heading')}
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
              <BoardseshBetaList links={betaLinks.items} isLoading={false} source="drawer" />
            ) : (
              <Typography variant="body2" component="p" sx={emptySectionSx}>
                {t('frontDoor.beta.empty')}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      <Box component="section" sx={sectionSx}>
        <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
          {t('frontDoor.similar.heading')}
        </Typography>
        {/* On an unavailable read the list gets NO seed, which is the retry:
              React Query treats a seeded query as fresh for five minutes, so
              handing it `[]` would pin "No similar climbs on this layout." on the
              page for the whole visit. Unseeded, the browser fetches the section
              itself on hydration — off the server-render budget, and against the
              reader's own IP rather than the web server's single shared one.
              `pendingMessage` is what the crawler (and the reader, for that one
              round trip) reads meanwhile: prose, never a bare spinner. */}
        <SimilarClimbsList
          boardType={boardDetails.board_name as BoardName}
          boardSlug={boardSlug}
          layoutId={boardDetails.layout_id}
          viewerBoardDetails={toBoardImageDetails(boardDetails)}
          climbUuid={climb.uuid}
          angle={angle}
          threshold={0.5}
          limit={10}
          initialClimbs={similarClimbs.status === 'loaded' ? similarClimbs.items : undefined}
          pendingMessage={similarClimbs.status === 'unavailable' ? t('frontDoor.similar.unavailable') : undefined}
          emptyMessage={t('similarClimbs.emptyOnLayout')}
        />
      </Box>

      <Box component="section" sx={sectionSx}>
        <Typography variant="h5" component="h2" sx={frontDoorSectionHeadingSx}>
          {t('frontDoor.community.heading')}
        </Typography>
        <ClimbSocialSection
          climbUuid={climb.uuid}
          boardType={boardDetails.board_name}
          angle={angle}
          currentClimbDifficulty={climb.difficulty}
          boardName={boardDetails.board_name}
        />
      </Box>

      {/* Last in `<main>`: its end marker is what tells the bar the content is over. */}
      <StickyInstallBar
        markUrl={resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp')}
        qrLanding="climb"
        labels={{
          free: t('frontDoor.stickyBar.free'),
          cta: t('frontDoor.stickyBar.cta'),
          dismiss: t('frontDoor.stickyBar.dismiss'),
          ctaAria: { ios: t('frontDoor.cta.getAppAriaIos'), android: t('frontDoor.cta.getAppAriaAndroid') },
        }}
      />
    </Box>
  );
}
