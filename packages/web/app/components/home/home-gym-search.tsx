import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageCard } from '@/app/components/ui/page-shell';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerTranslation } from '@/app/lib/i18n/server';
import {
  DIRECTORY_FACETS,
  FACET_BASE_PATHS,
  type DirectoryFacet,
  type DirectoryQuery,
} from '@/app/gyms/directory-facets';
import { facetChipLabel } from '@/app/gyms/directory-copy';
import { fetchDirectoryPage, fetchFacetCounts } from '@/app/gyms/directory-data';
import GymDirectoryCard from '@/app/gyms/gym-directory-card';
import GymDirectorySearchForm from '@/app/gyms/gym-directory-search-form';
import { themeTokens } from '@/app/theme/theme-config';
import HomeGymSearchNearMe from './home-gym-search-near-me';

/** Gym cards the homepage teases. Four fits the mockup's row and one screen. */
const TEASER_CARD_COUNT = 4;

/**
 * An unfiltered homepage preview. Claimed-first ordering is requested separately
 * and applied by the backend before pagination. Query arguments keep its cache
 * entry separate from the directory's newest-first first page.
 */
const TEASER_QUERY: DirectoryQuery = {
  query: '',
  boardTypes: [],
  latitude: null,
  longitude: null,
  radiusKm: null,
  page: 1,
};

/** The form renders empty on the homepage — there is nothing to carry over. */
const EMPTY_FORM_QUERY = TEASER_QUERY;

/**
 * "Find a board near you" — the homepage's gym-directory block.
 *
 * A SERVER component, and that is the whole design. The heading, the copy, the
 * board-type links and every gym card's `<a href>` are in the first HTML
 * response, so this block does for search what the old "find a gym" link card
 * could not: it puts real gym names and real internal links on the highest-
 * traffic page on the site. The one client island is the geolocation button,
 * which cannot be anything else.
 *
 * The search box is a plain `method="get"` form pointed at `/gyms`. With
 * JavaScript off, or before hydration, typing a town and pressing enter still
 * lands on a real search result page.
 *
 * FAIL SOFT. `fetchDirectoryPage` and `fetchFacetCounts` both report failure
 * rather than throwing, and neither one failing may take the homepage with it:
 * the heading, the intro, the search form and the `/gyms` anchor render no
 * matter what the gym backend is doing. A dead backend costs the cards and the
 * counts, nothing else.
 *
 * Takes no props deliberately: it resolves its own locale and data, so wiring it
 * into the page is `<HomeGymSearch />` and nothing more. It is `async`, so it
 * has to be mounted from a server component (`app/page.tsx`), not from inside
 * the client `HomePageContent` — pass it down as a slot if it needs to sit
 * between two client-rendered blocks.
 */
