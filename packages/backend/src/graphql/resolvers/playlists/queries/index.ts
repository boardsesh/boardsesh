import { userPlaylists, allUserPlaylists } from './user-playlists';
import { playlist, playlistsForClimb, playlistsForClimbs } from './playlist-detail';
import { playlistClimbs } from './playlist-climbs';
import { discoverPlaylists, playlistCreators } from './discover';
import { recommendedPlaylists } from './recommended';
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
  discoverPlaylists,
  recommendedPlaylists,
  playlistCreators,
  searchPlaylists,
  myPinnedPlaylists,
  smartPlaylist,
  mySmartPlaylistCounts,
};
