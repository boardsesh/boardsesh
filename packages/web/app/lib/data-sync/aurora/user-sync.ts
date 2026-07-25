import { getDb } from '@/app/lib/db/db';
import { userSync } from '../../api-wrappers/aurora/userSync';
import {
  type SyncOptions,
  type UserSyncData,
  type AuroraBoardName,
  USER_TABLES,
} from '../../api-wrappers/aurora/types';
import { eq, and, inArray, asc } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { foreignPlaylistOwnerGuard, selectUpstreamPlaylistOwners } from '@boardsesh/db/queries';
import {
  resolveUpstreamPlaylistWrite,
  canWriteUpstreamPlaylist,
  upstreamPlaylistSkipLogLine,
} from '@boardsesh/sync-runtime';
import { UNIFIED_TABLES } from '../../db/queries/util/table-select';
import { auroraCredentials, playlists, playlistClimbs, playlistOwnership } from '../../db/schema';
// Narrow subpath import (not the `./sync` barrel) so the web bundle doesn't
// transitively pull the aurora daemon's postgres-js client — apply-user-logbook
// is self-contained (drizzle-orm + @boardsesh/db + shared-schema only).
import { applyAuroraAscents, applyAuroraBids } from '@boardsesh/aurora-sync/apply-user-logbook';

/**
 * Get NextAuth user ID from Aurora user ID.
 *
 * When one Aurora account is linked to two Boardsesh users this is inherently
 * ambiguous — there is no "the" user. It used to be an unordered LIMIT 1, so
 * the winner was whatever the planner handed back and could differ between
 * calls; ordering by created_at at least makes it the ORIGINAL claimant every
 * time. It is not a fix for the ambiguity: the ownership guard in the circuits
 * branch below is what stops the wrong answer corrupting the other user's
 * playlists (#3526). The real remedy is the duplicate-link rejection in
 * `packages/backend/src/services/aurora-credentials.ts`, which blocks new
 * duplicates at link time.
 */
async function getNextAuthUserId(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardName: AuroraBoardName,
  auroraUserId: number,
): Promise<string | null> {
  const result = await db
    .select({ userId: auroraCredentials.userId })
    .from(auroraCredentials)
    .where(and(eq(auroraCredentials.boardType, boardName), eq(auroraCredentials.auroraUserId, auroraUserId)))
    .orderBy(asc(auroraCredentials.createdAt), asc(auroraCredentials.userId))
    .limit(1);

  return result[0]?.userId || null;
}

/**
 * Exported for unit tests: the circuits branch carries the duplicate-account
 * ownership guard (#3526) and there is no other seam to drive it through
 * without a live Aurora API.
 */
