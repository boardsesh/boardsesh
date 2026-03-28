import { getPool } from '@/app/lib/db/db';
import { SyncOptions, AuroraBoardName } from '../../api-wrappers/aurora/types';
import { sharedSync } from '../../api-wrappers/aurora/sharedSync';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { NeonDatabase } from 'drizzle-orm/neon-serverless';
import { Attempt, BetaLink, Climb, ClimbStats, SharedSync, SyncPutFields } from '../../api-wrappers/sync-api-types';
import { UNIFIED_TABLES } from '../../db/queries/util/table-select';
import { convertLitUpHoldsStringToMap } from '@/app/components/board-renderer/util';

export type NewClimbInfo = {
  uuid: string;
  setterId?: number;
  setterUsername?: string;
  layoutId: number;
  name?: string;
};

// Define shared sync tables in correct dependency order
// Order matches what the Android app sends - keep full list to remain indistinguishable
export const SHARED_SYNC_TABLES: string[] = [
  'products',
  'product_sizes',
  'holes',
  'leds',
  'products_angles',
  'layouts',
  'product_sizes_layouts_sets',
  'placements',
  'sets',
  'placement_roles',
  'climbs',
  'climb_stats',
  'beta_links',
  'attempts',
  'kits',
];

// Tables we actually want to process and store
const TABLES_TO_PROCESS = new Set(['climbs', 'climb_stats', 'beta_links', 'attempts', 'shared_syncs']);

const upsertAttempts = (db: NeonDatabase<Record<string, never>>, board: AuroraBoardName, data: Attempt[]) =>
  Promise.all(
    data.map(async (item) => {
      const attemptsSchema = UNIFIED_TABLES.attempts;
      return db
        .insert(attemptsSchema)
        .values({
          boardType: board,
          id: Number(item.id),
          position: Number(item.position),
          name: item.name,
        })
        .onConflictDoUpdate({
          target: [attemptsSchema.boardType, attemptsSchema.id],
          set: {
            // Only allow position updates if they're reasonable (0-100)
            position: sql`CASE WHEN ${Number(item.position)} >= 0 AND ${Number(item.position)} <= 100 THEN ${Number(item.position)} ELSE ${attemptsSchema.position} END`,
            // Allow name updates for display purposes
            name: item.name,
          },
        });
    }),
  );

async function upsertClimbStats(db: NeonDatabase<Record<string, never>>, board: AuroraBoardName, data: ClimbStats[]) {
  const climbStatsSchema = UNIFIED_TABLES.climbStats;
  const climbStatHistorySchema = UNIFIED_TABLES.climbStatsHistory;

  if (data.length === 0) return;

  // Fetch current stats for all climb+angle combos so we can detect changes
  const keys = data.map((item) => ({ uuid: item.climb_uuid, angle: Number(item.angle) }));
  const uuids = [...new Set(keys.map((k) => k.uuid))];

  const existingStats = await db
    .select({
      climbUuid: climbStatsSchema.climbUuid,
      angle: climbStatsSchema.angle,
      ascensionistCount: climbStatsSchema.ascensionistCount,
      qualityAverage: climbStatsSchema.qualityAverage,
      difficultyAverage: climbStatsSchema.difficultyAverage,
    })
    .from(climbStatsSchema)
    .where(and(eq(climbStatsSchema.boardType, board), inArray(climbStatsSchema.climbUuid, uuids)));

  const existingMap = new Map(
    existingStats.map((s) => [`${s.climbUuid}:${s.angle}`, s]),
  );

  // Upsert current stats (individual inserts to avoid bulk upsert issues)
  await Promise.all(
    data.map((item) =>
      db
        .insert(climbStatsSchema)
        .values({
          boardType: board,
          climbUuid: item.climb_uuid,
          angle: Number(item.angle),
          displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
          benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
          ascensionistCount: Number(item.ascensionist_count),
          difficultyAverage: Number(item.difficulty_average),
          qualityAverage: Number(item.quality_average),
          faUsername: item.fa_username,
          faAt: item.fa_at,
        })
        .onConflictDoUpdate({
          target: [climbStatsSchema.boardType, climbStatsSchema.climbUuid, climbStatsSchema.angle],
          set: {
            displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
            benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
            ascensionistCount: Number(item.ascensionist_count),
            difficultyAverage: Number(item.difficulty_average),
            qualityAverage: Number(item.quality_average),
            faUsername: item.fa_username,
            faAt: item.fa_at,
          },
        }),
    ),
  );

  // Only insert history for stats that actually changed (or are new)
  const changedItems = data.filter((item) => {
    const key = `${item.climb_uuid}:${Number(item.angle)}`;
    const existing = existingMap.get(key);
    if (!existing) return true; // New stat, always record
    return (
      Number(existing.ascensionistCount) !== Number(item.ascensionist_count) ||
      Number(existing.qualityAverage) !== Number(item.quality_average) ||
      Number(existing.difficultyAverage) !== Number(item.difficulty_average)
    );
  });

  if (changedItems.length > 0) {
    // Batch insert history records in chunks (single INSERT per chunk)
    const BATCH_SIZE = 500;
    for (let i = 0; i < changedItems.length; i += BATCH_SIZE) {
      const batch = changedItems.slice(i, i + BATCH_SIZE);
      await db.insert(climbStatHistorySchema).values(
        batch.map((item) => ({
          boardType: board,
          climbUuid: item.climb_uuid,
          angle: Number(item.angle),
          displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
          benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
          ascensionistCount: Number(item.ascensionist_count),
          difficultyAverage: Number(item.difficulty_average),
          qualityAverage: Number(item.quality_average),
          faUsername: item.fa_username,
          faAt: item.fa_at,
        })),
      );
    }
    console.log(`[SharedSync] Inserted ${changedItems.length} changed stats into history (skipped ${data.length - changedItems.length} unchanged)`);
  } else {
    console.log(`[SharedSync] No stats changed, skipped all ${data.length} history inserts`);
  }
}