export default async function HomeGymSearch() {
  const [{ t, locale }, { t: tGyms }] = await Promise.all([
    getServerTranslation('marketing'),
    getServerTranslation('gyms'),
  ]);

  // In parallel, and both already swallow their own failures. The session read
  // rides along rather than gating them: it only settles the claim call-out's
  // `viewerState`, and in series it would add a round trip in front of the
  // whole block.
  const [pageResult, facetCountsResult, distinctId] = await Promise.all([
    fetchDirectoryPage(TEASER_QUERY, { prioritizeClaimed: true, limit: TEASER_CARD_COUNT }),
    fetchFacetCounts(),
    getPosthogDistinctId(),
  ]);

  const numberFormat = new Intl.NumberFormat(locale);
  const formatNumber = (value: number) => numberFormat.format(value);
  // Settled server-side from the request's session, never with `useSession()`:
  // next-auth starts every page load at `loading`, so a claim click that beats
  // the round trip would report a signed-in climber as signed-out.
  const viewerState: GymClaimViewerState = distinctId !== null ? 'signed-in' : 'signed-out';

  const facetCounts = facetCountsResult.ok ? facetCountsResult.counts : null;
  const gyms = pageResult.ok ? pageResult.gyms.slice(0, TEASER_CARD_COUNT) : [];

  return (
    // Its own provider, so the block is self-contained: the reused directory
    // card and claim link read the `gyms` namespace, which the homepage does not
    // mount. A nested provider seeds from the enclosing one, so `marketing`
    // keeps resolving inside it.
    <I18nProvider locale={locale} namespaces={['marketing', 'gyms']}>
      <Box component="section" id="gyms" sx={{ scrollMarginTop: 'calc(var(--global-header-height) + 16px)' }}>
        <Typography
          variant="overline"
          component="p"
          sx={{
            color: 'var(--color-primary)',
            fontWeight: themeTokens.typography.fontWeight.semibold,
            letterSpacing: '0.06em',
          }}
        >
          {t('home.gymSearch.eyebrow')}
        </Typography>

        <Typography variant="h5" component="h2" fontWeight={themeTokens.typography.fontWeight.bold}>
          {t('home.gymSearch.title')}
        </Typography>

        <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 2, maxWidth: '68ch' }}>
          {/* The live catalogue size when we have it. When the count query is
              down we say the same thing without a number rather than printing a
              confident zero. */}
          {facetCounts === null
            ? t('home.gymSearch.leadNoCount')
            : t('home.gymSearch.lead', {
                count: facetCounts.all,
                formattedCount: formatNumber(facetCounts.all),
              })}
        </Typography>

        {/* The mockup's search panel: the text form and the location button on
            one row, with the fallback hint under them. `& form` un-does the
            directory form's own bottom margin so the row stays a row — the
            alternative was a second copy of that form with different spacing,
            which would drift within a release. */}
        <PageCard
          variant="surface"
          padding="sm"
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1.5,
            alignItems: 'flex-start',
            '& form': { mb: 0, flex: '1 1 320px' },
          }}
        >
          <GymDirectorySearchForm facet="all" query={EMPTY_FORM_QUERY} locale={locale} />
          <HomeGymSearchNearMe locale={locale} />
          <Typography variant="caption" color="text.secondary" sx={{ flexBasis: '100%' }}>
            {t('home.gymSearch.geoHint')}
          </Typography>
        </PageCard>

        {/* Facet chips point at the LITERAL routes, never at `?boardType=`:
            `/gyms/kilter` is a page with its own copy and its own canonical,
            and a query-string variant would self-canonicalise away and burn
            crawl budget. Hidden entirely when the counts are unavailable — a
            chip reading "Kilter · 0" is worse than no chip. */}
        {facetCounts !== null && (
          <Box
            sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2.5, mb: 3 }}
            role="group"
            aria-label={tGyms('facets.heading')}
          >
            {DIRECTORY_FACETS.map((facet: DirectoryFacet) => (
              <Chip
                key={facet}
                clickable
                component={LocaleLink}
                href={FACET_BASE_PATHS[facet]}
                label={facetChipLabel(tGyms, facet, facetCounts, formatNumber)}
                variant="outlined"
                // Both states spelled out: MUI's default outlined chip is a
                // barely-there hairline that loses the whole row on the
                // near-black page ground.
                sx={{
                  borderRadius: 'var(--border-radius-full)',
                  height: 36,
                  fontWeight: themeTokens.typography.fontWeight.semibold,
                  backgroundColor: 'var(--semantic-surface)',
                  borderColor: 'var(--separator)',
                  color: 'var(--neutral-900)',
                  '&:hover': {
                    backgroundColor: 'var(--semantic-surface-elevated)',
                    borderColor: 'var(--color-primary)',
                  },
                }}
              />
            ))}
          </Box>
        )}

        {gyms.length > 0 ? (
          <Box
            component="ul"
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
              gap: 2,
              m: 0,
              p: 0,
            }}
          >
            {gyms.map((gym) => (
              <GymDirectoryCard
                key={gym.uuid}
                gym={gym}
                // No origin on the homepage: nothing has told us where the
                // visitor is, and a distance computed from nowhere is a lie.
                // Cards therefore show an address or nothing at all.
                origin={null}
                viewerState={viewerState}
                locale={locale}
              />
            ))}
          </Box>
        ) : !pageResult.ok ? (
          /* A successful empty catalogue is not a backend outage. */
          <Typography variant="body2" color="text.secondary">
            {t('home.gymSearch.cardsUnavailable')}
          </Typography>
        ) : null}

        {/* The crawlable `/gyms` anchor. It survives every failure above on
            purpose: whatever else this block cannot show, it always hands both
            a climber and a crawler the way into the directory. */}
        <Box sx={{ mt: 3 }}>
          <MuiLink
            component={LocaleLink}
            href={FACET_BASE_PATHS.all}
            underline="hover"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'var(--color-primary)',
              fontWeight: themeTokens.typography.fontWeight.semibold,
            }}
          >
            {t('home.gymSearch.browseAll')}
            <ArrowForwardOutlined sx={{ fontSize: themeTokens.typography.fontSize.base }} />
          </MuiLink>
        </Box>
      </Box>
    </I18nProvider>
  );
}
