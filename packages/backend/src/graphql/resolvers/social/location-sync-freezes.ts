import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ClearLocationSyncFreezeResult,
  ConnectionContext,
  FrozenLocationSyncEntity,
  FrozenLocationSyncEntityConnection,
  LocationSyncEntityType,
} from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { ClearLocationSyncFreezeInputSchema, FrozenLocationSyncEntitiesInputSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { requireAdmin } from './roles';

const FROZEN_ENTITY_QUERY_LIMIT = 60;
const CLEAR_FREEZE_MUTATION_LIMIT = 10;

function toIsoString(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
}

function nullableIsoString(timestamp: Date | string | null): string | null {
  return timestamp === null ? null : toIsoString(timestamp);
}

async function listFrozenGyms(input: {
  query?: string;
  limit: number;
  offset: number;
}): Promise<FrozenLocationSyncEntityConnection> {
  const searchCondition = input.query
    ? or(
        ilike(dbSchema.gyms.name, `%${input.query}%`),
        ilike(dbSchema.gyms.uuid, `%${input.query}%`),
        ilike(dbSchema.gyms.slug, `%${input.query}%`),
      )
    : undefined;
  const frozenCondition = searchCondition
    ? and(isNotNull(dbSchema.gyms.syncFrozenAt), isNull(dbSchema.gyms.mergedIntoGymId), searchCondition)
    : and(isNotNull(dbSchema.gyms.syncFrozenAt), isNull(dbSchema.gyms.mergedIntoGymId));

  const [countRow] = await db.select({ value: count() }).from(dbSchema.gyms).where(frozenCondition);
  const rows = await db
    .select({
      id: dbSchema.gyms.id,
      uuid: dbSchema.gyms.uuid,
      slug: dbSchema.gyms.slug,
      name: dbSchema.gyms.name,
      ownerId: dbSchema.gyms.ownerId,
      deletedAt: dbSchema.gyms.deletedAt,
      syncFrozenAt: dbSchema.gyms.syncFrozenAt,
    })
    .from(dbSchema.gyms)
    .where(frozenCondition)
    .orderBy(desc(dbSchema.gyms.syncFrozenAt), desc(dbSchema.gyms.id))
    .limit(input.limit)
    .offset(input.offset);

  const gymIds = rows.map((row) => row.id);
  const [sourceRows, approvedClaimRows] =
    gymIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              gymId: dbSchema.locationSyncGymSources.gymId,
              sourceKey: dbSchema.locationSyncGymSources.sourceKey,
            })
            .from(dbSchema.locationSyncGymSources)
            .where(inArray(dbSchema.locationSyncGymSources.gymId, gymIds)),
          db
            .select({ gymId: dbSchema.gymClaims.gymId })
            .from(dbSchema.gymClaims)
            .where(and(inArray(dbSchema.gymClaims.gymId, gymIds), eq(dbSchema.gymClaims.status, 'approved'))),
        ]);

  const sourceKeysByGymId = new Map<number, string[]>();
  for (const sourceRow of sourceRows) {
    const sourceKeys = sourceKeysByGymId.get(sourceRow.gymId) ?? [];
    sourceKeys.push(sourceRow.sourceKey);
    sourceKeysByGymId.set(sourceRow.gymId, sourceKeys);
  }
  for (const sourceKeys of sourceKeysByGymId.values()) {
    sourceKeys.sort();
  }
  const approvedClaimGymIds = new Set(approvedClaimRows.map((row) => row.gymId));

  const entities: FrozenLocationSyncEntity[] = rows.map((row) => ({
    entityType: 'GYM',
    entityUuid: row.uuid,
    slug: row.slug,
    name: row.name,
    boardType: null,
    isSystemOwned: row.ownerId === SYSTEM_BOARD_OWNER_ID,
    ownerProtected: row.ownerId !== SYSTEM_BOARD_OWNER_ID || approvedClaimGymIds.has(row.id),
    isDeleted: row.deletedAt !== null,
    deletedAt: nullableIsoString(row.deletedAt),
    syncFrozenAt: toIsoString(row.syncFrozenAt!),
    sourceKeys: sourceKeysByGymId.get(row.id) ?? [],
  }));

  const totalCount = Number(countRow?.value ?? 0);
  return { entities, totalCount, hasMore: input.offset + entities.length < totalCount };
}

