import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import { contentVisibilityCondition, resourceAccessCondition, resolveCanonicalClimbUuid } from '@boardsesh/db/queries';
import { boardseshTicks, gymClimbCommentAttributions, userBoards } from '@boardsesh/db/schema';
import { isSharedConfigFeedBoard } from '../board-presence/shared';
import { lockSprayClimbAgainstDelete } from '../climbs/spray-climb-lock';
import { tickPrivacyCondition } from '../shared/activity-privacy';
import { currentSprayWallJoin, sprayInventoryClimbCondition, sprayOnlyMeCondition } from './gym-inventory';
import { ledRankingVariantCondition, validRankingOrientation } from './gym-ranking-variants';
import { readReportingGymIds, type GymReportingTransaction } from './gym-reporting';

type Attribution = Omit<typeof gymClimbCommentAttributions.$inferSelect, 'commentId' | 'commentCreatedAt'>;

function unavailable(): never {
  throw new GraphQLError('Content not available', { extensions: { code: 'NOT_FOUND' } });
}

/**
 * Lock a spray climb before the board, as saveTick does. Hold the tick before locking its parent comment.
 * Tick deletion already takes the tick before sweeping its comment rows.
 */
export async function readTickCommentAttribution(
  tx: GymReportingTransaction,
  tickUuid: string,
  viewerId: string,
): Promise<Attribution | null> {
  await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
  const [candidate] = await tx.select().from(boardseshTicks).where(eq(boardseshTicks.uuid, tickUuid)).limit(1);
  if (!candidate) return unavailable();
  const climbUuid = await resolveCanonicalClimbUuid(tx, candidate.boardType, candidate.climbUuid);
  if (candidate.boardType === 'spray') await lockSprayClimbAgainstDelete(tx, climbUuid);
  const [board] =
    candidate.boardId === null || candidate.boardId !== candidate.reportingBoardId
      ? []
      : await tx
          .select()
          .from(userBoards)
          .where(
            and(
              eq(userBoards.id, candidate.boardId),
              isNull(userBoards.deletedAt),
              isNull(userBoards.mergedIntoBoardUuid),
              resourceAccessCondition('board', userBoards.uuid, viewerId, { allowUnlistedLink: false }),
            ),
          )
          .limit(1)
          .for('share');
  const [tick] = await tx
    .select()
    .from(boardseshTicks)
    .where(
      and(eq(boardseshTicks.uuid, tickUuid), tickPrivacyCondition(viewerId, boardseshTicks, false, 'by-reference')),
    )
    .limit(1)
    .for('share', { of: boardseshTicks });
  if (!tick) return unavailable();
  if (
    !board ||
    board.gymId === null ||
    isSharedConfigFeedBoard(board) ||
    tick.origin !== 'native' ||
    tick.kilterDetachedAt !== null ||
    tick.boardId !== board.id ||
    tick.boardId !== tick.reportingBoardId ||
    tick.reportingGymId === null ||
    tick.reportingAttribution === null ||
    tick.boardType !== board.boardType ||
    tick.climbUuid !== candidate.climbUuid ||
    tick.isMirror === null ||
    !validRankingOrientation(board, tick.angle, tick.isMirror)
  )
    return null;
  const gymIds = await readReportingGymIds(tx, board.gymId);
  if (!gymIds.includes(tick.reportingGymId)) return null;

  const variant =
    board.boardType === 'spray'
      ? sql`${!tick.isMirror && board.angle === tick.angle} AND ${sprayInventoryClimbCondition(board.layoutId)}
        AND EXISTS (SELECT 1 FROM user_boards ${currentSprayWallJoin()}
          WHERE user_boards.id = ${board.id} AND spray_version.id IS NOT NULL AND NOT ${sprayOnlyMeCondition()})`
      : ledRankingVariantCondition(board, sql`${tick.angle}::int`, sql`${tick.isMirror}::boolean`);
  const [eligible] = rowsFromResult(
    await tx.execute(sql`
    SELECT 1 FROM board_climbs WHERE uuid = ${climbUuid} AND ${variant} LIMIT 1
  `),
  );
  if (!eligible) return null;
  return {
    logicalBoardId: board.id,
    boardUuid: board.uuid,
    gymId: tick.reportingGymId,
    boardType: tick.boardType,
    climbUuid,
    angle: tick.angle,
    isMirror: tick.isMirror,
  };
}

export async function inheritsTickCommentAttribution(
  tx: GymReportingTransaction,
  parentId: number,
  attribution: Attribution,
): Promise<boolean> {
  const [parent] = await tx
    .select()
    .from(gymClimbCommentAttributions)
    .where(eq(gymClimbCommentAttributions.commentId, parentId))
    .limit(1);
  return (
    parent != null &&
    parent.logicalBoardId === attribution.logicalBoardId &&
    parent.boardUuid === attribution.boardUuid &&
    parent.gymId === attribution.gymId &&
    parent.boardType === attribution.boardType &&
    parent.climbUuid === attribution.climbUuid &&
    parent.angle === attribution.angle &&
    parent.isMirror === attribution.isMirror
  );
}

export async function insertTickCommentAttribution(
  tx: GymReportingTransaction,
  commentUuid: string,
  attribution: Attribution,
) {
  await tx.execute(sql`
    INSERT INTO gym_climb_comment_attributions
      (comment_id, logical_board_id, board_uuid, gym_id, board_type, climb_uuid, angle, is_mirror, comment_created_at)
    SELECT id, ${attribution.logicalBoardId}, ${attribution.boardUuid}, ${attribution.gymId},
      ${attribution.boardType}, ${attribution.climbUuid}, ${attribution.angle}, ${attribution.isMirror}, created_at
    FROM comments WHERE uuid = ${commentUuid}
  `);
}

/** Ordinary threads keep their participant overrides. Venue counts require direct audience on every ancestor. */
export function reportingCommentAudience(viewerId: string): SQL {
  return sql`EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT discussion.id, discussion.uuid, discussion.user_id, discussion.parent_comment_id, 0 AS depth
      UNION ALL
      SELECT ancestor.id, ancestor.uuid, ancestor.user_id, ancestor.parent_comment_id, child.depth + 1
      FROM ancestors child JOIN comments ancestor ON ancestor.id = child.parent_comment_id
      WHERE child.depth < 32 AND ancestor.entity_type = discussion.entity_type AND ancestor.entity_id = discussion.entity_id
    )
    SELECT 1 FROM ancestors
    HAVING bool_or(parent_comment_id IS NULL) AND bool_and(
      ${contentVisibilityCondition('comment', sql`ancestors.uuid`, sql`ancestors.user_id`, viewerId)}
      AND NOT EXISTS (SELECT 1 FROM content_privacy policy WHERE policy.entity_type = 'comment'
        AND policy.entity_id = ancestors.uuid AND policy.audience = 'only_me')
    )
  )`;
}