async function upsertBetaLinks(db: NeonDatabase<Record<string, never>>, board: AuroraBoardName, data: BetaLink[]) {
  const betaLinksSchema = UNIFIED_TABLES.betaLinks;

  await Promise.all(
    data.map((item) => {
      return db
        .insert(betaLinksSchema)
        .values({
          boardType: board,
          climbUuid: item.climb_uuid,
          link: item.link,
          foreignUsername: item.foreign_username,
          angle: item.angle,
          thumbnail: item.thumbnail,
          isListed: item.is_listed,
          createdAt: item.created_at,
        })
        .onConflictDoUpdate({
          target: [betaLinksSchema.boardType, betaLinksSchema.climbUuid, betaLinksSchema.link],
          set: {
            foreignUsername: item.foreign_username,
            angle: item.angle,
            thumbnail: item.thumbnail,
            isListed: item.is_listed,
            createdAt: item.created_at,
          },
        });
    }),
  );
}

async function upsertClimbs(db: NeonDatabase<Record<string, never>>, board: AuroraBoardName, data: Climb[]): Promise<NewClimbInfo[]> {
  const climbsSchema = UNIFIED_TABLES.climbs;
  const climbHoldsSchema = UNIFIED_TABLES.climbHolds;

  if (data.length === 0) return [];

  // Check which UUIDs already exist to track new climbs
  const uuids = data.map((c) => c.uuid);
  const existingRows = await db
    .select({ uuid: climbsSchema.uuid })
    .from(climbsSchema)
    .where(inArray(climbsSchema.uuid, uuids));
  const existingUuids = new Set(existingRows.map((r) => r.uuid));

  await Promise.all(
    data.map(async (item: Climb) => {
      // Insert or update the climb
      await db
        .insert(climbsSchema)
        .values({
          uuid: item.uuid,
          boardType: board,
          name: item.name,
          description: item.description,
          hsm: item.hsm,
          edgeLeft: item.edge_left,
          edgeRight: item.edge_right,
          edgeBottom: item.edge_bottom,
          edgeTop: item.edge_top,
          framesCount: item.frames_count,
          framesPace: item.frames_pace,
          frames: item.frames,
          setterId: item.setter_id,
          setterUsername: item.setter_username,
          layoutId: item.layout_id,
          isDraft: item.is_draft,
          isListed: item.is_listed,
          createdAt: item.created_at,
          angle: item.angle,
        })
        .onConflictDoUpdate({
          target: [climbsSchema.uuid],
          set: {
            // Only allow isDraft to change from false to true (publishing)
            isDraft: sql`CASE WHEN ${climbsSchema.isDraft} = false AND ${item.is_draft} = true THEN true ELSE ${climbsSchema.isDraft} END`,
            // Only allow isListed to change from false to true (making public)
            isListed: sql`CASE WHEN ${climbsSchema.isListed} = false AND ${item.is_listed} = true THEN true ELSE ${climbsSchema.isListed} END`,
            // Allow updates to descriptive fields
            name: item.name,
            description: item.description,
            // Preserve all core climb data - never allow hostile updates to these critical fields
            hsm: climbsSchema.hsm,
            edgeLeft: climbsSchema.edgeLeft,
            edgeRight: climbsSchema.edgeRight,
            edgeBottom: climbsSchema.edgeBottom,
            edgeTop: climbsSchema.edgeTop,
            framesCount: climbsSchema.framesCount,
            framesPace: climbsSchema.framesPace,
            frames: climbsSchema.frames,
            setterId: climbsSchema.setterId,
            setterUsername: climbsSchema.setterUsername,
            layoutId: climbsSchema.layoutId,
            angle: climbsSchema.angle,
          },
        });

      const holdsByFrame = convertLitUpHoldsStringToMap(item.frames, board);

      const holdsToInsert = Object.entries(holdsByFrame).flatMap(([frameNumber, holds]) =>
        Object.entries(holds).map(([holdId, { state }]) => ({
          boardType: board,
          climbUuid: item.uuid,
          frameNumber: Number(frameNumber),
          holdId: Number(holdId),
          holdState: state,
        })),
      );

      await db.insert(climbHoldsSchema).values(holdsToInsert).onConflictDoNothing(); // Avoid duplicate inserts
    }),
  );

  // Return info about newly inserted climbs
  return data
    .filter((c) => !existingUuids.has(c.uuid))
    .map((c) => ({
      uuid: c.uuid,
      setterId: c.setter_id,
      setterUsername: c.setter_username,
      layoutId: c.layout_id,
      name: c.name,
    }));
}

