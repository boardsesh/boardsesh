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
import { GYMS_DIRECTORY_FLAG } from '@/app/flags';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import {
  BOARD_FACETS,
  DIRECTORY_FACETS,
  FACET_BASE_PATHS,
  hasActiveFilters,
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
import GymDirectoryMapMount from './gym-directory-map-mount';
import GymDirectoryPagination from './gym-directory-pagination';
import GymDirectorySearchForm from './gym-directory-search-form';
import GymDirectorySearchTracker from './gym-directory-search-tracker';

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
 * Every route is `noindex, follow` while the directory is flag-gated. Launch
 * (#4382) removes the noindex; nothing else here has to change.
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
  // Reachability gate, not a display gate: with the flag off the route is a
  // plain 404. Shipping only the `noindex` would leave a publicly reachable
  // directory of gyms the dedup pass hasn't finished merging yet.
  const distinctId = await getPosthogDistinctId();
  if (!(await getServerFeatureFlag(GYMS_DIRECTORY_FLAG, distinctId))) {
    notFound();
  }

  const searchParams = await props.searchParams;
  const query = parseDirectoryQuery(facet, searchParams);
  const { t, locale } = await getServerTranslation('gyms');
  const [page, facetCounts] = await Promise.all([fetchDirectoryPage(query), fetchFacetCounts()]);

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
  const crossLinks: DirectoryFacet[] = DIRECTORY_FACETS.filter((candidate) => candidate !== facet);

  return (
    <I18nProvider locale={locale} namespaces={['common', 'gyms']}>
      {hasActiveFilters(facet, query) && (
        <GymDirectorySearchTracker
          queryLength={query.query.length}
          boardTypesKey={query.boardTypes.join(',')}
          hasGeo={origin !== null}
          resultsCount={page.totalCount}
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
                href={FACET_BASE_PATHS[candidate]}
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

        <GymDirectoryMapMount />

        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 }}
        >
          {t('results.heading', { count: page.totalCount, formattedCount: formatNumber(page.totalCount) })}
        </Typography>

        {page.gyms.length === 0 ? (
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
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
              gap: 2,
              m: 0,
              p: 0,
            }}
          >
            {page.gyms.map((gym) => (
              <GymDirectoryCard
                key={gym.uuid}
                gym={gym}
                origin={origin}
                viewerState={viewerState}
                formatNumber={formatNumber}
              />
            ))}
          </Box>
        )}

        <GymDirectoryPagination facet={facet} query={query} totalCount={page.totalCount} />

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
