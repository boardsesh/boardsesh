import { SetterPlaylistScreen } from '../../../../src/components/SetterPlaylistScreen';

// A setter's list opened from a For You card. It is pushed inside Discover rather
// than into the Climbs tab, so closing the player and pressing Back both stay in
// Discover. Same screen as the Climbs tab's setter route.
export default function DiscoverSetterPlaylist() {
  return <SetterPlaylistScreen tab="discover" />;
}
