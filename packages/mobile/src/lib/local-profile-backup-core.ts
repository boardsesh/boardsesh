import { getLocalUserId, type OfflineDatabase, type SqlExecutor, type SqlValue } from '@boardsesh/offline-sync';

export const LOCAL_PROFILE_BACKUP_VERSION = 1;

export type LocalProfileBackupCounts = {
  ticks: number;
  favorites: number;
  playlists: number;
  playlistClimbs: number;
};

export type ValidatedLocalProfileBackup = LocalProfileBackupCounts & {
  createdAt: string;
  sourceOwnerUserId: string;
};

const MAX_BACKUP_ROWS_PER_TABLE = 100_000;
const REQUIRED_BACKUP_TABLES = new Set([
  'backup_metadata',
  'boardsesh_ticks',
  'user_favorites',
  'playlists',
  'playlist_climbs',
]);
const MAX_BACKUP_FIELD_BYTES = 1_000_000;

type BackupTable = {
  name: 'boardsesh_ticks' | 'user_favorites' | 'playlists' | 'playlist_climbs';
  columns: readonly string[];
  sourceWhere?: string;
  ownerScoped?: boolean;
};

const BACKUP_SCHEMA = `
CREATE TABLE backup_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE boardsesh_ticks (
  uuid TEXT PRIMARY KEY, user_id TEXT, board_type TEXT, climb_uuid TEXT, angle INTEGER,
  is_mirror INTEGER, status TEXT, attempt_count INTEGER, quality INTEGER, difficulty INTEGER,
  is_benchmark INTEGER, comment TEXT, climbed_at TEXT, session_id TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE user_favorites (
  board_name TEXT NOT NULL, climb_uuid TEXT NOT NULL, angle INTEGER NOT NULL,
  user_id TEXT, created_at TEXT, updated_at TEXT,
  PRIMARY KEY (board_name, climb_uuid, angle)
);
CREATE TABLE playlists (
  uuid TEXT PRIMARY KEY, board_type TEXT, layout_id INTEGER, name TEXT, description TEXT,
  is_public INTEGER, color TEXT, icon TEXT, created_at TEXT, updated_at TEXT, last_accessed_at TEXT
);
CREATE TABLE playlist_climbs (
  playlist_uuid TEXT NOT NULL, climb_uuid TEXT NOT NULL, angle INTEGER, position INTEGER,
  added_at TEXT, updated_at TEXT, PRIMARY KEY (playlist_uuid, climb_uuid)
);
`;

