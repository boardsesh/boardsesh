import { createContext, useContext } from 'react';
import type { GymPageStack } from './gym-page-route';

/**
 * The stack a screen is registered in. `app/boards/_layout.tsx` provides
 * `boards` around the board picker's own `<Stack>`; everywhere else reads the
 * default, `root`.
 *
 * Not `useSegments()`: that is the FOCUSED route, not the one a screen is
 * mounted in. The root gym map under a Boards modal would read `boards` and
 * swap its shell (remounting the map and losing its state), and the picker's
 * copy would read `root` while something above it is focused.
 */
export const GymRouteStackContext = createContext<GymPageStack>('root');

/**
 * The stack the calling screen stands in, for the gym route builders
 * (`gymPageHref`, `gymMapHref`, `gymEditHref`, `gymAnalyticsHref`) and the
 * other screens with a copy in both stacks: a screen registered in both pushes
 * into the one it is in.
 */
export function useGymRouteStack(): GymPageStack {
  return useContext(GymRouteStackContext);
}
