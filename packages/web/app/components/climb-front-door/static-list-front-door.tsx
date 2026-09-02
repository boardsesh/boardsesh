import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { frontDoorPagePath, isIndexableFrontDoorPage } from '@/app/lib/seo/list-page-robots';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';
import ClimbHandoffCta, { type HandoffTree } from './climb-handoff-cta';
import ClimbListJsonLd from './climb-list-json-ld';
import FrontDoorBreadcrumb from './front-door-breadcrumb';

type StaticListFrontDoorProps = {
  boardDetails: BoardDetails;
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
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

const headingSx = { fontWeight: themeTokens.typography.fontWeight.bold, mt: 1, mb: 1 };

const introSx = { color: 'var(--neutral-400)', m: 0, mb: 3, maxWidth: '68ch' };

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
  mt: 5,
  mb: 2,
  '@media (max-width: 480px)': {
    gridTemplateColumns: '1fr 1fr',
    columnGap: 1,
  },
};

// `minWidth: 0` overrides both the track's `auto` minimum and MUI's 64px button
// minimum; `maxWidth: 100%` plus wrapping keeps a long label inside its track
// instead of spilling out of the container.
const paginationControlSx = {
  minWidth: 0,
  maxWidth: '100%',
  whiteSpace: 'normal' as const,
  gridRow: 1,
};

const previousSx = { ...paginationControlSx, gridColumn: 1, justifySelf: 'start' };

const pageLabelSx = {
  gridColumn: 2,
  gridRow: 1,
  justifySelf: 'center',
  color: 'var(--neutral-400)',
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
  color: 'var(--neutral-400)',
  padding: `${themeTokens.spacing[6]}px ${themeTokens.spacing[4]}px`,
  border: '1px dashed var(--neutral-300)',
  borderRadius: `${themeTokens.borderRadius.md}px`,
  m: 0,
};

/**
 * The SSR `/list` page: one fixed page of climbs, every row a real anchor.
 *
 * `virtualize={false}` is the whole point. The virtualized path emits a
 * viewport-sized window on the server (~18 rows), and this page's contract is
 * ≥50 crawlable climb links per `?page`.
 *
 * No `logbook` prop, deliberately: these URLs carry a shared CDN `s-maxage`
 * with no session split, so a server-rendered ascent badge would be one
 * viewer's data served to everyone. See `climb-front-door.tsx` for the full
 * reasoning.
 */
export default async function StaticListFrontDoor({
  boardDetails,
  angle,
  climbs,
  hasMore,
  page,
  basePath,
  tree,
  noindex = false,
}: StaticListFrontDoorProps) {
  const { t, locale } = await getServerTranslation('climbs');
  const boardName = formatBoardDisplayName(boardDetails.board_name);
  // The breadcrumb's leaf is this page's CANONICAL, which on `/b/{slug}` is the
  // config-tuple URL rather than the path the reader is on — same split
  // `ClimbFrontDoor` handles, same builder on both trees.
  const canonicalListUrl = buildCanonicalClimbListUrl(boardDetails, angle);
  // `?page=2` is self-canonical, so a BreadcrumbList there whose leaf names page
  // 1 would be a second, contradicting answer to "which URL is this?". Page 1 is
  // the only page whose canonical the crumbs actually describe.
  const emitBreadcrumbJsonLd = !noindex && page === 1;

  return (
    <Box component="main" sx={containerSx}>
      <ClimbListJsonLd climbs={climbs} boardDetails={boardDetails} page={page} locale={locale} />

      <FrontDoorBreadcrumb
        boardName={boardName}
        angle={angle}
        boardListUrl={canonicalListUrl}
        emitJsonLd={emitBreadcrumbJsonLd}
      />

      <Box component="header">
        <Typography variant="h3" component="h1" sx={headingSx}>
          {t('list.frontDoor.heading', { boardName, angle })}
        </Typography>
        <Typography variant="body1" component="p" sx={introSx}>
          {t('list.frontDoor.intro', { boardName, angle })}
        </Typography>
      </Box>

      <StaticClimbList
        climbs={climbs}
        boardDetails={boardDetails}
        virtualize={false}
        // Keep the leading rows on plain image layers rather than the canvas
        // renderer: this page paints 50 rows at once, and the first screenful
        // is what LCP measures.
        initialImageCount={6}
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

      <ClimbHandoffCta
        pathname={basePath}
        label={t('list.frontDoor.cta')}
        ariaLabel={t('list.frontDoor.cta')}
        surface="list_front_door"
        tree={tree}
        boardName={boardDetails.board_name}
        layoutId={boardDetails.layout_id}
        angle={angle}
        locale={locale}
      />
    </Box>
  );
}
