export type TableSyncConfig = {
  queryName: string;
  operationKey: string;
  isPerBoard: boolean;
  invalidateKeys: string[][];
  primaryKeyColumns: string[];
};

export const TABLE_CONFIGS: Record<string, TableSyncConfig> = {
  boardsesh_ticks: {
    queryName: 'syncTicks',
    operationKey: 'SYNC_TICKS',
    isPerBoard: false,
    invalidateKeys: [['ticks'], ['logbook']],
    primaryKeyColumns: ['uuid'],
  },
  playlists: {
    queryName: 'syncPlaylists',
    operationKey: 'SYNC_PLAYLISTS',
    isPerBoard: false,
    invalidateKeys: [['playlists']],
    primaryKeyColumns: ['uuid'],
  },
  playlist_climbs: {
    queryName: 'syncPlaylistClimbs',
    operationKey: 'SYNC_PLAYLIST_CLIMBS',
    isPerBoard: false,
    invalidateKeys: [['playlists']],
    primaryKeyColumns: ['playlist_uuid', 'climb_uuid'],
  },
  user_favorites: {
    queryName: 'syncFavorites',
    operationKey: 'SYNC_FAVORITES',
    isPerBoard: false,
    invalidateKeys: [['favorites'], ['searchClimbs']],
    primaryKeyColumns: ['board_name', 'climb_uuid', 'angle'],
  },
  user_follows: {
    queryName: 'syncUserFollows',
    operationKey: 'SYNC_USER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['followers'], ['following']],
    primaryKeyColumns: ['following_id'],
  },
  setter_follows: {
    queryName: 'syncSetterFollows',
    operationKey: 'SYNC_SETTER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['setterFollows']],
    primaryKeyColumns: ['setter_username'],
  },
  playlist_follows: {
    queryName: 'syncPlaylistFollows',
    operationKey: 'SYNC_PLAYLIST_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['playlistFollows']],
    primaryKeyColumns: ['playlist_uuid'],
  },
  board_climbs: {
    queryName: 'syncClimbs',
    operationKey: 'SYNC_CLIMBS',
    isPerBoard: true,
    // Match the keys real readers use: the climb list reads ['searchClimbs', input]
    // + ['searchClimbsCount', input], the detail reads ['climb', variables]. The
    // old ['climb-search'] key had no reader, so a board pull never refreshed the UI.
    invalidateKeys: [['searchClimbs'], ['searchClimbsCount'], ['climb']],
    primaryKeyColumns: ['uuid'],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    operationKey: 'SYNC_CLIMB_STATS',
    isPerBoard: true,
    invalidateKeys: [['searchClimbs'], ['searchClimbsCount'], ['climb']],
    primaryKeyColumns: ['board_type', 'climb_uuid', 'angle'],
  },
};

export const USER_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => !config.isPerBoard)
  .map(([tableName]) => tableName);

export const BOARD_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => config.isPerBoard)
  .map(([tableName]) => tableName);
