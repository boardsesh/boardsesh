import { eq, and, isNull, count, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import {
  AddCommentInputSchema,
  UpdateCommentInputSchema,
  CommentsInputSchema,
  GlobalCommentFeedInputSchema,
} from '../../../validation/schemas';
import { encodeOffsetCursor, decodeOffsetCursor } from '../../../utils/feed-cursor';
import { validateEntityExists } from './entity-validation';
import { publishSocialEvent } from '../../../events/index';
import { pubsub } from '../../../pubsub/index';
import crypto from 'crypto';

type CommentRow = {
  id: number;
  uuid: string;
  userId: string;
  entityType: string;
  entityId: string;
  parentCommentId: number | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  userName: string | null;
  userImage: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  parentUuid: string | null;
  replyCount: number;
  upvotes: number;
  downvotes: number;
  userVote: number | null;
};

function mapCommentRow(row: CommentRow) {
  const isDeleted = row.deletedAt !== null;
  return {
    uuid: row.uuid,
    userId: row.userId,
    userDisplayName: row.displayName || row.userName || undefined,
    userAvatarUrl: row.avatarUrl || row.userImage || undefined,
    entityType: row.entityType,
    entityId: row.entityId,
    parentCommentUuid: row.parentUuid || null,
    body: isDeleted ? null : row.body,
    isDeleted,
    replyCount: Number(row.replyCount || 0),
    upvotes: Number(row.upvotes || 0),
    downvotes: Number(row.downvotes || 0),
    voteScore: Number(row.upvotes || 0) - Number(row.downvotes || 0),
    userVote: Number(row.userVote || 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

/**
 * Helper to get aggregate vote counts for a comment from vote_counts table
 */
async function getCommentVoteCounts(commentUuid: string) {
  const [counts] = await db
    .select({
      upvotes: dbSchema.voteCounts.upvotes,
      downvotes: dbSchema.voteCounts.downvotes,
    })
    .from(dbSchema.voteCounts)
    .where(and(eq(dbSchema.voteCounts.entityType, 'comment'), eq(dbSchema.voteCounts.entityId, commentUuid)))
    .limit(1);

  return {
    upvotes: counts?.upvotes ?? 0,
    downvotes: counts?.downvotes ?? 0,
  };
}

export const socialCommentQueries = {
  comments: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validated = validateInput(CommentsInputSchema, input, 'input');
    const { entityType, entityId, parentCommentUuid, sortBy, limit, offset } = validated;

    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : null;

    // If parentCommentUuid is provided, resolve to internal ID for filtering replies
    let parentCommentFilter: ReturnType<typeof sql>;
    let resolvedParentId: number | null = null;
    if (parentCommentUuid) {
      const [parentComment] = await db
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.uuid, parentCommentUuid))
        .limit(1);

      if (!parentComment) {
        return { comments: [], totalCount: 0, hasMore: false };
      }

      resolvedParentId = parentComment.id;
      parentCommentFilter = sql`c."parent_comment_id" = ${resolvedParentId}`;
    } else {
      parentCommentFilter = sql`c."parent_comment_id" IS NULL`;
    }

    // Build ORDER BY based on sortBy — uses vote_counts columns instead of LATERAL subqueries
    let orderByClause: ReturnType<typeof sql>;
    switch (sortBy) {
      case 'top':
        orderByClause = sql`COALESCE(vc."score", 0) DESC, c."created_at" DESC`;
        break;
      case 'controversial':
        orderByClause = sql`
          CASE WHEN COALESCE(vc."upvotes", 0) + COALESCE(vc."downvotes", 0) = 0 THEN 0
          ELSE POWER(COALESCE(vc."upvotes", 0) + COALESCE(vc."downvotes", 0),
            LEAST(COALESCE(vc."upvotes", 0)::float, COALESCE(vc."downvotes", 0)::float) /
            GREATEST(COALESCE(vc."upvotes", 0)::float, COALESCE(vc."downvotes", 0)::float, 1)
          ) END DESC, c."created_at" DESC`;
        break;
      case 'hot':
        orderByClause = sql`
          SIGN(COALESCE(vc."score", 0)) *
          LN(GREATEST(ABS(COALESCE(vc."score", 0)), 1)) +
          EXTRACT(EPOCH FROM c."created_at") / 45000 DESC`;
        break;
      default: // 'new'
        orderByClause = sql`c."created_at" DESC`;
    }

    // Total count query — reuse resolvedParentId to avoid duplicate lookup
    const countResult = await db
      .select({ count: count() })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, entityType),
          eq(dbSchema.comments.entityId, entityId),
          resolvedParentId !== null
            ? eq(dbSchema.comments.parentCommentId, resolvedParentId)
            : isNull(dbSchema.comments.parentCommentId),
        ),
      );
    const totalCount = Number(countResult[0]?.count || 0);

    // Main query — LEFT JOIN vote_counts instead of LATERAL JOIN subqueries
    const rawRows = await executeRows<CommentRow>(
      db,
      sql`
      SELECT
        c."id",
        c."uuid",
        c."user_id" as "userId",
        c."entity_type" as "entityType",
        c."entity_id" as "entityId",
        c."parent_comment_id" as "parentCommentId",
        c."body",
        c."created_at" as "createdAt",
        c."updated_at" as "updatedAt",
        c."deleted_at" as "deletedAt",
        u."name" as "userName",
        u."image" as "userImage",
        up."display_name" as "displayName",
        up."avatar_url" as "avatarUrl",
        parent_c."uuid" as "parentUuid",
        COALESCE(reply_cnt.cnt, 0) as "replyCount",
        COALESCE(vc."upvotes", 0) as "upvotes",
        COALESCE(vc."downvotes", 0) as "downvotes",
        ${authenticatedUserId ? sql`COALESCE(my_vote."value", 0)` : sql`0`} as "userVote"
      FROM "comments" c
      INNER JOIN "users" u ON c."user_id" = u."id"
      LEFT JOIN "user_profiles" up ON c."user_id" = up."user_id"
      LEFT JOIN "comments" parent_c ON c."parent_comment_id" = parent_c."id"
      LEFT JOIN (
        SELECT r."parent_comment_id", COUNT(*) as cnt
        FROM "comments" r
        WHERE r."parent_comment_id" IS NOT NULL AND r."deleted_at" IS NULL
          AND r."entity_type" = ${entityType} AND r."entity_id" = ${entityId}
        GROUP BY r."parent_comment_id"
      ) reply_cnt ON reply_cnt."parent_comment_id" = c."id"
      LEFT JOIN "vote_counts" vc ON vc."entity_type" = 'comment' AND vc."entity_id" = c."uuid"
      ${
        authenticatedUserId
          ? sql`LEFT JOIN "votes" my_vote ON my_vote."entity_type" = 'comment' AND my_vote."entity_id" = c."uuid" AND my_vote."user_id" = ${authenticatedUserId}`
          : sql``
      }
      WHERE c."entity_type" = ${entityType}
        AND c."entity_id" = ${entityId}
        AND ${parentCommentFilter}
      ORDER BY ${orderByClause}
      LIMIT ${limit}
      OFFSET ${offset}
    `,
    );

    const comments = rawRows.map(mapCommentRow);

    return {
      comments,
      totalCount,
      hasMore: offset + comments.length < totalCount,
    };
  },

  /**
   * Global comment feed: recent comments across all entities.
   * Supports board filtering via boardUuid. Always chronological.
   */
  globalCommentFeed: async (_: unknown, { input }: { input?: Record<string, unknown> }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(GlobalCommentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : null;

    const offset = validatedInput.cursor ? (decodeOffsetCursor(validatedInput.cursor) ?? 0) : 0;

    // Board filter: resolve boardUuid to boardType
    let boardTypeFilter: string | null = null;
    if (validatedInput.boardUuid) {
      const board = await db
        .select({ boardType: dbSchema.userBoards.boardType })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
        .limit(1)
        .then((rows) => rows[0]);

      if (board) {
        boardTypeFilter = board.boardType;
      }
    }

    // Board filter: join through entity relationships to filter by board type
    // Comments on sessions -> boardsesh_ticks.board_type
    // Comments on climbs -> board_climbs.board_type
    // Comments on proposals -> climb_proposals.board_type
    const boardFilterJoin = boardTypeFilter
      ? sql`
        LEFT JOIN boardsesh_ticks bt_filter
          ON c."entity_type" = 'session'
          AND (bt_filter.session_id = c."entity_id" OR bt_filter.inferred_session_id = c."entity_id")
        LEFT JOIN board_climbs bc_filter
          ON c."entity_type" = 'climb'
          AND bc_filter.uuid = c."entity_id"
        LEFT JOIN climb_proposals cp_filter
          ON c."entity_type" = 'proposal'
          AND cp_filter.uuid = c."entity_id"
      `
      : sql``;

    const boardFilterWhere = boardTypeFilter
      ? sql`AND (
          (c."entity_type" = 'session' AND bt_filter.board_type = ${boardTypeFilter})
          OR (c."entity_type" = 'climb' AND bc_filter.board_type = ${boardTypeFilter})
          OR (c."entity_type" = 'proposal' AND cp_filter.board_type = ${boardTypeFilter})
          OR (c."entity_type" NOT IN ('session', 'climb', 'proposal'))
        )`
      : sql``;

    const distinctClause = boardTypeFilter ? sql`DISTINCT ON (c."id")` : sql``;

    const rawRows = await executeRows<CommentRow>(
      db,
      sql`
      SELECT ${distinctClause}
        c."id",
        c."uuid",
        c."user_id" as "userId",
        c."entity_type" as "entityType",
        c."entity_id" as "entityId",
        c."parent_comment_id" as "parentCommentId",
        c."body",
        c."created_at" as "createdAt",
        c."updated_at" as "updatedAt",
        c."deleted_at" as "deletedAt",
        u."name" as "userName",
        u."image" as "userImage",
        up."display_name" as "displayName",
        up."avatar_url" as "avatarUrl",
        parent_c."uuid" as "parentUuid",
        COALESCE(reply_cnt.cnt, 0) as "replyCount",
        COALESCE(vc."upvotes", 0) as "upvotes",
        COALESCE(vc."downvotes", 0) as "downvotes",
        ${authenticatedUserId ? sql`COALESCE(my_vote."value", 0)` : sql`0`} as "userVote"
      FROM "comments" c
      INNER JOIN "users" u ON c."user_id" = u."id"
      LEFT JOIN "user_profiles" up ON c."user_id" = up."user_id"
      LEFT JOIN "comments" parent_c ON c."parent_comment_id" = parent_c."id"
      LEFT JOIN (
        -- Global feed spans all entities, so reply counts are computed globally.
        -- The join naturally scopes to only matching parent IDs.
        SELECT "parent_comment_id", COUNT(*) as cnt
        FROM "comments"
        WHERE "parent_comment_id" IS NOT NULL AND "deleted_at" IS NULL
        GROUP BY "parent_comment_id"
      ) reply_cnt ON reply_cnt."parent_comment_id" = c."id"
      LEFT JOIN "vote_counts" vc ON vc."entity_type" = 'comment' AND vc."entity_id" = c."uuid"
      ${
        authenticatedUserId
          ? sql`LEFT JOIN "votes" my_vote ON my_vote."entity_type" = 'comment' AND my_vote."entity_id" = c."uuid" AND my_vote."user_id" = ${authenticatedUserId}`
          : sql``
      }
      ${boardFilterJoin}
      WHERE c."deleted_at" IS NULL
        ${boardFilterWhere}
      ORDER BY ${boardTypeFilter ? sql`c."id",` : sql``} c."created_at" DESC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `,
    );

    const hasMore = rawRows.length > limit;
    const resultRows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const comments = resultRows.map(mapCommentRow);

    const nextCursor = hasMore ? encodeOffsetCursor(offset + limit) : null;

    return {
      comments,
      totalCount: 0, // Not computing totalCount for performance (infinite scroll doesn't need it)
      hasMore,
      cursor: nextCursor,
    };
  },
};

