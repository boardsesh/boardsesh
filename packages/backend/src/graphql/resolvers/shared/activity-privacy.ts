import { and, eq, exists, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import * as schema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import {
  boardGymListedCondition,
  climbDraftVisibilityCondition,
  ownedOrPublicClimbCondition,
  playlistClimbEntityClimbUuid,
  playlistClimbEntityPlaylistUuid,
  publicClimbCondition,
  sessionCoMemberTickCondition,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import { playlistVisibilityCondition } from '../playlists/helpers/enrichment';
import { gymVisibleCondition } from '../social/gym-visibility';
import {
  contentVisibilityCondition,
  entityOwnerCondition,
  resourceAccessCondition,
  userActivityVisibilityCondition,
} from '../../../services/privacy';

// Predicate construction must not depend on a database connection or its mocks.
const queryBuilder = new QueryBuilder();

/**
 * The climb a comment thread, vote or one climb's own logs point at, read by
 * its id, may be read: it is published, or it is the viewer's own draft, and
 * it is not on a spray wall the viewer may not see. No account privacy, item
 * audience or follow relation applies to a published climb, and an unlisted
 * one still resolves by reference. The spray half is the wall's own rule.
 */
function readableClimbCondition(
  climb: { userId: SQLWrapper; isDraft: SQLWrapper; boardType: SQLWrapper; layoutId: SQLWrapper },
  viewerId: string | null | undefined,
): SQL {
  return and(
    climbDraftVisibilityCondition({ isDraft: climb.isDraft, userId: climb.userId }, viewerId),
    sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
  )!;
}

/**
 * The climb a tick, beta link, comment, notification or proposal in a list or
 * feed points at may be shown: it is published and listed, or it is the
 * viewer's own, and it is not on a spray wall the viewer may not see. An
 * unlisted climb stays out of browse surfaces, so everything about it does
 * too; only its own page, read by reference, shows its logs and thread.
 */
function listedClimbCondition(
  climb: { userId: SQLWrapper; isDraft: SQLWrapper; isListed: SQLWrapper; boardType: SQLWrapper; layoutId: SQLWrapper },
  viewerId: string | null | undefined,
): SQL {
  return and(
    ownedOrPublicClimbCondition({ isDraft: climb.isDraft, isListed: climb.isListed, userId: climb.userId }, viewerId),
    sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
  )!;
}

/**
 * Which climbs a tick, comment thread, vote or notification may be shown on.
 * `listed` (the default) is for feeds, inboxes, logbooks, profiles and every
 * other list: an unlisted climb and everything about it stay out. `by-reference`
 * is for one entity read by its id (a climb's own page, its logs, its comment
 * thread and votes), which a direct link to an unlisted climb still opens.
 * Proposals are always `listed`: a proposal is not a read of the climb by its
 * link, so it never discloses an unlisted climb to anyone but its owner.
 */
export type ClimbScope = 'listed' | 'by-reference';

export function scopedClimbCondition(
  climb: { userId: SQLWrapper; isDraft: SQLWrapper; isListed: SQLWrapper; boardType: SQLWrapper; layoutId: SQLWrapper },
  viewerId: string | null | undefined,
  climbScope: ClimbScope,
): SQL {
  return climbScope === 'by-reference'
    ? readableClimbCondition(climb, viewerId)
    : listedClimbCondition(climb, viewerId);
}

/**
 * Logs follow their author and item audience. Session and board privacy hides
 * board identity only; draft, publication and spray-wall rules still apply.
 * Raw owner reads can retain a missing climb without exposing its cached name.
 * `authorRelease` widens only the author/audience half (see
 * `sessionTickVisibleCondition`); the climb half always applies.
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
  climbScope: ClimbScope = 'listed',
  authorRelease?: SQL,
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
    authorRelease
      ? or(contentVisibilityCondition('tick', ticks.uuid, ticks.userId, viewerId), authorRelease)
      : contentVisibilityCondition('tick', ticks.uuid, ticks.userId, viewerId),
    // A tick never reveals another climber's draft, an unlisted climb outside
    // that climb's own page, or a climb on a wall the viewer cannot see. It is
    // never hidden because of who set its climb. Enriched feeds may retain
    // denormalized names after deletion, so only raw owner reads allow a
    // missing parent.
    or(
      allowOwnWithoutClimb && viewerId ? eq(ticks.userId, viewerId) : sql`false`,
      exists(
        queryBuilder
          .select({ uuid: climb.uuid })
          .from(climb)
          .where(and(referencedClimb, scopedClimbCondition(climb, viewerId, climbScope))),
      ),
    ),
  )!;
}

/**
 * A tick a session's own surfaces (its detail, summary and feed card) may count
 * and list: one the viewer may read (`tickPrivacyCondition`), or one a fellow
 * member of its session logged while in it (`sessionCoMemberTickCondition`,
 * #6582), shown with its climb, grade, attempts and result. The climb rule
 * still applies to both. Its note and clips still need `tickPrivacyCondition`.
 */
export function sessionTickVisibleCondition(
  viewerId: string | null | undefined,
  ticks: {
    uuid: SQLWrapper;
    userId: SQLWrapper;
    climbUuid: SQLWrapper;
    boardType: SQLWrapper;
    sessionId: SQLWrapper;
    climbedAt: SQLWrapper;
    boardId: SQLWrapper;
  } = schema.boardseshTicks,
): SQL {
  return tickPrivacyCondition(viewerId, ticks, false, 'listed', sessionCoMemberTickCondition(ticks, viewerId));
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
            // Beta is listed (recent beta, profiles, the climb's own section):
            // an unlisted climb's beta stays out like its logs.
            listedClimbCondition(climb, viewerId),
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

/**
 * Whether a board may surface for this viewer somewhere they did not open it by
 * link. A board's UUID is its link, so an Unlisted board reaches a feed only for
 * the people who already hold it: its owner, an approved grant, or follower
 * inheritance. The same reading as `boardIdentityVisibleCondition`.
 */
function listedBoardCondition(boardUuid: SQLWrapper, viewerId: string | null | undefined): SQL {
  return and(
    resourceAccessCondition('board', boardUuid, viewerId, { allowUnlistedLink: false }),
    sql`EXISTS (SELECT 1 FROM user_boards listed_identity_board WHERE listed_identity_board.uuid = ${boardUuid} AND ${boardGymListedCondition(sql`listed_identity_board.gym_id`)})`,
  )!;
}

export type SocialEntityReadOptions = {
  /**
   * The read surfaces entities the viewer did not ask for (the global comment
   * feed, the activity feed). A session there needs `listedSessionCondition`
   * and a board `listedBoardCondition`, since each one's id is its link; a
   * direct read (a thread, a vote, a notification addressed to the viewer)
   * keeps the unlisted link. Ticks, climbs, proposals and playlists have no
   * link that widens their own rule, so both modes read them alike.
   */
  discovery?: boolean;
  climbScope?: ClimbScope;
};

/**
 * A UUID is an address, not permission to read its discussion or notifications.
 * Every terminal branch below already admits the item's owner on the account and
 * audience layer (a climber reads their own tick, host their session, setter
 * their climb); the owner's view of other people's comments on it comes from
 * `commentPrivacyCondition`, which each traversed comment passes through. The
 * spray wall rule and a climb's draft/listing rule still apply to owners.
 * `climbScope` is `listed` for a feed or an inbox, and `by-reference` for one
 * entity read by its id; see {@link ClimbScope}.
 */
export function socialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
  options: SocialEntityReadOptions | ClimbScope = {},
): SQL {
  const readOptions = typeof options === 'string' ? {} : options;
  const climbScope = typeof options === 'string' ? options : (options.climbScope ?? 'listed');
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
    WHERE ${terminalSocialEntityPrivacyCondition(sql`privacy_entity_target.entity_type`, sql`privacy_entity_target.entity_id`, viewerId, readOptions, climbScope)}
  )`;
}

function terminalSocialEntityPrivacyCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  viewerId: string | null | undefined,
  { discovery = false }: SocialEntityReadOptions,
  climbScope: ClimbScope,
): SQL {
  const tick = alias(schema.boardseshTicks, 'privacy_entity_tick');
  const climb = alias(schema.boardClimbs, 'privacy_entity_climb');
  const proposal = alias(schema.climbProposals, 'privacy_entity_proposal');
  const gym = alias(schema.gyms, 'privacy_entity_gym');
  return sql`CASE
    WHEN ${entityType} = 'tick' THEN ${exists(
      queryBuilder
        .select({ id: tick.id })
        .from(tick)
        .where(and(eq(tick.uuid, entityId), tickPrivacyCondition(viewerId, tick, false, climbScope))),
    )}
    WHEN ${entityType} = 'session' THEN ${discovery ? listedSessionCondition(entityId, viewerId) : resourceAccessCondition('session', entityId, viewerId)}
    WHEN ${entityType} = 'board' THEN ${discovery ? listedBoardCondition(entityId, viewerId) : resourceAccessCondition('board', entityId, viewerId)}
    WHEN ${entityType} = 'climb' THEN ${exists(
      queryBuilder
        .select({ uuid: climb.uuid })
        .from(climb)
        .where(and(eq(climb.uuid, entityId), scopedClimbCondition(climb, viewerId, climbScope))),
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
                    // Always listed, whatever the scope: see ClimbScope.
                    listedClimbCondition(climb, viewerId),
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
            eq(schema.playlists.uuid, playlistClimbEntityPlaylistUuid(entityId)),
            playlistVisibilityCondition(viewerId),
            or(
              sql`${playlistClimbEntityClimbUuid(entityId)} = '_all'`,
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
                      eq(climb.uuid, playlistClimbEntityClimbUuid(entityId)),
                      scopedClimbCondition(climb, viewerId, climbScope),
                    ),
                  ),
              ),
            ),
          ),
        ),
    )}
    WHEN ${entityType} = 'gym' THEN ${exists(
      queryBuilder
        .select({ id: gym.id })
        .from(gym)
        // A gym's thread reads exactly when the gym does: a private gym's
        // comments stay with the people `gym(gymUuid)` shows it to, for direct
        // reads and discovery alike.
        .where(and(eq(gym.uuid, entityId), isNull(gym.deletedAt), gymVisibleCondition(gym, viewerId, discovery))),
    )}
    ELSE false END`;
}

/** The one item (tick, climb, session, ...) a statement reads comments on. */
export type CommentThreadItem = { entityType: string; entityId: string };

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
 *   viewer's own comments are walked up to their roots once per statement, and
 *   any comment on those paths is readable to them.
 * - An ancestor row that no longer exists is readable. Deleting an account
 *   cascades its comments, and that must not orphan the replies under them.
 *
 * Pass `item` whenever the statement reads comments on one known item. A
 * comment and its ancestors always share their item, so the walk then starts
 * from the viewer's comments on that item only, and its cost follows the
 * thread instead of how many replies the viewer has written site-wide. Without
 * it (feeds, inboxes, a comment reached by uuid alone) the walk covers every
 * comment the viewer wrote.
 *
 * Structure still fails closed for everyone: the chain must end at a root or a
 * missing row within 32 ancestors, so a cycle or an over-deep chain never reads.
 */
export function commentPrivacyCondition(
  viewerId: string | null | undefined,
  comment: CommentPrivacyColumns = schema.comments,
  item?: CommentThreadItem,
): SQL {
  const ownComment = viewerId ? sql`COALESCE(${comment.userId} = ${viewerId}, false)` : sql`false`;
  // Bound constants, never the outer row: the walk stays uncorrelated.
  const viewerCommentsOnItem = item
    ? sql` AND privacy_mine.entity_type = ${item.entityType} AND privacy_mine.entity_id = ${item.entityId}`
    : sql``;
  // Every comment above one the viewer wrote, walked up with the same
  // 32-ancestor cap as `privacy_ancestors` (so a cycle stops too). It names no
  // outer column, so PostgreSQL runs it once per statement and probes the
  // result as a hashed set, instead of walking a thread for every row.
  const viewerThreadUuids = viewerId
    ? sql`(
      WITH RECURSIVE privacy_viewer_thread AS (
        SELECT privacy_replied_to.id, privacy_replied_to.uuid, privacy_replied_to.parent_comment_id, 1 AS depth
        FROM comments privacy_mine JOIN comments privacy_replied_to ON privacy_replied_to.id = privacy_mine.parent_comment_id
        WHERE privacy_mine.user_id = ${viewerId}${viewerCommentsOnItem}
        UNION ALL
        SELECT privacy_above.id, privacy_above.uuid, privacy_above.parent_comment_id, privacy_below.depth + 1
        FROM comments privacy_above JOIN privacy_viewer_thread privacy_below ON privacy_above.id = privacy_below.parent_comment_id
        WHERE privacy_below.depth < 32
      )
      SELECT privacy_viewer_thread.uuid FROM privacy_viewer_thread
    )`
    : null;
  const inViewerThread = (uuid: SQLWrapper): SQL =>
    viewerThreadUuids ? sql`${uuid} IN ${viewerThreadUuids}` : sql`false`;
  const readable = (uuid: SQLWrapper, userId: SQLWrapper): SQL =>
    sql`(${contentVisibilityCondition('comment', uuid, userId, viewerId)} OR ${inViewerThread(uuid)})`;
  return sql`(
    WITH RECURSIVE privacy_ancestors AS (
      SELECT privacy_parent_seed.id, privacy_parent_seed.uuid, privacy_parent_seed.user_id, privacy_parent_seed.parent_comment_id, 1 AS depth FROM comments privacy_parent_seed WHERE privacy_parent_seed.id = ${comment.parentCommentId}
      UNION ALL
      SELECT parent.id, parent.uuid, parent.user_id, parent.parent_comment_id, child.depth + 1
      FROM comments parent JOIN privacy_ancestors child ON parent.id = child.parent_comment_id
      WHERE child.depth < 32
    )
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

/**
 * The notification and feed row types that announce a climb's publication,
 * naming its author: the only rows on which the author of a published, listed
 * climb is public with it. Feed rows use `new_climb` alone.
 */
const CLIMB_AUTHORSHIP_ROW_TYPES = ['new_climb', 'new_climb_global'] as const;

/**
 * Whether the viewer may see who acted on an entity (a notification's or feed
 * row's actor). `rowType` is the row's own notification or feed type.
 *
 * A climb has no audience. Who set a published, listed climb is public with
 * it, so on a row announcing that climb (`new_climb`, `new_climb_global`) its
 * author is named to everyone, a private account included. Every other row
 * about a climb is activity and keeps its actor's account privacy, the
 * author's own included: a comment reply stored with no `comment_id` (the
 * inline writer, or a reply deleted since) names a private commenter only to
 * who may see them. The author of a draft or an unlisted climb keeps their
 * account privacy too, and so does the author of a climb on a spray wall the
 * viewer may not read. Every other entity type keeps its item audience.
 *
 * Whether the row may be shown at all is a separate test: an inbox or feed
 * pairs this with {@link socialEntityPrivacyCondition}, which keeps a draft
 * and an unlisted climb out for everyone but the owner.
 */
export function entityActorVisibilityCondition(
  entityType: SQLWrapper,
  entityId: SQLWrapper,
  actorId: SQLWrapper,
  viewerId: string | null | undefined,
  rowType: SQLWrapper,
): SQL {
  const climb = alias(schema.boardClimbs, 'privacy_actor_climb');
  const announcesActorsPublicClimb = sql`(${rowType}::text IN (${sql.join(
    CLIMB_AUTHORSHIP_ROW_TYPES.map((type) => sql`${type}`),
    sql`, `,
  )}) AND ${exists(
    queryBuilder
      .select({ uuid: climb.uuid })
      .from(climb)
      .where(
        and(
          eq(climb.uuid, entityId),
          eq(climb.userId, actorId),
          publicClimbCondition(climb),
          sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
        ),
      ),
  )})`;
  return sql`(CASE WHEN ${entityType}::text = 'climb'
    THEN (${announcesActorsPublicClimb} OR ${userActivityVisibilityCondition(actorId, viewerId)})
    ELSE ${contentVisibilityCondition(entityType, entityId, actorId, viewerId)} END)`;
}

/**
 * {@link socialEntityPrivacyCondition} for one entity read by its id, so
 * `by-reference` by default: a direct link to an unlisted climb opens its
 * thread and votes. A caller deciding whether something lands in a feed or an
 * inbox passes `listed`.
 */
export async function canReadSocialEntity(
  entityType: string,
  entityId: string,
  viewerId: string | null | undefined,
  climbScope: ClimbScope = 'by-reference',
): Promise<boolean> {
  const [result] = await db
    .select({ allowed: socialEntityPrivacyCondition(sql`${entityType}`, sql`${entityId}`, viewerId, climbScope) })
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
      allowed: commentPrivacyCondition(
        viewerId,
        {
          uuid: sql`${deleted.commentUuid}::text`,
          userId: sql`${deleted.authorUserId}::text`,
          parentCommentId: sql`${deleted.parentCommentId}::bigint`,
          entityType: sql`${deleted.entityType}::text`,
          entityId: sql`${deleted.entityId}::text`,
        },
        { entityType: deleted.entityType, entityId: deleted.entityId },
      ),
    })
    .from(sql`(SELECT 1) privacy_deleted_comment`);
  return result?.allowed === true;
}

