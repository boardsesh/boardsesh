import { and, eq, exists, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import * as schema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { playlistVisibilityCondition } from '../playlists/helpers/enrichment';
import {
  contentVisibilityCondition,
  resourceAccessCondition,
  userActivityVisibilityCondition,
} from '../../../services/privacy';

// Predicate construction must not depend on a database connection or its mocks.
const queryBuilder = new QueryBuilder();

/** Identifiable logs obey both their author/item audience and their containers. */
export function tickPrivacyCondition(
  viewerId: string | null | undefined,
  ticks: {
    uuid: SQLWrapper;
    userId: SQLWrapper;
    sessionId: SQLWrapper;
    boardId: SQLWrapper;
    climbUuid: SQLWrapper;
    boardType: SQLWrapper;
  } = schema.boardseshTicks,
  allowOwnWithoutClimb = false,
): SQL {
  const board = alias(schema.userBoards, 'privacy_tick_board');
  const climb = alias(schema.boardClimbs, 'privacy_tick_climb');
  const climbAlias = alias(schema.boardClimbAliases, 'privacy_tick_climb_alias');
  const canonicalClimbUuid = queryBuilder
    .select({ uuid: climbAlias.canonicalUuid })
    .from(climbAlias)
    .where(and(eq(climbAlias.aliasUuid, ticks.climbUuid), eq(climbAlias.boardType, ticks.boardType)));
  const referencedClimb = and(
    eq(climb.uuid, sql`COALESCE((${canonicalClimbUuid}), ${ticks.climbUuid})`),
    eq(climb.boardType, ticks.boardType),
  );
  const containerAccess = and(
    or(isNull(ticks.sessionId), resourceAccessCondition('session', ticks.sessionId, viewerId)),
    or(
      isNull(ticks.boardId),
      exists(
        queryBuilder
          .select({ id: board.id })
          .from(board)
          .where(and(eq(board.id, ticks.boardId), resourceAccessCondition('board', board.uuid, viewerId))),
      ),
    ),
  );
  return and(
    contentVisibilityCondition('tick', ticks.uuid, ticks.userId, viewerId),
    // A public tick cannot reveal metadata from an authored climb whose
    // audience has since narrowed. Enriched feeds may retain denormalized
    // names after deletion, so only raw owner reads allow a missing parent.
    or(
      allowOwnWithoutClimb && viewerId ? eq(ticks.userId, viewerId) : sql`false`,
      exists(
        queryBuilder
          .select({ uuid: climb.uuid })
          .from(climb)
          .where(
            and(
              referencedClimb,
              contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
              sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
              or(
                viewerId ? eq(climb.userId, viewerId) : sql`false`,
                and(eq(climb.isDraft, false), eq(climb.isListed, true)),
              ),
            ),
          ),
      ),
    ),
    // The author retains their own logbook even after losing access to a wall.
    or(viewerId ? eq(ticks.userId, viewerId) : sql`false`, containerAccess),
  )!;
}

/** Beta can identify its author, tick, wall and climb even without a userId field. */
export function betaPrivacyCondition(
  viewerId: string | null | undefined,
  beta: {
    boardType: SQLWrapper;
    climbUuid: SQLWrapper;
    link: SQLWrapper;
    createdByUserId: SQLWrapper;
    tickUuid: SQLWrapper;
    boardId: SQLWrapper;
  } = schema.boardBetaLinks,
): SQL {
  const tick = alias(schema.boardseshTicks, 'privacy_beta_tick');
  const board = alias(schema.userBoards, 'privacy_beta_board');
  const climb = alias(schema.boardClimbs, 'privacy_beta_climb');
  return and(
    contentVisibilityCondition(
      'beta',
      sql`${beta.boardType} || ':' || ${beta.climbUuid} || ':' || ${beta.link}`,
      beta.createdByUserId,
      viewerId,
    ),
    or(
      isNull(beta.tickUuid),
      exists(
        queryBuilder
          .select({ id: tick.id })
          .from(tick)
          .where(and(eq(tick.uuid, beta.tickUuid), tickPrivacyCondition(viewerId, tick))),
      ),
    ),
    or(
      isNull(beta.boardId),
      exists(
        queryBuilder
          .select({ id: board.id })
          .from(board)
          .where(and(eq(board.id, beta.boardId), resourceAccessCondition('board', board.uuid, viewerId))),
      ),
    ),
    exists(
      queryBuilder
        .select({ uuid: climb.uuid })
        .from(climb)
        .where(
          and(
            eq(climb.uuid, beta.climbUuid),
            eq(climb.boardType, beta.boardType),
            contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
            sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
            or(
              viewerId ? eq(climb.userId, viewerId) : sql`false`,
              and(eq(climb.isDraft, false), eq(climb.isListed, true)),
            ),
          ),
        ),
    ),
  )!;
}

/** A UUID is an address, not permission to read its discussion or notifications. */
export function socialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
): SQL {
  // Resolve at most two comment references before checking the real entity.
  // Expanding every entity branch recursively produces a huge query plan (and
  // seconds of JIT compilation) even for a feed containing only a few comments.
  // Each traversed comment still checks its own audience and reply ancestors;
  // missing references, cycles and longer chains never reach an allowed entity.
  return sql`EXISTS (
    WITH RECURSIVE privacy_entity_chain AS (
      SELECT ${entityType}::text AS entity_type, ${entityId}::text AS entity_id, 0 AS depth
      UNION ALL
      SELECT privacy_entity_reference.entity_type, privacy_entity_reference.entity_id, privacy_entity_chain.depth + 1
      FROM privacy_entity_chain
      JOIN comments privacy_entity_reference ON privacy_entity_reference.uuid = privacy_entity_chain.entity_id
      WHERE privacy_entity_chain.entity_type = 'comment' AND privacy_entity_chain.depth < 2
        AND ${commentPrivacyCondition(viewerId, {
          uuid: sql`privacy_entity_reference.uuid`,
          userId: sql`privacy_entity_reference.user_id`,
          parentCommentId: sql`privacy_entity_reference.parent_comment_id`,
        })}
    )
    SELECT 1 FROM privacy_entity_chain privacy_entity_target
    WHERE ${terminalSocialEntityPrivacyCondition(sql`privacy_entity_target.entity_type`, sql`privacy_entity_target.entity_id`, viewerId)}
  )`;
}

function terminalSocialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
): SQL {
  const tick = alias(schema.boardseshTicks, 'privacy_entity_tick');
  const climb = alias(schema.boardClimbs, 'privacy_entity_climb');
  const proposal = alias(schema.climbProposals, 'privacy_entity_proposal');
  return sql`CASE
    WHEN ${entityType} = 'tick' THEN ${exists(
      queryBuilder
        .select({ id: tick.id })
        .from(tick)
        .where(and(eq(tick.uuid, entityId), tickPrivacyCondition(viewerId, tick))),
    )}
    WHEN ${entityType} = 'session' THEN ${resourceAccessCondition('session', entityId, viewerId)}
    WHEN ${entityType} = 'board' THEN ${resourceAccessCondition('board', entityId, viewerId)}
    WHEN ${entityType} = 'climb' THEN ${exists(
      queryBuilder
        .select({ uuid: climb.uuid })
        .from(climb)
        .where(
          and(
            eq(climb.uuid, entityId),
            contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
            sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
            or(
              viewerId ? eq(climb.userId, viewerId) : sql`false`,
              and(eq(climb.isDraft, false), eq(climb.isListed, true)),
            ),
          ),
        ),
    )}
    WHEN ${entityType} = 'proposal' THEN ${exists(
      queryBuilder
        .select({ id: proposal.id })
        .from(proposal)
        .where(
          and(
            eq(proposal.uuid, entityId),
            userActivityVisibilityCondition(proposal.proposerId, viewerId),
            exists(
              queryBuilder
                .select({ uuid: climb.uuid })
                .from(climb)
                .where(
                  and(
                    eq(climb.uuid, proposal.climbUuid),
                    eq(climb.boardType, proposal.boardType),
                    contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
                    sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
                    or(
                      viewerId ? eq(climb.userId, viewerId) : sql`false`,
                      and(eq(climb.isDraft, false), eq(climb.isListed, true)),
                    ),
                  ),
                ),
            ),
          ),
        ),
    )}
    WHEN ${entityType} = 'playlist_climb' THEN ${exists(
      queryBuilder
        .select({ id: schema.playlists.id })
        .from(schema.playlists)
        .where(
          and(
            eq(schema.playlists.uuid, sql`split_part(${entityId}, ':', 1)`),
            playlistVisibilityCondition(viewerId),
            or(
              sql`split_part(${entityId}, ':', 2) = '_all'`,
              exists(
                queryBuilder
                  .select({ id: schema.playlistClimbs.id })
                  .from(schema.playlistClimbs)
                  .innerJoin(
                    climb,
                    and(
                      eq(climb.uuid, schema.playlistClimbs.climbUuid),
                      eq(climb.boardType, schema.playlists.boardType),
                    ),
                  )
                  .where(
                    and(
                      eq(schema.playlistClimbs.playlistId, schema.playlists.id),
                      eq(climb.uuid, sql`split_part(${entityId}, ':', 2)`),
                      contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
                      sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
                      or(
                        viewerId ? eq(climb.userId, viewerId) : sql`false`,
                        and(eq(climb.isDraft, false), eq(climb.isListed, true)),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        ),
    )}
    WHEN ${entityType} = 'gym' THEN ${exists(
      queryBuilder
        .select({ id: schema.gyms.id })
        .from(schema.gyms)
        .where(and(eq(schema.gyms.uuid, entityId), isNull(schema.gyms.deletedAt))),
    )}
    ELSE false END`;
}

