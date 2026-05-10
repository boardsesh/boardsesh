import { userSync } from '../api/user-sync-api';
import { type SyncOptions, type UserSyncData, type AuroraBoardName, USER_TABLES } from '../api/types';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { UNIFIED_TABLES } from '../db/table-select';
import { boardseshTicks, playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema/app';
import { upsertUserClimbQuality, upsertUserClimbGrade } from '@boardsesh/db/queries';
import { randomUUID } from 'crypto';
import { convertQuality } from '@boardsesh/shared-schema';
import { formatDbError } from './db-error';

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

type UpsertResult = {
  synced: number;
  skipped: number;
  skippedReason?: string;
};

type AuroraApiRow = Record<string, string>;

type DrizzleDb = PostgresJsDatabase<Record<string, never>>;

async function upsertTableData(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  tableName: string,
  auroraUserId: number,
  nextAuthUserId: string,
  data: AuroraApiRow[],
  log: (message: string) => void = console.info,
): Promise<UpsertResult> {
  if (data.length === 0) return { synced: 0, skipped: 0 };

  log(`  Upserting ${data.length} rows for ${tableName} in batches of ${BATCH_SIZE}`);

  switch (tableName) {
    case 'users': {
      const usersSchema = UNIFIED_TABLES.users;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: boardName,
          id: Number(item.id),
          username: item.username,
          createdAt: item.created_at,
        }));
        await db
          .insert(usersSchema)
          .values(values)
          .onConflictDoUpdate({
            target: [usersSchema.boardType, usersSchema.id],
            set: {
              username: sql`excluded.username`,
            },
          });
      });
      break;
    }

    case 'walls': {
      const wallsSchema = UNIFIED_TABLES.walls;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: boardName,
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
          boardType: boardName,
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
      if (nextAuthUserId) {
        const now = new Date().toISOString();
        await processBatches(data, BATCH_SIZE, async (batch) => {
          const tickValues = batch.map((item) => ({
            uuid: randomUUID(),
            userId: nextAuthUserId,
            boardType: boardName,
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

          // Project each ascent's quality/difficulty into the user_climb_*
          // tables. The setWhere guard inside the helpers means out-of-order
          // Aurora replays can't clobber a newer opinion already on file.
          for (const tickValue of tickValues) {
            if (tickValue.quality != null) {
              await upsertUserClimbQuality(db, {
                userId: tickValue.userId,
                boardType: tickValue.boardType,
                climbUuid: tickValue.climbUuid,
                quality: tickValue.quality,
                recordedAt: tickValue.climbedAt,
              });
            }
            if (tickValue.difficulty != null) {
              await upsertUserClimbGrade(db, {
                userId: tickValue.userId,
                boardType: tickValue.boardType,
                climbUuid: tickValue.climbUuid,
                angle: tickValue.angle,
                difficulty: tickValue.difficulty,
                recordedAt: tickValue.climbedAt,
              });
            }
          }
        });
      } else {
        log(`  Skipping ascents sync: no NextAuth user ID provided`);
        return { synced: 0, skipped: data.length, skippedReason: 'No NextAuth user ID provided' };
      }
      break;
    }

    case 'bids': {
      if (nextAuthUserId) {
        const now = new Date().toISOString();
        await processBatches(data, BATCH_SIZE, async (batch) => {
          const tickValues = batch.map((item) => ({
            uuid: randomUUID(),
            userId: nextAuthUserId,
            boardType: boardName,
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
      } else {
        log(`  Skipping bids sync: no NextAuth user ID provided`);
        return { synced: 0, skipped: data.length, skippedReason: 'No NextAuth user ID provided' };
      }
      break;
    }

    case 'tags': {
      const tagsSchema = UNIFIED_TABLES.tags;
      await processBatches(data, BATCH_SIZE, async (batch) => {
        for (const item of batch) {
          const result = await db
            .update(tagsSchema)
            .set({
              isListed: Boolean(item.is_listed),
            })
            .where(
              and(
                eq(tagsSchema.boardType, boardName),
                eq(tagsSchema.entityUuid, item.entity_uuid),
                eq(tagsSchema.userId, Number(auroraUserId)),
                eq(tagsSchema.name, item.name),
              ),
            )
            .returning();

          if (result.length === 0) {
            await db.insert(tagsSchema).values({
              boardType: boardName,
              entityUuid: item.entity_uuid,
              userId: Number(auroraUserId),
              name: item.name,
              isListed: Boolean(item.is_listed),
            });
          }
        }
      });
      break;
    }

    case 'circuits': {
      const circuitsSchema = UNIFIED_TABLES.circuits;

      await processBatches(data, BATCH_SIZE, async (batch) => {
        const values = batch.map((item) => ({
          boardType: boardName,
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

      if (nextAuthUserId) {
        for (const item of data) {
          const formattedColor = item.color ? `#${item.color}` : null;

          const [playlist] = await db
            .insert(playlists)
            .values({
              uuid: item.uuid,
              boardType: boardName,
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
            .values({
              playlistId: playlist.id,
              userId: nextAuthUserId,
              role: 'owner',
            })
            .onConflictDoNothing();

          if (item.climbs && Array.isArray(item.climbs)) {
            await db.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

            for (let i = 0; i < item.climbs.length; i++) {
              const climb = item.climbs[i];
              const climbUuid = climb.climb_uuid || climb.uuid || climb;
              const climbAngle = climb.angle ?? null;
              const climbPosition = climb.position ?? i;

              if (typeof climbUuid === 'string') {
                await db.insert(playlistClimbs).values({
                  playlistId: playlist.id,
                  climbUuid: climbUuid,
                  angle: climbAngle,
                  position: climbPosition,
                });
              }
            }
          }
        }
        log(`  Synced ${data.length} circuits to playlists table`);
      }
      break;
    }

    default:
      log(`  No specific upsert logic for table: ${tableName}`);
      return {
        synced: 0,
        skipped: data.length,
        skippedReason: `No upsert logic for table: ${tableName}`,
      };
  }

  return { synced: data.length, skipped: 0 };
}

async function updateUserSyncs(tx: DrizzleDb, boardName: AuroraBoardName, userSyncs: UserSyncData[]) {
  const userSyncsSchema = UNIFIED_TABLES.userSyncs;

  for (const sync of userSyncs) {
    await tx
      .insert(userSyncsSchema)
      .values({
        boardType: boardName,
        userId: Number(sync.user_id),
        tableName: sync.table_name,
        lastSynchronizedAt: sync.last_synchronized_at,
      })
      .onConflictDoUpdate({
        target: [userSyncsSchema.boardType, userSyncsSchema.userId, userSyncsSchema.tableName],
        set: {
          lastSynchronizedAt: sync.last_synchronized_at,
        },
      });
  }
}

export async function getLastSyncTimes(
  pgClient: ReturnType<typeof postgres>,
  boardName: AuroraBoardName,
  userId: number,
  tableNames: string[],
) {
  const userSyncsSchema = UNIFIED_TABLES.userSyncs;
  const db = drizzle(pgClient);
  return db
    .select()
    .from(userSyncsSchema)
    .where(
      and(
        eq(userSyncsSchema.boardType, boardName),
        eq(userSyncsSchema.userId, Number(userId)),
        inArray(userSyncsSchema.tableName, tableNames),
      ),
    );
}

export async function getLastSharedSyncTimes(
  pgClient: ReturnType<typeof postgres>,
  boardName: AuroraBoardName,
  tableNames: string[],
) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  const db = drizzle(pgClient);
  return db
    .select()
    .from(sharedSyncsSchema)
    .where(and(eq(sharedSyncsSchema.boardType, boardName), inArray(sharedSyncsSchema.tableName, tableNames)));
}

export type SyncTableResult = {
  synced: number;
  skipped?: number;
  skippedReason?: string;
};

export type SyncUserDataResult = Record<string, SyncTableResult>;

export async function syncUserData(
  pgClient: ReturnType<typeof postgres>,
  board: AuroraBoardName,
  token: string,
  auroraUserId: number,
  nextAuthUserId: string,
  tables: string[] = USER_TABLES,
  log: (message: string) => void = console.info,
): Promise<SyncUserDataResult> {
  try {
    const syncParams: SyncOptions = {
      tables,
    };

    const allSyncTimes = await getLastSyncTimes(pgClient, board, auroraUserId, tables);
    const userSyncMap = new Map(allSyncTimes.map((sync) => [sync.tableName, sync.lastSynchronizedAt]));

    const defaultTimestamp = '1970-01-01 00:00:00.000000';

    syncParams.userSyncs = tables.map((tableName) => ({
      table_name: tableName,
      last_synchronized_at: userSyncMap.get(tableName) || defaultTimestamp,
      user_id: Number(auroraUserId),
    }));

    log(`Syncing ${tables.length} tables for user ${auroraUserId}`);

    const totalResults: SyncUserDataResult = {};

    let currentSyncParams = syncParams;
    let isComplete = false;
    let syncAttempts = 0;
    const maxSyncAttempts = 50;

    const db = drizzle(pgClient);

    while (!isComplete && syncAttempts < maxSyncAttempts) {
      syncAttempts++;
      log(`Sync attempt ${syncAttempts} for user ${auroraUserId}`);

      const syncResults = await userSync(board, auroraUserId, currentSyncParams, token);

      try {
        await db.transaction(async (tx) => {
          for (const tableName of tables) {
            log(`Syncing ${tableName} for user ${auroraUserId} (batch ${syncAttempts})`);
            if (syncResults[tableName] && Array.isArray(syncResults[tableName])) {
              const data = syncResults[tableName];

              const upsertResult = await upsertTableData(
                tx as unknown as DrizzleDb,
                board,
                tableName,
                auroraUserId,
                nextAuthUserId,
                data,
                log,
              );

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

          if (syncResults['user_syncs']) {
            await updateUserSyncs(tx as unknown as DrizzleDb, board, syncResults['user_syncs']);

            const newUserSyncs = syncResults['user_syncs'].map(
              (sync: { table_name: string; last_synchronized_at: string }) => ({
                table_name: sync.table_name,
                last_synchronized_at: sync.last_synchronized_at,
                user_id: Number(auroraUserId),
              }),
            );

            currentSyncParams = {
              ...currentSyncParams,
              userSyncs: newUserSyncs,
            };
          }
        });
      } catch (error) {
        const formatted = formatDbError(error);
        log(formatted);
        throw new Error(formatted);
      }

      isComplete = syncResults._complete !== false;

      if (!isComplete) {
        log(`Sync not complete for user ${auroraUserId}, continuing with next batch...`);
      } else {
        log(`Sync complete for user ${auroraUserId} after ${syncAttempts} attempts`);
      }
    }

    if (syncAttempts >= maxSyncAttempts) {
      log(`Sync reached maximum attempts (${maxSyncAttempts}) for user ${auroraUserId}`);
    }

    return totalResults;
  } catch (error) {
    const formatted = formatDbError(error);
    log(`Error syncing user data: ${formatted}`);
    throw error instanceof Error ? error : new Error(formatted);
  }
}
