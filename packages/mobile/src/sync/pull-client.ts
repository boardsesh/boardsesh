import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';
import type { SyncCursorInput, SyncResult, SyncDeletionsResult } from '../lib/graphql/operations';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './table-config';
import { getCheckpoint, setCheckpoint, getCheckpointKey } from './checkpoints';

export type SyncProgress = {
  phase: 'user_data' | 'board_data' | 'deletions' | 'idle';
  currentTable: string | null;
  documentsProcessed: number;
};

export type SyncOptions = {
  enabledBoards?: string[];
  onProgress?: (progress: SyncProgress) => void;
};

const PAGE_LIMIT = 500;
const UPSERT_BATCH_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function buildSyncQuery(queryName: string, isPerBoard: boolean): string {
  const boardTypeParam = isPerBoard ? '$boardType: String!, ' : '';
  const boardTypeArg = isPerBoard ? 'boardType: $boardType, ' : '';
  return `
    query ${queryName[0].toUpperCase()}${queryName.slice(1)}(${boardTypeParam}$cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
      ${queryName}(${boardTypeArg}cursor: $cursor, limit: $limit) {
        documents
        cursor {
          updatedAt
          syncSeq
        }
        hasMore
      }
    }
  `;
}

const SYNC_DELETIONS_QUERY = `
  query SyncDeletions($cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
    syncDeletions(cursor: $cursor, limit: $limit) {
      deletions {
        tableName
        recordId
        deletedAt
      }
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

async function upsertDocuments(
  db: SQLiteDatabase,
  tableName: string,
  documents: Record<string, unknown>[],
): Promise<void> {
  if (documents.length === 0) return;

  const columns = Object.keys(documents[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const columnList = columns.join(', ');
  const sql = `INSERT OR REPLACE INTO ${tableName} (${columnList}) VALUES (${placeholders})`;

  for (const batch of chunk(documents, UPSERT_BATCH_SIZE)) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      for (const document of batch) {
        const values = columns.map((col) => {
          const value = document[col];
          if (value === null || value === undefined) return null;
          if (typeof value === 'boolean') return value ? 1 : 0;
          if (typeof value === 'object') return JSON.stringify(value);
          return value;
        });
        await transaction.runAsync(sql, values as (string | number | null)[]);
      }
    });
  }
}

async function syncTable(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  tableName: string,
  boardType?: string,
  onProgress?: (documentsProcessed: number) => void,
): Promise<void> {
  const config = TABLE_CONFIGS[tableName];
  if (!config) throw new Error(`No sync config for table: ${tableName}`);

  const checkpointKey = getCheckpointKey(tableName, boardType);
  const checkpoint = await getCheckpoint(db, checkpointKey);
  const query = buildSyncQuery(config.queryName, config.isPerBoard);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;

  let hasMore = true;
  while (hasMore) {
    const variables: Record<string, unknown> = { cursor, limit: PAGE_LIMIT };
    if (config.isPerBoard && boardType) {
      variables.boardType = boardType;
    }

    const response = await graphqlFetch<Record<string, SyncResult>>(query, variables);
    const result = response[config.queryName];

    // An empty page would not advance the cursor; if the backend ever returns
    // documents:[] with hasMore:true we'd spin forever. Stop here (I2).
    if (result.documents.length === 0) break;

    await upsertDocuments(db, tableName, result.documents);
    await setCheckpoint(db, checkpointKey, result.cursor);

    totalProcessed += result.documents.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  for (const key of config.invalidateKeys) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}

async function processDeletions(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  onProgress?: (documentsProcessed: number) => void,
): Promise<void> {
  const checkpointKey = 'checkpoint:deletions';
  const checkpoint = await getCheckpoint(db, checkpointKey);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;
  const invalidatedKeys = new Set<string>();

  let hasMore = true;
  while (hasMore) {
    const response = await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, {
      cursor,
      limit: PAGE_LIMIT,
    });
    const result = response.syncDeletions;

    // Empty page can't advance the cursor; break to avoid an infinite loop if
    // the backend returns deletions:[] with hasMore:true (I2).
    if (result.deletions.length === 0) break;

    for (const deletion of result.deletions) {
      const config = TABLE_CONFIGS[deletion.tableName];
      if (!config) continue;

      const pkColumns = config.primaryKeyColumns;

      if (pkColumns.length === 1) {
        await db.runAsync(`DELETE FROM ${deletion.tableName} WHERE ${pkColumns[0]} = ?`, [deletion.recordId]);
      } else {
        // Backend encodes composite PKs as exactly N colon-separated segments
        // matching primaryKeyColumns order (e.g. "kilter:uuid:40" for
        // board_climb_stats with PK [board_type, climb_uuid, angle]). The split
        // must produce exactly pkColumns.length parts — if not, skip the deletion
        // rather than silently deleting the wrong row.
        const recordIdParts = deletion.recordId.split(':');
        if (recordIdParts.length !== pkColumns.length) {
          console.warn(
            `[Sync] Skipping deletion: expected ${pkColumns.length} PK parts for ${deletion.tableName}, got ${recordIdParts.length} from "${deletion.recordId}"`,
          );
          continue;
        }
        const whereClause = pkColumns.map((col) => `${col} = ?`).join(' AND ');
        await db.runAsync(`DELETE FROM ${deletion.tableName} WHERE ${whereClause}`, recordIdParts);
      }

      for (const key of config.invalidateKeys) {
        invalidatedKeys.add(JSON.stringify(key));
      }
    }

    await setCheckpoint(db, checkpointKey, result.cursor);
    totalProcessed += result.deletions.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  for (const serializedKey of invalidatedKeys) {
    queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as string[] });
  }
}

export async function pullSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  options?: SyncOptions,
): Promise<void> {
  const enabledBoards = options?.enabledBoards ?? [];
  const onProgress = options?.onProgress;
  let totalDocuments = 0;

  for (const tableName of USER_DATA_TABLES) {
    onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
    const baseCount = totalDocuments;
    await syncTable(db, queryClient, graphqlFetch, tableName, undefined, (tableProcessed) => {
      totalDocuments = baseCount + tableProcessed;
      onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
    });
  }

  for (const boardType of enabledBoards) {
    for (const tableName of BOARD_DATA_TABLES) {
      const tableLabel = `${tableName}:${boardType}`;
      onProgress?.({ phase: 'board_data', currentTable: tableLabel, documentsProcessed: totalDocuments });
      const baseCount = totalDocuments;
      await syncTable(db, queryClient, graphqlFetch, tableName, boardType, (tableProcessed) => {
        totalDocuments = baseCount + tableProcessed;
        onProgress?.({ phase: 'board_data', currentTable: tableLabel, documentsProcessed: totalDocuments });
      });
    }
  }

  onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: totalDocuments });
  const baseCount = totalDocuments;
  await processDeletions(db, queryClient, graphqlFetch, (deletionsProcessed) => {
    totalDocuments = baseCount + deletionsProcessed;
    onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: totalDocuments });
  });

  onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: totalDocuments });
}
