import React from 'react';
import { visuallyHidden } from '@mui/utils';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import { paginationWindow } from '@/app/gyms/directory-facets';

/**
 * Every page control is the same grey button: the label ink, a transparent ground
 * and the opaque control edge, with the button state layer on hover. Underlined
 * violet text on the page ground was fine on white and reads as loose debris on
 * the near-black ground, where nothing else at that size is a link. The current
 * page is the tonal selected container with its own ink.
 */
const PAGE_PILL = {
  // `minHeight`, never `height`: 40px was under the 44px target every other
  // control on the site holds, and a fixed height cannot grow for a bigger
  // text size or a translated Prev/Next label.
  minWidth: 44,
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  px: 1.5,
  borderRadius: 'var(--border-radius-button)',
  border: '1px solid var(--control-border)',
  backgroundColor: 'transparent',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  '&:hover': { backgroundColor: 'var(--semantic-button-hover)' },
} as const;

export type DirectoryPaginationProps = {
  currentPage: number;
  totalCount: number;
  pageSize: number;
  maxPages?: number;
  hrefForPage: (page: number) => string;
  labels: {
    region: string;
    previous: string;
    next: string;
    page: (page: number) => string;
    current: (page: number) => string;
  };
};

/**
 * Real, crawlable `?page=N` anchors — Prev, a window of numbers, Next.
 *
 * One page per interaction by construction: each link is a navigation to the
 * next offset, so there is no "load more" loop that can drain the catalog into
 * one request. The caller controls query preservation and its crawl ceiling.
 */
export function DirectoryPagination({
  currentPage,
  totalCount,
  pageSize,
  maxPages = Number.POSITIVE_INFINITY,
  hrefForPage,
  labels,
}: DirectoryPaginationProps) {
  const totalPages = Math.min(maxPages, Math.ceil(totalCount / pageSize));
  if (totalPages <= 1) return null;

  // The route validates its page before rendering, so controls match the URL.
  const pages = paginationWindow(currentPage, totalPages);

  return (
    <Box
      component="nav"
      aria-label={labels.region}
      sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mt: 4 }}
    >
      {currentPage > 1 && (
        <MuiLink
          component={LocaleLink}
          href={hrefForPage(currentPage - 1)}
          rel="prev"
          underline="none"
          sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
        >
          {labels.previous}
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
              backgroundColor: 'var(--semantic-selected)',
              borderColor: 'var(--semantic-selected)',
              color: 'var(--semantic-on-selected)',
              '&:hover': { backgroundColor: 'var(--semantic-selected)' },
            }}
          >
            {/* The pill shows the number; the sentence is for screen readers
                only. It used to render "Page 2, current page" as VISIBLE text,
                which is three words of scaffolding inside a 40px pill and wrapped
                the whole pager onto a second row. A hidden span rather than
                `aria-label`, because this is a plain span: `aria-label` on an
                element with no role is not reliably exposed. */}
            <Box component="span" aria-hidden="true">
              {page}
            </Box>
            <Box component="span" sx={visuallyHidden}>
              {labels.current(page)}
            </Box>
          </Typography>
        ) : (
          <MuiLink
            key={page}
            component={LocaleLink}
            href={hrefForPage(page)}
            // Same split as the current page: the number is what you read, the
            // full "Page 3" is the accessible name, so a screen reader still
            // hears which page a bare digit would leave ambiguous.
            aria-label={labels.page(page)}
            underline="none"
            variant="body2"
            sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
          >
            {page}
          </MuiLink>
        ),
      )}

      {currentPage < totalPages && (
        <MuiLink
          component={LocaleLink}
          href={hrefForPage(currentPage + 1)}
          rel="next"
          underline="none"
          sx={{ ...PAGE_PILL, color: 'var(--neutral-900)' }}
        >
          {labels.next}
        </MuiLink>
      )}
    </Box>
  );
}

export default DirectoryPagination;
