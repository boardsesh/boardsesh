import { and, eq, inArray, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';

// Any drizzle-orm PgDatabase (the backend's `db` singleton, or the
// `tx` a `db.transaction(...)` callback receives) satisfies this — the
// callers here always pass a transaction so the deletes are atomic with
// whatever else the caller is doing (e.g. deleting the climb row itself).
type DrizzleTx = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Delete the rows that hang off a set of climbs without an FK back to
 * `board_climbs` — `board_climb_stats`, `board_climb_stats_history`, and
 * `board_beta_links`. There is no `ON DELETE CASCADE` here on purpose:
 * stats legitimately arrive before their climb during upstream sync (see
 * the schema note at `packages/db/src/schema/boards/unified.ts` near the
 * `boardClimbStats` table), so every site that deletes a `board_climbs`
 * row is responsible for clearing these itself or it strands an orphan
 * (issue #3943).
 *
 * Callers MUST run this before deleting the `board_climbs` row(s) it
 * targets, in the same transaction. `board_climb_holds` needs no such
 * call — it has a real FK cascade (`board_climb_holds_climb_fk`).
 */
export async function deleteClimbDependentRows(
  tx: DrizzleTx,
  boardType: string,
  climbUuids: readonly string[],
): Promise<void> {
  if (climbUuids.length === 0) return;

  await tx
    .delete(dbSchema.boardClimbStats)
    .where(
      and(eq(dbSchema.boardClimbStats.boardType, boardType), inArray(dbSchema.boardClimbStats.climbUuid, climbUuids)),
    );

  await tx
    .delete(dbSchema.boardClimbStatsHistory)
    .where(
      and(
        eq(dbSchema.boardClimbStatsHistory.boardType, boardType),
        inArray(dbSchema.boardClimbStatsHistory.climbUuid, climbUuids),
      ),
    );

  await tx
    .delete(dbSchema.boardBetaLinks)
    .where(
      and(eq(dbSchema.boardBetaLinks.boardType, boardType), inArray(dbSchema.boardBetaLinks.climbUuid, climbUuids)),
    );
}

/**
 * Group (boardType, climbUuid) pairs by boardType, for callers that need
 * to clean up dependent rows for climbs spanning more than one board
 * (e.g. account deletion, where a user's drafts can live on any board).
 */
export function groupClimbUuidsByBoardType(
  climbs: readonly { boardType: string; uuid: string }[],
): Map<string, string[]> {
  const byBoardType = new Map<string, string[]>();
  for (const climb of climbs) {
    const existing = byBoardType.get(climb.boardType);
    if (existing) {
      existing.push(climb.uuid);
    } else {
      byBoardType.set(climb.boardType, [climb.uuid]);
    }
  }
  return byBoardType;
}

/**
 * Delete everything that points at ONE published climb, ahead of hard-deleting
 * it (`deleteClimb`, #5960). `deleteClimbDependentRows` covers stats and beta
 * links; this covers the rest, none of which has an FK back to `board_climbs`:
 *
 *  - other climbers' favourites and playlist entries. They never block the
 *    delete (owner decision). Both tables carry user-scoped tombstone triggers,
 *    so each climber's phone drops its copy on the next pull;
 *  - comments on the climb and on its proposals, the votes on the climb and on
 *    those comments, and the vote tallies;
 *  - proposals (their votes cascade), the community and classic status rows and
 *    any climb-scoped community setting;
 *  - the feed rows and notifications that name the climb, its proposals or its
 *    comments, so nobody is handed a card for a climb that is gone;
 *  - the derived tables: popularity, embeddings, similar-climb lists (as the
 *    climb AND as somebody else's neighbour), grades, send stats, climb events,
 *    pending recomputes and ratings.
 *
 * `board_climb_neighbors`, `board_climb_aliases`, `board_climb_holds`,
 * `board_climb_revisions` and `spray_climb_lineage` (as the child) cascade from
 * the climb row itself.
 *
 * Ticks are NOT touched: the caller refuses the delete while any exist.
 * Callers MUST run this in the same transaction as the climb delete, and
 * before it.
 */
export async function deleteClimbReferenceRows(tx: DrizzleTx, boardType: string, climbUuid: string): Promise<void> {
  const proposals = await tx
    .select({ uuid: dbSchema.climbProposals.uuid })
    .from(dbSchema.climbProposals)
    .where(and(eq(dbSchema.climbProposals.boardType, boardType), eq(dbSchema.climbProposals.climbUuid, climbUuid)));
  const proposalUuids = proposals.map((proposal) => proposal.uuid);

  // A reply carries its thread's entity, so this picks up replies too.
  const threadConditions = [and(eq(dbSchema.comments.entityType, 'climb'), eq(dbSchema.comments.entityId, climbUuid))];
  if (proposalUuids.length > 0) {
    threadConditions.push(
      and(eq(dbSchema.comments.entityType, 'proposal'), inArray(dbSchema.comments.entityId, proposalUuids)),
    );
  }
  const commentRows = await tx
    .select({ id: dbSchema.comments.id, uuid: dbSchema.comments.uuid })
    .from(dbSchema.comments)
    .where(or(...threadConditions));
  const commentIds = commentRows.map((comment) => comment.id);
  const commentUuids = commentRows.map((comment) => comment.uuid);

  // Every entity id that names this climb or something hung off it. Climb,
  // proposal and comment uuids are all v4 uuids, so matching on the id alone
  // cannot catch an unrelated row.
  const entityIds = [climbUuid, ...proposalUuids, ...commentUuids];

  const notificationConditions = [inArray(dbSchema.notifications.entityId, entityIds)];
  if (commentIds.length > 0) notificationConditions.push(inArray(dbSchema.notifications.commentId, commentIds));
  await tx.delete(dbSchema.notifications).where(or(...notificationConditions));
  await tx.delete(dbSchema.feedItems).where(inArray(dbSchema.feedItems.entityId, entityIds));

  const votedEntityIds = [climbUuid, ...commentUuids];
  await tx.delete(dbSchema.votes).where(inArray(dbSchema.votes.entityId, votedEntityIds));
  await tx.delete(dbSchema.voteCounts).where(inArray(dbSchema.voteCounts.entityId, votedEntityIds));
  if (commentIds.length > 0) {
    await tx.delete(dbSchema.comments).where(inArray(dbSchema.comments.id, commentIds));
  }

  await tx
    .delete(dbSchema.climbCommunityStatus)
    .where(
      and(
        eq(dbSchema.climbCommunityStatus.boardType, boardType),
        eq(dbSchema.climbCommunityStatus.climbUuid, climbUuid),
      ),
    );
  await tx
    .delete(dbSchema.climbClassicStatus)
    .where(
      and(eq(dbSchema.climbClassicStatus.boardType, boardType), eq(dbSchema.climbClassicStatus.climbUuid, climbUuid)),
    );
  if (proposalUuids.length > 0) {
    await tx.delete(dbSchema.climbProposals).where(inArray(dbSchema.climbProposals.uuid, proposalUuids));
  }
  await tx
    .delete(dbSchema.communitySettings)
    .where(and(eq(dbSchema.communitySettings.scope, 'climb'), eq(dbSchema.communitySettings.scopeKey, climbUuid)));

  await tx
    .delete(dbSchema.userFavorites)
    .where(and(eq(dbSchema.userFavorites.boardName, boardType), eq(dbSchema.userFavorites.climbUuid, climbUuid)));
  await tx
    .delete(dbSchema.playlistClimbs)
    .where(
      and(
        eq(dbSchema.playlistClimbs.climbUuid, climbUuid),
        inArray(
          dbSchema.playlistClimbs.playlistId,
          tx
            .select({ id: dbSchema.playlists.id })
            .from(dbSchema.playlists)
            .where(eq(dbSchema.playlists.boardType, boardType)),
        ),
      ),
    );

  await tx
    .delete(dbSchema.boardClimbPopularity)
    .where(
      and(
        eq(dbSchema.boardClimbPopularity.boardType, boardType),
        eq(dbSchema.boardClimbPopularity.climbUuid, climbUuid),
      ),
    );
  await tx
    .delete(dbSchema.boardClimbEmbeddings)
    .where(
      and(
        eq(dbSchema.boardClimbEmbeddings.boardType, boardType),
        eq(dbSchema.boardClimbEmbeddings.climbUuid, climbUuid),
      ),
    );
  await tx
    .delete(dbSchema.boardClimbSimilar)
    .where(
      and(
        eq(dbSchema.boardClimbSimilar.boardType, boardType),
        or(eq(dbSchema.boardClimbSimilar.climbUuid, climbUuid), eq(dbSchema.boardClimbSimilar.neighborUuid, climbUuid)),
      ),
    );
  await tx
    .delete(dbSchema.boardClimbGrades)
    .where(and(eq(dbSchema.boardClimbGrades.boardType, boardType), eq(dbSchema.boardClimbGrades.climbUuid, climbUuid)));
  await tx
    .delete(dbSchema.boardClimbSendStats)
    .where(
      and(eq(dbSchema.boardClimbSendStats.boardType, boardType), eq(dbSchema.boardClimbSendStats.climbUuid, climbUuid)),
    );
  await tx
    .delete(dbSchema.boardClimbEvents)
    .where(and(eq(dbSchema.boardClimbEvents.boardType, boardType), eq(dbSchema.boardClimbEvents.climbUuid, climbUuid)));
  await tx
    .delete(dbSchema.climbStatsRecomputePending)
    .where(
      and(
        eq(dbSchema.climbStatsRecomputePending.boardType, boardType),
        eq(dbSchema.climbStatsRecomputePending.climbUuid, climbUuid),
      ),
    );
  await tx
    .delete(dbSchema.boardClimbRatings)
    .where(
      and(eq(dbSchema.boardClimbRatings.boardType, boardType), eq(dbSchema.boardClimbRatings.climbUuid, climbUuid)),
    );
}
