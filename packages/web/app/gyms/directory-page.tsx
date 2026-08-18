import 'server-only';
import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import {
  BOARD_FACETS,
  DIRECTORY_FACETS,
  DIRECTORY_MAX_PAGE,
  DIRECTORY_PAGE_SIZE,
  FACET_BASE_PATHS,
  buildFacetSwitchHref,
  isSearchApplication,
  parseDirectoryQuery,
  type DirectoryFacet,
  type DirectorySearchParams,
} from './directory-facets';
import {
  facetChipLabel,
  facetDetail,
  facetHeading,
  facetLead,
  facetLinkLabel,
  facetMetaDescription,
  facetMetaTitle,
} from './directory-copy';
import { fetchDirectoryPage, fetchFacetCounts } from './directory-data';
import GymDirectoryCard from './gym-directory-card';
import GymDirectoryNearMe from './gym-directory-near-me';
import GymDirectoryPagination from './gym-directory-pagination';
import GymDirectorySearchForm from './gym-directory-search-form';
import GymDirectorySearchTracker from './gym-directory-search-tracker';
import { pinCoverage, toMapPins } from './near-me-model';

export type DirectoryRouteProps = {
  searchParams: Promise<DirectorySearchParams>;
};

/**
 * Metadata for one directory route.
 *
 * `path` is ALWAYS the route's own clean base and never carries a query string.
 * That one line is the entire canonical policy: `/gyms/kilter?page=3`,
 * `/gyms/kilter?q=bristol`, `/gyms/kilter?lat=…&lng=…&radius=25` and every
 * combination of them all self-canonicalise to `/gyms/kilter` — its OWN base,
 * not `/gyms`, because a facet page is a distinct page with distinct copy and
 * folding it into `/gyms` would throw away the "kilter board near me" surface
 * this issue exists to build. `/gyms?boardType=grasshopper` canonicalises to
 * `/gyms` for the mirror-image reason: the long tail gets no page of its own.
 *
 * Every route is `noindex, follow`. The routes themselves are public and
 * unconditional, but the listings stay out of the index until the duplicate-gym
 * queue is drained and the gyms sitemap shard can enumerate them (#4372,
 * #4381) — indexed duplicates outlive their merges in Google's cache. Removing
 * the noindex is a one-line change here once that lands.
 */
export async function generateGymDirectoryMetadata(facet: DirectoryFacet): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('gyms');

  return createNoIndexMetadata({
    title: facetMetaTitle(t, facet),
    description: facetMetaDescription(t, facet),
    path: FACET_BASE_PATHS[facet],
    locale,
  });
}

/**
 * The one renderer behind `/gyms`, `/gyms/kilter`, `/gyms/moonboard` and
 * `/gyms/tension`. Each route file is a four-line delegate to this.
 */
