/**
 * Kilter user data sync.
 *
 * Uses the new sync stream at sync1.kiltergrips.com with Bearer token auth.
 * The response format is the same table-keyed JSON as the old Aurora /sync,
 * so we reuse the same upsert logic from aurora-sync.
 */

import { kilterUserSync } from '../api/kilter-sync-api';
import type { KilterSyncOptions, KilterSyncData } from '../api/types';
import { KILTER_USER_TABLES } from '../api/types';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { Pool } from '@neondatabase/serverless';
import { UNIFIED_TABLES } from '../db/table-select';
import { boardseshTicks, playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema/app';
import { randomUUID } from 'crypto';
import { convertQuality } from './convert-quality';

const BOARD_TYPE = 'kilter' as const;
const BATCH_SIZE = 100;

async function processBatches<T>(
  data: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    await processor(batch);
  }
}

interface UpsertResult {
  synced: number;
  skipped: number;
  skippedReason?: string;
}

type SyncRow = Record<string, string>;

async function upsertTableData(
  db: NeonDatabase<Record<string, never>>,
  tableName: string,
  auroraUserId: number,
  nextAuthUserId: string,
  data: SyncRow[],
  log: (message: string) => void = console.log,
): Promise<UpsertResult> {
  if (data.length === 0) return { synced: 0, skipped: 0 };

  log(`  Upserting ${data.length} rows for ${tableName} in batches of ${BATCH_SIZE}`);

  switch (tableName) {
    case 'users': {
      const usersSchema = UNIFIED_TABLES.users;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: BOARD_TYPE,
          id: Number(item.id),
          username: item.username,
          createdAt: item.created_at,
        }));
        await db
          .insert(usersSchema)
          .values(values)
          .onConflictDoUpdate({
            target: [usersSchema.boardType, usersSchema.id],
            set: { username: sql`excluded.username` },
          });
      });
      break;
    }

    case 'walls': {
      const wallsSchema = UNIFIED_TABLES.walls;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: BOARD_TYPE,
          uuid: item.uuid,
          userId: Number(auroraUserId),
          name: item.name,
          productId: Number(item.product_id),
          isAdjustable: Boolean(item.is_adjustable),
          angle: Number(item.angle),
          layoutId: Number(item.layout_id),
          productSizeId: Number(item.product_size_id),
          hsm: Number(item.hsm),
          serialNumber: item.serial_number,
          createdAt: item.created_at,
        }));
        await db
          .insert(wallsSchema)
          .values(values)
          .onConflictDoUpdate({
            target: [wallsSchema.boardType, wallsSchema.uuid],
            set: {
              name: sql`excluded.name`,
              isAdjustable: sql`excluded.is_adjustable`,
              angle: sql`excluded.angle`,
              layoutId: sql`excluded.layout_id`,
              productSizeId: sql`excluded.product_size_id`,
              hsm: sql`excluded.hsm`,
              serialNumber: sql`excluded.serial_number`,
            },
          });
      });
      break;
    }

    case 'draft_climbs': {
      const climbsSchema = UNIFIED_TABLES.climbs;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: BOARD_TYPE,
          uuid: item.uuid,
          layoutId: Number(item.layout_id),
          setterId: Number(auroraUserId),
          setterUsername: item.setter_username || '',
          name: item.name || 'Untitled Draft',
          description: item.description || '',
          hsm: Number(item.hsm),
          edgeLeft: Number(item.edge_left),
          edgeRight: Number(item.edge_right),
          edgeBottom: Number(item.edge_bottom),
          edgeTop: Number(item.edge_top),
          angle: item.angle != null && !isNaN(Number(item.angle)) ? Number(item.angle) : null,
          framesCount: Number(item.frames_count || 1),
          framesPace: Number(item.frames_pace || 0),
          frames: item.frames || '',
          isDraft: true,
          isListed: false,
          createdAt: item.created_at || new Date().toISOString(),
          synced: true,
          syncError: null,
          userId: null,
        }));
        await db
          .insert(climbsSchema)
          .values(values)
          .onConflictDoUpdate({
            target: climbsSchema.uuid,
            set: {
              layoutId: sql`excluded.layout_id`,
              setterId: sql`excluded.setter_id`,
              setterUsername: sql`excluded.setter_username`,
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              hsm: sql`excluded.hsm`,
              edgeLeft: sql`excluded.edge_left`,
              edgeRight: sql`excluded.edge_right`,
              edgeBottom: sql`excluded.edge_bottom`,
              edgeTop: sql`excluded.edge_top`,
              angle: sql`excluded.angle`,
              framesCount: sql`excluded.frames_count`,
              framesPace: sql`excluded.frames_pace`,
              frames: sql`excluded.frames`,
              isDraft: sql`excluded.is_draft`,
              isListed: sql`excluded.is_listed`,
            },
          });
      });
      break;
    }

    case 'ascents': {
      if (!nextAuthUserId) {
        log(`  Skipping ascents sync: no NextAuth user ID`);
        return { synced: 0, skipped: data.length, skippedReason: 'No NextAuth user ID' };
      }
      const now = new Date().toISOString();
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const tickValues = batch.map((item) => ({
          uuid: randomUUID(),
          userId: nextAuthUserId,
          boardType: BOARD_TYPE,
          climbUuid: item.climb_uuid,
          angle: Number(item.angle),
          isMirror: Boolean(item.is_mirror),
          status: (Number(item.attempt_id) === 1 ? 'flash' : 'send') as 'flash' | 'send' | 'attempt',
          attemptCount: Number(item.bid_count || 1),
          quality: convertQuality(item.quality ? Number(item.quality) : null),
          difficulty: item.difficulty ? Number(item.difficulty) : null,
          isBenchmark: Boolean(item.is_benchmark || 0),
          comment: item.comment || '',
          climbedAt: new Date(item.climbed_at).toISOString(),
          createdAt: item.created_at ? new Date(item.created_at).toISOString() : now,
          updatedAt: now,
          auroraType: 'ascents' as const,
          auroraId: item.uuid,
          auroraSyncedAt: now,
        }));
        await db
          .insert(boardseshTicks)
          .values(tickValues)
          .onConflictDoUpdate({
            target: boardseshTicks.auroraId,
            set: {
              climbUuid: sql`excluded.climb_uuid`,
              angle: sql`excluded.angle`,
              isMirror: sql`excluded.is_mirror`,
              status: sql`excluded.status`,
              attemptCount: sql`excluded.attempt_count`,
              quality: sql`excluded.quality`,
              difficulty: sql`excluded.difficulty`,
              isBenchmark: sql`excluded.is_benchmark`,
              comment: sql`excluded.comment`,
              climbedAt: sql`excluded.climbed_at`,
              updatedAt: sql`excluded.updated_at`,
              auroraSyncedAt: sql`excluded.aurora_synced_at`,
            },
          });
      });
      break;
    }

    case 'bids': {
      if (!nextAuthUserId) {
        log(`  Skipping bids sync: no NextAuth user ID`);
        return { synced: 0, skipped: data.length, skippedReason: 'No NextAuth user ID' };
      }
      const now = new Date().toISOString();
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const tickValues = batch.map((item) => ({
          uuid: randomUUID(),
          userId: nextAuthUserId,
          boardType: BOARD_TYPE,
          climbUuid: item.climb_uuid,
          angle: Number(item.angle),
          isMirror: Boolean(item.is_mirror),
          status: 'attempt' as const,
          attemptCount: Number(item.bid_count || 1),
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: item.comment || '',
          climbedAt: new Date(item.climbed_at).toISOString(),
          createdAt: new Date(item.created_at).toISOString(),
          updatedAt: now,
          auroraType: 'bids' as const,
          auroraId: item.uuid,
          auroraSyncedAt: now,
        }));
        await db
          .insert(boardseshTicks)
          .values(tickValues)
          .onConflictDoUpdate({
            target: boardseshTicks.auroraId,
            set: {
              climbUuid: sql`excluded.climb_uuid`,
              angle: sql`excluded.angle`,
              isMirror: sql`excluded.is_mirror`,
              attemptCount: sql`excluded.attempt_count`,
              comment: sql`excluded.comment`,
              climbedAt: sql`excluded.climbed_at`,
              updatedAt: sql`excluded.updated_at`,
              auroraSyncedAt: sql`excluded.aurora_synced_at`,
            },
          });
      });
      break;
    }

    case 'tags': {
      const tagsSchema = UNIFIED_TABLES.tags;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: BOARD_TYPE,
          entityUuid: item.entity_uuid,
          userId: Number(auroraUserId),
          name: item.name,
          isListed: Boolean(item.is_listed),
        }));
        await db
          .insert(tagsSchema)
          .values(values)
          .onConflictDoUpdate({
            target: [tagsSchema.boardType, tagsSchema.entityUuid, tagsSchema.userId, tagsSchema.name],
            set: { isListed: sql`excluded.is_listed` },
          });
      });
      break;
    }

    case 'circuits': {
      const circuitsSchema = UNIFIED_TABLES.circuits;

      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: BOARD_TYPE,
          uuid: item.uuid,
          name: item.name,
          description: item.description,
          color: item.color,
          userId: Number(auroraUserId),
          isPublic: Boolean(item.is_public),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        }));
        await db
          .insert(circuitsSchema)
          .values(values)
          .onConflictDoUpdate({
            target: [circuitsSchema.boardType, circuitsSchema.uuid],
            set: {
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              color: sql`excluded.color`,
              isPublic: sql`excluded.is_public`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      });

      // Dual-write to playlists
      if (nextAuthUserId) {
        for (const item of data) {
          const formattedColor = item.color ? `#${item.color}` : null;

          const [playlist] = await db
            .insert(playlists)
            .values({
              uuid: item.uuid,
              boardType: BOARD_TYPE,
              layoutId: null,
              name: item.name || 'Untitled Circuit',
              description: item.description || null,
              isPublic: Boolean(item.is_public),
              color: formattedColor,
              auroraType: 'circuits',
              auroraId: item.uuid,
              auroraSyncedAt: new Date(),
              createdAt: item.created_at ? new Date(item.created_at) : new Date(),
              updatedAt: item.updated_at ? new Date(item.updated_at) : new Date(),
            })
            .onConflictDoUpdate({
              target: playlists.auroraId,
              set: {
                name: item.name || 'Untitled Circuit',
                description: item.description || null,
                isPublic: Boolean(item.is_public),
                color: formattedColor,
                updatedAt: item.updated_at ? new Date(item.updated_at) : new Date(),
                auroraSyncedAt: new Date(),
              },
            })
            .returning({ id: playlists.id });

          await db
            .insert(playlistOwnership)
            .values({ playlistId: playlist.id, userId: nextAuthUserId, role: 'owner' })
            .onConflictDoNothing();

          if (item.climbs && Array.isArray(item.climbs)) {
            await db.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

            const climbValues: Array<{
              playlistId: bigint;
              climbUuid: string;
              angle: number | null;
              position: number;
            }> = [];
            for (let i = 0; i < item.climbs.length; i++) {
              const climb = item.climbs[i] as Record<string, unknown>;
              const climbUuid = climb.climb_uuid || climb.uuid || climb;
              if (typeof climbUuid === 'string') {
                climbValues.push({
                  playlistId: playlist.id,
                  climbUuid,
                  angle: (climb.angle as number) ?? null,
                  position: (climb.position as number) ?? i,
                });
              }
            }

            if (climbValues.length > 0) {
              await processBatches(climbValues, BATCH_SIZE, async (batch) => {
                await db.insert(playlistClimbs).values(batch);
              });
            }
          }
        }
        log(`  Synced ${data.length} circuits to playlists table`);
      }
      break;
    }

    default:
      log(`  No upsert logic for table: ${tableName}`);
      return { synced: 0, skipped: data.length, skippedReason: `No upsert logic for table: ${tableName}` };
  }

  return { synced: data.length, skipped: 0 };
}

