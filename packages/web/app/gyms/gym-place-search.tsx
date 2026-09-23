'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { SEARCH_PLACES, type SearchPlacesQueryResponse } from '@boardsesh/graphql/operations';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { buildDirectoryHref, FACET_BASE_PATHS, type DirectoryFacet, type DirectoryQuery } from './directory-facets';

function placeLabel(place: PlaceSuggestion): string {
  return [...new Set([place.name, place.region, place.country].filter(Boolean))].join(', ');
}

export default function GymPlaceSearch({
  facet,
  query,
  locale,
  children,
}: {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  locale: Locale;
  /**
   * The board filter panel, rendered INSIDE this form.
   *
   * It is a server component passed through as children rather than imported
   * here, which keeps the filter chips off the client bundle. Inside the form
   * because its checkboxes have to submit with the text and the place: one
   * "Show gyms" for the whole search, rather than a filter that silently
   * survives or dies depending on which button the visitor reached for.
   */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('gyms');
  const router = useRouter();
  const [input, setInput] = useState(query.place ?? query.query);
  const [edited, setEdited] = useState(false);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const selectedPlace = !edited && Boolean(query.place);
  // Preserve old coordinate + gym-name URLs until the visitor edits a selected
  // place. The selected place's label must never become a gym-name predicate.
  const keepOrigin = (!query.place || !edited) && query.latitude !== null && query.longitude !== null;

  useEffect(() => {
    const trimmed = input.trim();
    if (!edited || trimmed.length < 3 || trimmed.length > 80) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await createGraphQLHttpClient().request<SearchPlacesQueryResponse>({
          document: SEARCH_PLACES,
          variables: { query: trimmed },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setSuggestions(response.searchPlaces);
          setStatus('ready');
        }
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, edited]);

  const selectPlace = (place: PlaceSuggestion) => {
    router.push(
      localeHref(
        buildDirectoryHref(
          facet,
          {
            ...query,
            query: '',
            place: placeLabel(place),
            latitude: place.latitude,
            longitude: place.longitude,
            radiusKm: 50,
            page: 1,
          },
          1,
        ),
        locale,
      ),
    );
  };

  return (
    <Box
      component="form"
      method="get"
      action={localeHref(FACET_BASE_PATHS[facet], locale)}
      role="search"
      sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 3 }}
    >
      <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
        <Autocomplete<PlaceSuggestion, false, false, true>
          freeSolo
          options={suggestions}
          filterOptions={(options) => options}
          getOptionLabel={(option) => (typeof option === 'string' ? option : placeLabel(option))}
          getOptionKey={(option) => (typeof option === 'string' ? option : option.id)}
          inputValue={input}
          value={selectedPlace ? input : null}
          loading={status === 'loading'}
          loadingText={t('places.loading')}
          clearText={t('places.clear')}
          openText={t('places.open')}
          closeText={t('places.close')}
          onInputChange={(_event, next, reason) => {
            if (reason !== 'input' && reason !== 'clear') return;
            setEdited(true);
            setInput(next);
            setSuggestions([]);
            setStatus(next.trim().length >= 3 && next.trim().length <= 80 ? 'loading' : 'idle');
          }}
          onChange={(_event, next) => {
            if (next && typeof next !== 'string') selectPlace(next);
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              name={selectedPlace ? undefined : 'q'}
              type="search"
              size="small"
              label={t('search.label')}
              placeholder={t('search.placeholder')}
              sx={{ '& .MuiInputBase-root': { minHeight: 44, fontSize: 16 } }}
            />
          )}
        />
        <Typography variant="caption" color="text.secondary" aria-live="polite" sx={{ display: 'block', mt: 0.5 }}>
          {status === 'loading'
            ? t('places.loading')
            : status === 'error'
              ? t('places.error')
              : status === 'ready' && suggestions.length === 0
                ? t('places.empty')
                : t('places.hint')}
        </Typography>
        <MuiLink href="https://www.geonames.org/" target="_blank" rel="noreferrer" variant="caption">
          {t('places.attribution')}
        </MuiLink>
      </Box>
      {/* The board filter rides the text search as hidden inputs, or typing a
          town would wipe the wall the visitor just picked. Facet routes carry
          their board type in the path, so only the deeper tiers go along there. */}
      {facet === 'all' &&
        query.boardTypes.map((boardType) => <input key={boardType} type="hidden" name="boardType" value={boardType} />)}
      {(query.layoutIds ?? []).map((layoutId) => (
        <input key={`layout-${layoutId}`} type="hidden" name="layout" value={String(layoutId)} />
      ))}
      {(query.sizeIds ?? []).map((sizeId) => (
        <input key={`size-${sizeId}`} type="hidden" name="size" value={String(sizeId)} />
      ))}
      {(query.angles ?? []).map((angle) => (
        <input key={`angle-${angle}`} type="hidden" name="angle" value={String(angle)} />
      ))}
      {keepOrigin && (
        <>
          <input type="hidden" name="lat" value={String(query.latitude)} />
          <input type="hidden" name="lng" value={String(query.longitude)} />
          {query.radiusKm !== null && <input type="hidden" name="radius" value={String(query.radiusKm)} />}
          {selectedPlace && <input type="hidden" name="place" value={query.place} />}
        </>
      )}
      <Button type="submit" variant="contained" sx={{ textTransform: 'none', minHeight: 44, fontSize: 16 }}>
        {t('search.submit')}
      </Button>
      {/* Full-width below the search row, so the filter tiers get the measure
          they need while the text field and its button stay on one line. */}
      <Box sx={{ flexBasis: '100%' }}>{children}</Box>
    </Box>
  );
}
