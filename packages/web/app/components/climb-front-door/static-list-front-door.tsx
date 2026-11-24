import { toBoardImageDetails } from '@/app/lib/board-image-details';
import React from 'react';
import { boardTypeProperty } from '@boardsesh/analytics';
import { buildClimbThumbnailCrops } from '@/app/lib/climb-thumbnail-crop.server';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import LocaleLink from '@/app/components/i18n/locale-link';
import BoardAppGuideLink from '@/app/components/marketing/board-app-guide-link';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import { buildBoardArtLayers } from '@/app/components/board-renderer/util';
import { listQrUrl } from '@/app/lib/gym-attribution';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { fillNodeSlot, nodeSlot } from '@/app/lib/i18n/node-slot';
import { boardConfigForSearch, climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { formatBoardDisplayName, resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl, buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import { frontDoorPagePath, isIndexableFrontDoorPage } from '@/app/lib/seo/list-page-robots';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import type { HandoffTree } from './climb-handoff-cta';
import ClimbBoardStage from './climb-board-stage';
import ClimbListJsonLd from './climb-list-json-ld';
import CommunityProofLine from './community-proof-line';
import FrontDoorBreadcrumb from './front-door-breadcrumb';
import FrontDoorHeroCta from './front-door-hero-cta';
import GradeTile from './grade-tile';
import ListAngleRail from './list-angle-rail';
import QrLandingTracker from './qr-landing-tracker';
import { frontDoorSectionHeadingSx, frontDoorTitleSx } from './front-door-heading-sx';
import styles from './static-list-front-door.module.css';

type StaticListFrontDoorProps = {
  boardDetails: BoardImageDetails;
  /** Navigation identity; metadata continues to canonicalise by configuration. */
  boardSlug?: string;
  angle: number;
  climbs: Climb[];
  hasMore: boolean;
  /** 1-based `?page=N`, already clamped by `parseFrontDoorPage`. */
  page: number;
  /** The clean base path with no query string — pagination anchors hang off it. */
  basePath: string;
  tree: HandoffTree;
  /**
   * True when the page is asking Google not to index it — today only `/b/{slug}`
   * on an unlisted or non-public board. Gates the `BreadcrumbList` payload for
   * the same reason `ClimbFrontDoor` gates `CreativeWork`: a noindex URL whose
   * structured data names an indexable twin is a conflicting signal Google can
   * resolve by propagating the noindex onto the public page.
   */
  noindex?: boolean;
  /**
   * "Something wrong with this board? Report a problem", at the end of the
   * details. Only the `/b/{slug}` list passes it: it is about one board, and the
   * config-tuple list is about every board of a layout. The island renders the
   * same markup for every reader, so the cached HTML stays the same.
   */
  reportProblem?: React.ReactNode;
};

const CAPTION_CLIMB_SLOT = 'climb';

const headingSx = { ...frontDoorTitleSx, m: 0 };

const introSx = {
  color: 'var(--neutral-700)',
  m: 0,
  mt: 2,
  maxWidth: '68ch',
  fontSize: { xs: themeTokens.typography.fontSize.base, md: themeTokens.typography.fontSize.lg },
};

// A 44px tap target that still reads as a word in the caption: the public-page
// audit holds every link in `<main>` to 44×44, and a climb can be called "Yo".
const captionLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  maxWidth: '100%',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  overflowWrap: 'anywhere' as const,
};

const climbsHeadingSx = { ...frontDoorSectionHeadingSx, mt: 1 };

// Prev / page label / next as a three-column grid rather than a flex row with
// `<span />` spacers: the label stays centred whether or not both arrows exist.
//
// Under 480px the two controls share row 1 and the label drops to row 2. Both
// buttons plus a centred label do not fit side by side on a 320–360px phone
// once the labels are translated ("Página anterior" / "Página siguiente"), and
// a grid track defaults to `min-width: auto`, so a three-column row there would
// push the whole page into horizontal scroll rather than shrink.
const paginationSx = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'center',
  gap: 2,
  mt: 2,
  mb: 2,
  '@media (max-width: 480px)': {
    gridTemplateColumns: '1fr 1fr',
    columnGap: 1,
  },
};

// The 44px target floor still overrides MUI's 64px button minimum;
// `maxWidth: 100%` plus wrapping keeps a long label inside its track.
const paginationControlSx = {
  minWidth: 44,
  minHeight: 44,
  maxWidth: '100%',
  whiteSpace: 'normal' as const,
  gridRow: 1,
};

