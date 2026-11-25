import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { db, runWithDatabaseTransaction } from '../../db/client';
import { transactionWithAfterCommit } from '../../db/after-commit';
import {
  isBoardHeldOffGym,
  isLatestHoldEventStaffRemoval,
  recordBoardModerationEvent,
} from '../../graphql/resolvers/social/board-moderation-events';
import { boardRepairStateHash } from '../../services/board-repair-state';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { assertGymMcpGlobalAdmin, gymRepairStateHash } from './admin-domain';

const OPERATION = 'attach_unlinked_spray_wall_to_gym';
const inspectionSchema = z
  .object({ gymUuid: z.string().uuid(), boardUuids: z.array(z.string().uuid()).min(1).max(10) })
  .strict();
const attachmentSchema = z.object({
  gymUuid: z.string().uuid(),
  boardUuid: z.string().uuid(),
  expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedGymStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(10).max(1000),
});

export type SprayWallGymLinkInput = z.infer<typeof attachmentSchema>;
type BoardRow = typeof tables.userBoards.$inferSelect;
type WallState = Pick<
  typeof tables.sprayWalls.$inferSelect,
  'boardUuid' | 'currentVersionId' | 'deletedAt' | 'archivedAt'
>;

function refusal(message: string, code = 'CONFLICT'): never {
  throw new GraphQLError(message, { extensions: { code } });
}

function activeWall(board: BoardRow | undefined, wall: WallState | undefined): board is BoardRow {
  return (
    !!board &&
    board.boardType === 'spray' &&
    !board.deletedAt &&
    !board.mergedIntoBoardUuid &&
    !!wall &&
    !wall.deletedAt &&
    !wall.archivedAt
  );
}

async function loadTarget(gymUuid: string) {
  const [gym] = await db
    .select()
    .from(tables.gyms)
    .where(and(eq(tables.gyms.uuid, gymUuid), isNull(tables.gyms.deletedAt), isNull(tables.gyms.mergedIntoGymId)))
    .limit(1);
  if (!gym) refusal('The selected gym is not active.', 'NOT_FOUND');
  return gym;
}

