import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import {
  DIRECTORY_MAX_PAGE,
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

  const totalPages = Math.min(Math.ceil(totalCount / DIRECTORY_PAGE_SIZE), DIRECTORY_MAX_PAGE);
  if (totalPages <= 1) {
    return null;
  }

  const currentPage = Math.min(query.page, totalPages);
  const pages = paginationWindow(currentPage, totalPages);

  return (
    <Box
      component="nav"
      aria-label={t('pagination.label')}
      sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mt: 4 }}
    >
      {currentPage > 1 && (
        <MuiLink
          component={LocaleLink}
          href={buildDirectoryHref(facet, query, currentPage - 1)}
          rel="prev"
          underline="hover"
          sx={{ color: 'var(--color-primary)' }}
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
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}
          >
            {t('pagination.current', { page })}
          </Typography>
        ) : (
          <MuiLink
            key={page}
            component={LocaleLink}
            href={buildDirectoryHref(facet, query, page)}
            underline="hover"
            variant="body2"
            sx={{ color: 'var(--color-primary)' }}
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
          underline="hover"
          sx={{ color: 'var(--color-primary)' }}
        >
          {t('pagination.next')}
        </MuiLink>
      )}
    </Box>
  );
}