const previousSx = { ...paginationControlSx, gridColumn: 1, justifySelf: 'start' };

const pageLabelSx = {
  gridColumn: 2,
  gridRow: 1,
  justifySelf: 'center',
  color: 'var(--neutral-500)',
  '@media (max-width: 480px)': { gridColumn: '1 / -1', gridRow: 2 },
};

const nextSx = {
  ...paginationControlSx,
  gridColumn: 3,
  justifySelf: 'end',
  '@media (max-width: 480px)': { gridColumn: 2 },
};

const emptyStateSx = {
  textAlign: 'center' as const,
  color: 'var(--neutral-500)',
  padding: `${themeTokens.spacing[6]}px ${themeTokens.spacing[4]}px`,
  border: '1px dashed var(--neutral-300)',
  borderRadius: `${themeTokens.borderRadius.md}px`,
  m: 0,
};

/**
 * The SSR `/list` page: the first climb's board as the hero, one call to
 * action, the board's other angles, then one fixed page of climbs, every row a
 * real anchor.
 *
 * The hero is the first listed climb's board render, the same `<img>` URL that
 * climb's own page draws (`buildBoardArtLayers(…, false)`), so the CDN has
 * usually rendered it already, and the page preloads exactly that URL
 * (`fetchFrontDoorListPage`). It is the LCP element: explicit dimensions,
 * `fetchPriority="high"`, never lazy (`ClimbBoardStage`).
 *
 * The call to action is the climb page's (`FrontDoorHeroCta`): the store first
 * on a phone, because these lists are mostly reached by scanning a poster or a
 * kiosk at the wall, and the browser hand-off plus a QR code for the phone on a
 * laptop. One block; the page has no second set.
 *
 * `virtualize={false}` on the list is the whole point of the page. The
 * virtualized path emits a viewport-sized window on the server (~18 rows), and
 * this page's contract is ≥50 crawlable climb links per `?page`.
 *
 * No `logbook` prop, deliberately: these URLs carry a shared CDN `s-maxage`
 * with no session split, so a server-rendered ascent badge would be one
 * viewer's data served to everyone. See `climb-front-door.tsx` for the full
 * reasoning. The same rule keeps every part of this page the same for every
 * reader: the QR medium and the visitor's store are read in the browser.
 */
