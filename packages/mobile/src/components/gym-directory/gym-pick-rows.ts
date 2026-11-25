// The rows of the gym list in pick mode: the add-a-board flow's "Which gym?"
// step (`GymStep`). Gyms to choose from, not boards to activate, so a row is
// one tap with nothing to expand. Pure, so every lookup state is a table test.
// "Add my gym" is not a row: the panel pins it at the bottom of what is
// visible, so it is there at every detent.
//
// Duplicate listings are not folded: each row shows its street so two listings
// of the same name can be told apart, and the data is cleaned at the source.

import type { Gym } from '@boardsesh/shared-schema';
import type { Coords } from '../../lib/use-device-location';
import type { LookupState } from '../../lib/boards/find-wall-state';
import { formatDistance } from '../board-discovery/use-board-item-copy';
import { groupedCellPosition } from '../gym-page/gym-page-view-model';
import type { GymListRow } from './gym-list-rows';

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

export function buildGymPickRows({ gyms, lookup, origin, selectedId, labels }: BuildGymPickRowsArgs): GymListRow[] {
  if (lookup === 'idle') return [];
  const rows: GymListRow[] = [{ kind: 'sectionHeader', key: 'sh:gyms', label: labels.section }];

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
