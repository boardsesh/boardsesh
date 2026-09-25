import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageCard, sectionHeadingTypeClassName } from '@/app/components/ui/page-shell';
import { filterChipSx } from '@/app/components/ui/filter-chip';
import { getServerTranslation } from '@/app/lib/i18n/server';
import {
  DIRECTORY_FACETS,
  FACET_BASE_PATHS,
  type DirectoryFacet,
  type DirectoryQuery,
} from '@/app/gyms/directory-facets';
import { facetChipLabel } from '@/app/gyms/directory-copy';
import { fetchFacetCounts } from '@/app/gyms/directory-data';
import GymDirectorySearchForm from '@/app/gyms/gym-directory-search-form';
import { themeTokens } from '@/app/theme/theme-config';
import HomeGymSearchNearMe from './home-gym-search-near-me';
import styles from './home-gym-search.module.css';

/** The form renders empty on the homepage — there is nothing to carry over. */
const EMPTY_FORM_QUERY: DirectoryQuery = {
  query: '',
  boardTypes: [],
  latitude: null,
  longitude: null,
  radiusKm: null,
  page: 1,
};

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
 * The search box is a server-rendered GET form pointed at `/gyms`. Town
 * suggestions enhance it after hydration; gym-name searches work without JS.
 *
 * FAIL SOFT. `fetchFacetCounts` reports failure rather than throwing, and it
 * failing may not take the homepage with it: the heading, the intro, the search
 * form and the `/gyms` anchor render no matter what the gym backend is doing. A
 * dead backend costs the counts, nothing else.
 *
 * It used to render four gym cards too — a second copy of the directory's own
 * row, on a page that already links to the directory twice. The cards went with
 * the marketing trim; this block now sells the directory instead of previewing
 * it, and `/gyms` is the one place that renders gym rows.
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

  // Swallows its own failure, so the block renders with or without counts.
  const facetCountsResult = await fetchFacetCounts();

  const numberFormat = new Intl.NumberFormat(locale);
  const formatNumber = (value: number) => numberFormat.format(value);

  const facetCounts = facetCountsResult.ok ? facetCountsResult.counts : null;

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
            fontSize: themeTokens.typography.fontSize.sm,
            fontWeight: themeTokens.typography.fontWeight.semibold,
            letterSpacing: '0.06em',
          }}
        >
          {t('home.gymSearch.eyebrow')}
        </Typography>

        <Typography variant="h3" component="h2" className={sectionHeadingTypeClassName}>
          {t('home.gymSearch.title')}
        </Typography>

        <Typography variant="body1" color="text.secondary" sx={{ mt: 1.5, mb: 3, maxWidth: '60ch' }}>
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
        <Box className={styles.locator}>
          <Box className={styles.controls}>
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
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ flexBasis: '100%', fontSize: 14, lineHeight: 1.5 }}
              >
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
                    // Never selected here: these chips LEAVE the homepage for a
                    // facet route rather than filtering in place, so there is no
                    // current facet to mark.
                    sx={filterChipSx()}
                  />
                ))}
              </Box>
            )}
          </Box>
        </Box>
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
              minHeight: 44,
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
