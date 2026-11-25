import { GymFinderCardScreen } from '../../src/components/gym-directory/GymFinderCardScreen';
import { GymFinderMapScreen } from '../../src/components/gym-directory/GymFinderMapScreen';
import { useGymRouteStack } from '../../src/components/gym-page/use-gym-route-stack';

/**
 * The gym map. Registered on the root stack here and re-exported in the board
 * picker's stack (`app/boards/gyms.tsx`). The same finder (`useGymFinder`) in
 * two frames: on the root stack a full-screen map with one draggable panel
 * over it; inside the picker's sheet a map card over the list, because a
 * draggable panel there would be a sheet on a sheet
 * (docs/mobile/mobile-sheets-vs-routes.md).
 */
export default function GymDiscovery() {
  return useGymRouteStack() === 'boards' ? <GymFinderCardScreen /> : <GymFinderMapScreen />;
}
