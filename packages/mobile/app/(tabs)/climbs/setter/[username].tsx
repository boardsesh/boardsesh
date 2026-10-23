import { SetterPlaylistScreen } from '../../../../src/components/SetterPlaylistScreen';

// A setter's list pushed inside the Climbs tab: from search, the setter's name in
// the player and Home's "See all". Discover has its own copy of this route for For
// You, so Back from there stays in Discover.
export default function ClimbsSetterPlaylist() {
  return <SetterPlaylistScreen tab="climbs" />;
}