async function listFrozenBoards(input: {
  query?: string;
  limit: number;
  offset: number;
}): Promise<FrozenLocationSyncEntityConnection> {
  const searchCondition = input.query
    ? or(
        ilike(dbSchema.userBoards.name, `%${input.query}%`),
        ilike(dbSchema.userBoards.uuid, `%${input.query}%`),
        ilike(dbSchema.userBoards.slug, `%${input.query}%`),
      )
    : undefined;
  const frozenCondition = searchCondition
    ? and(isNotNull(dbSchema.userBoards.syncFrozenAt), searchCondition)
    : isNotNull(dbSchema.userBoards.syncFrozenAt);

  const [countRow] = await db.select({ value: count() }).from(dbSchema.userBoards).where(frozenCondition);
  const rows = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      name: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      deletedAt: dbSchema.userBoards.deletedAt,
      syncFrozenAt: dbSchema.userBoards.syncFrozenAt,
    })
    .from(dbSchema.userBoards)
    .where(frozenCondition)
    .orderBy(desc(dbSchema.userBoards.syncFrozenAt), desc(dbSchema.userBoards.id))
    .limit(input.limit)
    .offset(input.offset);

  const entities: FrozenLocationSyncEntity[] = rows.map((row) => ({
    entityType: 'BOARD',
    entityUuid: row.uuid,
    slug: row.slug,
    name: row.name,
    boardType: row.boardType,
    isSystemOwned: row.ownerId === SYSTEM_BOARD_OWNER_ID,
    // Boards have no second owner/claim guard: whether a source reaches a board
    // is determined by its deterministic source UUID, which is not persisted.
    ownerProtected: false,
    isDeleted: row.deletedAt !== null,
    deletedAt: nullableIsoString(row.deletedAt),
    syncFrozenAt: toIsoString(row.syncFrozenAt!),
    sourceKeys: [],
  }));

  const totalCount = Number(countRow?.value ?? 0);
  return { entities, totalCount, hasMore: input.offset + entities.length < totalCount };
}

function alreadyUnfrozen(entityType: LocationSyncEntityType, entityUuid: string): ClearLocationSyncFreezeResult {
  return { status: 'ALREADY_UNFROZEN', entityType, entityUuid, previousSyncFrozenAt: null };
}

function assertExpectedFreeze(actual: Date, expected: Date): void {
  if (actual.getTime() !== expected.getTime()) {
    throw new GraphQLError('This listing was edited again after the unfreeze confirmation opened.', {
      extensions: { code: 'LOCATION_SYNC_FREEZE_STALE' },
    });
  }
}

export const socialLocationSyncFreezeQueries = {
  frozenLocationSyncEntities: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<FrozenLocationSyncEntityConnection> => {
    // `requireAdmin` without a board type deliberately admits global admins
    // only. A board-scoped admin must not release catalog-wide protections.
    await requireAdmin(ctx);
    await applyRateLimit(ctx, FROZEN_ENTITY_QUERY_LIMIT, 'frozenLocationSyncEntities');
    const validated = validateInput(FrozenLocationSyncEntitiesInputSchema, input, 'input');

    return validated.entityType === 'GYM' ? listFrozenGyms(validated) : listFrozenBoards(validated);
  },
};

