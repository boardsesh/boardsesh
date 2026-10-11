import { and, eq, exists, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import * as schema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { playlistVisibilityCondition } from '../playlists/helpers/enrichment';
import { contentVisibilityCondition, entityOwnerCondition, resourceAccessCondition } from '../../../services/privacy';

// Predicate construction must not depend on a database connection or its mocks.
const queryBuilder = new QueryBuilder();

/**
 * A log follows its author: their account privacy plus the tick's own audience.
 * The session and wall it was logged in never hide it; projections that name the
 * wall blank those fields instead (`boardIdentityVisibleCondition`). The climb
 * clause is separate: a public tick cannot reveal an authored climb whose
 * audience has narrowed.
 *
 * `allowOwnWithoutClimb` is climb-only: raw owner reads (a climber's own
 * logbook and counts) keep a tick whose climb row is gone. Enriched feeds may
 * retain denormalized climb names after deletion, so they leave it off.
 */
export function tickPrivacyCondition(
  viewerId: string | null | undefined,
  ticks: {
    uuid: SQLWrapper;
    userId: SQLWrapper;
    climbUuid: SQLWrapper;
    boardType: SQLWrapper;
  } = schema.boardseshTicks,
  allowOwnWithoutClimb = false,
): SQL {
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
  return and(
    contentVisibilityCondition('tick', ticks.uuid, ticks.userId, viewerId),
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
  )!;
}

/**
 * Beta follows its author, its tick and its climb. The board it was filmed on
 * never hides it; readers blank `boardId` instead (`visibleBoardIdentityIds`).
 */
export function betaPrivacyCondition(
  viewerId: string | null | undefined,
  beta: {
    boardType: SQLWrapper;
    climbUuid: SQLWrapper;
    link: SQLWrapper;
    createdByUserId: SQLWrapper;
    tickUuid: SQLWrapper;
  } = schema.boardBetaLinks,
): SQL {
  const tick = alias(schema.boardseshTicks, 'privacy_beta_tick');
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

/**
 * Whether a session may surface for this viewer somewhere they did not open it
 * by link: a feed or a listing. The session's own policy without the unlisted
 * link, plus its host and anyone who joined it, so an unlisted session's link
 * alone never puts it (or its id, which is that link) there.
 */
export function listedSessionCondition(sessionId: SQLWrapper, viewerId: string | null | undefined): SQL {
  return resourceAccessCondition('session', sessionId, viewerId, {
    allowUnlistedLink: false,
    unlistedWhen: viewerId
      ? sql`EXISTS (SELECT 1 FROM board_session_participants listed_session_member
          WHERE listed_session_member.session_id = ${sessionId} AND listed_session_member.user_id = ${viewerId})`
      : undefined,
  });
}

export type SocialEntityReadOptions = {
  /**
   * The read surfaces entities the viewer did not ask for (the global comment
   * feed, the activity feed). A session there needs `listedSessionCondition`;
   * a direct read (a thread, a vote, a notification addressed to the viewer)
   * keeps the unlisted link.
   */
  discovery?: boolean;
};

/**
 * A UUID is an address, not permission to read its discussion or notifications.
 * Every terminal branch below already admits the item's owner on the account and
 * audience layer (a climber reads their own tick, host their session, setter
 * their climb); the owner's view of other people's comments on it comes from
 * `commentPrivacyCondition`, which each traversed comment passes through. The
 * spray wall rule and a climb's draft/listing rule still apply to owners.
 */
export function socialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
  options: SocialEntityReadOptions = {},
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
      SELECT privacy_entity_reference.entity_type::text, privacy_entity_reference.entity_id, privacy_entity_chain.depth + 1
      FROM privacy_entity_chain
      JOIN comments privacy_entity_reference ON privacy_entity_reference.uuid = privacy_entity_chain.entity_id
      WHERE privacy_entity_chain.entity_type = 'comment' AND privacy_entity_chain.depth < 2
        AND ${commentPrivacyCondition(viewerId, {
          uuid: sql`privacy_entity_reference.uuid`,
          userId: sql`privacy_entity_reference.user_id`,
          parentCommentId: sql`privacy_entity_reference.parent_comment_id`,
          entityType: sql`privacy_entity_reference.entity_type`,
          entityId: sql`privacy_entity_reference.entity_id`,
        })}
    )
    SELECT 1 FROM privacy_entity_chain privacy_entity_target
    WHERE ${terminalSocialEntityPrivacyCondition(sql`privacy_entity_target.entity_type`, sql`privacy_entity_target.entity_id`, viewerId, options)}
  )`;
}

function terminalSocialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
  { discovery = false }: SocialEntityReadOptions,
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
    WHEN ${entityType} = 'session' THEN ${discovery ? listedSessionCondition(entityId, viewerId) : resourceAccessCondition('session', entityId, viewerId)}
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
            // A proposal is moderation on a published climb: its reason, votes
            // and discussion read for everyone who can read the climb. Only a
            // private proposer's identity is withheld, by the enrichment.
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

type CommentPrivacyColumns = {
  uuid: SQLWrapper;
  userId: SQLWrapper;
  parentCommentId: SQLWrapper;
  entityType: SQLWrapper;
  entityId: SQLWrapper;
};

/**
 * A comment is its author's activity, read through its own audience and the
 * audience of every ancestor above it: a public reply never widens a private
 * ancestor. Three exemptions sit on top:
 *
 * - The owner of the commented item (`entityOwnerCondition`) reads every comment
 *   on it, whoever wrote it.
 * - Whoever replied in a thread reads every ancestor of their reply: the
 *   viewer's own comments on the item are walked up to their roots, and any
 *   comment on that path is readable to them.
 * - An ancestor row that no longer exists is readable. Deleting an account
 *   cascades its comments, and that must not orphan the replies under them.
 *
 * Structure still fails closed for everyone: the chain must end at a root or a
 * missing row within 32 ancestors, so a cycle or an over-deep chain never reads.
 */
export function commentPrivacyCondition(
  viewerId: string | null | undefined,
  comment: CommentPrivacyColumns = schema.comments,
): SQL {
  const ownComment = viewerId ? sql`COALESCE(${comment.userId} = ${viewerId}, false)` : sql`false`;
  // Every comment the viewer wrote on this item, walked up to its root. UNION
  // (not UNION ALL) drops repeated rows, so a cyclic chain stops expanding.
  const viewerThread = viewerId
    ? sql`, privacy_viewer_thread AS (
      SELECT privacy_mine.id, privacy_mine.uuid, privacy_mine.parent_comment_id FROM comments privacy_mine
      WHERE privacy_mine.user_id = ${viewerId}
        AND privacy_mine.entity_type = (${comment.entityType})::text::social_entity_type
        AND privacy_mine.entity_id = ${comment.entityId}
      UNION
      SELECT privacy_above.id, privacy_above.uuid, privacy_above.parent_comment_id
      FROM comments privacy_above JOIN privacy_viewer_thread privacy_below ON privacy_above.id = privacy_below.parent_comment_id
    )`
    : sql``;
  const inViewerThread = (uuid: SQLWrapper): SQL =>
    viewerId
      ? sql`EXISTS (SELECT 1 FROM privacy_viewer_thread WHERE privacy_viewer_thread.uuid = ${uuid})`
      : sql`false`;
  const readable = (uuid: SQLWrapper, userId: SQLWrapper): SQL =>
    sql`(${contentVisibilityCondition('comment', uuid, userId, viewerId)} OR ${inViewerThread(uuid)})`;
  return sql`(
    WITH RECURSIVE privacy_ancestors AS (
      SELECT privacy_parent_seed.id, privacy_parent_seed.uuid, privacy_parent_seed.user_id, privacy_parent_seed.parent_comment_id, 1 AS depth FROM comments privacy_parent_seed WHERE privacy_parent_seed.id = ${comment.parentCommentId}
      UNION ALL
      SELECT parent.id, parent.uuid, parent.user_id, parent.parent_comment_id, child.depth + 1
      FROM comments parent JOIN privacy_ancestors child ON parent.id = child.parent_comment_id
      WHERE child.depth < 32
    )${viewerThread}
    SELECT (
      ${comment.parentCommentId} IS NULL
      OR NOT EXISTS (SELECT 1 FROM comments privacy_gone_parent WHERE privacy_gone_parent.id = ${comment.parentCommentId})
      OR EXISTS (
        SELECT 1 FROM privacy_ancestors privacy_chain_end
        WHERE privacy_chain_end.parent_comment_id IS NULL
          OR (privacy_chain_end.depth < 32 AND NOT EXISTS (
            SELECT 1 FROM comments privacy_gone_ancestor WHERE privacy_gone_ancestor.id = privacy_chain_end.parent_comment_id
          ))
      )
    ) AND (
      ${entityOwnerCondition(comment.entityType, comment.entityId, viewerId)}
      OR (
        ${readable(comment.uuid, comment.userId)}
        AND (${ownComment} OR NOT EXISTS (
          SELECT 1 FROM privacy_ancestors ancestor WHERE NOT ${readable(sql`ancestor.uuid`, sql`ancestor.user_id`)}
        ))
      )
    )
  )`;
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

/** A hard-deleted comment's tombstone, checked as if the row still existed. */
export async function canReadDeletedComment(
  deleted: {
    commentUuid: string;
    authorUserId: string;
    parentCommentId: number | null;
    entityType: string;
    entityId: string;
  },
  viewerId: string | null | undefined,
): Promise<boolean> {
  const [result] = await db
    .select({
      allowed: commentPrivacyCondition(viewerId, {
        uuid: sql`${deleted.commentUuid}::text`,
        userId: sql`${deleted.authorUserId}::text`,
        parentCommentId: sql`${deleted.parentCommentId}::bigint`,
        entityType: sql`${deleted.entityType}::text`,
        entityId: sql`${deleted.entityId}::text`,
      }),
    })
    .from(sql`(SELECT 1) privacy_deleted_comment`);
  return result?.allowed === true;
}

/** Whether the viewer owns the item a like or comment is about. */
export async function viewerOwnsSocialEntity(
  entityType: string,
  entityId: string,
  viewerId: string | null | undefined,
): Promise<boolean> {
  if (!viewerId) return false;
  const [result] = await db
    .select({ owned: entityOwnerCondition(entityType, sql`${entityId}::text`, viewerId) })
    .from(sql`(SELECT 1) privacy_owner_check`);
  return result?.owned === true;
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
          or(
            contentVisibilityCondition(notification.entityType, notification.entityId, notification.actorId, viewerId),
            // A like on your own item names its liker to you, private or not.
            entityOwnerCondition(notification.entityType, notification.entityId, viewerId),
          ),
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