/** A public reply never widens a private ancestor's audience. */
export function commentPrivacyCondition(
  viewerId: string | null | undefined,
  comment: { uuid: SQLWrapper; userId: SQLWrapper; parentCommentId: SQLWrapper } = schema.comments,
): SQL {
  return and(
    contentVisibilityCondition('comment', comment.uuid, comment.userId, viewerId),
    sql`NOT EXISTS (
    WITH RECURSIVE privacy_ancestors AS (
      SELECT privacy_parent_seed.id, privacy_parent_seed.uuid, privacy_parent_seed.user_id, privacy_parent_seed.parent_comment_id, 1 AS depth FROM comments privacy_parent_seed WHERE privacy_parent_seed.id = ${comment.parentCommentId}
      UNION ALL
      SELECT parent.id, parent.uuid, parent.user_id, parent.parent_comment_id, child.depth + 1
      FROM comments parent JOIN privacy_ancestors child ON parent.id = child.parent_comment_id
      WHERE child.depth < 32
    )
    SELECT 1 FROM privacy_ancestors ancestor WHERE
      NOT ${contentVisibilityCondition('comment', sql`ancestor.uuid`, sql`ancestor.user_id`, viewerId)}
      OR (ancestor.depth = 32 AND ancestor.parent_comment_id IS NOT NULL)
  )`,
  )!;
}

export async function canReadSocialEntity(
  entityType: string,
  entityId: string,
  viewerId: string | null | undefined,
): Promise<boolean> {
  const [result] = await db
    .select({ allowed: socialEntityPrivacyCondition(sql`${entityType}`, sql`${entityId}`, viewerId) })
    .from(sql`(SELECT 1) privacy_check`);
  return result?.allowed === true;
}

export async function canReadDeletedComment(
  commentUuid: string,
  authorUserId: string,
  parentCommentId: number | null,
  viewerId: string | null | undefined,
): Promise<boolean> {
  const [result] = await db
    .select({
      allowed: commentPrivacyCondition(viewerId, {
        uuid: sql`${commentUuid}::text`,
        userId: sql`${authorUserId}::text`,
        parentCommentId: sql`${parentCommentId}::integer`,
      }),
    })
    .from(sql`(SELECT 1) privacy_deleted_comment`);
  return result?.allowed === true;
}

export function notificationPrivacyCondition(
  viewerId: string,
  notification: {
    type: SQLWrapper;
    actorId: SQLWrapper;
    commentId: SQLWrapper;
    entityType: SQLWrapper;
    entityId: SQLWrapper;
  } = schema.notifications,
): SQL {
  const comment = alias(schema.comments, 'privacy_notification_comment');
  return or(
    eq(notification.type, 'new_follower'),
    and(
      or(
        isNull(notification.actorId),
        and(
          isNull(notification.commentId),
          contentVisibilityCondition(notification.entityType, notification.entityId, notification.actorId, viewerId),
        ),
        exists(
          queryBuilder
            .select({ id: comment.id })
            .from(comment)
            .where(and(eq(comment.id, notification.commentId), commentPrivacyCondition(viewerId, comment))),
        ),
      ),
      socialEntityPrivacyCondition(notification.entityType, notification.entityId, viewerId),
    ),
  )!;
}
