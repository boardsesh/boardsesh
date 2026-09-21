// What the "At a gym" choice shows under itself in the first-board picker
// (#5654). Location is asked on the tap, not when the picker opens, so the
// question comes with a reason on screen. Every state leads somewhere: a list,
// the map, or Settings. None of them is a dead end that only looks tappable.

import type { LocationStatus } from '../use-device-location';

export type FirstBoardGymState =
  /** The choice has not been tapped. */
  | 'idle'
  /** Asking for location, getting a fix, or loading the boards around it. */
  | 'searching'
  /** Boards within 20 km: the list shows under the choice. */
  | 'found'
  /** A fix, but nothing within 20 km: point to the map search. */
  | 'none_nearby'
  /**
   * A fix, but the lookup failed (dead gym wifi, a backend error after the
   * retries): say so, offer a retry and the map. Never "Nothing within 20 km",
   * which would tell a climber standing in a gym that it isn't there.
   */
  | 'nearby_error'
  /** Permission denied, or no fix at all: point to Settings and the map. */
  | 'location_off';

export function firstBoardGymState({
  chosen,
  locationStatus,
  nearbyLoading,
  nearbyFailed,
  nearbyCount,
}: {
  chosen: boolean;
  locationStatus: LocationStatus;
  /** A nearby request is in flight: the first load, or a retry after an error. */
  nearbyLoading: boolean;
  /** The last nearby request failed. */
  nearbyFailed: boolean;
  nearbyCount: number;
}): FirstBoardGymState {
  if (!chosen) return 'idle';
  // `unavailable` is mostly Location Services switched off for the whole phone:
  // the permission prompt answers "granted" and the fix then fails. To the
  // climber that is the same thing as a denial, so it reads the same.
  if (locationStatus === 'denied' || locationStatus === 'unavailable') return 'location_off';
  if (locationStatus !== 'granted') return 'searching';
  // Boards already on screen stay there through a refetch, failed or not.
  if (nearbyCount > 0) return 'found';
  if (nearbyLoading) return 'searching';
  return nearbyFailed ? 'nearby_error' : 'none_nearby';
}