export default async function StaticListFrontDoor({
  boardDetails,
  boardSlug,
  angle,
  climbs,
  hasMore,
  page,
  basePath,
  tree,
  noindex = false,
  reportProblem,
}: StaticListFrontDoorProps) {
  const [{ t, locale }, storeButtonLabels] = await Promise.all([
    getServerTranslation('climbs'),
    getStoreButtonLabels(),
  ]);
  const boardName = formatBoardDisplayName(boardDetails.board_name);
  // "Kilter Board Original 12x12 with kickboard", not "Kilter": the heading,
  // the intro, the helper and the QR label name the layout and size a climber
  // searches for, the same words as the page's `<title>` (`boardConfigForSearch`
  // in `generateMetadata`). Without the size every Kilter Original at 40° would
  // share one heading.
  const boardLabel = boardConfigForSearch(boardDetails);
  // The breadcrumb's leaf is this page's CANONICAL, which on `/b/{slug}` is the
  // config-tuple URL rather than the path the reader is on — same split
  // `ClimbFrontDoor` handles, same builder on both trees.
  const canonicalListUrl = buildCanonicalClimbListUrl(boardDetails, angle);
  // `?page=2` is self-canonical, so a BreadcrumbList there whose leaf names page
  // 1 would be a second, contradicting answer to "which URL is this?". Page 1 is
  // the only page whose canonical the crumbs actually describe.
  const emitBreadcrumbJsonLd = !noindex && page === 1;

  const firstClimb = climbs.at(0);
  const firstClimbArt = firstClimb ? buildBoardArtLayers(boardDetails, firstClimb.frames, false) : null;
  const firstClimbOverlayUrl = firstClimbArt?.overlayUrl ?? null;

  return (
    <Box component="main" className={styles.page}>
      {/* A phone that scanned this list's laptop QR code lands here: count it once. */}
      <QrLandingTracker kind="list" boardType={boardTypeProperty(boardDetails.board_name).boardType} />
      <ClimbListJsonLd climbs={climbs} boardDetails={boardDetails} page={page} />

      <FrontDoorBreadcrumb
        boardName={boardName}
        angle={angle}
        boardListUrl={canonicalListUrl}
        emitJsonLd={emitBreadcrumbJsonLd}
      />

      <Box className={firstClimbOverlayUrl ? styles.hero : `${styles.hero} ${styles.heroWithoutStage}`}>
        <Box component="header" className={styles.title}>
          <Typography variant="h3" component="h1" sx={headingSx}>
            {t('list.frontDoor.heading', { boardName: boardLabel, angle })}
          </Typography>
          <Typography variant="body1" component="p" sx={introSx}>
            {t('list.frontDoor.intro', { boardName: boardLabel, angle })}
          </Typography>
        </Box>

        {firstClimb && firstClimbArt && firstClimbOverlayUrl ? (
          <Box className={styles.stage}>
            <ClimbBoardStage
              backgroundUrls={firstClimbArt.backgroundUrls}
              overlayUrl={firstClimbOverlayUrl}
              boardWidth={boardDetails.boardWidth}
              boardHeight={boardDetails.boardHeight}
              alt={t('frontDoor.boardImageAlt', {
                climbName: resolveClimbDisplayName(firstClimb.name, boardDetails.board_name),
                boardName: boardDetails.board_name,
                layoutName: boardDetails.layout_name ?? '',
                angle,
              })}
            >
              <FirstClimbCaption
                climb={firstClimb}
                boardDetails={boardDetails}
                boardSlug={boardSlug}
                captionTemplate={
                  page === 1
                    ? t('list.frontDoor.stage.caption', { climb: nodeSlot(CAPTION_CLIMB_SLOT) })
                    : t('list.frontDoor.stage.captionLaterPage', { climb: nodeSlot(CAPTION_CLIMB_SLOT) })
                }
                unnamedLabel={t('frontDoor.hero.unnamedClimb', { board: boardName })}
                gradeForSearch={
                  firstClimb.difficulty
                    ? t('frontDoor.hero.gradeForSearch', { grade: climbGradeForSearch(firstClimb.difficulty) })
                    : ''
                }
              />
            </ClimbBoardStage>
          </Box>
        ) : null}

        <Box className={styles.cta}>
          <FrontDoorHeroCta
            placement="climb-list"
            qrCardPlacement="climb-list-qr-card"
            // A kiosk or poster code lands on the `/b/{slug}` list only, so only
            // that tree's link id names the code (`climb-list.kiosk`), exactly as
            // before. The config-tuple list is only ever landed on through its
            // own laptop code (`climb-list.desktop`).
            qrLanding={tree === 'slug' ? 'board' : 'list'}
            handoff={{
              pathname: basePath,
              surface: 'list_front_door',
              tree,
              boardName: boardDetails.board_name,
              layoutId: boardDetails.layout_id,
              angle,
              locale,
            }}
            qrUrl={listQrUrl(basePath, locale)}
            storeLabels={storeButtonLabels}
            labels={{
              storeHelper: t('list.frontDoor.cta.getAppHelper', { board: boardLabel }),
              // The list's own words: the climb page's "open it" names a climb,
              // which reads wrong in the languages where a list is feminine.
              handoffMobile: t('list.frontDoor.cta.openInBrowserMobile'),
              handoffDesktop: t('list.frontDoor.cta.openInBrowser'),
              qr: {
                title: t('list.frontDoor.qr.title'),
                body: t('frontDoor.qr.body'),
                imageLabel: t('list.frontDoor.qr.imageLabel', { boardName: boardLabel, angle }),
              },
            }}
          />
        </Box>

        <Box className={styles.details}>
          <CommunityProofLine />

          {/* Searches like "kilter board app not working" land on board lists: point them at the
              comparison for this board, the same link the climb page carries. */}
          <BoardAppGuideLink board={boardDetails.board_name} />

          <ListAngleRail
            boardDetails={boardDetails}
            boardSlug={boardSlug}
            currentAngle={angle}
            boardLabel={boardLabel}
          />

          <Box component="section">
            <Typography component="h2" variant="h5" sx={climbsHeadingSx}>
              {t('list.frontDoor.climbsHeading', { angle })}
            </Typography>
            <StaticClimbList
              climbs={climbs}
              thumbnailCropsByClimb={buildClimbThumbnailCrops(climbs, () => boardDetails)}
              boardSlug={boardSlug}
              boardDetails={toBoardImageDetails(boardDetails)}
              virtualize={false}
              // The app's rows: rounded cards with the grade on a chip in its
              // grade colour, as on the setter page.
              rowVariant="card"
              // The hero's board render is this page's LCP and takes the high
              // priority; a row thumbnail asking for it too would compete.
              prioritizeFirstRow={false}
              emptyState={
                <Typography variant="body1" component="p" sx={emptyStateSx}>
                  {t('list.frontDoor.empty')}
                </Typography>
              }
            />

            <Box component="nav" aria-label={t('list.frontDoor.pagination.aria')} sx={paginationSx}>
              {page > 1 ? (
                <Button
                  component={LocaleLink}
                  href={frontDoorPagePath(basePath, page - 1)}
                  rel="prev"
                  variant="outlined"
                  size="small"
                  sx={previousSx}
                >
                  {t('list.frontDoor.pagination.previous')}
                </Button>
              ) : (
                <Button disabled variant="outlined" size="small" sx={previousSx}>
                  {t('list.frontDoor.pagination.previous')}
                </Button>
              )}
              <Typography variant="body2" component="span" sx={pageLabelSx}>
                {t('list.frontDoor.pagination.pageLabel', { page })}
              </Typography>
              {/*
                The walk stops at the last indexable page, not at the last page with
                climbs behind it. `noindex, follow` past the cap tells a crawler to
                keep following links, so a `next` chain that ran on `hasMore` alone
                would hand it a corridor thousands of pages deep, each hop a deeper
                `OFFSET` over the climb/stats join. Deep climbs stay reachable through
                the sitemap and the per-climb cross-links.
              */}
              {hasMore && isIndexableFrontDoorPage(page + 1) ? (
                <Button
                  component={LocaleLink}
                  href={frontDoorPagePath(basePath, page + 1)}
                  rel="next"
                  variant="outlined"
                  size="small"
                  sx={nextSx}
                >
                  {t('list.frontDoor.pagination.next')}
                </Button>
              ) : (
                <Button disabled variant="outlined" size="small" sx={nextSx}>
                  {t('list.frontDoor.pagination.next')}
                </Button>
              )}
            </Box>
          </Box>

          {reportProblem}
        </Box>
      </Box>
    </Box>
  );
}