async function updateUserSyncs(
  tx: NeonDatabase<Record<string, never>>,
  userSyncs: Array<{ table_name: string; last_synchronized_at: string; user_id: number }>,
) {
  const userSyncsSchema = UNIFIED_TABLES.userSyncs;

  for (const sync of userSyncs) {
    await tx
      .insert(userSyncsSchema)
      .values({
        boardType: BOARD_TYPE,
        userId: Number(sync.user_id),
        tableName: sync.table_name,
        lastSynchronizedAt: sync.last_synchronized_at,
      })
      .onConflictDoUpdate({
        target: [userSyncsSchema.boardType, userSyncsSchema.userId, userSyncsSchema.tableName],
        set: { lastSynchronizedAt: sync.last_synchronized_at },
      });
  }
}

export async function getLastSyncTimes(pool: Pool, userId: number, tableNames: string[]) {
  const userSyncsSchema = UNIFIED_TABLES.userSyncs;
  const client = await pool.connect();

  try {
    const db = drizzle(client);
    return await db
      .select()
      .from(userSyncsSchema)
      .where(
        and(
          eq(userSyncsSchema.boardType, BOARD_TYPE),
          eq(userSyncsSchema.userId, Number(userId)),
          inArray(userSyncsSchema.tableName, tableNames),
        ),
      );
  } finally {
    client.release();
  }
}

