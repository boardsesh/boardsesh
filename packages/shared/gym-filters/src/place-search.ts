import type { PlaceSuggestion } from '@boardsesh/shared-schema';

export const PLACE_SEARCH_DEBOUNCE_MS = 300;

/** The public searchPlaces endpoint accepts 3–80 trimmed characters. */
export function isPlaceSearchQuery(query: string): boolean {
  const length = query.trim().length;
  return length >= 3 && length <= 80;
}

export function placeSuggestionLabel(place: PlaceSuggestion): string {
  return [...new Set([place.name, place.region, place.country].filter(Boolean))].join(', ');
}