const BACKUP_TABLES: readonly BackupTable[] = [
  {
    name: 'boardsesh_ticks',
    columns: [
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
    sourceWhere: 'user_id = ?',
    ownerScoped: true,
  },
  {
    name: 'user_favorites',
    columns: ['board_name', 'climb_uuid', 'angle', 'user_id', 'created_at', 'updated_at'],
    sourceWhere: 'user_id = ?',
    ownerScoped: true,
  },
  {
    name: 'playlists',
    columns: [
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
  {
    name: 'playlist_climbs',
    columns: ['playlist_uuid', 'climb_uuid', 'angle', 'position', 'added_at', 'updated_at'],
    sourceWhere: 'EXISTS (SELECT 1 FROM playlists WHERE playlists.uuid = playlist_climbs.playlist_uuid)',
  },
];

const INTEGER_COLUMNS = new Set([
  'boardsesh_ticks.angle',
  'boardsesh_ticks.is_mirror',
  'boardsesh_ticks.attempt_count',
  'boardsesh_ticks.quality',
  'boardsesh_ticks.difficulty',
  'boardsesh_ticks.is_benchmark',
  'user_favorites.angle',
  'playlists.layout_id',
  'playlists.is_public',
  'playlist_climbs.angle',
  'playlist_climbs.position',
]);

async function copyTable(
  source: SqlExecutor,
  destination: SqlExecutor,
  table: BackupTable,
  ownerUserId: string,
): Promise<number> {
  const columnList = table.columns.join(', ');
  const rows = await source.getAllAsync<Record<string, SqlValue>>(
    `SELECT ${columnList} FROM ${table.name}${table.sourceWhere ? ` WHERE ${table.sourceWhere}` : ''}`,
    table.ownerScoped ? [ownerUserId] : [],
  );
  const placeholders = table.columns.map(() => '?').join(', ');
  for (const row of rows) {
    await destination.runAsync(
      `INSERT INTO ${table.name} (${columnList}) VALUES (${placeholders})`,
      table.columns.map((column) => row[column] ?? null),
    );
  }
  return rows.length;
}

async function readMetadata(backup: SqlExecutor, key: string): Promise<string | null> {
  const row = await backup.getFirstAsync<{ value: string }>('SELECT value FROM backup_metadata WHERE key = ?', [key]);
  return row?.value ?? null;
}

async function countRows(backup: SqlExecutor, tableName: BackupTable['name']): Promise<number> {
  const row = await backup.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return row?.count ?? 0;
}

/** Rejects corrupt, oversized, foreign-schema, or non-login-free SQLite files before any merge. */
export async function validateLocalProfileBackup(backup: SqlExecutor): Promise<ValidatedLocalProfileBackup> {
  const integrity = await backup.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') throw new Error('The selected SQLite backup failed its integrity check');

  const tableRows = await backup.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const actualTables = new Set(tableRows.map(({ name }) => name));
  if (
    actualTables.size !== REQUIRED_BACKUP_TABLES.size ||
    [...REQUIRED_BACKUP_TABLES].some((tableName) => !actualTables.has(tableName))
  ) {
    throw new Error('The selected file is not a personal-only Boardsesh backup');
  }

  const expectedColumns = new Map<string, readonly string[]>([
    ['backup_metadata', ['key', 'value']],
    ...BACKUP_TABLES.map((table) => [table.name, table.columns] as const),
  ]);
  for (const [tableName, columns] of expectedColumns) {
    const columnRows = await backup.getAllAsync<{ name: string; type: string }>(`PRAGMA table_info(${tableName})`);
    const matches =
      columnRows.length === columns.length &&
      columnRows.every(
        (column, index) =>
          column.name === columns[index] &&
          column.type.toUpperCase() === (INTEGER_COLUMNS.has(`${tableName}.${column.name}`) ? 'INTEGER' : 'TEXT'),
      );
    if (!matches) throw new Error(`The selected backup has an invalid ${tableName} schema`);

    for (const column of columns) {
      const allowedTypes = INTEGER_COLUMNS.has(`${tableName}.${column}`) ? "'null', 'integer'" : "'null', 'text'";
      const invalidStorage = await backup.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${tableName} WHERE typeof(${column}) NOT IN (${allowedTypes})`,
      );
      const oversized = await backup.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${tableName} WHERE length(CAST(${column} AS BLOB)) > ?`,
        [MAX_BACKUP_FIELD_BYTES],
      );
      if ((invalidStorage?.count ?? 0) > 0 || (oversized?.count ?? 0) > 0) {
        throw new Error(`The selected backup contains an invalid ${tableName}.${column} value`);
      }
    }
  }

  const formatVersion = await readMetadata(backup, 'format_version');
  const createdAt = await readMetadata(backup, 'created_at');
  const sourceOwnerUserId = await readMetadata(backup, 'local_owner_id');
  if (formatVersion !== String(LOCAL_PROFILE_BACKUP_VERSION)) throw new Error('This backup version is not supported');
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('The backup creation date is invalid');
  if (!sourceOwnerUserId?.startsWith('local:')) throw new Error('The backup owner is invalid');

  const counts = {
    ticks: await countRows(backup, 'boardsesh_ticks'),
    favorites: await countRows(backup, 'user_favorites'),
    playlists: await countRows(backup, 'playlists'),
    playlistClimbs: await countRows(backup, 'playlist_climbs'),
  };
  if (Object.values(counts).some((count) => count < 0 || count > MAX_BACKUP_ROWS_PER_TABLE)) {
    throw new Error('The selected backup contains too many rows');
  }

  const foreignTicks = await backup.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM boardsesh_ticks WHERE user_id IS NULL OR user_id != ?',
    [sourceOwnerUserId],
  );
  const foreignFavorites = await backup.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM user_favorites WHERE user_id IS NULL OR user_id != ?',
    [sourceOwnerUserId],
  );
  const publicPlaylists = await backup.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM playlists WHERE is_public != 0 OR is_public IS NULL',
  );
  const orphanMemberships = await backup.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM playlist_climbs
     WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE playlists.uuid = playlist_climbs.playlist_uuid)`,
  );
  if (
    (foreignTicks?.count ?? 0) > 0 ||
    (foreignFavorites?.count ?? 0) > 0 ||
    (publicPlaylists?.count ?? 0) > 0 ||
    (orphanMemberships?.count ?? 0) > 0
  ) {
    throw new Error('The selected backup contains invalid personal rows');
  }

  const invalidTicks = await backup.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM boardsesh_ticks
     WHERE uuid IS NULL OR uuid = '' OR climb_uuid IS NULL OR climb_uuid = '' OR board_type IS NULL OR board_type = ''
       OR status NOT IN ('flash', 'send', 'attempt') OR angle IS NULL OR angle < 0 OR angle > 90
       OR attempt_count IS NULL OR attempt_count < 1 OR attempt_count > 1000000
       OR (is_mirror IS NOT NULL AND is_mirror NOT IN (0, 1))
       OR (is_benchmark IS NOT NULL AND is_benchmark NOT IN (0, 1))`,
  );
  const invalidFavorites = await backup.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM user_favorites
     WHERE board_name IS NULL OR board_name = '' OR climb_uuid IS NULL OR climb_uuid = ''
       OR angle < 0 OR angle > 90`,
  );
  const invalidPlaylists = await backup.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM playlists
     WHERE uuid IS NULL OR uuid = '' OR name IS NULL OR name = '' OR layout_id IS NULL`,
  );
  const invalidMemberships = await backup.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM playlist_climbs
     WHERE playlist_uuid IS NULL OR playlist_uuid = '' OR climb_uuid IS NULL OR climb_uuid = ''
       OR (angle IS NOT NULL AND (angle < 0 OR angle > 90)) OR (position IS NOT NULL AND position < 0)`,
  );
  if (
    (invalidTicks?.count ?? 0) > 0 ||
    (invalidFavorites?.count ?? 0) > 0 ||
    (invalidPlaylists?.count ?? 0) > 0 ||
    (invalidMemberships?.count ?? 0) > 0
  ) {
    throw new Error('The selected backup contains invalid row values');
  }

  return { ...counts, createdAt, sourceOwnerUserId };
}

/** Atomically merges a validated backup, preserving current rows on UUID conflicts. */
export async function restoreLocalProfileBackup(
  backup: SqlExecutor,
  destination: OfflineDatabase,
): Promise<LocalProfileBackupCounts> {
  const validated = await validateLocalProfileBackup(backup);
  const destinationOwnerUserId = await getLocalUserId(destination);
  if (!destinationOwnerUserId?.startsWith('local:')) {
    throw new Error('A ready login-free profile is required to restore a backup');
  }

  const backupRows = new Map<BackupTable['name'], Array<Record<string, SqlValue>>>();
  for (const table of BACKUP_TABLES) {
    backupRows.set(
      table.name,
      await backup.getAllAsync<Record<string, SqlValue>>(`SELECT ${table.columns.join(', ')} FROM ${table.name}`),
    );
  }

  const outcome: { counts: LocalProfileBackupCounts | null } = { counts: null };
  await destination.withExclusiveTransactionAsync(async (transaction) => {
    const inserted: number[] = [];
    const importedPlaylistUuids = new Set<string>();
    const sourceAndDestinationOwnerMatch = validated.sourceOwnerUserId === destinationOwnerUserId;
    for (const table of BACKUP_TABLES) {
      let tableInserted = 0;
      const columns = table.columns.join(', ');
      const placeholders = table.columns.map(() => '?').join(', ');
      for (const row of backupRows.get(table.name) ?? []) {
        if (
          table.name === 'playlist_climbs' &&
          !sourceAndDestinationOwnerMatch &&
          !importedPlaylistUuids.has(String(row.playlist_uuid ?? ''))
        ) {
          continue;
        }
        const parameters = table.columns.map((column) =>
          column === 'user_id' ? destinationOwnerUserId : (row[column] ?? null),
        );
        const result = await transaction.runAsync(
          `INSERT OR IGNORE INTO ${table.name} (${columns}) VALUES (${placeholders})`,
          parameters,
        );
        tableInserted += result.changes;
        if (table.name === 'playlists' && result.changes > 0) importedPlaylistUuids.add(String(row.uuid ?? ''));
      }
      inserted.push(tableInserted);
    }
    outcome.counts = {
      ticks: inserted[0],
      favorites: inserted[1],
      playlists: inserted[2],
      playlistClimbs: inserted[3],
    };
  });
  if (outcome.counts === null) throw new Error('The local restore transaction did not finish');
  return outcome.counts;
}

/**
 * Copies only login-free personal rows into a small, versioned SQLite file.
 * Catalogs, sync checkpoints, outbox entries, and social rows are deliberately
 * absent. The provider chosen by the climber protects the resulting file.
 */
export async function exportLocalProfileBackup(
  source: OfflineDatabase,
  destination: SqlExecutor,
  createdAt: string,
): Promise<LocalProfileBackupCounts> {
  const outcome: { counts: LocalProfileBackupCounts | null } = { counts: null };
  await source.withExclusiveTransactionAsync(async (snapshot) => {
    const ownerUserId = await getLocalUserId(snapshot);
    if (!ownerUserId?.startsWith('local:')) {
      throw new Error('A ready login-free profile is required to create a backup');
    }

    await destination.execAsync('BEGIN IMMEDIATE');
    try {
      await destination.execAsync(BACKUP_SCHEMA);
      await destination.runAsync('INSERT INTO backup_metadata (key, value) VALUES (?, ?)', [
        'format_version',
        String(LOCAL_PROFILE_BACKUP_VERSION),
      ]);
      await destination.runAsync('INSERT INTO backup_metadata (key, value) VALUES (?, ?)', ['created_at', createdAt]);
      await destination.runAsync('INSERT INTO backup_metadata (key, value) VALUES (?, ?)', [
        'local_owner_id',
        ownerUserId,
      ]);

      const counts: number[] = [];
      // Keep parent playlists ahead of membership rows and avoid concurrent writes
      // against a single native SQLite handle. The source transaction gives every
      // SELECT the same point-in-time snapshot while climbing can continue later.
      for (const table of BACKUP_TABLES) counts.push(await copyTable(snapshot, destination, table, ownerUserId));
      await destination.execAsync('COMMIT');
      outcome.counts = {
        ticks: counts[0],
        favorites: counts[1],
        playlists: counts[2],
        playlistClimbs: counts[3],
      };
    } catch (error) {
      await destination.execAsync('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  if (outcome.counts === null) throw new Error('The local backup transaction did not finish');
  return outcome.counts;
}