type FirstClimbCaptionProps = {
  climb: Climb;
  boardDetails: BoardImageDetails;
  boardSlug?: string;
  /** "First on the list: {{climb}}", translated with `nodeSlot` where the link goes. */
  captionTemplate: string;
  /** What the link says for a climb with no name: "Unnamed Kilter climb". */
  unnamedLabel: string;
  /** ", V6 (7a)": the grade in words for a screen reader, which the chip beside it is hidden from. */
  gradeForSearch: string;
};

/**
 * "First on the list: leistenliebe V6", under the board, so the art is never a
 * mystery climb. The link is the same URL as that climb's row below: same
 * builder, same `resolveClimbDisplayName` slug, same tree.
 */
function FirstClimbCaption({
  climb,
  boardDetails,
  boardSlug,
  captionTemplate,
  unnamedLabel,
  gradeForSearch,
}: FirstClimbCaptionProps) {
  const slugName = resolveClimbDisplayName(climb.name, boardDetails.board_name);
  const href = boardSlug
    ? constructBoardSlugViewUrl(encodeURIComponent(boardSlug), climb.angle, climb.uuid, slugName)
    : buildCanonicalClimbViewUrl(boardDetails, climb.angle, climb.uuid, slugName);

  return (
    <Box component="p" className={styles.caption} data-testid="list-stage-caption">
      <Box component="span">
        {fillNodeSlot(
          captionTemplate,
          CAPTION_CLIMB_SLOT,
          <MuiLink component={LocaleLink} href={href} sx={captionLinkSx}>
            {climb.name?.trim() || unnamedLabel}
          </MuiLink>,
        )}
        {gradeForSearch ? (
          <Box component="span" sx={visuallyHidden}>
            {gradeForSearch}
          </Box>
        ) : null}
      </Box>
      <GradeTile difficulty={climb.difficulty} boardName={boardDetails.board_name} size="compact" />
    </Box>
  );
}
