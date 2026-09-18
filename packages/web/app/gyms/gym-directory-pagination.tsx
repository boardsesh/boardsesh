import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * Every page control is the same pill: a surface fill and the one hairline.
 * Underlined violet text on the page ground was fine on white and reads as
 * loose debris on the near-black ground, where nothing else at that size
 * is a link.
 */
const PAGE_PILL = {
  minWidth: 40,
  height: 40,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  px: 1.5,
  borderRadius: 'var(--border-radius-button)',
  border: '1px solid var(--separator)',
  backgroundColor: 'var(--semantic-surface)',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  '&:hover': { backgroundColor: 'var(--semantic-surface-elevated)', borderColor: 'var(--color-primary)' },
} as const;
import {
  DIRECTORY_PAGE_SIZE,
  buildDirectoryHref,
  paginationWindow,
  type DirectoryFacet,
  type DirectoryQuery,
} from './directory-facets';

type GymDirectoryPaginationProps = {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  totalCount: number;
};

/**
 * Real, crawlable `?page=N` anchors — Prev, a window of numbers, Next.
 *
 * One page per interaction by construction: each link is a navigation to the
 * next offset, so there is no "load more" loop that can drain the catalog into
 * one request. Every one of these URLs canonicalises back to the route's clean
 * base (see `generateGymDirectoryMetadata`), so the numbered links are a
 * crawl path, not 40 competing URLs.
 */
export default async function GymDirectoryPagination({ facet, query, totalCount }: GymDirectoryPaginationProps) {
  const { t } = await getServerTranslation('gyms');

  const totalPages = Math.ceil(totalCount / DIRECTORY_PAGE_SIZE);
  if (totalPages <= 1) {
    return null;
  }

  // Not clamped. The renderer 404s any `?page` past the end, so `query.page` is
  // always a real page by the time this renders — and clamping here was what
  // let the URL say 40 while `aria-current` said 2.
  const currentPage = query.page;
  const pages = paginationWindow(currentPage, totalPages);

  return (
    <Box
      component="nav"
      aria-label={t('pagination.label')}
      sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mt: 4 }}
    >
      {currentPage > 1 && (
        <MuiLink
          component={LocaleLink}
          href={buildDirectoryHref(facet, query, currentPage - 1)}
          rel="prev"
          underline="none"
          sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
        >
          {t('pagination.previous')}
        </MuiLink>
      )}

      {pages.map((page) =>
        page === currentPage ? (
          <Typography
            key={page}
            component="span"
            aria-current="page"
            variant="body2"
            sx={{
              ...PAGE_PILL,
              backgroundColor: 'var(--semantic-surface-elevated)',
              borderColor: 'var(--color-primary)',
              color: 'var(--color-primary)',
            }}
          >
            {t('pagination.current', { page })}
          </Typography>
        ) : (
          <MuiLink
            key={page}
            component={LocaleLink}
            href={buildDirectoryHref(facet, query, page)}
            underline="none"
            variant="body2"
            sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
          >
            {t('pagination.page', { page })}
          </MuiLink>
        ),
      )}

      {currentPage < totalPages && (
        <MuiLink
          component={LocaleLink}
          href={buildDirectoryHref(facet, query, currentPage + 1)}
          rel="next"
          underline="none"
          sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
        >
          {t('pagination.next')}
        </MuiLink>
      )}
    </Box>
  );
}
