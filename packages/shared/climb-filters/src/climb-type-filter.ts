import { DEFAULT_CLIMB_FILTER_STATE, climbTypeSelection, type ClimbFilterState } from './filter-state';

/**
 * "Climb type" as one single-select over the boulders/routes flags: boulders
 * only, routes only, or both. Both-off reads as "both" (no frames_count
 * constraint), and no control can produce it. One derivation, shared by every
 * chip row and filter sheet, so two controls can never show a different pick.
 */
export const CLIMB_TYPE_VALUES = ['boulders', 'routes', 'both'] as const;
export type ClimbTypeFilter = (typeof CLIMB_TYPE_VALUES)[number];

/**
 * Reads the current climb type out of the boulders/routes flags. An unset flag
 * reads as `defaults`' value: the Climbs list's (boulders only) unless a list
 * with other defaults (a playlist, both on) passes its own.
 */
export function getClimbTypeFilter(
  filters: Pick<ClimbFilterState, 'boulders' | 'routes'>,
  defaults: Pick<ClimbFilterState, 'boulders' | 'routes'> = DEFAULT_CLIMB_FILTER_STATE,
): ClimbTypeFilter {
  const [bouldersOn, routesOn] = climbTypeSelection(filters, defaults);
  if (bouldersOn && !routesOn) return 'boulders';
  if (!bouldersOn && routesOn) return 'routes';
  return 'both';
}

/** The flags that select one climb type. Both are always written, so an unset flag never reads as a default. */
export function climbTypePatch(value: ClimbTypeFilter): Pick<ClimbFilterState, 'boulders' | 'routes'> {
  switch (value) {
    case 'routes':
      return { boulders: false, routes: true };
    case 'both':
      return { boulders: true, routes: true };
    case 'boulders':
      return { boulders: true, routes: false };
  }
}
