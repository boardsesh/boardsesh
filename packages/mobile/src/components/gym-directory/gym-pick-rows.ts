// The rows of the add-a-board flow's "Which gym?" step (`GymStep`): gyms to
// choose from, not boards to activate, so a row is one tap with nothing to
// expand. Towns suggested for the search text come first, as a "Places"
// section, and the location prompt stands in for the gyms while there is
// nowhere to look. Pure, so every lookup state is a table test. "Add my gym"
// is not a row: `MapCardList` pins it under the list.
//
// Duplicate listings are not folded: each row shows its street so two listings
// of the same name can be told apart, and the data is cleaned at the source.

import type { Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import type { Coords } from '../../lib/use-device-location';
import type { LookupState } from '../../lib/boards/find-wall-state';
import { formatDistance } from '../board-discovery/use-board-item-copy';
import { groupedCellPosition, type GroupedCellPosition } from '../gym-page/gym-page-view-model';

export type GymPickRow =
  | { kind: 'sectionHeader'; key: string; label: string }
  | { kind: 'loading'; key: string }
  | {
      kind: 'empty';
      key: string;
      label: string;
      /** A "Try again" under the notice (a lookup that failed). */
      retryLabel?: string;
    }
  | {
      kind: 'pickGym';
      key: string;
      gym: Gym;
      /** "1.2 km · Street 1", the distance or the address alone, or null with neither. */
      subtitle: string | null;
      /** "3 boards" or "No boards yet". */
      boardsLabel: string;
      position: GroupedCellPosition;
      selected: boolean;
    }
  /** A town suggested for the search text: one slice of the "Places" card. */
  | { kind: 'place'; key: string; place: PlaceSuggestion; label: string; position: GroupedCellPosition }
  /** The gazetteer's credit under the suggested towns. */
  | { kind: 'placesAttribution'; key: string; label: string }
  /** Nowhere to look yet: the location prompt in place of the gyms. */
  | { kind: 'locationPrompt'; key: string };

export type GymPickLabels = {
  /** The section title over the gyms ("Gyms near you"). */
  section: string;
  /** No gym matched (nothing here, or nothing by that name). */
  empty: string;
  offline: string;
  failed: string;
  /** The action under a failed lookup. */
  retry: string;
  boardCount: (count: number) => string;
  noBoards: string;
};

/** The towns suggested for the search text, listed above the gyms. */
export type GymPickPlaces = {
  suggestions: readonly PlaceSuggestion[];
  /** The section title ("Places"). */
  label: string;
  /** The gazetteer's credit ("City data: GeoNames"), or null where the field already shows it (the browser). */
  attribution: string | null;
};

type BuildGymPickRowsArgs = {
  gyms: readonly Gym[];
  /** The gym lookup's state (`lookupState`). Rows already listed stay through a refetch. */
  lookup: LookupState;
  /**
   * The climber's own position. A distance is only shown from here: a distance
   * from a searched town would read as a distance from the climber.
   */
  origin: Coords | null;
  /** The gym whose pin was tapped. */
  selectedId: string | null;
  labels: GymPickLabels;
  /** Towns for the search text: a "Places" section first, when there are any. */
  places?: GymPickPlaces;
  /** Nowhere to look yet: the location prompt stands in for the gyms. */
  locationPrompt?: boolean;
};

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres (haversine). */
export function distanceBetweenMeters(from: Coords, to: Coords): number {
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const halfChord =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(halfChord)));
}

/**
 * "1.2 km · Fokkerweg 75": the distance when the climber's position is known,
 * then the address. Null with neither: the row leaves the line out.
 */
export function gymPickSubtitle(gym: Gym, origin: Coords | null): string | null {
  const hasCoordinates = Number.isFinite(gym.latitude) && Number.isFinite(gym.longitude);
  const distance =
    origin && hasCoordinates
      ? formatDistance(
          distanceBetweenMeters(origin, { latitude: gym.latitude as number, longitude: gym.longitude as number }),
        )
      : null;
  const address = gym.address?.trim() || null;
  const parts = [distance, address].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function placeRows(places: GymPickPlaces | undefined): GymPickRow[] {
  if (!places || places.suggestions.length === 0) return [];
  const { suggestions } = places;
  const rows: GymPickRow[] = [
    { kind: 'sectionHeader', key: 'sh:places', label: places.label },
    ...suggestions.map((place, index): GymPickRow => ({
      kind: 'place',
      key: `place:${place.id}`,
      place,
      label: placeSuggestionLabel(place),
      position: groupedCellPosition(index, suggestions.length),
    })),
  ];
  if (places.attribution)
    rows.push({ kind: 'placesAttribution', key: 'places-attribution', label: places.attribution });
  return rows;
}

export function buildGymPickRows({
  gyms,
  lookup,
  origin,
  selectedId,
  labels,
  places,
  locationPrompt = false,
}: BuildGymPickRowsArgs): GymPickRow[] {
  const rows = placeRows(places);
  if (locationPrompt) {
    rows.push({ kind: 'locationPrompt', key: 'location-prompt' });
    return rows;
  }
  if (lookup === 'idle') return rows;
  rows.push({ kind: 'sectionHeader', key: 'sh:gyms', label: labels.section });

  switch (lookup) {
    case 'loading':
      rows.push({ kind: 'loading', key: 'loading' });
      break;
    case 'offline':
      rows.push({ kind: 'empty', key: 'offline', label: labels.offline });
      break;
    case 'failed':
      rows.push({ kind: 'empty', key: 'failed', label: labels.failed, retryLabel: labels.retry });
      break;
    case 'empty':
      rows.push({ kind: 'empty', key: 'empty', label: labels.empty });
      break;
    case 'listed':
      gyms.forEach((gym, index) => {
        rows.push({
          kind: 'pickGym',
          key: `gym:${gym.uuid}`,
          gym,
          subtitle: gymPickSubtitle(gym, origin),
          boardsLabel: gym.boardCount > 0 ? labels.boardCount(gym.boardCount) : labels.noBoards,
          position: groupedCellPosition(index, gyms.length),
          selected: selectedId === gym.uuid,
        });
      });
      break;
  }
  return rows;
}
