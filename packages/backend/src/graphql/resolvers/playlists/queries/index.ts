import { userPlaylists, allUserPlaylists } from './user-playlists';
import { playlist, playlistsForClimb, playlistsForClimbs } from './playlist-detail';
import { playlistClimbs } from './playlist-climbs';
import { playlistSetters } from './playlist-setters';
import { discoverPlaylists, playlistCreators } from './discover';
import { searchPlaylists } from './search';
import { myPinnedPlaylists } from './pinned';
import { smartPlaylist, mySmartPlaylistCounts } from './smart-playlists';

export const playlistQueries = {
  userPlaylists,
  allUserPlaylists,
  playlist,
  playlistsForClimb,
  playlistsForClimbs,
  playlistClimbs,
  playlistSetters,
  discoverPlaylists,
  playlistCreators,
  searchPlaylists,
  myPinnedPlaylists,
  smartPlaylist,
  mySmartPlaylistCounts,
};