/** Explicit UUIDs let staff review private, draft and unlocated walls without enumerating them. */
export async function inspectSprayWallGymLinks(
  input: { gymUuid: string; boardUuids: string[] },
  context: ConnectionContext,
) {
  const validated = inspectionSchema.parse(input);
  if (new Set(validated.boardUuids).size !== validated.boardUuids.length)
    refusal('Select each spray wall only once.', 'BAD_USER_INPUT');
  return runWithDatabaseTransaction(
    async () => {
      await assertGymMcpGlobalAdmin(context);
      const gym = await loadTarget(validated.gymUuid);
      const boards = await db
        .select()
        .from(tables.userBoards)
        .where(inArray(tables.userBoards.uuid, validated.boardUuids));
      const walls = await db
        .select({
          boardUuid: tables.sprayWalls.boardUuid,
          currentVersionId: tables.sprayWalls.currentVersionId,
          deletedAt: tables.sprayWalls.deletedAt,
          archivedAt: tables.sprayWalls.archivedAt,
        })
        .from(tables.sprayWalls)
        .where(inArray(tables.sprayWalls.boardUuid, validated.boardUuids));
      if (
        boards.length !== validated.boardUuids.length ||
        boards.some(
          (board) =>
            !activeWall(
              board,
              walls.find((wall) => wall.boardUuid === board.uuid),
            ),
        )
      )
        refusal('Select active spray walls that have not been deleted or archived.', 'NOT_FOUND');
      const policies = await db
        .select()
        .from(tables.resourcePrivacy)
        .where(
          and(
            eq(tables.resourcePrivacy.kind, 'board'),
            inArray(tables.resourcePrivacy.resourceId, validated.boardUuids),
          ),
        );
      const owners = await db
        .select({ id: tables.users.id, name: tables.users.name, displayName: tables.userProfiles.displayName })
        .from(tables.users)
        .leftJoin(tables.userProfiles, eq(tables.userProfiles.userId, tables.users.id))
        .where(inArray(tables.users.id, [...new Set(boards.map((board) => board.ownerId))]));
      const linkedIds = [...new Set(boards.flatMap((board) => (board.gymId === null ? [] : [board.gymId])))];
      const linkedGyms = linkedIds.length
        ? await db
            .select({ id: tables.gyms.id, uuid: tables.gyms.uuid })
            .from(tables.gyms)
            .where(inArray(tables.gyms.id, linkedIds))
        : [];
      return {
        gym: { gymUuid: gym.uuid, name: gym.name, slug: gym.slug, stateHash: gymRepairStateHash(gym) },
        boards: await Promise.all(
          validated.boardUuids.map(async (boardUuid) => {
            const board = boards.find((candidate) => candidate.uuid === boardUuid)!;
            const policy = policies.find((candidate) => candidate.resourceId === board.uuid);
            const owner = owners.find((candidate) => candidate.id === board.ownerId);
            return {
              boardUuid: board.uuid,
              name: board.name,
              slug: board.slug,
              ownerId: board.ownerId,
              ownerDisplayName: owner?.displayName || owner?.name || null,
              boardType: board.boardType,
              layoutId: board.layoutId,
              sizeId: board.sizeId,
              setIds: board.setIds,
              angle: board.angle,
              isPublic: board.isPublic,
              isUnlisted: board.isUnlisted,
              hideLocation: board.hideLocation,
              audience: policy?.audience ?? (board.isUnlisted ? 'unlisted' : board.isPublic ? 'public' : 'only_me'),
              locationAudience: policy?.locationAudience ?? (board.hideLocation ? 'only_me' : 'public'),
              gymUuid: linkedGyms.find((candidate) => candidate.id === board.gymId)?.uuid ?? null,
              isLinked: board.gymId !== null,
              isPublished: walls.find((wall) => wall.boardUuid === board.uuid)!.currentVersionId !== null,
              isHeldOffGym:
                (await isBoardHeldOffGym(board.id, gym.id)) || (await isLatestHoldEventStaffRemoval(board.id)),
              stateHash: boardRepairStateHash(board, policy),
            };
          }),
        ),
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** Follow owner -> destination gym -> board; inverse wall/policy writers must never make us wait. */
async function lockSelection(input: SprayWallGymLinkInput, context: ConnectionContext) {
  await assertGymMcpGlobalAdmin(context);
  const [candidate] = await db
    .select({ ownerId: tables.userBoards.ownerId })
    .from(tables.userBoards)
    .where(eq(tables.userBoards.uuid, input.boardUuid))
    .limit(1);
  if (!candidate) refusal('The selected spray wall is unavailable.', 'NOT_FOUND');
  const [owner] = await db
    .select({ id: tables.users.id })
    .from(tables.users)
    .where(eq(tables.users.id, candidate.ownerId))
    .for('key share')
    .limit(1);
  if (!owner) refusal('The selected spray wall is unavailable.', 'NOT_FOUND');
  const [gym] = await db
    .select()
    .from(tables.gyms)
    .where(and(eq(tables.gyms.uuid, input.gymUuid), isNull(tables.gyms.deletedAt), isNull(tables.gyms.mergedIntoGymId)))
    .orderBy(asc(tables.gyms.id))
    .for('no key update')
    .limit(1);
  if (!gym) refusal('The selected gym is not active.', 'NOT_FOUND');
  const [board] = await db
    .select()
    .from(tables.userBoards)
    .where(eq(tables.userBoards.uuid, input.boardUuid))
    .for('update', { noWait: true })
    .limit(1);
  const [policy] = await db
    .select()
    .from(tables.resourcePrivacy)
    .where(and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, input.boardUuid)))
    .for('update', { noWait: true })
    .limit(1);
  const [wall] = await db
    .select({
      boardUuid: tables.sprayWalls.boardUuid,
      currentVersionId: tables.sprayWalls.currentVersionId,
      deletedAt: tables.sprayWalls.deletedAt,
      archivedAt: tables.sprayWalls.archivedAt,
    })
    .from(tables.sprayWalls)
    .where(eq(tables.sprayWalls.boardUuid, input.boardUuid))
    .for('update', { noWait: true })
    .limit(1);
  if (!activeWall(board, wall)) refusal('The selected spray wall is not active.', 'NOT_FOUND');
  if (board.ownerId !== candidate.ownerId) refusal('The spray wall owner changed. Inspect it again.');
  if ((await isBoardHeldOffGym(board.id, gym.id)) || (await isLatestHoldEventStaffRemoval(board.id)))
    refusal('This wall was removed by staff. Resolve its listing hold before attaching it.');
  return { gym, board, policy };
}

function handleLockFailure(error: unknown): never {
  if (getPostgresErrorCode(error) === '55P03') refusal('The selected gym or wall is changing. Retry the same action.');
  throw error;
}

/** This repair changes the catalogue association only; publication and audience remain owner-controlled. */
export async function attachUnlinkedSprayWallToGym(input: SprayWallGymLinkInput, context: ConnectionContext) {
  const validated = attachmentSchema.parse(input);
  return runWithDatabaseTransaction(() =>
    transactionWithAfterCommit(async (transaction) => {
      const { gym, board, policy } = await lockSelection(validated, context);
      if (board.gymId !== null)
        refusal('The spray wall already belongs to a gym. This action only attaches unlinked walls.');
      if (
        boardRepairStateHash(board, policy) !== validated.expectedStateHash ||
        gymRepairStateHash(gym) !== validated.expectedGymStateHash
      )
        refusal('The gym or wall changed. Inspect both again before attaching the wall.');
      const now = new Date();
      const [updated] = await transaction
        .update(tables.userBoards)
        .set({ gymId: gym.id, updatedAt: now, syncFrozenAt: now })
        .where(eq(tables.userBoards.id, board.id))
        .returning();
      const stateHash = boardRepairStateHash(updated!, policy);
      await transaction.insert(tables.gymDirectoryRepairAudit).values({
        operation: OPERATION,
        gymId: gym.id,
        gymUuid: gym.uuid,
        actorUserId: context.userId!,
        reason: validated.reason,
        before: { gymId: null },
        after: { gymId: gym.id },
        details: {
          boardUuid: board.uuid,
          expectedStateHash: validated.expectedStateHash,
          expectedGymStateHash: validated.expectedGymStateHash,
          stateHashAfter: stateHash,
        },
      });
      await recordBoardModerationEvent(transaction, {
        boardId: board.id,
        gymId: gym.id,
        actorUserId: context.userId!,
        actorRole: 'global_admin',
        action: 'relinked',
        reason: validated.reason,
        details: { mutation: OPERATION, fields: ['gymId'] },
      });
      return { gymUuid: gym.uuid, boardUuid: board.uuid, stateHash };
    }),
  ).catch(handleLockFailure);
}

/** A cached receipt cannot reveal an earlier owner/audience snapshot after the approved state changes. */
export async function authorizeSprayWallGymLinkReplay(input: SprayWallGymLinkInput, context: ConnectionContext) {
  const validated = attachmentSchema.parse(input);
  return runWithDatabaseTransaction(async () => {
    const { gym, board, policy } = await lockSelection(validated, context);
    if (board.gymId !== gym.id || gymRepairStateHash(gym) !== validated.expectedGymStateHash)
      refusal('The selected gym or wall changed. Inspect them before starting a new action.');
    const [audit] = await db
      .select({ details: tables.gymDirectoryRepairAudit.details })
      .from(tables.gymDirectoryRepairAudit)
      .where(
        and(
          eq(tables.gymDirectoryRepairAudit.operation, OPERATION),
          eq(tables.gymDirectoryRepairAudit.gymUuid, gym.uuid),
          eq(tables.gymDirectoryRepairAudit.actorUserId, context.userId!),
          eq(tables.gymDirectoryRepairAudit.reason, validated.reason),
          sql`${tables.gymDirectoryRepairAudit.details}->>'boardUuid' = ${board.uuid}`,
          sql`${tables.gymDirectoryRepairAudit.details}->>'expectedStateHash' = ${validated.expectedStateHash}`,
          sql`${tables.gymDirectoryRepairAudit.details}->>'expectedGymStateHash' = ${validated.expectedGymStateHash}`,
        ),
      )
      .orderBy(desc(tables.gymDirectoryRepairAudit.id))
      .limit(1);
    const details = audit?.details;
    if (
      !details ||
      typeof details !== 'object' ||
      !('stateHashAfter' in details) ||
      details.stateHashAfter !== boardRepairStateHash(board, policy)
    )
      refusal('The spray wall changed. Inspect it before starting a new action.');
  }).catch(handleLockFailure);
}
