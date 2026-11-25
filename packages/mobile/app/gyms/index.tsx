import { GymFinderMapScreen } from '../../src/components/gym-directory/GymFinderMapScreen';

/**
 * The gym map on the root stack (Home's Gyms near you, Gyms you run): a
 * full-screen map with one draggable panel over it. The board picker's copy,
 * `app/boards/gyms.tsx`, draws the same finder (`useGymFinder`) as a map card
 * over the list, because a draggable panel inside the picker's sheet would be a
 * sheet on a sheet (docs/mobile/mobile-sheets-vs-routes.md). Each route file
 * names its own shell, so the shell never changes while it is mounted.
 */
export default function GymDiscovery() {
  return <GymFinderMapScreen />;
}