export async function upsertTableData(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardName: AuroraBoardName,
  tableName: string,
  auroraUserId: number,
  nextAuthUserId: string,
  data: Record<string, string>[],
) {
  if (data.length === 0) return;

  switch (tableName) {
    case 'users': {
      const usersSchema = UNIFIED_TABLES.users;
      for (const item of data) {
        await db
          .insert(usersSchema)
          .values({
            boardType: boardName,
            id: Number(item.id),
            username: item.username,
            createdAt: item.created_at,
          })
          .onConflictDoUpdate({
            target: [usersSchema.boardType, usersSchema.id],
            set: {
              username: item.username,
            },
          });
      }
      break;
    }

    case 'walls': {
      const wallsSchema = UNIFIED_TABLES.walls;
      for (const item of data) {
        await db
          .insert(wallsSchema)
          .values({
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
          })
          .onConflictDoUpdate({
            target: [wallsSchema.boardType, wallsSchema.uuid],
            set: {
              name: item.name,
              isAdjustable: Boolean(item.is_adjustable),
              angle: Number(item.angle),
              layoutId: Number(item.layout_id),
              productSizeId: Number(item.product_size_id),
              hsm: Number(item.hsm),
              serialNumber: item.serial_number,
            },
          });
      }
      break;
    }

    case 'draft_climbs': {
      const climbsSchema = UNIFIED_TABLES.climbs;
      for (const item of data) {
        await db
          .insert(climbsSchema)
          .values({
            uuid: item.uuid,
            boardType: boardName,
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
            angle: Number(item.angle),
            framesCount: Number(item.frames_count || 1),
            framesPace: Number(item.frames_pace || 0),
            frames: item.frames || '',
            isDraft: true,
            isListed: false,
            createdAt: item.created_at || new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: climbsSchema.uuid,
            set: {
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
              angle: Number(item.angle),
              framesCount: Number(item.frames_count || 1),
              framesPace: Number(item.frames_pace || 0),
              frames: item.frames || '',
              isDraft: true,
              isListed: false,
            },
          });
      }
      break;
    }

    case 'ascents': {
      // Timezone-correct write + cross-source claim + soft-delete + edit guard
      // all live in the shared apply module (aurora-sync/apply-user-logbook).
      await applyAuroraAscents(db, boardName, nextAuthUserId, data);
      break;
    }

    case 'bids': {
      await applyAuroraBids(db, boardName, nextAuthUserId, data);
      break;
    }

    case 'tags': {
      const tagsSchema = UNIFIED_TABLES.tags;
      for (const item of data) {
        // First try to update existing record
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

        // If no record was updated, insert a new one
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
      break;
    }

    case 'circuits': {
      const circuitsSchema = UNIFIED_TABLES.circuits;
      // Who already owns the playlists behind these circuit uuids?
      // `playlists_aurora_id_idx` is a GLOBAL unique index, so the
      // `ON CONFLICT (aurora_id) DO UPDATE` below lands on whichever Boardsesh
      // user's row got there first, and the ownership insert then hands this
      // user an `owner` edge on it. That is how the 8 cross-linked tension
      // playlists in prod were created (#3526 / #3541), and this legacy proxy
      // route is the third writer of that shape — the other two live in
      // `@boardsesh/aurora-sync`. Same guard, same helper.
      const ownersByAuroraId = nextAuthUserId
        ? await selectUpstreamPlaylistOwners(
            db,
            playlists.auroraId,
            data.map((item) => item.uuid).filter((uuid): uuid is string => typeof uuid === 'string'),
          )
        : new Map<string, string[]>();

      for (const item of data) {
        // 1. Write to unified circuits table
        await db
          .insert(circuitsSchema)
          .values({
            boardType: boardName,
            uuid: item.uuid,
            name: item.name,
            description: item.description,
            color: item.color,
            userId: Number(auroraUserId),
            isPublic: Boolean(item.is_public),
            createdAt: item.created_at,
            updatedAt: item.updated_at,
          })
          .onConflictDoUpdate({
            target: [circuitsSchema.boardType, circuitsSchema.uuid],
            set: {
              name: item.name,
              description: item.description,
              color: item.color,
              isPublic: Boolean(item.is_public),
              updatedAt: item.updated_at,
            },
          });

        // 2. Dual write to playlists table (only if NextAuth user exists)
        if (nextAuthUserId) {
          const decision = resolveUpstreamPlaylistWrite(ownersByAuroraId.get(item.uuid) ?? [], nextAuthUserId);
          if (!canWriteUpstreamPlaylist(decision)) {
            // Refuse the whole dual-write — upsert, ownership grant AND the
            // playlist_climbs replace below. Skipping only the upsert would
            // still wipe the other user's climbs further down.
            console.warn(
              upstreamPlaylistSkipLogLine({
                syncTag: 'aurora-proxy',
                upstreamIdColumn: 'aurora_id',
                upstreamId: item.uuid,
                syncingUserId: nextAuthUserId,
                decision,
              }),
            );
            continue;
          }

          // Format color - Aurora uses hex without #, we store with #
          const formattedColor = item.color ? `#${item.color}` : null;

          // Insert/update playlist
          const [playlist] = await db
            .insert(playlists)
            .values({
              uuid: item.uuid, // Use same UUID as Aurora circuit
              boardType: boardName,
              layoutId: null, // Nullable for Aurora-synced circuits
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
              // SQL-level twin of the decision gate above, evaluated at
              // statement time against the conflicting row.
              setWhere: foreignPlaylistOwnerGuard(nextAuthUserId),
            })
            .returning({ id: playlists.id });

          // Empty when the guard suppressed the DO UPDATE — abandon the item
          // rather than dereferencing an undefined id.
          if (!playlist) continue;

          // 3. Create ownership if not exists
          await db
            .insert(playlistOwnership)
            .values({
              playlistId: playlist.id,
              userId: nextAuthUserId,
              role: 'owner',
            })
            .onConflictDoNothing();

          // 4. Sync playlist climbs (from nested climbs array)
          if (item.climbs && Array.isArray(item.climbs)) {
            // Delete existing climbs for this playlist to handle removals
            await db.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

            // Insert new climbs
            for (let i = 0; i < item.climbs.length; i++) {
              const climb = item.climbs[i];
              // Handle different possible structures of climb data
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
      }
      break;
    }

    default:
      console.warn(`No specific upsert logic for table: ${tableName}`);
      break;
  }
}

async function updateUserSyncs(
  tx: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardName: AuroraBoardName,
  userSyncs: UserSyncData[],
) {
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

export async function getLastSyncTimes(boardName: AuroraBoardName, userId: number, tableNames: string[]) {
  const userSyncsSchema = UNIFIED_TABLES.userSyncs;
  const db = getDb();

  const result = await db
    .select()
    .from(userSyncsSchema)
    .where(
      and(
        eq(userSyncsSchema.boardType, boardName),
        eq(userSyncsSchema.userId, Number(userId)),
        inArray(userSyncsSchema.tableName, tableNames),
      ),
    );

  return result;
}

export async function syncUserData(
  board: AuroraBoardName,
  token: string,
  userId: number,
  tables: string[] = USER_TABLES,
): Promise<Record<string, { synced: number }>> {
  try {
    const syncParams: SyncOptions = {
      tables,
    };

    // Get user sync times
    const allSyncTimes = await getLastSyncTimes(board, userId, tables);

    // Create a map of existing sync times
    const userSyncMap = new Map(allSyncTimes.map((sync) => [sync.tableName, sync.lastSynchronizedAt]));

    // Ensure all user tables have a sync entry (default to 1970 if not synced)
    const defaultTimestamp = '1970-01-01 00:00:00.000000';

    syncParams.userSyncs = tables.map((tableName) => ({
      table_name: tableName,
      last_synchronized_at: userSyncMap.get(tableName) || defaultTimestamp,
      user_id: Number(userId),
    }));

    // Initialize results tracking
    const totalResults: Record<string, { synced: number }> = {};

    // Recursive sync until _complete is true
    let currentSyncParams = syncParams;
    let isComplete = false;
    let syncAttempts = 0;
    const maxSyncAttempts = 50; // Prevent infinite loops

    while (!isComplete && syncAttempts < maxSyncAttempts) {
      syncAttempts++;

      const syncResults = await userSync(board, userId, currentSyncParams, token);

      // Process this batch in a transaction
      const db = getDb();
      await db.transaction(async (tx) => {
        // Get NextAuth user ID for dual write to boardsesh_ticks
        const nextAuthUserId = await getNextAuthUserId(tx, board, userId);
        if (!nextAuthUserId) {
          console.warn(`No NextAuth user found for Aurora user ${userId} on ${board}, skipping ascents/bids sync`);
          // We can still sync other tables (users, walls, etc.) that don't need NextAuth user ID
        }

        // Process each table - data is directly under table names
        for (const tableName of tables) {
          if (syncResults[tableName] && Array.isArray(syncResults[tableName])) {
            const data = syncResults[tableName];

            // Skip ascents/bids if no NextAuth user (can't dual write)
            if ((tableName === 'ascents' || tableName === 'bids') && !nextAuthUserId) {
              console.warn(`Skipping ${tableName} sync for Aurora user ${userId} - no NextAuth mapping`);
              continue;
            }

            await upsertTableData(tx, board, tableName, userId, nextAuthUserId || '', data);

            // Accumulate results
            if (!totalResults[tableName]) {
              totalResults[tableName] = { synced: 0 };
            }
            totalResults[tableName].synced += data.length;
          } else if (!totalResults[tableName]) {
            totalResults[tableName] = { synced: 0 };
          }
        }

        // Update user_syncs table with new sync times from this batch
        if (syncResults['user_syncs']) {
          await updateUserSyncs(tx, board, syncResults['user_syncs']);

          // Update sync params for next iteration with new timestamps
          const newUserSyncs = syncResults['user_syncs'].map(
            (sync: { table_name: string; last_synchronized_at: string }) => ({
              table_name: sync.table_name,
              last_synchronized_at: sync.last_synchronized_at,
              user_id: Number(userId),
            }),
          );

          currentSyncParams = {
            ...currentSyncParams,
            userSyncs: newUserSyncs,
          };
        }
      });

      // Check if sync is complete
      isComplete = syncResults._complete !== false;

      if (!isComplete) {
        console.info(`Sync not complete for user ${userId}, continuing with next batch...`);
      } else {
        console.info(`Sync complete for user ${userId} after ${syncAttempts} attempts`);
      }
    }

    if (syncAttempts >= maxSyncAttempts) {
      console.warn(`Sync reached maximum attempts (${maxSyncAttempts}) for user ${userId}`);
    }

    return totalResults;
  } catch (error) {
    console.error('Error syncing user data:', error);
    throw error;
  }
}