async function upsertSharedTableData(
  db: NeonDatabase<Record<string, never>>,
  boardName: AuroraBoardName,
  tableName: string,
  data: SyncPutFields[],
): Promise<NewClimbInfo[]> {
  switch (tableName) {
    case 'attempts':
      await upsertAttempts(db, boardName, data as Attempt[]);
      return [];
    case 'climb_stats':
      await upsertClimbStats(db, boardName, data as ClimbStats[]);
      return [];
    case 'beta_links':
      await upsertBetaLinks(db, boardName, data as BetaLink[]);
      return [];
    case 'climbs':
      return await upsertClimbs(db, boardName, data as Climb[]);
    case 'shared_syncs':
      await updateSharedSyncs(db, boardName, data as SharedSync[]);
      return [];
    default:
      // Tables not in TABLES_TO_PROCESS are handled in the main sync loop
      console.log(`Table ${tableName} not handled in upsertSharedTableData`);
      return [];
  }
}
async function updateSharedSyncs(
  tx: NeonDatabase<Record<string, never>>,
  boardName: AuroraBoardName,
  sharedSyncs: SharedSync[],
) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;

  for (const sync of sharedSyncs) {
    await tx
      .insert(sharedSyncsSchema)
      .values({
        boardType: boardName,
        tableName: sync.table_name,
        lastSynchronizedAt: sync.last_synchronized_at,
      })
      .onConflictDoUpdate({
        target: [sharedSyncsSchema.boardType, sharedSyncsSchema.tableName],
        set: {
          lastSynchronizedAt: sync.last_synchronized_at,
        },
      });
  }
}

export async function getLastSharedSyncTimes(boardName: AuroraBoardName) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  const pool = getPool();
  const client = await pool.connect();

  try {
    const db = drizzle(client);
    const result = await db
      .select({
        table_name: sharedSyncsSchema.tableName,
        last_synchronized_at: sharedSyncsSchema.lastSynchronizedAt,
      })
      .from(sharedSyncsSchema)
      .where(eq(sharedSyncsSchema.boardType, boardName));

    return result;
  } finally {
    client.release();
  }
}

