export type TableSyncConfig = {
  queryName: string;
  operationKey: string;
  isPerBoard: boolean;
  invalidateKeys: string[][];
  primaryKeyColumns: string[];
  localColumns: readonly string[];
};

export const TABLE_CONFIGS: Record<string, TableSyncConfig> = {
  boardsesh_ticks: {
    queryName: 'syncTicks',
    operationKey: 'SYNC_TICKS',
    isPerBoard: false,
    invalidateKeys: [['ticks'], ['logbook']],
    primaryKeyColumns: ['uuid'],
    localColumns: [
      'uuid',
      'user_id',
      'board_type',
      'climb_uuid',
      'angle',
      'is_mirror',
      'status',
      'attempt_count',
      'quality',
      'difficulty',
      'is_benchmark',
      'comment',
      'climbed_at',
      'session_id',
      'created_at',
      'updated_at',
    ],
  },
  playlists: {
    queryName: 'syncPlaylists',
    operationKey: 'SYNC_PLAYLISTS',
    isPerBoard: false,
    invalidateKeys: [['playlists']],
    primaryKeyColumns: ['uuid'],
    localColumns: [
      'uuid',
      'board_type',
      'layout_id',
      'name',
      'description',
      'is_public',
      'color',
      'icon',
      'created_at',
      'updated_at',
      'last_accessed_at',
    ],
  },
  playlist_climbs: {
    queryName: 'syncPlaylistClimbs',
    operationKey: 'SYNC_PLAYLIST_CLIMBS',
    isPerBoard: false,
    invalidateKeys: [['playlists']],
    primaryKeyColumns: ['playlist_uuid', 'climb_uuid'],
    localColumns: ['playlist_uuid', 'climb_uuid', 'angle', 'position', 'added_at', 'updated_at'],
  },
  user_favorites: {
    queryName: 'syncFavorites',
    operationKey: 'SYNC_FAVORITES',
    isPerBoard: false,
    invalidateKeys: [['favorites'], ['searchClimbs']],
    primaryKeyColumns: ['board_name', 'climb_uuid', 'angle'],
    localColumns: ['board_name', 'climb_uuid', 'angle', 'user_id', 'created_at', 'updated_at'],
  },
  user_follows: {
    queryName: 'syncUserFollows',
    operationKey: 'SYNC_USER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['followers'], ['following']],
    primaryKeyColumns: ['following_id'],
    localColumns: ['following_id', 'follower_id', 'created_at', 'updated_at'],
  },
  setter_follows: {
    queryName: 'syncSetterFollows',
    operationKey: 'SYNC_SETTER_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['setterFollows']],
    primaryKeyColumns: ['setter_username'],
    localColumns: ['setter_username', 'follower_id', 'created_at', 'updated_at'],
  },
  playlist_follows: {
    queryName: 'syncPlaylistFollows',
    operationKey: 'SYNC_PLAYLIST_FOLLOWS',
    isPerBoard: false,
    invalidateKeys: [['playlistFollows']],
    primaryKeyColumns: ['playlist_uuid'],
    localColumns: ['playlist_uuid', 'follower_id', 'created_at', 'updated_at'],
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
    localColumns: [
      'uuid',
      'board_type',
      'layout_id',
      'setter_id',
      'setter_username',
      'name',
      'description',
      'hsm',
      'edge_left',
      'edge_right',
      'edge_bottom',
      'edge_top',
      'angle',
      'frames_count',
      'frames_pace',
      'frames',
      'is_draft',
      'is_listed',
      'created_at',
      'published_at',
      'user_id',
      'required_set_ids',
      'compatible_size_ids',
      'hold_fingerprint',
      'updated_at',
      'sync_seq',
    ],
  },
  board_climb_stats: {
    queryName: 'syncClimbStats',
    operationKey: 'SYNC_CLIMB_STATS',
    isPerBoard: true,
    invalidateKeys: [['searchClimbs'], ['searchClimbsCount'], ['climb']],
    primaryKeyColumns: ['board_type', 'climb_uuid', 'angle'],
    localColumns: [
      'board_type',
      'climb_uuid',
      'angle',
      'display_difficulty',
      'benchmark_difficulty',
      'ascensionist_count',
      'difficulty_average',
      'quality_average',
      'fa_username',
      'fa_at',
      'updated_at',
      'sync_seq',
    ],
  },
};

export const USER_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => !config.isPerBoard)
  .map(([tableName]) => tableName);

export const BOARD_DATA_TABLES = Object.entries(TABLE_CONFIGS)
  .filter(([, config]) => config.isPerBoard)
  .map(([tableName]) => tableName);
