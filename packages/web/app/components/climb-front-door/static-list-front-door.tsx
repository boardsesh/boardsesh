import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { frontDoorPagePath, isIndexableFrontDoorPage } from '@/app/lib/seo/list-page-robots';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';
import ClimbHandoffCta, { type HandoffTree } from './climb-handoff-cta';

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
};

const containerSx = {
  maxWidth: 900,
  margin: '0 auto',
  padding: `${themeTokens.spacing[4]}px`,
};

const paginationSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: `${themeTokens.spacing[4]}px`,
  margin: `${themeTokens.spacing[6]}px 0`,
};

const introSx = { color: 'var(--neutral-400)', marginBottom: `${themeTokens.spacing[4]}px` };

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
}: StaticListFrontDoorProps) {
  const { t, locale } = await getServerTranslation('climbs');
  const boardName = formatBoardDisplayName(boardDetails.board_name);

  return (
    <Box component="main" sx={containerSx}>
      <Box component="header">
        <h1>{t('list.frontDoor.heading', { boardName, angle })}</h1>
        <Typography component="p" sx={introSx}>
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
        emptyState={<Typography component="p">{t('list.frontDoor.empty')}</Typography>}
      />

      <Box component="nav" aria-label={t('list.frontDoor.pagination.aria')} sx={paginationSx}>
        {page > 1 ? (
          <LocaleLink href={frontDoorPagePath(basePath, page - 1)} rel="prev">
            {t('list.frontDoor.pagination.previous')}
          </LocaleLink>
        ) : (
          <span />
        )}
        <span>{t('list.frontDoor.pagination.pageLabel', { page })}</span>
        {/*
          The walk stops at the last indexable page, not at the last page with
          climbs behind it. `noindex, follow` past the cap tells a crawler to
          keep following links, so a `next` chain that ran on `hasMore` alone
          would hand it a corridor thousands of pages deep, each hop a deeper
          `OFFSET` over the climb/stats join. Deep climbs stay reachable through
          the sitemap and the per-climb cross-links.
        */}
        {hasMore && isIndexableFrontDoorPage(page + 1) ? (
          <LocaleLink href={frontDoorPagePath(basePath, page + 1)} rel="next">
            {t('list.frontDoor.pagination.next')}
          </LocaleLink>
        ) : (
          <span />
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
