import { userSync } from '../api/user-sync-api';
import { type SyncOptions, type UserSyncData, type AuroraBoardName, USER_TABLES } from '../api/types';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  resolveUpstreamPlaylistWrite,
  upstreamPlaylistSkipLogLine,
  type UpstreamPlaylistWriteDecision,
} from '@boardsesh/sync-runtime';
import { normalizePlaylistColor } from '@boardsesh/shared-schema';
import {
  DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  type CircuitPlaylistOwnershipConflictState,
} from '@boardsesh/shared-schema/sync-error-codes';
import { foreignPlaylistOwnerGuard, selectUpstreamPlaylistOwners } from '@boardsesh/db/queries';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { UNIFIED_TABLES } from '../db/table-select';
import { playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema/app';
import { formatDbError } from './db-error';
import { applyAuroraAscents, applyAuroraBids } from './apply-user-logbook';
import { auroraCircuitAdvisoryLockStatement, normalizeAuroraCircuitItems } from './circuit-arbitration';

const BATCH_SIZE = 100;

/**
 * The generic Drizzle shape the ownership queries accept. Wider
 * than this module's `DrizzleDb` (which pins the postgres-js driver) so the
 * runner can hand over its own client without a cast.
 */
type OwnerQueryDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Machine-stable marker on `SyncTableResult.skippedReason` for circuits refused
 * because another Boardsesh user owns the playlist.
 *
 * Retains the pre-#3950 generic code for callers that inspect per-table sync
 * results. The runner now persists a more precise foreign/ambiguous code and
 * does NOT derive it from this counter: see
 * getCircuitPlaylistOwnershipConflictState for why that must be a state
 * question.
 */
export const DUPLICATE_CIRCUIT_OWNER_SKIP_REASON = DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;

/**
 * Classify ownership across every playlist mirroring THIS Aurora account's
 * circuits as `none`, `foreign`, or `ambiguous`.
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
export async function getCircuitPlaylistOwnershipConflictState(
  db: OwnerQueryDb,
  boardName: AuroraBoardName,
  auroraUserId: number,
  nextAuthUserId: string,
): Promise<CircuitPlaylistOwnershipConflictState> {
  const circuitsSchema = UNIFIED_TABLES.circuits;
  const ownerRows = await db
    .select({ circuitUuid: circuitsSchema.uuid, ownerUserId: playlistOwnership.userId })
    .from(circuitsSchema)
    .innerJoin(
      playlists,
      and(eq(playlists.auroraId, circuitsSchema.uuid), eq(playlists.boardType, circuitsSchema.boardType)),
    )
    .leftJoin(
      playlistOwnership,
      and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.role, 'owner')),
    )
    .where(and(eq(circuitsSchema.boardType, boardName), eq(circuitsSchema.userId, auroraUserId)));

  const ownerIdsByCircuit = new Map<string, string[]>();
  for (const row of ownerRows) {
    let ownerIds = ownerIdsByCircuit.get(row.circuitUuid);
    if (!ownerIds) {
      ownerIds = [];
      ownerIdsByCircuit.set(row.circuitUuid, ownerIds);
    }
    if (typeof row.ownerUserId === 'string') ownerIds.push(row.ownerUserId);
  }

  let hasForeignOwner = false;
  for (const ownerIds of ownerIdsByCircuit.values()) {
    const decision = resolveUpstreamPlaylistWrite(ownerIds, nextAuthUserId);
    if (decision === 'ambiguous') return 'ambiguous';
    if (decision === 'foreign') hasForeignOwner = true;
  }

  return hasForeignOwner ? 'foreign' : 'none';
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

export type CircuitPlaylistRefusalSummary = {
  foreign: number;
  ambiguous: number;
  invariant: number;
};

export type UpsertResult = {
  synced: number;
  skipped: number;
  skippedReason?: string;
  circuitPlaylistRefusals?: CircuitPlaylistRefusalSummary;
};

type AuroraApiRow = Record<string, string>;

type DrizzleDb = PostgresJsDatabase<Record<string, never>>;

type CircuitRefusalStage = 'ownership-check' | 'suppressed-upsert';
type CircuitRefusalReason = 'foreign' | 'ambiguous' | 'no-owner' | 'own';
type CircuitPlaylistWriteOutcome = { status: 'written' } | { status: 'refused'; reason: CircuitRefusalReason };

export const CIRCUIT_PLAYLIST_INVARIANT_SKIP_REASON = 'circuit-playlist-invariant:circuits';

function logCircuitRefusal(
  log: (message: string) => void,
  logError: (message: string) => void,
  input: {
    boardName: AuroraBoardName;
    circuitUuid: string;
    syncingUserId: string;
    stage: CircuitRefusalStage;
    reason: CircuitRefusalReason;
  },
): void {
  const structuredContext = JSON.stringify({
    event: 'aurora_circuit_playlist_refused',
    boardType: input.boardName,
    circuitUuid: input.circuitUuid,
    syncingUserId: input.syncingUserId,
    stage: input.stage,
    reason: input.reason,
  });

  if (input.stage === 'suppressed-upsert' && input.reason === 'own') {
    // `foreignPlaylistOwnerGuard` cannot suppress an update when the syncing
    // user is the sole owner. Keep the item in the invariant refusal bucket,
    // but emit a separate error-level event so an operator can distinguish this
    // protocol contradiction from the recoverable no-owner race. Do not include
    // the circuit payload, credentials, or other upstream response data.
    logError(
      JSON.stringify({
        level: 'error',
        event: 'aurora_circuit_playlist_suppressed_own_contradiction',
        boardType: input.boardName,
        circuitUuid: input.circuitUuid,
        syncingUserId: input.syncingUserId,
        stage: input.stage,
        reason: input.reason,
      }),
    );
  }

  if (input.reason === 'foreign' || input.reason === 'ambiguous') {
    log(
      `${upstreamPlaylistSkipLogLine({
        syncTag: 'aurora-sync',
        upstreamIdColumn: 'aurora_id',
        upstreamId: input.circuitUuid,
        syncingUserId: input.syncingUserId,
        decision: input.reason,
      })} ${structuredContext}`,
    );
    return;
  }

  const ownerState = input.reason === 'no-owner' ? 'no owner edge' : 'only the syncing user as owner';
  log(
    `[aurora-sync] aurora_id ${input.circuitUuid}: invariant/concurrency warning — playlist upsert returned no row, but the fresh owner read found ${ownerState}; refusing to mutate ownership or climbs for user ${input.syncingUserId} ${structuredContext}`,
  );
}

async function selectCircuitOwnerDecision(
  db: OwnerQueryDb,
  circuitUuid: string,
  syncingUserId: string,
): Promise<UpstreamPlaylistWriteDecision> {
  const ownersByAuroraId = await selectUpstreamPlaylistOwners(db, playlists.auroraId, [circuitUuid]);
  const owners = ownersByAuroraId.get(circuitUuid) ?? [];
  return resolveUpstreamPlaylistWrite(owners, syncingUserId);
}

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
  logError: (message: string) => void = console.error,
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
      const { items: circuitItems, rejectedCount } = normalizeAuroraCircuitItems(data);

      if (rejectedCount > 0) {
        logError(
          JSON.stringify({
            level: 'error',
            event: 'aurora_circuit_playlist_malformed_payload',
            boardType: boardName,
            rejectedCount,
          }),
        );
      }

      return db.transaction(async (transaction): Promise<UpsertResult> => {
        const circuitsTransaction = transaction as unknown as DrizzleDb;

        // Take the complete normalized lock set before ANY row write. Source
        // rows and playlist rows share the same surrounding transaction, so
        // writing board_circuits first would mix row locks with advisory locks
        // and let two reused outer transactions form a cross-lock deadlock.
        // UUID sorting in normalizeCircuitItems gives every claimant the same
        // acquisition order. When the caller already supplied a transaction,
        // this callback is a savepoint and the locks remain owned by that outer
        // transaction until it commits or rolls back.
        for (const item of circuitItems) {
          await circuitsTransaction.execute(auroraCircuitAdvisoryLockStatement(boardName, item.uuid));
        }

        await processBatches(circuitItems, BATCH_SIZE, async (batch) => {
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
          await circuitsTransaction
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

        if (!nextAuthUserId) {
          return rejectedCount > 0
            ? {
                synced: data.length - rejectedCount,
                skipped: rejectedCount,
                skippedReason: CIRCUIT_PLAYLIST_INVARIANT_SKIP_REASON,
                circuitPlaylistRefusals: { foreign: 0, ambiguous: 0, invariant: rejectedCount },
              }
            : { synced: data.length, skipped: 0 };
        }

        const refusalReasonsByCircuitUuid = new Map<string, CircuitRefusalReason>();
        // One owner query per payload, after every advisory lock and source
        // write. Compliant writers cannot change these owner sets until this
        // transaction releases its complete lock set; only the rare SQL-guard
        // suppression path below needs a second, per-circuit diagnostic read.
        const ownersByCircuitUuid = await selectUpstreamPlaylistOwners(
          circuitsTransaction as unknown as OwnerQueryDb,
          playlists.auroraId,
          circuitItems.map((item) => item.uuid),
        );

        for (const item of circuitItems) {
          const outcome = await circuitsTransaction.transaction(
            async (playlistTransaction): Promise<CircuitPlaylistWriteOutcome> => {
              const tx = playlistTransaction as unknown as DrizzleDb;

              // All server-wide per-(board,circuit) locks were acquired above,
              // before the source upsert. The fresh owner read therefore sees
              // any prior claimant's committed edge under READ COMMITTED.
              const initialOwnerDecision = resolveUpstreamPlaylistWrite(
                ownersByCircuitUuid.get(item.uuid) ?? [],
                nextAuthUserId,
              );
              if (initialOwnerDecision === 'foreign' || initialOwnerDecision === 'ambiguous') {
                // Refuse the whole item — upsert, ownership grant AND the
                // playlist_climbs replace below. Skipping only the upsert would
                // still wipe the other user's climbs further down.
                logCircuitRefusal(log, logError, {
                  boardName,
                  circuitUuid: item.uuid,
                  syncingUserId: nextAuthUserId,
                  stage: 'ownership-check',
                  reason: initialOwnerDecision,
                });
                return { status: 'refused', reason: initialOwnerDecision };
              }

              const formattedColor = normalizePlaylistColor(item.color);

              const [playlist] = await tx
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
                  // Defence in depth: the advisory lock is the primary
                  // arbitration mechanism, while this statement-time predicate
                  // still prevents a foreign owner from being adopted if a
                  // caller ever bypasses or changes the lock protocol.
                  setWhere: foreignPlaylistOwnerGuard(nextAuthUserId),
                })
                .returning({ id: playlists.id });

              if (!playlist) {
                // The SQL guard suppressed the update. Re-read after the failed
                // write so observability reports the actual owner state that
                // caused it, rather than the stale pre-upsert decision.
                const suppressedOwnerDecision = await selectCircuitOwnerDecision(
                  tx as unknown as OwnerQueryDb,
                  item.uuid,
                  nextAuthUserId,
                );
                const reason: CircuitRefusalReason =
                  suppressedOwnerDecision === 'adopt' ? 'no-owner' : suppressedOwnerDecision;
                logCircuitRefusal(log, logError, {
                  boardName,
                  circuitUuid: item.uuid,
                  syncingUserId: nextAuthUserId,
                  stage: 'suppressed-upsert',
                  reason,
                });
                return { status: 'refused', reason };
              }

              await tx
                .insert(playlistOwnership)
                .values({
                  playlistId: playlist.id,
                  userId: nextAuthUserId,
                  role: 'owner',
                })
                .onConflictDoUpdate({
                  target: [playlistOwnership.playlistId, playlistOwnership.userId],
                  // An orphan can still have this user attached as editor/viewer.
                  // Claiming it must promote that existing edge, not let
                  // ON CONFLICT DO NOTHING leave the playlist ownerless.
                  set: { role: 'owner' },
                });

              if (item.climbs && Array.isArray(item.climbs)) {
                await tx.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

                for (let i = 0; i < item.climbs.length; i++) {
                  const climb = item.climbs[i];
                  const climbUuid = climb.climb_uuid || climb.uuid || climb;
                  const climbAngle = climb.angle ?? null;
                  const climbPosition = climb.position ?? i;

                  if (typeof climbUuid === 'string') {
                    await tx.insert(playlistClimbs).values({
                      playlistId: playlist.id,
                      climbUuid,
                      angle: climbAngle,
                      position: climbPosition,
                    });
                  }
                }
              }

              return { status: 'written' };
            },
          );

          if (outcome.status === 'refused') {
            refusalReasonsByCircuitUuid.set(item.uuid, outcome.reason);
          }
        }

        log(`  Synced ${circuitItems.length - refusalReasonsByCircuitUuid.size} circuits to playlists table`);
        if (refusalReasonsByCircuitUuid.size > 0 || rejectedCount > 0) {
          const circuitPlaylistRefusals: CircuitPlaylistRefusalSummary = {
            foreign: 0,
            ambiguous: 0,
            invariant: rejectedCount,
          };
          for (const reason of refusalReasonsByCircuitUuid.values()) {
            if (reason === 'foreign') circuitPlaylistRefusals.foreign += 1;
            else if (reason === 'ambiguous') circuitPlaylistRefusals.ambiguous += 1;
            else circuitPlaylistRefusals.invariant += 1;
          }
          const hasOwnershipConflict = circuitPlaylistRefusals.foreign > 0 || circuitPlaylistRefusals.ambiguous > 0;

          // `synced` retains the existing input-row metric for compatibility;
          // duplicate UUIDs are applied once, with their last payload row
          // winning. `skipped` and the detailed summary count unique circuits.
          return {
            synced: data.length - rejectedCount,
            skipped: refusalReasonsByCircuitUuid.size + rejectedCount,
            skippedReason: hasOwnershipConflict
              ? DUPLICATE_CIRCUIT_OWNER_SKIP_REASON
              : CIRCUIT_PLAYLIST_INVARIANT_SKIP_REASON,
            circuitPlaylistRefusals,
          };
        }

        return { synced: data.length, skipped: 0 };
      });
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
  circuitPlaylistRefusals?: CircuitPlaylistRefusalSummary;
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
  logError: (message: string) => void = console.error,
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
                logError,
              );

              if (!totalResults[tableName]) {
                totalResults[tableName] = { synced: 0 };
              }
              totalResults[tableName].synced += upsertResult.synced;
              if (upsertResult.skipped > 0) {
                totalResults[tableName].skipped = (totalResults[tableName].skipped || 0) + upsertResult.skipped;
                // Keep the legacy duplicate-account marker if any page saw a
                // genuine owner conflict; a later invariant refusal must not
                // overwrite it. Detailed counts preserve every category.
                if (
                  !totalResults[tableName].skippedReason ||
                  upsertResult.skippedReason === DUPLICATE_CIRCUIT_OWNER_SKIP_REASON
                ) {
                  totalResults[tableName].skippedReason = upsertResult.skippedReason;
                }
                if (upsertResult.circuitPlaylistRefusals) {
                  const accumulated = totalResults[tableName].circuitPlaylistRefusals ?? {
                    foreign: 0,
                    ambiguous: 0,
                    invariant: 0,
                  };
                  accumulated.foreign += upsertResult.circuitPlaylistRefusals.foreign;
                  accumulated.ambiguous += upsertResult.circuitPlaylistRefusals.ambiguous;
                  accumulated.invariant += upsertResult.circuitPlaylistRefusals.invariant;
                  totalResults[tableName].circuitPlaylistRefusals = accumulated;
                }
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