export async function renderGymDirectory(facet: DirectoryFacet, props: DirectoryRouteProps) {
  const searchParams = await props.searchParams;
  const query = parseDirectoryQuery(facet, searchParams);

  // Past the crawl-trap ceiling, before spending a query on it. A 404 rather
  // than a clamp: clamping serves a 200 whose URL and highlighted page disagree.
  if (query.page > DIRECTORY_MAX_PAGE) {
    notFound();
  }

  const { t, locale } = await getServerTranslation('gyms');
  const [pageResult, facetCountsResult] = await Promise.all([fetchDirectoryPage(query), fetchFacetCounts()]);

  // Either fetch failing means we cannot state the counts the body copy is
  // built around. Render the outage instead of a confident "0 gyms".
  if (!pageResult.ok || !facetCountsResult.ok) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'gyms']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Typography variant="h3" component="h1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, mb: 2 }}>
            {facetHeading(t, facet)}
          </Typography>
          <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
            {t('error.title')}
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5, maxWidth: '68ch' }}>
            {t('error.body')}
          </Typography>
        </Container>
      </I18nProvider>
    );
  }

  const facetCounts = facetCountsResult.counts;
  const totalPages = Math.ceil(pageResult.totalCount / DIRECTORY_PAGE_SIZE);

  // A page past the real end is a 404, not an empty 200. Page one of an empty
  // result set is a legitimate 200 with the empty state — "no gyms match that
  // search" is an answer; "page 40 of 2" is not a page.
  if (query.page > 1 && query.page > totalPages) {
    notFound();
  }

  const numberFormat = new Intl.NumberFormat(locale);
  const formatNumber = (value: number) => numberFormat.format(value);
  const origin =
    query.latitude !== null && query.longitude !== null
      ? { latitude: query.latitude, longitude: query.longitude }
      : null;
  // Settled server-side from the request's session, so a claim click that beats
  // hydration still reports the truth. Derived inline rather than through
  // `viewerStateFrom` so this server module doesn't pull the browser analytics
  // client into its import graph — same call the gym page makes off its cookie.
  const viewerState: GymClaimViewerState = distinctId !== null ? 'signed-in' : 'signed-out';
  // The map's pill numbers, computed from the page the server actually
  // rendered — not from the catalog total, which would claim coverage for gyms
  // nobody on this page can see.
  const browseCoverage = pinCoverage(pageResult.gyms);
  const crossLinks: DirectoryFacet[] = DIRECTORY_FACETS.filter((candidate) => candidate !== facet);

  return (
    <I18nProvider locale={locale} namespaces={['common', 'gyms']}>
      {isSearchApplication(facet, query) && (
        <GymDirectorySearchTracker
          queryLength={query.query.length}
          boardTypesKey={query.boardTypes.join(',')}
          hasGeo={origin !== null}
          resultsCount={pageResult.totalCount}
        />
      )}

      <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography variant="h3" component="h1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, mb: 2 }}>
          {facetHeading(t, facet)}
        </Typography>

        <Typography variant="body1" sx={{ mb: 1.5, maxWidth: '68ch' }}>
          {facetLead(t, facet, facetCounts, formatNumber)}
        </Typography>
        <Typography variant="body1" sx={{ mb: 3, maxWidth: '68ch' }}>
          {facetDetail(t, facet, facetCounts, formatNumber)}
        </Typography>

        <GymDirectorySearchForm facet={facet} query={query} locale={locale} />

        <Box component="section" sx={{ mb: 3 }}>
          <Typography
            variant="subtitle2"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1 }}
          >
            {t('facets.heading')}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {DIRECTORY_FACETS.map((candidate) => (
              <Chip
                key={candidate}
                clickable
                component={LocaleLink}
                href={buildFacetSwitchHref(candidate, query)}
                label={facetChipLabel(t, candidate, facetCounts, formatNumber)}
                color={candidate === facet ? 'primary' : 'default'}
                variant={candidate === facet ? 'filled' : 'outlined'}
                sx={{ borderRadius: `${themeTokens.borderRadius.full}px` }}
              />
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t('facets.countHint')}
          </Typography>
        </Box>

        {/* The map column and near-me mode wrap the results block rather than
            sitting above it: the map is a second COLUMN beside this list at
            960px and up, and near-me swaps the list out for its own. The list
            stays first in the DOM either way. */}
        <GymDirectoryNearMe
          boardTypes={query.boardTypes}
          // Threaded through, not dropped: the search box keeps rendering what
          // was typed, so near-me has to keep applying it.
          searchQuery={query.query}
          locale={locale}
          viewerState={viewerState}
          browsePins={toMapPins(pageResult.gyms)}
          browsePinnedCount={browseCoverage.pinned}
          browseShownCount={browseCoverage.total}
        >
          <Typography
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 }}
          >
            {t('results.heading', {
              count: pageResult.totalCount,
              formattedCount: formatNumber(pageResult.totalCount),
            })}
          </Typography>

          {pageResult.gyms.length === 0 ? (
            <Box sx={{ py: 4 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                {t('results.emptyTitle')}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {t('results.emptyBody')}
              </Typography>
            </Box>
          ) : (
            <Box
              component="ul"
              sx={{
                display: 'grid',
                // Three at wide widths, same as before the map existed. This is
                // the surface whose whole job is surfacing gyms, so more of
                // them above the fold wins over a grid that never reflows —
                // the one-off shift when somebody opens the map on a narrow
                // screen is the cheaper cost. The near-me grid stays at two,
                // because it genuinely renders beside an open map.
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
                gap: 2,
                m: 0,
                p: 0,
              }}
            >
              {pageResult.gyms.map((gym) => (
                <GymDirectoryCard key={gym.uuid} gym={gym} origin={origin} viewerState={viewerState} locale={locale} />
              ))}
            </Box>
          )}

          <GymDirectoryPagination facet={facet} query={query} totalCount={pageResult.totalCount} />
        </GymDirectoryNearMe>

        <Box component="section" sx={{ mt: 5 }}>
          <Typography
            variant="subtitle2"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1 }}
          >
            {t('links.heading')}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {crossLinks.map((candidate) => (
              <Box component="li" key={candidate} sx={{ mb: 0.5 }}>
                <MuiLink
                  component={LocaleLink}
                  href={FACET_BASE_PATHS[candidate]}
                  underline="hover"
                  sx={{ color: 'var(--color-primary)' }}
                >
                  {facetLinkLabel(t, candidate)}
                </MuiLink>
              </Box>
            ))}
          </Box>
        </Box>
      </Container>
    </I18nProvider>
  );
}

// Re-exported so the four route files import their whole contract from one
// module. `BOARD_FACETS` is the list #4381's sitemap will enumerate.
export { BOARD_FACETS, FACET_BASE_PATHS };
