import { createPinnedChipsStore } from './pinned-chips-store';
import {
  PLAYLIST_DEFAULT_PINNED_CHIPS,
  PLAYLIST_PINNABLE_CHIP_CATALOG,
  type PlaylistPinnableChipKind,
} from './playlist-pinnable-chips';

/**
 * The preference-store key for the playlist-style lists' pins (playlists, smart
 * lists, setter pages: one row layout for all three). Never shared with the
 * Climbs tab or the Logbook.
 */
export const PLAYLIST_PINNED_CHIPS_STORAGE_KEY = 'pinnedPlaylistChips';

/**
 * Which playlist capsules the climber has pinned, in the order the row draws
 * them (set in Settings › Climbs & grades › Quick filters). Device-global like
 * the climbs and Logbook pins: one layout for every playlist, smart list and
 * setter page. Unknown kinds in a stored payload drop out and the saved order
 * stays (the factory's default normalize), so the catalog can grow without a
 * migration.
 */
export const playlistPinnedChipsStore = createPinnedChipsStore<PlaylistPinnableChipKind>({
  storageKey: PLAYLIST_PINNED_CHIPS_STORAGE_KEY,
  catalog: PLAYLIST_PINNABLE_CHIP_CATALOG,
  defaults: PLAYLIST_DEFAULT_PINNED_CHIPS,
});
