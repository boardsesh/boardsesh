import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import { getServerTranslation, getServerTranslationForLocale } from '@/app/lib/i18n/server';
import type { Locale, SeedNamespace } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection } from '@/app/components/ui/page-shell';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { fetchFacetCounts } from '@/app/gyms/directory-data';
import { DIRECTORY_FACETS, FACET_BASE_PATHS } from '@/app/gyms/directory-facets';
import { facetChipLabel } from '@/app/gyms/directory-copy';

// The search is the only action in this home-page region, so it is the region's
// one filled violet button; the facet chips and the directory link stay grey and
// violet text respectively. 48px to sit level with the text field beside it.
const SEARCH_SX = { ...brandCtaSx({ size: 'medium' }), minHeight: 48 };

export default async function HomeGymSearch({ locale: explicitLocale }: { locale?: Locale } = {}) {
  const translate = (namespace: SeedNamespace) =>
    explicitLocale ? getServerTranslationForLocale(explicitLocale, namespace) : getServerTranslation(namespace);
  const loadDirectoryCopy = async () => {
    const { t: website } = await (explicitLocale
      ? getServerTranslationForLocale(explicitLocale, 'website')
      : getServerTranslation('website'));
    return {
      searchLabel: website('directorySearchLabel'),
      search: website('directorySearch'),
      browse: website('browseDirectory'),
    };
  };
  const [{ t, locale }, countsResult, { t: gyms }, directoryCopy] = await Promise.all([
    translate('marketing'),
    fetchFacetCounts(),
    translate('gyms'),
    loadDirectoryCopy(),
  ]);
  const format = new Intl.NumberFormat(locale);
  const counts = countsResult.ok ? countsResult.counts : null;
  return (
    <PageSection
      id="gyms"
      title={t('home.gymSearch.title')}
      lead={
        counts
          ? t('home.gymSearch.lead', { count: counts.all, formattedCount: format.format(counts.all) })
          : t('home.gymSearch.leadNoCount')
      }
    >
      <Box
        component="form"
        method="get"
        action={localeHref('/gyms', locale)}
        role="search"
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, my: 3 }}
      >
        <TextField
          name="q"
          label={directoryCopy.searchLabel}
          placeholder={directoryCopy.search}
          sx={{ flex: '1 1 240px' }}
        />
        <Button type="submit" variant="contained" sx={SEARCH_SX}>
          {directoryCopy.search}
        </Button>
      </Box>
      {counts ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 3 }}>
          {DIRECTORY_FACETS.filter((facet) => counts[facet] > 0).map((facet) => (
            <Chip
              key={facet}
              component={LocaleLink}
              clickable
              href={FACET_BASE_PATHS[facet]}
              label={facetChipLabel(gyms, facet, counts, (count) => format.format(count))}
              variant="outlined"
              sx={{ minHeight: 44, borderColor: 'var(--control-border)' }}
            />
          ))}
        </Box>
      ) : null}
      <MuiLink
        component={LocaleLink}
        href="/gyms"
        underline="hover"
        sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
      >
        {directoryCopy.browse}
      </MuiLink>
    </PageSection>
  );
}