export async function syncSharedData(
  board: AuroraBoardName,
  token: string,
): Promise<{ complete: boolean; results: Record<string, { synced: number; complete: boolean }>; newClimbs: NewClimbInfo[] }> {
  try {
    console.log('Entered sync shared data');

    // Get shared sync times
    const allSyncTimes = await getLastSharedSyncTimes(board);
    console.log('Fetched previous sync times:', allSyncTimes);

    // Create a map of existing sync times
    const sharedSyncMap = new Map(allSyncTimes.map((sync) => [sync.table_name, sync.last_synchronized_at]));

    // Ensure all shared tables have a sync entry (default to 1970 if not synced)
    const defaultTimestamp = '1970-01-01 00:00:00.000000';

    const syncParams: SyncOptions = {
      tables: [...SHARED_SYNC_TABLES],
      sharedSyncs: SHARED_SYNC_TABLES.map((tableName) => ({
        table_name: tableName,
        last_synchronized_at: sharedSyncMap.get(tableName) || defaultTimestamp,
      })),
    };

    console.log('syncParams', syncParams);

    // Initialize results tracking
    const totalResults: Record<string, { synced: number; complete: boolean }> = {};
    const allNewClimbs: NewClimbInfo[] = [];
    let isComplete = false;

    const syncResults = await sharedSync(board, syncParams, token);
    console.log('syncResults keys:', Object.keys(syncResults));
    console.log('syncResults structure:', JSON.stringify(syncResults, null, 2).substring(0, 1000));

    // Process this batch in a transaction
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create a drizzle instance for this transaction
      const tx = drizzle(client);

      // Process each table - data is directly under table names
      for (const tableName of SHARED_SYNC_TABLES) {
        if (syncResults[tableName] && Array.isArray(syncResults[tableName])) {
          const data = syncResults[tableName];

          // Only process tables we actually care about
          if (TABLES_TO_PROCESS.has(tableName)) {
            console.log(`Syncing ${tableName}: ${data.length} records`);
            const newClimbs = await upsertSharedTableData(tx, board, tableName, data);
            allNewClimbs.push(...newClimbs);

            // Accumulate results
            if (!totalResults[tableName]) {
              totalResults[tableName] = { synced: 0, complete: false };
            }
            totalResults[tableName].synced += data.length;
          } else {
            console.log(`Skipping ${tableName}: ${data.length} records (not processed)`);
            // Still track in results but don't sync
            if (!totalResults[tableName]) {
              totalResults[tableName] = { synced: 0, complete: false };
            }
          }
        } else if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0, complete: false };
        }
      }

      // Update shared_syncs table with new sync times from this batch
      if (syncResults['shared_syncs']) {
        console.log('Updating shared_syncs with data:', syncResults['shared_syncs']);
        await updateSharedSyncs(tx, board, syncResults['shared_syncs']);

        // Update sync params for next iteration with new timestamps
        const newSharedSyncs = syncResults['shared_syncs'].map(
          (sync: { table_name: string; last_synchronized_at: string }) => ({
            table_name: sync.table_name,
            last_synchronized_at: sync.last_synchronized_at,
          }),
        );

        // Log timestamp updates for debugging
        const climbsSync = newSharedSyncs.find((s: { table_name: string }) => s.table_name === 'climbs');
        if (climbsSync) {
          console.log(`Climbs table sync timestamp updated to: ${climbsSync.last_synchronized_at}`);
        }

        // Update syncParams for next batch
        syncParams.sharedSyncs = newSharedSyncs;
      } else {
        console.log('No shared_syncs data in sync results');
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to commit sync database transaction:', error);
      throw error;
    } finally {
      client.release();
    }

    // Check if sync is complete - default to true if _complete is not present (matches Android app behavior)
    isComplete = syncResults._complete !== false;

    console.log(`Sync complete. _complete flag: ${syncResults._complete}, isComplete: ${isComplete}`);

    // Mark completion status for all tables
    Object.keys(totalResults).forEach((table) => {
      totalResults[table].complete = isComplete;
    });

    // Log summary of what was synced
    console.log('Sync batch summary:');
    Object.entries(totalResults).forEach(([table, result]) => {
      if (result.synced > 0) {
        console.log(`  ${table}: ${result.synced} records synced`);
      }
    });
    console.log(`Sync complete: ${isComplete}`);

    return { complete: isComplete, results: totalResults, newClimbs: allNewClimbs };
  } catch (error) {
    console.error('Error syncing shared data:', error);
    throw error;
  }
}
