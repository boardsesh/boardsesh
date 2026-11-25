// The gym map inside the board picker's modal stack, so Near you's Map ›, In
// range's Search gyms and Manage boards' + push it on top of the picker with a
// back chevron. The root copy pushed from inside the picker would be presented
// as a second sheet (docs/mobile/mobile-sheets-vs-routes.md, "Same-navigator
// modal inheritance"). It draws the map card over the list, not the root
// copy's full-screen map with its draggable panel: the same finder
// (`useGymFinder`) in the frame that fits inside a sheet.
import { GymFinderCardScreen } from '../../src/components/gym-directory/GymFinderCardScreen';

export default function BoardsGymMap() {
  return <GymFinderCardScreen />;
}
