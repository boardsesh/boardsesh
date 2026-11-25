import { useSegments } from 'expo-router';
import { gymPageStackForSegments, type GymPageStack } from './gym-page-route';

/**
 * The stack the calling screen stands in, for the gym route builders
 * (`gymPageHref`, `gymMapHref`, `gymEditHref`, `gymAnalyticsHref`): a screen
 * registered in both stacks pushes into the one it is in.
 */
export function useGymRouteStack(): GymPageStack {
  return gymPageStackForSegments(useSegments());
}