export const socialLocationSyncFreezeMutations = {
  clearLocationSyncFreeze: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<ClearLocationSyncFreezeResult> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, CLEAR_FREEZE_MUTATION_LIMIT, 'clearLocationSyncFreeze');
    const validated = validateInput(ClearLocationSyncFreezeInputSchema, input, 'input');
    const performedBy = ctx.userId!;
    const expectedSyncFrozenAt = new Date(validated.expectedSyncFrozenAt);

    const result = await db.transaction(async (tx): Promise<ClearLocationSyncFreezeResult> => {
      if (validated.entityType === 'GYM') {
        const [target] = await tx
          .select({
            id: dbSchema.gyms.id,
            uuid: dbSchema.gyms.uuid,
            ownerId: dbSchema.gyms.ownerId,
            deletedAt: dbSchema.gyms.deletedAt,
            syncFrozenAt: dbSchema.gyms.syncFrozenAt,
            mergedIntoGymId: dbSchema.gyms.mergedIntoGymId,
          })
          .from(dbSchema.gyms)
          .where(eq(dbSchema.gyms.uuid, validated.entityUuid))
          .limit(1)
          .for('update');

        if (!target) {
          throw new GraphQLError('Gym not found.', { extensions: { code: 'NOT_FOUND' } });
        }
        if (target.mergedIntoGymId !== null) {
          throw new GraphQLError('A merged gym cannot be unfrozen; its source now resolves to the survivor.', {
            extensions: { code: 'LOCATION_SYNC_TARGET_MERGED' },
          });
        }
        if (target.syncFrozenAt === null) {
          return alreadyUnfrozen('GYM', target.uuid);
        }
        assertExpectedFreeze(target.syncFrozenAt, expectedSyncFrozenAt);

        const clearedRows = await tx
          .update(dbSchema.gyms)
          .set({ syncFrozenAt: null })
          // The row is locked and the expected timestamp was already compared
          // at millisecond precision above. Do not repeat the timestamp in the
          // WHERE: legacy backfills can retain Postgres microseconds that a JS
          // Date cannot represent, turning an otherwise valid clear into a
          // silent no-op.
          .where(eq(dbSchema.gyms.id, target.id))
          .returning({ id: dbSchema.gyms.id });
        if (clearedRows.length !== 1) {
          throw new GraphQLError('The gym sync freeze could not be cleared.', {
            extensions: { code: 'LOCATION_SYNC_FREEZE_CLEAR_FAILED' },
          });
        }
        await tx.insert(dbSchema.locationSyncUnfreezeAudit).values({
          entityType: 'gym',
          entityUuid: target.uuid,
          previousSyncFrozenAt: target.syncFrozenAt,
          previousDeletedAt: target.deletedAt,
          previousOwnerId: target.ownerId,
          reason: validated.reason,
          performedBy,
        });

        return {
          status: 'CLEARED',
          entityType: 'GYM',
          entityUuid: target.uuid,
          previousSyncFrozenAt: target.syncFrozenAt.toISOString(),
        };
      }

      const [target] = await tx
        .select({
          id: dbSchema.userBoards.id,
          uuid: dbSchema.userBoards.uuid,
          ownerId: dbSchema.userBoards.ownerId,
          deletedAt: dbSchema.userBoards.deletedAt,
          syncFrozenAt: dbSchema.userBoards.syncFrozenAt,
        })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validated.entityUuid))
        .limit(1)
        .for('update');

      if (!target) {
        throw new GraphQLError('Board not found.', { extensions: { code: 'NOT_FOUND' } });
      }
      if (target.syncFrozenAt === null) {
        return alreadyUnfrozen('BOARD', target.uuid);
      }
      assertExpectedFreeze(target.syncFrozenAt, expectedSyncFrozenAt);

      const clearedRows = await tx
        .update(dbSchema.userBoards)
        .set({ syncFrozenAt: null })
        .where(eq(dbSchema.userBoards.id, target.id))
        .returning({ id: dbSchema.userBoards.id });
      if (clearedRows.length !== 1) {
        throw new GraphQLError('The board sync freeze could not be cleared.', {
          extensions: { code: 'LOCATION_SYNC_FREEZE_CLEAR_FAILED' },
        });
      }
      await tx.insert(dbSchema.locationSyncUnfreezeAudit).values({
        entityType: 'board',
        entityUuid: target.uuid,
        previousSyncFrozenAt: target.syncFrozenAt,
        previousDeletedAt: target.deletedAt,
        previousOwnerId: target.ownerId,
        reason: validated.reason,
        performedBy,
      });

      return {
        status: 'CLEARED',
        entityType: 'BOARD',
        entityUuid: target.uuid,
        previousSyncFrozenAt: target.syncFrozenAt.toISOString(),
      };
    });

    if (result.status === 'CLEARED') {
      logger.info('Location-sync human-curation freeze cleared by global admin', {
        entityType: result.entityType,
        entityUuid: result.entityUuid,
        previousSyncFrozenAt: result.previousSyncFrozenAt,
        performedBy,
      });
    }
    return result;
  },
};
