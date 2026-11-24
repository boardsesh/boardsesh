import { and, asc, eq, exists, inArray, isNull, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { mergeLockedBoards, lockBoardSerialWrite, SYSTEM_USER_ID, type BoardMergeRow } from '@boardsesh/db/queries';
import { normaliseSetIds } from '@boardsesh/board-config';
import { KioskLayoutSchema, parseKioskLayoutLenient, type KioskLayout } from '@boardsesh/kiosk';
import { afterCommit, transactionWithAfterCommit } from '../db/after-commit';
import { requireAdmin } from '../graphql/resolvers/social/roles';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import { resolveReportsForMergedBoard } from '../graphql/resolvers/social/directory-reports';
import { recordBoardModerationEvent } from '../graphql/resolvers/social/board-moderation-events';
import { publishBoardQueuePreviewTombstoneForBoard } from './board-queue-preview';
import { notifyResourcePrivacyChanged } from './board-session-privacy';
import { boardRepairStateHash } from './board-repair-state';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import {
  captureFixedSystemOwnerOrderMode,
  lockCooperativeFixedSystemOwnerTransaction,
} from './fixed-system-owner-order';

const MergeDuplicateBoardsSchema = z
  .object({
    gymUuid: z.uuid(),
    canonicalBoardUuid: z.uuid(),
    duplicateBoardUuids: z.array(z.uuid()).min(1).max(10),
    reason: z.string().trim().min(10).max(1000),
    expectedStates: z
      .array(z.object({ boardUuid: z.uuid(), stateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .min(2)
      .max(11),
  })
  .strict();
export type MergeDuplicateBoardsInput = z.infer<typeof MergeDuplicateBoardsSchema>;

function conflict(message: string): never {
  throw new GraphQLError(message, { extensions: { code: 'CONFLICT' } });
}

/** Replace only the requested board identities, retaining order and all kiosk settings. */
export function mergeKioskBoardReferences(
  layout: KioskLayout,
  duplicateUuids: ReadonlySet<string>,
  canonicalUuid: string,
): KioskLayout {
  const seen = new Set<string>();
  const boards = layout.boards.flatMap((slot) => {
    const boardUuid = duplicateUuids.has(slot.boardUuid) ? canonicalUuid : slot.boardUuid;
    if (seen.has(boardUuid)) return [];
    seen.add(boardUuid);
    return [{ ...slot, boardUuid }];
  });
  const leaderboard =
    layout.leaderboard === null
      ? null
      : {
          ...layout.leaderboard,
          boardUuid:
            layout.leaderboard.boardUuid !== null && duplicateUuids.has(layout.leaderboard.boardUuid)
              ? canonicalUuid
              : layout.leaderboard.boardUuid,
        };
  return KioskLayoutSchema.parse({ ...layout, boards, leaderboard });
}

function asMergeRow(board: typeof tables.userBoards.$inferSelect): BoardMergeRow {
  return {
    ...board,
    climbEventCount: 0,
    tickCount: 0,
    followCount: 0,
  };
}

/**
 * Explicit, serial-independent repair of confirmed duplicate public catalogue walls.
 * Captured reporting IDs, source provenance and historical audit identities stay original.
 * Restricted boards and independently granted access need a separate merge contract.
 */
export async function mergeDuplicateBoards(input: MergeDuplicateBoardsInput, context: ConnectionContext) {
  await requireAdmin(context);
  await applyRateLimit(context, 20, 'mergeDuplicateBoards');
  const validated = MergeDuplicateBoardsSchema.parse(input);
  const duplicateUuids = [...new Set(validated.duplicateBoardUuids)];
  if (duplicateUuids.includes(validated.canonicalBoardUuid)) conflict('The survivor cannot also be a duplicate.');
  const allUuids = [validated.canonicalBoardUuid, ...duplicateUuids];
  const duplicateSet = new Set(duplicateUuids);
  const orderMode = captureFixedSystemOwnerOrderMode();
  try {
    return await transactionWithAfterCommit(
      async (transaction) => {
        await lockCooperativeFixedSystemOwnerTransaction(transaction, orderMode);
        // Privacy and account writers lock users before boards. Pin every user
        // the merge may reference before board locks, so follow/audit FKs cannot
        // invert that order later in the migration.
        const ownerCandidates = await transaction
          .select({ uuid: tables.userBoards.uuid, ownerId: tables.userBoards.ownerId })
          .from(tables.userBoards)
          .where(inArray(tables.userBoards.uuid, allUuids));
        const ownerByBoardUuid = new Map(ownerCandidates.map((board) => [board.uuid, board.ownerId]));
        const referencedUserIds = [
          ...new Set([context.userId!, ...ownerCandidates.map((board) => board.ownerId)]),
        ].sort();
        const referencedUsers = await transaction
          .select({ id: tables.users.id })
          .from(tables.users)
          .where(inArray(tables.users.id, referencedUserIds))
          .orderBy(asc(tables.users.id))
          .for('key share', { noWait: true });
        if (referencedUsers.length !== referencedUserIds.length)
          conflict('A board owner is changing. Inspect the boards again.');
        // A live qualifying global role stays pinned through commit, including standalone callers.
        const [role] = await transaction
          .select({ id: tables.communityRoles.id })
          .from(tables.communityRoles)
          .where(
            and(
              eq(tables.communityRoles.userId, context.userId!),
              eq(tables.communityRoles.role, 'admin'),
              isNull(tables.communityRoles.boardType),
            ),
          )
          .for('share');
        if (!role) throw new GraphQLError('Global admin role required.', { extensions: { code: 'FORBIDDEN' } });
        // First-party writers use board -> serial. NOWAIT avoids an inverted gym/board wait
        // when this operation is called inside an outer MCP authorization transaction.
        const locked = await transaction
          .select()
          .from(tables.userBoards)
          .where(
            or(inArray(tables.userBoards.uuid, allUuids), inArray(tables.userBoards.mergedIntoBoardUuid, allUuids)),
          )
          .orderBy(asc(tables.userBoards.id))
          .for('update', { noWait: true });
        const boards = locked.filter((board) => allUuids.includes(board.uuid));
        if (
          boards.length !== allUuids.length ||
          boards.some((board) => board.deletedAt !== null || board.mergedIntoBoardUuid !== null)
        ) {
          conflict('Every selected board must still be active and unmerged. Inspect the boards again.');
        }
        if (boards.some((board) => ownerByBoardUuid.get(board.uuid) !== board.ownerId))
          conflict('A selected board changed owners during the merge. Inspect the boards again.');
        const canonical = boards.find((board) => board.uuid === validated.canonicalBoardUuid)!;
        for (const serial of [
          ...new Set(boards.flatMap((board) => (board.serialNumber?.trim() ? [board.serialNumber] : []))),
        ].sort()) {
          await lockBoardSerialWrite(transaction, serial);
        }
        const [gym] = await transaction
          .select({ id: tables.gyms.id })
          .from(tables.gyms)
          .where(
            and(
              eq(tables.gyms.uuid, validated.gymUuid),
              isNull(tables.gyms.deletedAt),
              isNull(tables.gyms.mergedIntoGymId),
            ),
          )
          .for('share', { noWait: true });
        if (!gym || boards.some((board) => board.gymId !== gym.id))
          conflict('Merge the gyms first, then select boards attached to the same canonical gym.');
        const canonicalConfig = `${canonical.boardType}|${canonical.layoutId}|${canonical.sizeId}|${normaliseSetIds(canonical.setIds)}`;
        if (
          boards.some(
            (board) =>
              board.boardType === 'spray' ||
              `${board.boardType}|${board.layoutId}|${board.sizeId}|${normaliseSetIds(board.setIds)}` !==
                canonicalConfig,
          )
        ) {
          conflict(
            'Selected boards need identical catalogue layouts, sizes and hold sets. Correct stale setups separately.',
          );
        }
        if (boards.some((board) => !board.isPublic || board.isUnlisted))
          conflict('This repair supports public, listed catalogue boards only.');
        // Different non-null controller identities are evidence this is not a confirmed wall.
        if (new Set(boards.flatMap((board) => (board.serialNumber?.trim() ? [board.serialNumber] : []))).size > 1) {
          conflict('The selected boards have different controller serials. Resolve that evidence before merging.');
        }
        const policies = await transaction
          .select()
          .from(tables.resourcePrivacy)
          .where(and(eq(tables.resourcePrivacy.kind, 'board'), inArray(tables.resourcePrivacy.resourceId, allUuids)))
          .for('update');
        if (
          validated.expectedStates.length !== allUuids.length ||
          new Set(validated.expectedStates.map((expected) => expected.boardUuid)).size !== allUuids.length
        )
          conflict('Expected board states must identify every selected board exactly once.');
        for (const board of boards) {
          const expected = validated.expectedStates.find((entry) => entry.boardUuid === board.uuid);
          const policy = policies.find((entry) => entry.resourceId === board.uuid);
          if (!expected || expected.stateHash !== boardRepairStateHash(board, policy))
            conflict('A selected board changed after inspection. Inspect the boards again before merging.');
        }
        if (
          policies.some(
            (policy) => policy.audience !== 'public' || policy.locationAudience !== 'public' || policy.inheritFollowers,
          )
        ) {
          conflict(
            'A selected board has a restricted privacy policy. Correct its location explicitly or use a reviewed restricted-board merge.',
          );
        }
        const [grant] = await transaction
          .select({ resourceId: tables.resourceGrants.resourceId })
          .from(tables.resourceGrants)
          .where(and(eq(tables.resourceGrants.kind, 'board'), inArray(tables.resourceGrants.resourceId, allUuids)))
          .limit(1);
        const [shareLink] = await transaction
          .select({ boardUuid: tables.boardShareLinks.boardUuid })
          .from(tables.boardShareLinks)
          .where(and(inArray(tables.boardShareLinks.boardUuid, allUuids), isNull(tables.boardShareLinks.revokedAt)))
          .limit(1);
        if (grant || shareLink)
          conflict(
            'A selected board has explicit access grants or an active share link. Review that access before merging.',
          );
        const boardIds = boards.map((board) => board.id);
        const [alias] = await transaction
          .select({ id: tables.gymReportingBoardAliases.id })
          .from(tables.gymReportingBoardAliases)
          .where(
            and(
              isNull(tables.gymReportingBoardAliases.revokedAt),
              or(
                inArray(tables.gymReportingBoardAliases.boardId, boardIds),
                inArray(tables.gymReportingBoardAliases.rootBoardId, boardIds),
              ),
            ),
          )
          .limit(1);
        if (alias)
          conflict('Remove the existing physical-board reporting grouping before merging these board identities.');
        const collections = await transaction
          .select()
          .from(tables.gymBoardGradeCollections)
          .where(inArray(tables.gymBoardGradeCollections.boardId, boardIds))
          .for('update');
        const selections = [
          ...new Set(collections.flatMap((selection) => (selection.playlistId === null ? [] : [selection.playlistId]))),
        ];
        if (selections.length > 1)
          conflict('These boards use different grade comparison collections. Choose one collection before merging.');
        const kiosks = await transaction
          .select()
          .from(tables.gymKiosks)
          .where(eq(tables.gymKiosks.gymId, gym.id))
          .orderBy(asc(tables.gymKiosks.id))
          .for('update', { noWait: true });
        const kioskUpdates = kiosks.flatMap((kiosk) => {
          const { layout } = parseKioskLayoutLenient(kiosk.layout);
          const referencesDuplicate =
            layout.boards.some((slot) => duplicateSet.has(slot.boardUuid)) ||
            (layout.leaderboard?.boardUuid != null && duplicateSet.has(layout.leaderboard.boardUuid));
          return referencesDuplicate
            ? [{ kiosk, layout: mergeKioskBoardReferences(layout, duplicateSet, canonical.uuid) }]
            : [];
        });
        const flattenedIds = locked
          .filter((board) => board.mergedIntoBoardUuid !== null && duplicateSet.has(board.mergedIntoBoardUuid))
          .map((board) => board.id);
        // Rebinding can own a session before consulting its board. Refuse that
        // inverse lock order rather than waiting while holding the merge boards.
        await transaction
          .select({ id: tables.boardSessions.id })
          .from(tables.boardSessions)
          .where(
            or(
              inArray(tables.boardSessions.boardId, boardIds),
              exists(
                transaction
                  .select({ id: tables.sessionBoards.id })
                  .from(tables.sessionBoards)
                  .where(
                    and(
                      eq(tables.sessionBoards.sessionId, tables.boardSessions.id),
                      inArray(tables.sessionBoards.boardId, boardIds),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(tables.boardSessions.id))
          .for('no key update', { noWait: true });
        const counts = await mergeLockedBoards(
          transaction,
          boards.map(asMergeRow),
          asMergeRow(canonical),
          flattenedIds,
        );
        await transaction
          .update(tables.userBoards)
          .set({ syncFrozenAt: new Date() })
          .where(inArray(tables.userBoards.id, boardIds));
        // Legacy booleans and the policy projection must agree after restrictive OR merging.
        const locationHidden = boards.some((board) => board.hideLocation);
        if (policies.some((policy) => policy.resourceId === canonical.uuid) && locationHidden) {
          await transaction
            .update(tables.resourcePrivacy)
            .set({
              locationAudience: 'only_me',
              revision: policies.find((policy) => policy.resourceId === canonical.uuid)!.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, canonical.uuid)),
            );
        }
        if (selections[0] !== undefined) {
          await transaction
            .insert(tables.gymBoardGradeCollections)
            .values({ boardId: canonical.id, playlistId: selections[0] })
            .onConflictDoUpdate({
              target: tables.gymBoardGradeCollections.boardId,
              set: { playlistId: selections[0] },
            });
        }
        await transaction.delete(tables.gymBoardGradeCollections).where(
          inArray(
            tables.gymBoardGradeCollections.boardId,
            boards.filter((board) => duplicateSet.has(board.uuid)).map((board) => board.id),
          ),
        );
        for (const { kiosk, layout } of kioskUpdates) {
          await transaction
            .update(tables.gymKiosks)
            .set({ layout, updatedAt: new Date() })
            .where(eq(tables.gymKiosks.id, kiosk.id));
        }
        let reportsClosed = 0;
        for (const duplicate of boards.filter((board) => duplicateSet.has(board.uuid))) {
          reportsClosed += await resolveReportsForMergedBoard(duplicate.id, canonical.id, transaction);
        }
        const before = boards.map(({ uuid, ownerId, name, layoutId, sizeId, setIds, hideLocation, isUnlisted }) => ({
          uuid,
          ownerId,
          name,
          layoutId,
          sizeId,
          setIds,
          hideLocation,
          isUnlisted,
        }));
        const details = {
          mutation: 'mergeDuplicateBoards',
          fields: ['mergedIntoBoardUuid'],
          merge: { canonicalBoardUuid: canonical.uuid, duplicateBoardUuids: duplicateUuids, before, counts },
        };
        await recordBoardModerationEvent(transaction, {
          boardId: canonical.id,
          gymId: gym.id,
          actorUserId: context.userId!,
          actorRole: 'global_admin',
          action: 'edited_by_staff',
          reason: validated.reason,
          details,
        });
        // Preserve the original target so every affected creator can read their
        // own notice after tombstoning. One representative per owner avoids spam
        // when several of that owner's rows described the same physical wall.
        const notifiedOwnerIds = new Set([canonical.ownerId, context.userId!, SYSTEM_USER_ID]);
        for (const duplicate of boards.filter((board) => duplicateSet.has(board.uuid))) {
          if (notifiedOwnerIds.has(duplicate.ownerId)) continue;
          notifiedOwnerIds.add(duplicate.ownerId);
          await recordBoardModerationEvent(transaction, {
            boardId: duplicate.id,
            gymId: gym.id,
            actorUserId: context.userId!,
            actorRole: 'global_admin',
            action: 'edited_by_staff',
            reason: validated.reason,
            details,
          });
        }
        afterCommit(transaction, () => {
          void Promise.all(boards.map((board) => publishBoardQueuePreviewTombstoneForBoard(board.id)))
            .then(() => notifyResourcePrivacyChanged('board', canonical.uuid))
            .catch((error: unknown) =>
              logger.warn('Board merge preview refresh failed after commit', {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        });
        return {
          canonicalBoardUuid: canonical.uuid,
          mergedBoardUuids: duplicateUuids,
          counts,
          reportsClosed,
          kiosksUpdated: kioskUpdates.length,
        };
      },
      { isolationLevel: 'read committed' },
    );
  } catch (error) {
    if (getPostgresErrorCode(error) === '55P03')
      conflict('These boards are changing. Retry the same merge after inspecting their current state.');
    throw error;
  }
}
