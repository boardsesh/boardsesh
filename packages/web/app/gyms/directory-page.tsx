import { isBoardTypeVisible } from '@boardsesh/board-config/visibility';
import { getBoardVisibilityFlags } from '@/app/lib/boards/board-visibility.server';
import 'server-only';
import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { PageCard, PageShell, StatePanel } from '@/app/components/ui/page-shell';
import { themeTokens } from '@/app/theme/theme-config';
import {
  BOARD_FACETS,
  DIRECTORY_FACETS,
  DIRECTORY_MAX_PAGE,
  DIRECTORY_PAGE_SIZE,
  FACET_BASE_PATHS,
  buildFacetSwitchHref,
  buildDirectoryHref,
  isSearchApplication,
  parseDirectoryQuery,
  type DirectoryFacet,
  type DirectorySearchParams,
} from './directory-facets';
import { facetHeading, facetLead, facetLinkLabel, facetMetaDescription, facetMetaTitle } from './directory-copy';
import { fetchDirectoryPage, fetchFacetCounts } from './directory-data';
import GymDirectoryCard from './gym-directory-card';
import GymDirectoryClaimLink from './gym-directory-claim-link';
import GymDirectoryFilters from './gym-directory-filters';
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
  const queryWithoutRollout = parseDirectoryQuery(facet, searchParams);
  const focusSearch = searchParams.claim === '1';

  // Past the crawl-trap ceiling, before spending a query on it. A 404 rather
  // than a clamp: clamping serves a 200 whose URL and highlighted page disagree.
  if (queryWithoutRollout.page > DIRECTORY_MAX_PAGE) {
    notFound();
  }

  const viewerPromise = getPosthogDistinctId();
  const visibilityPromise = viewerPromise.then(getBoardVisibilityFlags);
  const requestedTypes = Array.isArray(searchParams.boardType) ? searchParams.boardType : [searchParams.boardType];
  const hasGatedFilter = requestedTypes.some(
    (boardType) => boardType !== undefined && !isBoardTypeVisible(boardType.trim().toLowerCase()),
  );
  // Ordinary directory queries do not depend on the rollout. Start them alongside
  // the session/flag read; only a requested gated type needs that decision first.
  const [{ t, locale }, distinctId, visibilityFlags, storeButtonLabels, facetCountsResult, ordinaryPage] =
    await Promise.all([
      getServerTranslation('gyms'),
      viewerPromise,
      visibilityPromise,
      getStoreButtonLabels(),
      fetchFacetCounts(),
      hasGatedFilter ? Promise.resolve(null) : fetchDirectoryPage(queryWithoutRollout),
    ]);
  const query = parseDirectoryQuery(facet, searchParams, visibilityFlags);
  const pageResult = ordinaryPage ?? (await fetchDirectoryPage(query));
  const currentSearchHref = buildDirectoryHref(facet, query, 1);
  const claimSearchHref = `${currentSearchHref}${currentSearchHref.includes('?') ? '&' : '?'}claim=1#gym-directory-query`;

  // Either fetch failing means we cannot state the counts the body copy is
  // built around. Render the outage instead of a confident "0 gyms".
  if (!pageResult.ok || !facetCountsResult.ok) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'gyms']}>
        {/* The h1 survives an outage — a test asserts the page still says what
            it is — but the count-bearing lead does not, because there are no
            counts to state. */}
        <PageShell
          width="wide"
          title={facetHeading(t, facet)}
          headerActions={
            <Button component={LocaleLink} href="/gyms/new" variant="contained" startIcon={<AddOutlined />}>
              {t('create.action')}
            </Button>
          }
          breadcrumb={
            <DirectoryBreadcrumb facet={facet} homeLabel={t('breadcrumb.home')} gymsLabel={t('breadcrumb.gyms')} />
          }
        >
          <StatePanel
            tone="warning"
            icon={<WarningAmberOutlined />}
            title={t('error.title')}
            body={t('error.body')}
            actions={
              <>
                {/* A plain anchor, not a LocaleLink: this button's whole job is
                    to fetch the page again, and a soft navigation to the URL
                    the visitor is already on is a no-op. */}
                <Button variant="contained" color="primaryFill" href={localeHref(FACET_BASE_PATHS[facet], locale)}>
                  {t('error.retry')}
                </Button>
                <Button variant="outlined" component={LocaleLink} href="/">
                  {t('error.home')}
                </Button>
              </>
            }
          />
        </PageShell>
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
  const visibleGyms = pageResult.gyms.map((gym) => ({
    ...gym,
    boardSummaries: gym.boardSummaries.filter((summary) => isBoardTypeVisible(summary.boardType, visibilityFlags)),
  }));
  const origin =
    query.latitude !== null && query.longitude !== null
      ? { latitude: query.latitude, longitude: query.longitude }
      : null;
  // Settled server-side from the request's session, so a claim click that beats
  // hydration still reports the truth. Derived inline rather than through
  // `viewerStateFrom` so this server module doesn't pull the browser analytics
  // client into its import graph — same call the gym page makes off its cookie.
  // `getPosthogDistinctId` is the session read: it returns `users.id` or null,
  // which is both "is anyone signed in" and the person the funnel events land on.
  const viewerState: GymClaimViewerState = distinctId !== null ? 'signed-in' : 'signed-out';
  // The map's pill numbers, computed from the page the server actually
  // rendered — not from the catalog total, which would claim coverage for gyms
  // nobody on this page can see.
  const browseCoverage = pinCoverage(visibleGyms);
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

      {/* PageShell owns the fixed-header clearance and the 1200px measure, so
          no page file hand-rolls the header offset any more. */}
      <PageShell
        width="wide"
        title={facetHeading(t, facet)}
        lead={facetLead(t, facet, facetCounts, formatNumber)}
        breadcrumb={
          <DirectoryBreadcrumb facet={facet} homeLabel={t('breadcrumb.home')} gymsLabel={t('breadcrumb.gyms')} />
        }
      >
        <Typography component="p" variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('directory.source')}{' '}
          <MuiLink component={LocaleLink} href={claimSearchHref}>
            {t('claim.topAction')}
          </MuiLink>
        </Typography>

        {/* The anchor the closing claim prompt jumps back to. Same clearance
            the shell gives every other anchored block, so the fixed header does
            not land on top of the search field. */}
        <PageCard
          id="gym-directory-search"
          sx={{
            mb: 2,
            '& form': { mb: 1.5 },
            scrollMarginTop: 'calc(var(--global-header-height) + var(--spacing-4))',
          }}
        >
          <GymDirectorySearchForm facet={facet} query={query} locale={locale} focusSearch={focusSearch}>
            {/* Inside the form on purpose: layout, size and angle are
                checkboxes, and a closed <details> still submits them, so one
                "Show gyms" applies the text, the place and the wall together. */}
            <GymDirectoryFilters
              facet={facet}
              query={query}
              t={t}
              facetCounts={facetCounts}
              locale={locale}
              visibilityFlags={visibilityFlags}
            />
          </GymDirectorySearchForm>
        </PageCard>

        {/* The map column and near-me mode wrap the results block rather than
            sitting above it: the map is a second COLUMN beside this list at
            960px and up, and near-me swaps the list out for its own. The list
            stays first in the DOM either way. */}
        <GymDirectoryNearMe
          visibilityFlags={visibilityFlags}
          key={buildFacetSwitchHref(facet, query)}
          selectedArea={origin ? { facet, query } : undefined}
          boardFilter={query}
          // Threaded through, not dropped: the search box keeps rendering what
          // was typed, so near-me has to keep applying it.
          searchQuery={query.query}
          locale={locale}
          browsePins={toMapPins(visibleGyms)}
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

          {visibleGyms.length === 0 ? (
            /* A legitimate 200 on page one, so it gets a designed answer rather
               than two bare lines: the card surface, a muted glyph, and two ways
               out. Each action only renders when it would actually change the
               query — on a bare `/gyms` there is nothing to clear and nothing
               wider to browse. */
            <StatePanel
              tone="brand"
              icon={<SearchOutlined />}
              title={t('results.emptyTitle')}
              body={t('results.emptyBody')}
              actions={
                <>
                  <Button variant="contained" component={LocaleLink} href="/gyms/new" startIcon={<AddOutlined />}>
                    {t('create.action')}
                  </Button>
                  {query.query.length > 0 && (
                    <Button variant="outlined" component={LocaleLink} href={FACET_BASE_PATHS[facet]}>
                      {t('results.emptyClearSearch')}
                    </Button>
                  )}
                  {(facet !== 'all' || query.boardTypes.length > 0) && (
                    <Button variant="contained" color="primaryFill" component={LocaleLink} href={FACET_BASE_PATHS.all}>
                      {t('results.emptyBrowseAll')}
                    </Button>
                  )}
                </>
              }
            />
          ) : (
            <Box
              component="ul"
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: 0,
                m: 0,
                p: 0,
              }}
            >
              {visibleGyms.map((gym) => (
                <GymDirectoryCard key={gym.uuid} gym={gym} origin={origin} locale={locale} />
              ))}
            </Box>
          )}

          <GymDirectoryPagination facet={facet} query={query} totalCount={pageResult.totalCount} />
        </GymDirectoryNearMe>
        <Box sx={{ mt: 3 }}>
          <MuiLink component={LocaleLink} href="/gyms/new">
            {t('create.notListed')}
          </MuiLink>
        </Box>

        {/* ONE claim prompt for the page, below the list. It used to sit on
            every unclaimed row, so the page said "Is this your gym?" 24 times
            and the phrase read as a defect on each listing instead of an offer
            to one owner. Suppressed on an empty page: there is nothing to
            claim, and the search that found nothing is the thing to fix. */}
        {visibleGyms.length > 0 && (
          <Box component="section" sx={{ mt: 4 }}>
            <GymDirectoryClaimLink viewerState={viewerState} />
          </Box>
        )}

        {/* On every directory page, results or not (#6027): someone who found
            their gym here needs the app to do anything at its boards, and
            someone whose search came up empty still has a board at home. The
            gym's own page carries the per-gym link; this one is the directory's. */}
        <Box component="section" sx={{ mt: 5 }}>
          <Typography
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 0.5 }}
          >
            {t('install.heading')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
            {t('install.body')}
          </Typography>
          <StoreInstallButtons placement="gyms-directory" labels={storeButtonLabels} align="start" />
        </Box>

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
                  sx={{ color: 'var(--color-primary)', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
                >
                  {facetLinkLabel(t, candidate)}
                </MuiLink>
              </Box>
            ))}
          </Box>
        </Box>
      </PageShell>
    </I18nProvider>
  );
}

