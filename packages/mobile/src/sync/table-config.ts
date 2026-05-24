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
    primaryKeyColumns: ['user_id', 'climb_uuid', 'angle'],
  },
  user_follows: {
    queryName: 'syncUserFollows',
    operationKey: 'SYNC_USER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['followers'], ['following']],
    primaryKeyColumns: ['follower_id', 'followed_id'],
  },
  setter_follows: {
    queryName: 'syncSetterFollows',
    operationKey: 'SYNC_SETTER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['setterFollows']],
    primaryKeyColumns: ['user_id', 'setter_username'],
  },
  playlist_follows: {
    queryName: 'syncPlaylistFollows',
    operationKey: 'SYNC_PLAYLIST_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['playlistFollows']],
    primaryKeyColumns: ['user_id', 'playlist_uuid'],
  },
  board_climbs: {
    queryName: 'syncClimbs',
    operationKey: 'SYNC_CLIMBS',
    isPerBoard: true,
    invalidateKeys: [['climb-search'], ['climb']],
    primaryKeyColumns: ['uuid'],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    operationKey: 'SYNC_CLIMB_STATS',
    isPerBoard: true,
    invalidateKeys: [['climb-search'], ['climb']],
    primaryKeyColumns: ['climb_uuid', 'angle'],
  },
};

export const USER_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => !config.isPerBoard)
  .map(([tableName]) => tableName);

export const BOARD_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => config.isPerBoard)
  .map(([tableName]) => tableName);