export interface SyncTableResult {
  synced: number;
  skipped?: number;
  skippedReason?: string;
}

export interface KilterSyncUserDataResult {
  [tableName: string]: SyncTableResult;
}

/**
 * Sync user data from the new Kilter API into the Boardsesh database.
 *
 * @param pool      - Neon connection pool
 * @param accessToken - Kilter OAuth2 access token (Bearer)
 * @param auroraUserId - The user's numeric Aurora user ID (still used in sync stream data)
 * @param nextAuthUserId - The Boardsesh NextAuth user ID
 * @param tables    - Which tables to sync (defaults to all user tables)
 * @param log       - Logger function
 */
export async function syncKilterUserData(
  pool: Pool,
  accessToken: string,
  auroraUserId: number,
  nextAuthUserId: string,
  tables: string[] = KILTER_USER_TABLES,
  log: (message: string) => void = console.log,
): Promise<KilterSyncUserDataResult> {
  const syncOptions: KilterSyncOptions = { tables };

  // Get existing sync timestamps
  const allSyncTimes = await getLastSyncTimes(pool, auroraUserId, tables);
  const userSyncMap = new Map(allSyncTimes.map((s) => [s.tableName, s.lastSynchronizedAt]));
  const defaultTimestamp = '1970-01-01 00:00:00.000000';

  syncOptions.userSyncs = tables.map((tableName) => ({
    table_name: tableName,
    last_synchronized_at: userSyncMap.get(tableName) || defaultTimestamp,
    user_id: Number(auroraUserId),
  }));

  log(`[KilterSync] Syncing ${tables.length} tables for user ${auroraUserId}`);

  const totalResults: KilterSyncUserDataResult = {};
  let currentOptions = syncOptions;
  let isComplete = false;
  let attempts = 0;
  const maxAttempts = 50;

  while (!isComplete && attempts < maxAttempts) {
    attempts++;
    log(`[KilterSync] Sync batch ${attempts} for user ${auroraUserId}`);

    const syncResults = await kilterUserSync(accessToken, currentOptions) as KilterSyncData;

    // Process batch in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = drizzle(client);

      for (const tableName of tables) {
        log(`[KilterSync] Processing ${tableName} (batch ${attempts})`);
        if (syncResults[tableName] && Array.isArray(syncResults[tableName])) {
          const data = syncResults[tableName] as SyncRow[];

          const upsertResult = await upsertTableData(tx, tableName, auroraUserId, nextAuthUserId, data, log);

          if (!totalResults[tableName]) {
            totalResults[tableName] = { synced: 0 };
          }
          totalResults[tableName].synced += upsertResult.synced;
          if (upsertResult.skipped > 0) {
            totalResults[tableName].skipped = (totalResults[tableName].skipped || 0) + upsertResult.skipped;
            totalResults[tableName].skippedReason = upsertResult.skippedReason;
          }
        } else if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0 };
        }
      }

      // Update sync timestamps
      if (syncResults['user_syncs'] && Array.isArray(syncResults['user_syncs'])) {
        const userSyncsData = syncResults['user_syncs'] as Array<{
          table_name: string;
          last_synchronized_at: string;
          user_id: number;
        }>;
        await updateUserSyncs(tx, userSyncsData);

        currentOptions = {
          ...currentOptions,
          userSyncs: userSyncsData.map((s) => ({
            table_name: s.table_name,
            last_synchronized_at: s.last_synchronized_at,
            user_id: Number(auroraUserId),
          })),
        };
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const errorMessage =
        error instanceof Error
          ? error.message.includes('violates foreign key constraint')
            ? `FK constraint violation: ${error.message.split('violates foreign key constraint')[1]?.split('"')[1] || 'unknown'}`
            : error.message.slice(0, 2000)
          : String(error).slice(0, 2000);
      log(`[KilterSync] Database error: ${errorMessage}`);
      throw new Error(`Database error: ${errorMessage}`);
    } finally {
      client.release();
    }

    isComplete = syncResults._complete !== false;

    if (!isComplete) {
      log(`[KilterSync] Sync not complete, continuing...`);
    } else {
      log(`[KilterSync] Sync complete after ${attempts} batches`);
    }
  }

  if (attempts >= maxAttempts) {
    log(`[KilterSync] Reached max attempts (${maxAttempts})`);
  }

  return totalResults;
}