/**
 * Home > Gyms, as real anchors.
 *
 * Both crumbs are passed in already resolved, and both `t()` call sites that
 * produce them are literal keys — a computed `t(crumb)` is a hard lint failure
 * and would hide the two catalog entries from the orphan checker.
 */
function DirectoryBreadcrumb({
  facet,
  homeLabel,
  gymsLabel,
}: {
  facet: DirectoryFacet;
  homeLabel: string;
  gymsLabel: string;
}) {
  return (
    <Box component="nav" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <MuiLink component={LocaleLink} href="/" underline="hover" sx={{ color: 'var(--color-primary)' }}>
        {homeLabel}
      </MuiLink>
      <Box component="span" aria-hidden="true" sx={{ color: 'var(--neutral-400)' }}>
        ›
      </Box>
      {facet === 'all' ? (
        <Box component="span" aria-current="page">
          {gymsLabel}
        </Box>
      ) : (
        <MuiLink
          component={LocaleLink}
          href={FACET_BASE_PATHS.all}
          underline="hover"
          sx={{ color: 'var(--color-primary)' }}
        >
          {gymsLabel}
        </MuiLink>
      )}
    </Box>
  );
}

/**
 * The empty and the outage panel, which are the same object with a different
 * glyph tone: a card surface, a ringed glyph, one line of what happened, and
 * the ways out. Neither branch had a design before — zero results rendered two
 * bare lines and a failed fetch rendered three.
 */
// Re-exported so the four route files import their whole contract from one
// module. `BOARD_FACETS` is the list #4381's sitemap will enumerate.
export { BOARD_FACETS, FACET_BASE_PATHS };
