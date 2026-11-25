// Town and city suggestions for a gym search field, from our own gazetteer
// (`searchPlaces`, GeoNames data). Needs no location permission, so "search a
// town" works for a climber who said no to location. Shared by the browser and
// native search fields.

import { useEffect, useState } from 'react';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { SEARCH_PLACES, type SearchPlacesQueryResponse } from '@boardsesh/graphql/operations';
import { isPlaceSearchQuery, PLACE_SEARCH_DEBOUNCE_MS } from '@boardsesh/gym-filters';
import { getHttpClient } from './graphql/client';

/** Suggestions shown at most; the gazetteer ranks them. */
export const PLACE_SUGGESTION_LIMIT = 5;

type PlaceLookup = {
  query: string;
  status: 'ready' | 'error';
  suggestions: readonly PlaceSuggestion[];
};

export type PlaceSuggestions = {
  /** The text is a lookup the endpoint takes (3 to 80 characters) and no place is chosen yet. */
  canSearch: boolean;
  /** The answer for the current text, or null while it is on its way (or there is none to wait for). */
  lookup: PlaceLookup | null;
  suggestions: readonly PlaceSuggestion[];
};

const NO_SUGGESTIONS: readonly PlaceSuggestion[] = [];

/**
 * Looks the field's text up once it has been still for `PLACE_SEARCH_DEBOUNCE_MS`.
 * A chosen place stops the lookups (its label is in the field, not a query). An
 * answer for older text is never shown against newer text.
 */
export function usePlaceSuggestions(text: string, hasSelectedPlace: boolean): PlaceSuggestions {
  const [lookup, setLookup] = useState<PlaceLookup | null>(null);
  const query = text.trim();
  const canSearch = !hasSelectedPlace && isPlaceSearchQuery(query);

  useEffect(() => {
    if (!canSearch) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await getHttpClient().request<SearchPlacesQueryResponse>({
          document: SEARCH_PLACES,
          variables: { query },
          signal: controller.signal,
        });
        if (!controller.signal.aborted)
          setLookup({ query, status: 'ready', suggestions: response.searchPlaces.slice(0, PLACE_SUGGESTION_LIMIT) });
      } catch {
        if (!controller.signal.aborted) setLookup({ query, status: 'error', suggestions: NO_SUGGESTIONS });
      }
    }, PLACE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canSearch, query]);

  const current = canSearch && lookup?.query === query ? lookup : null;
  return { canSearch, lookup: current, suggestions: current?.suggestions ?? NO_SUGGESTIONS };
}
