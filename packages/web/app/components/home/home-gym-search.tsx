import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection } from '@/app/components/ui/page-shell';
import { fetchFacetCounts } from '@/app/gyms/directory-data';
import { DIRECTORY_FACETS, FACET_BASE_PATHS } from '@/app/gyms/directory-facets';
import { facetChipLabel } from '@/app/gyms/directory-copy';

export default async function HomeGymSearch() {
  const [{ t, locale }, countsResult] = await Promise.all([getServerTranslation('marketing'), fetchFacetCounts()]);
  const { t: website } = await getServerTranslation('website');
  const { t: gyms } = await getServerTranslation('gyms');
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
          label={website('directorySearchLabel')}
          placeholder={website('directorySearch')}
          sx={{ flex: '1 1 240px' }}
        />
        <Button type="submit" variant="outlined" sx={{ minHeight: 48 }}>
          {website('directorySearch')}
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
        {website('browseDirectory')}
      </MuiLink>
    </PageSection>
  );
}