/**
 * Whether a notification of `type` about this item may name its actor to the
 * viewer, in one round trip: the item's owner hears about every like on it,
 * and anyone else needs {@link entityActorVisibilityCondition} to allow it.
 * The same pair `notificationPrivacyCondition` applies when the inbox is read.
 */
export async function canSeeActorOnEntity(
  entityType: string,
  entityId: string,
  actorId: string,
  viewerId: string,
  type: string,
): Promise<boolean> {
  const entityTypeText = sql`${entityType}::text`;
  const entityIdText = sql`${entityId}::text`;
  const [result] = await db
    .select({
      allowed: sql<boolean>`(${entityOwnerCondition(entityTypeText, entityIdText, viewerId)} OR ${entityActorVisibilityCondition(
        entityTypeText,
        entityIdText,
        sql`${actorId}::text`,
        viewerId,
        sql`${type}::text`,
      )})`,
    })
    .from(sql`(SELECT 1) privacy_actor_check`);
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
  const followRequest = alias(schema.userFollowRequests, 'privacy_notification_follow_request');
  return or(
    eq(notification.type, 'new_follower'),
    // A follow request names its requester to the account they asked to follow,
    // whatever the requester's own activity privacy. It shows only while the
    // request is still pending: once it is approved, declined or cancelled there
    // is nothing left to act on.
    and(
      eq(notification.type, 'follow_request'),
      exists(
        queryBuilder
          .select({ requesterId: followRequest.requesterId })
          .from(followRequest)
          .where(and(eq(followRequest.requesterId, notification.actorId), eq(followRequest.recipientId, viewerId))),
      ),
    ),
    and(
      ne(notification.type, 'follow_request'),
      or(
        isNull(notification.actorId),
        and(
          isNull(notification.commentId),
          or(
            entityActorVisibilityCondition(
              notification.entityType,
              notification.entityId,
              notification.actorId,
              viewerId,
              notification.type,
            ),
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
