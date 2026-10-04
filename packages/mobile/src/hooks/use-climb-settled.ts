import { useDeferredAfterInteractions } from './use-deferred-after-interactions';
import { useClimbDwell } from '../lib/graphql/hooks/use-following-climb-logs';

/**
 * The gate for a per-climb request made from the open play drawer: true once
 * the drawer's open animation has settled (`active` is "the drawer is open")
 * and the climber has stayed on this climb for the dwell window.
 *
 * Its own file, outside the GraphQL hooks barrel, because the interaction
 * defer imports `react-native` and the barrel has to stay loadable without it.
 */
export function useClimbSettled(active: boolean, climbUuid: string): boolean {
  const settled = useDeferredAfterInteractions(active, climbUuid);
  const dwelled = useClimbDwell(climbUuid);
  return settled && dwelled;
}
