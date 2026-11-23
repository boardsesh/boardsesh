'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import { isPlaceSearchQuery, PLACE_SEARCH_DEBOUNCE_MS, placeSuggestionLabel } from '@boardsesh/gym-filters';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { buildDirectoryHref, FACET_BASE_PATHS, type DirectoryFacet, type DirectoryQuery } from './directory-facets';

/** Serializable route and copy overrides for another public directory. */
export type DirectorySearchAdapter = {
  basePath: string;
  /** Carries the directory's active filters when a suggested town is selected. */
  selectedPlaceBaseHref: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchSubmit: string;
  placeHint?: string;
  placeEmpty?: string;
  placeError?: string;
  inputId?: string;
  placeRadiusKm?: number;
};

export default function GymPlaceSearch({
  facet = 'all',
  query,
  locale,
  children,
  actions,
  focusSearch = false,
  directory,
}: {
  facet?: DirectoryFacet;
  query: DirectoryQuery;
  locale: Locale;
  focusSearch?: boolean;
  directory?: DirectorySearchAdapter;
  /** Secondary controls in the submit row; they must use type="button". */
  actions?: React.ReactNode;
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
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) searchInput.current?.focus();
  }, [focusSearch]);
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
    if (!edited || !isPlaceSearchQuery(trimmed)) return;
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
    }, PLACE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, edited]);

  const selectPlace = (place: PlaceSuggestion) => {
    if (directory) {
      const href = new URL(directory.selectedPlaceBaseHref, 'https://www.boardsesh.com');
      href.searchParams.delete('q');
      href.searchParams.delete('page');
      href.searchParams.set('place', placeSuggestionLabel(place));
      href.searchParams.set('lat', String(place.latitude));
      href.searchParams.set('lng', String(place.longitude));
      href.searchParams.set('radius', String(directory.placeRadiusKm ?? 50));
      router.push(localeHref(`${href.pathname}?${href.searchParams.toString()}`, locale));
      return;
    }
    router.push(
      localeHref(
        buildDirectoryHref(
          facet,
          {
            ...query,
            query: '',
            place: placeSuggestionLabel(place),
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
      action={localeHref(directory?.basePath ?? FACET_BASE_PATHS[facet], locale)}
      role="search"
      sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 3 }}
    >
      <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
        <Autocomplete<PlaceSuggestion, false, false, true>
          id={directory?.inputId ?? 'gym-directory-query'}
          freeSolo
          options={suggestions}
          filterOptions={(options) => options}
          getOptionLabel={(option) => (typeof option === 'string' ? option : placeSuggestionLabel(option))}
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
            setStatus(isPlaceSearchQuery(next) ? 'loading' : 'idle');
          }}
          onChange={(_event, next) => {
            if (next && typeof next !== 'string') selectPlace(next);
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              autoFocus={focusSearch}
              inputRef={searchInput}
              name={selectedPlace ? undefined : 'q'}
              type="search"
              size="small"
              label={directory?.searchLabel ?? t('search.label')}
              placeholder={directory?.searchPlaceholder ?? t('search.placeholder')}
              sx={{ '& .MuiInputBase-root': { minHeight: 44, fontSize: 16 } }}
            />
          )}
        />
        <Typography variant="caption" color="text.secondary" aria-live="polite" sx={{ display: 'block', mt: 0.5 }}>
          {status === 'loading'
            ? t('places.loading')
            : status === 'error'
              ? (directory?.placeError ?? t('places.error'))
              : status === 'ready' && suggestions.length === 0
                ? (directory?.placeEmpty ?? t('places.empty'))
                : (directory?.placeHint ?? t('places.hint'))}
        </Typography>
        <MuiLink href="https://www.geonames.org/" target="_blank" rel="noreferrer" variant="caption">
          {t('places.attribution')}
        </MuiLink>
      </Box>
      {/* The board TYPE rides the text search as hidden inputs, or typing a town
          would wipe the board the visitor just picked. It needs them because the
          board-type row is anchors, so the form has no control of its own for it.

          Layout, size and angle deliberately get NO hidden inputs: the filter
          panel renders them as real checkboxes inside this same form, so a
          hidden twin would submit alongside an UNCHECKED box and make the filter
          impossible to remove. Facet routes carry their board type in the path. */}
      {!directory &&
        facet === 'all' &&
        query.boardTypes.map((boardType) => <input key={boardType} type="hidden" name="boardType" value={boardType} />)}
      {/* Claim mode survives a search: the results keep their Claim buttons. */}
      {!directory && query.claimMode && <input type="hidden" name="claim" value="1" />}
      {keepOrigin && (
        <>
          <input type="hidden" name="lat" value={String(query.latitude)} />
          <input type="hidden" name="lng" value={String(query.longitude)} />
          {query.radiusKm !== null && <input type="hidden" name="radius" value={String(query.radiusKm)} />}
          {selectedPlace && <input type="hidden" name="place" value={query.place} />}
        </>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button type="submit" variant="contained" sx={{ textTransform: 'none', minHeight: 44, fontSize: 16 }}>
          {directory?.searchSubmit ?? t('search.submit')}
        </Button>
        {actions}
      </Box>
      {/* Full-width below the search row, so the filter tiers get the measure
          they need while the text field and its button stay on one line. */}
      <Box sx={{ flex: '1 1 100%', minWidth: 0, width: '100%', maxWidth: '100%' }}>{children}</Box>
    </Box>
  );
}