export const socialCommentMutations = {
  addComment: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'comment');

    const validated = validateInput(AddCommentInputSchema, input, 'input');
    const { entityType, entityId, parentCommentUuid, body } = validated;
    const userId = ctx.userId!;

    await validateEntityExists(entityType, entityId);

    let parentCommentId: number | null = null;
    if (parentCommentUuid) {
      const [parent] = await db
        .select({
          id: dbSchema.comments.id,
          entityType: dbSchema.comments.entityType,
          entityId: dbSchema.comments.entityId,
          deletedAt: dbSchema.comments.deletedAt,
        })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.uuid, parentCommentUuid))
        .limit(1);

      if (!parent) {
        throw new Error('Parent comment not found');
      }
      if (parent.deletedAt) {
        throw new Error('Cannot reply to a deleted comment');
      }
      if (parent.entityType !== entityType || parent.entityId !== entityId) {
        throw new Error('Parent comment belongs to a different entity');
      }
      parentCommentId = parent.id;
    }

    const uuid = crypto.randomUUID();

    const [inserted] = await db
      .insert(dbSchema.comments)
      .values({
        uuid,
        userId,
        entityType,
        entityId,
        parentCommentId,
        body,
      })
      .returning();

    // Fetch user info
    const [user] = await db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, userId))
      .limit(1);

    const commentResult = {
      uuid: inserted.uuid,
      userId: inserted.userId,
      userDisplayName: user?.displayName || user?.name || undefined,
      userAvatarUrl: user?.avatarUrl || user?.image || undefined,
      entityType: inserted.entityType,
      entityId: inserted.entityId,
      parentCommentUuid: parentCommentUuid || null,
      body: inserted.body,
      isDeleted: false,
      replyCount: 0,
      upvotes: 0,
      downvotes: 0,
      voteScore: 0,
      userVote: 0,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
    };

    // Live comment update via PubSub (synchronous for real-time)
    const entityKey = `${entityType}:${entityId}`;
    pubsub.publishCommentEvent(entityKey, {
      __typename: 'CommentAdded',
      comment: commentResult,
    });

    // Notification via event broker (async)
    publishSocialEvent({
      type: parentCommentUuid ? 'comment.reply' : 'comment.created',
      actorId: userId,
      entityType,
      entityId,
      timestamp: Date.now(),
      metadata: {
        commentUuid: uuid,
        ...(parentCommentUuid ? { parentCommentId: parentCommentUuid } : {}),
      },
    }).catch((err) => console.error('[Comments] Failed to publish social event:', err));

    return commentResult;
  },

  updateComment: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'comment');

    const validated = validateInput(UpdateCommentInputSchema, input, 'input');
    const { commentUuid, body } = validated;
    const userId = ctx.userId!;

    const [comment] = await db.select().from(dbSchema.comments).where(eq(dbSchema.comments.uuid, commentUuid)).limit(1);

    if (!comment) {
      throw new Error('Comment not found');
    }
    if (comment.userId !== userId) {
      throw new Error('You can only edit your own comments');
    }
    if (comment.deletedAt) {
      throw new Error('Cannot edit a deleted comment');
    }

    const now = new Date();
    const [updated] = await db
      .update(dbSchema.comments)
      .set({ body, updatedAt: now })
      .where(eq(dbSchema.comments.uuid, commentUuid))
      .returning();

    // Fetch enriched data for the response
    const [user] = await db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, userId))
      .limit(1);

    // Fetch vote data from vote_counts
    const { upvotes, downvotes } = await getCommentVoteCounts(commentUuid);

    // Reply count
    const replyResult = await db
      .select({ count: count() })
      .from(dbSchema.comments)
      .where(and(eq(dbSchema.comments.parentCommentId, comment.id), isNull(dbSchema.comments.deletedAt)));
    const replyCount = Number(replyResult[0]?.count || 0);

    // User's own vote
    const [myVote] = await db
      .select({ value: dbSchema.votes.value })
      .from(dbSchema.votes)
      .where(
        and(
          eq(dbSchema.votes.entityType, 'comment'),
          eq(dbSchema.votes.entityId, commentUuid),
          eq(dbSchema.votes.userId, userId),
        ),
      )
      .limit(1);

    // Get parent UUID if applicable
    let parentCommentUuid: string | null = null;
    if (updated.parentCommentId) {
      const [parentComment] = await db
        .select({ uuid: dbSchema.comments.uuid })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.id, updated.parentCommentId))
        .limit(1);
      parentCommentUuid = parentComment?.uuid || null;
    }

    const updateResult = {
      uuid: updated.uuid,
      userId: updated.userId,
      userDisplayName: user?.displayName || user?.name || undefined,
      userAvatarUrl: user?.avatarUrl || user?.image || undefined,
      entityType: updated.entityType,
      entityId: updated.entityId,
      parentCommentUuid,
      body: updated.body,
      isDeleted: false,
      replyCount,
      upvotes,
      downvotes,
      voteScore: upvotes - downvotes,
      userVote: myVote?.value || 0,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };

    // Live comment update via PubSub (synchronous, no notification needed)
    const entityKey = `${updated.entityType}:${updated.entityId}`;
    pubsub.publishCommentEvent(entityKey, {
      __typename: 'CommentUpdated',
      comment: updateResult,
    });

    return updateResult;
  },

  deleteComment: async (
    _: unknown,
    { commentUuid }: { commentUuid: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const [comment] = await db.select().from(dbSchema.comments).where(eq(dbSchema.comments.uuid, commentUuid)).limit(1);

    if (!comment) {
      throw new Error('Comment not found');
    }
    if (comment.userId !== userId) {
      throw new Error('You can only delete your own comments');
    }
    if (comment.deletedAt) {
      return true; // Already deleted
    }

    // Use transaction to prevent race condition between reply check and delete
    await db.transaction(async (tx) => {
      const replyResult = await tx
        .select({ count: count() })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.parentCommentId, comment.id));

      const hasReplies = Number(replyResult[0]?.count || 0) > 0;

      if (hasReplies) {
        // Soft delete — preserve thread structure
        await tx
          .update(dbSchema.comments)
          .set({ deletedAt: new Date() })
          .where(eq(dbSchema.comments.uuid, commentUuid));
      } else {
        // Hard delete
        await tx.delete(dbSchema.comments).where(eq(dbSchema.comments.uuid, commentUuid));
      }
    });

    // Live comment update via PubSub (synchronous, no notification needed)
    const entityKey = `${comment.entityType}:${comment.entityId}`;
    pubsub.publishCommentEvent(entityKey, {
      __typename: 'CommentDeleted',
      commentUuid,
      entityType: comment.entityType,
      entityId: comment.entityId,
    });

    return true;
  },
};
