import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { FACET_BASE_PATHS, type DirectoryFacet, type DirectoryQuery } from './directory-facets';

type GymDirectorySearchFormProps = {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  locale: Locale;
};

/**
 * A plain `method="get"` form, no JavaScript involved.
 *
 * Submitting navigates to `?q=…` on the same route, which is what makes the
 * search server-renderable, shareable as a URL, and usable before hydration.
 * The client island that reports `Gym Directory Searched` reads the RESULT of
 * that navigation, so the event carries a real `resultsCount` instead of a
 * guess made at submit time.
 *
 * The action carries the locale prefix by hand: `LocaleLink` can't help a form,
 * and a bare `/gyms` action would bounce a `/de/gyms` visitor to English.
 */
export default async function GymDirectorySearchForm({ facet, query, locale }: GymDirectorySearchFormProps) {
  const { t } = await getServerTranslation('gyms');

  return (
    <Box
      component="form"
      method="get"
      action={localeHref(FACET_BASE_PATHS[facet], locale)}
      role="search"
      sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 3 }}
    >
      <TextField
        name="q"
        type="search"
        size="small"
        defaultValue={query.query}
        label={t('search.label')}
        placeholder={t('search.placeholder')}
        sx={{ flex: '1 1 260px', minWidth: 0 }}
      />
      {/* A new search starts at page 1, so `page` is deliberately not carried
          over. Location is: it's how the visitor got here. */}
      {facet === 'all' &&
        query.boardTypes.map((boardType) => <input key={boardType} type="hidden" name="boardType" value={boardType} />)}
      {query.latitude !== null && query.longitude !== null && (
        <>
          <input type="hidden" name="lat" value={String(query.latitude)} />
          <input type="hidden" name="lng" value={String(query.longitude)} />
        </>
      )}
      {query.radiusKm !== null && <input type="hidden" name="radius" value={String(query.radiusKm)} />}
      <Button type="submit" variant="contained" sx={{ textTransform: 'none' }}>
        {t('search.submit')}
      </Button>
    </Box>
  );
}
