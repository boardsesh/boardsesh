import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { gymMembers, gymReportingBoardAliases, gyms, userBoards } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { validatedReportingTimeZone } from '../../../services/reporting-time';
import {
  SetGymReportingBoardAliasInputSchema,
  SetGymReportingTimeZoneInputSchema,
} from '../../../validation/schemas/gyms';
import { isSharedConfigFeedBoard } from '../board-presence/shared';
import { applyRateLimit, validateInput } from '../shared/helpers';
import {
  authorizedReportingBoardCondition,
  reportingBoardNotFound,
  readReportingGymIds,
  requireReportingUser,
  type GymReportingTransaction,
} from './gym-reporting';
import { requireGymEditAccess, requireGymOwnerOrAdmin } from './gyms';

export async function lockGymSettings(
  tx: GymReportingTransaction,
  gymUuid: string,
  viewerId: string,
  requireAccess: typeof requireGymEditAccess,
) {
  const gym = await requireAccess(gymUuid, viewerId, tx);
  const [lockedGym] = await tx
    .select({ id: gyms.id })
    .from(gyms)
    .where(and(eq(gyms.id, gym.id), isNull(gyms.deletedAt)))
    .for('no key update');
  if (!lockedGym) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
  await tx
    .select({ userId: gymMembers.userId })
    .from(gymMembers)
    .where(and(eq(gymMembers.gymId, gym.id), eq(gymMembers.userId, viewerId)))
    .for('share');
  return requireAccess(gym.uuid, viewerId, tx);
}

const aliasConflict = () =>
  new GraphQLError('Choose an independent root of the same board type in this gym', {
    extensions: { code: 'BAD_USER_INPUT' },
  });

export const gymReportingSettingsMutations = {
  setGymReportingTimeZone: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const viewerId = requireReportingUser(ctx);
    await applyRateLimit(ctx, 20, 'setGymReportingTimeZone');
    const { gymUuid, timeZone } = validateInput(SetGymReportingTimeZoneInputSchema, input, 'input');
    const validatedZone = timeZone == null ? null : await validatedReportingTimeZone(timeZone);
    if (timeZone != null && !validatedZone) {
      throw new GraphQLError('Enter a valid IANA time zone', { extensions: { code: 'INVALID_TIME_ZONE' } });
    }
    await db.transaction(async (tx) => {
      const gym = await lockGymSettings(tx, gymUuid, viewerId, requireGymEditAccess);
      await tx.update(gyms).set({ reportingTimeZone: validatedZone }).where(eq(gyms.id, gym.id));
    });
    return true;
  },

  setGymReportingBoardAlias: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const viewerId = requireReportingUser(ctx);
    await applyRateLimit(ctx, 20, 'setGymReportingBoardAlias');
    const { gymUuid, boardUuid, rootBoardUuid } = validateInput(SetGymReportingBoardAliasInputSchema, input, 'input');
    if (boardUuid === rootBoardUuid) throw aliasConflict();
    await db.transaction(async (tx) => {
      const gym = await lockGymSettings(tx, gymUuid, viewerId, requireGymOwnerOrAdmin);
      const requested = rootBoardUuid ? [boardUuid, rootBoardUuid] : [boardUuid];
      const requestedRows = await tx
        .select({ id: userBoards.id, uuid: userBoards.uuid })
        .from(userBoards)
        .where(and(inArray(userBoards.uuid, requested), authorizedReportingBoardCondition(gym.id, viewerId)));
      const sourceIdRow = requestedRows.find((board) => board.uuid === boardUuid);
      if (!sourceIdRow || requestedRows.length !== requested.length) throw reportingBoardNotFound();
      const knownRelations = await tx
        .select({ boardId: gymReportingBoardAliases.boardId, rootBoardId: gymReportingBoardAliases.rootBoardId })
        .from(gymReportingBoardAliases)
        .where(
          and(
            isNull(gymReportingBoardAliases.revokedAt),
            or(
              inArray(
                gymReportingBoardAliases.boardId,
                requestedRows.map(({ id }) => id),
              ),
              eq(gymReportingBoardAliases.rootBoardId, sourceIdRow.id),
            ),
          ),
        );
      const relatedIds = [...new Set(knownRelations.flatMap(({ boardId, rootBoardId }) => [boardId, rootBoardId]))];
      // Existing venue moves update these same physical board rows. Take the
      // stable lock order before rechecking both independent resource grants.
      const lockedBoards = await tx
        .select({ id: userBoards.id, gymId: userBoards.gymId, deletedAt: userBoards.deletedAt })
        .from(userBoards)
        .where(
          or(
            inArray(userBoards.uuid, requested),
            relatedIds.length > 0 ? inArray(userBoards.id, relatedIds) : undefined,
          ),
        )
        .orderBy(asc(userBoards.id))
        .for('no key update');
      const endpoints = (
        await tx
          .select()
          .from(userBoards)
          .where(and(authorizedReportingBoardCondition(gym.id, viewerId), inArray(userBoards.uuid, requested)))
      ).filter((board) => !isSharedConfigFeedBoard(board));
      const source = endpoints.find((board) => board.uuid === boardUuid);
      const root = rootBoardUuid == null ? undefined : endpoints.find((board) => board.uuid === rootBoardUuid);
      if (!source || (rootBoardUuid && !root)) throw reportingBoardNotFound();
      if (root && (root.boardType !== source.boardType || source.boardType === 'spray')) throw aliasConflict();

      const activeRelations = await tx
        .select()
        .from(gymReportingBoardAliases)
        .where(
          and(
            isNull(gymReportingBoardAliases.revokedAt),
            or(
              eq(gymReportingBoardAliases.boardId, source.id),
              eq(gymReportingBoardAliases.rootBoardId, source.id),
              root ? eq(gymReportingBoardAliases.boardId, root.id) : undefined,
            ),
          ),
        );
      if (root) {
        const gymIds = new Set(await readReportingGymIds(tx, gym.id));
        const localBoards = new Set(
          lockedBoards.filter((board) => board.gymId === gym.id && !board.deletedAt).map(({ id }) => id),
        );
        const wouldNest = activeRelations.some(
          (alias) =>
            gymIds.has(alias.gymId) &&
            localBoards.has(alias.boardId) &&
            localBoards.has(alias.rootBoardId) &&
            (alias.rootBoardId === source.id || alias.boardId === root.id),
        );
        // Locks on the proposed endpoints serialize any simultaneous group change.
        if (wouldNest) throw aliasConflict();
      }
      const previous = activeRelations.find((alias) => alias.boardId === source.id);
      if (previous && root?.id === previous.rootBoardId && previous.gymId === gym.id) return;
      if (previous)
        await tx
          .update(gymReportingBoardAliases)
          .set({ revokedAt: sql`clock_timestamp()`, revokedBy: viewerId })
          .where(eq(gymReportingBoardAliases.id, previous.id));
      if (root)
        await tx.insert(gymReportingBoardAliases).values({
          gymId: gym.id,
          boardId: source.id,
          rootBoardId: root.id,
          verifiedBy: viewerId,
        });
    });
    return true;
  },
};
