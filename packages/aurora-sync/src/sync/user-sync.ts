import { userSync } from '../api/user-sync-api';
import { type SyncOptions, type UserSyncData, type AuroraBoardName, USER_TABLES } from '../api/types';
import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  resolveUpstreamPlaylistWrite,
  canWriteUpstreamPlaylist,
  upstreamPlaylistSkipLogLine,
} from '@boardsesh/sync-runtime';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { foreignPlaylistOwnerGuard, selectUpstreamPlaylistOwners } from '@boardsesh/db/queries';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { UNIFIED_TABLES } from '../db/table-select';
import { playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema/app';
import { formatDbError } from './db-error';
import { applyAuroraAscents, applyAuroraBids } from './apply-user-logbook';

const BATCH_SIZE = 100;

/**
 * The generic Drizzle shape `hasForeignOwnedCircuitPlaylists` accepts. Wider
 * than this module's `DrizzleDb` (which pins the postgres-js driver) so the
 * runner can hand over its own client without a cast.
 */
type OwnerQueryDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Machine-stable marker on `SyncTableResult.skippedReason` for circuits refused
 * because another Boardsesh user owns the playlist.
 *
 * Same string the runners write to `aurora_credentials.sync_error`, so the
 * per-table result, the daemon log and the board card all name one condition —
 * but the runner does NOT derive the credential's value from this counter: see
 * hasForeignOwnedCircuitPlaylists for why that has to be a state question.
 */
export const DUPLICATE_CIRCUIT_OWNER_SKIP_REASON = DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;

/**
 * Does any playlist mirroring one of THIS Aurora account's circuits belong to a
 * different Boardsesh user?
 *
 * Drives the user-facing `sync_error`, and it is deliberately a STATE query
 * rather than a count of what this cycle refused. Aurora's user sync is
 * incremental — `syncUserData` sends per-table `last_synchronized_at` and
 * advances the watermark even on a cycle where every circuit was refused — so a
 * per-cycle counter reports the problem once and then silently clears itself on
 * the next cycle, when Aurora returns no circuit rows at all. That would leave
 * the second user back where they started: an empty playlist list and no
 * explanation. Reading state instead means the message persists while the
 * duplicate link persists, and disappears on its own once it's resolved.
 *
 * `board_circuits` accumulates across cycles (upserted, never pruned per-sync)
 * and is keyed by the Aurora numeric user id, so it holds the account's full
 * circuit set regardless of what arrived in this delta. `clearAuroraBoardData`
 * does wipe it board-wide, but that also clears `board_user_syncs` in the same
 * transaction, so the next sync refills both and the check self-heals.
 */
export async function hasForeignOwnedCircuitPlaylists(
  db: OwnerQueryDb,
  boardName: AuroraBoardName,
  auroraUserId: number,
  nextAuthUserId: string,
): Promise<boolean> {
  const circuitsSchema = UNIFIED_TABLES.circuits;
  const conflicting = await db
    .select({ playlistId: playlistOwnership.playlistId })
    .from(circuitsSchema)
    .innerJoin(
      playlists,
      and(eq(playlists.auroraId, circuitsSchema.uuid), eq(playlists.boardType, circuitsSchema.boardType)),
    )
    .innerJoin(
      playlistOwnership,
      and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.role, 'owner')),
    )
    .where(
      and(
        eq(circuitsSchema.boardType, boardName),
        eq(circuitsSchema.userId, auroraUserId),
        ne(playlistOwnership.userId, nextAuthUserId),
      ),
    )
    .limit(1);

  return conflicting.length > 0;
}

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

/**
 * Exported for unit tests: the circuits branch carries the duplicate-account
 * ownership guard (#3526) and there is no other seam to drive it through
 * without a live Aurora API.
 */
export async function upsertTableData(
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
        // Timezone-correct write + cross-source claim + soft-delete + edit
        // guard all live in the shared apply module (see apply-user-logbook.ts).
        await applyAuroraAscents(db, boardName, nextAuthUserId, data);
      } else {
        log(`  Skipping ascents sync: no NextAuth user ID provided`);
        return { synced: 0, skipped: data.length, skippedReason: 'No NextAuth user ID provided' };
      }
      break;
    }

    case 'bids': {
      if (nextAuthUserId) {
        await applyAuroraBids(db, boardName, nextAuthUserId, data);
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
        // Who already owns the playlists behind these circuit uuids?
        // `playlists_aurora_id_idx` is a GLOBAL unique index, so the
        // `ON CONFLICT (aurora_id) DO UPDATE` below lands on whichever
        // Boardsesh user's row got there first — and the ownership insert then
        // hands this user an `owner` edge on it. That is how the 8 cross-linked
        // tension playlists in prod were created (#3526 / #3541). Same
        // partition-and-skip shape as the foreignAuroraIds guard in
        // apply-user-logbook.ts.
        const ownersByAuroraId = await selectUpstreamPlaylistOwners(
          db,
          playlists.auroraId,
          data.map((item) => item.uuid).filter((uuid): uuid is string => typeof uuid === 'string'),
        );
        // Distinct circuit uuids, not items: a duplicated uuid in one payload
        // must not inflate the count the log line and the result report.
        const refusedCircuitUuids = new Set<string>();

        for (const item of data) {
          const decision = resolveUpstreamPlaylistWrite(ownersByAuroraId.get(item.uuid) ?? [], nextAuthUserId);
          if (!canWriteUpstreamPlaylist(decision)) {
            // Refuse the whole item — upsert, ownership grant AND the
            // playlist_climbs replace below. Skipping only the upsert would
            // still wipe the other user's climbs further down.
            refusedCircuitUuids.add(item.uuid);
            log(
              upstreamPlaylistSkipLogLine({
                syncTag: 'aurora-sync',
                upstreamIdColumn: 'aurora_id',
                upstreamId: item.uuid,
                syncingUserId: nextAuthUserId,
                decision,
              }),
            );
            continue;
          }

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
              // SQL-level twin of the decision gate above, evaluated at
              // statement time against the conflicting row — closes the window
              // where two daemons syncing two Boardsesh users on the SAME
              // Aurora account both read "no playlist yet" and both INSERT.
              // Widened by #3539 (no cross-instance mutual exclusion). When it
              // bites, DO UPDATE matches nothing and `.returning()` comes back
              // empty, so the guard below skips the item.
              setWhere: foreignPlaylistOwnerGuard(nextAuthUserId),
            })
            .returning({ id: playlists.id });

          if (!playlist) continue;

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
        log(`  Synced ${data.length - refusedCircuitUuids.size} circuits to playlists table`);
        if (refusedCircuitUuids.size > 0) {
          // `synced` stays data.length: every row DID land in the `circuits`
          // table above (that upsert is user-scoped by aurora_user_id and was
          // never at risk). Only the playlists mirror was refused, and that's
          // what `skipped` reports.
          return {
            synced: data.length,
            skipped: refusedCircuitUuids.size,
            skippedReason: DUPLICATE_CIRCUIT_OWNER_SKIP_REASON,
          };
        }
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
