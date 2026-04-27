import { eq, and, isNull, count, sql, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { GroupedNotificationsInputSchema } from '../../../validation/schemas';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';
import { filterVisibleUserIds } from './helpers';
import type { NotificationEvent } from '@boardsesh/shared-schema';

interface NotificationRow {
  uuid: string;
  type: string;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  commentId: number | null;
  readAt: Date | null;
  createdAt: Date;
  actorDisplayName: string | null;
  actorAvatarUrl: string | null;
  actorName: string | null;
  actorImage: string | null;
  commentBody: string | null;
}

function mapNotificationRow(row: NotificationRow) {
  return {
    uuid: row.uuid,
    type: row.type,
    actorId: row.actorId,
    actorDisplayName: row.actorDisplayName || row.actorName || undefined,
    actorAvatarUrl: row.actorAvatarUrl || row.actorImage || undefined,
    entityType: row.entityType,
    entityId: row.entityId,
    commentBody: row.commentBody
      ? (row.commentBody.length > 100 ? row.commentBody.slice(0, 100) + '...' : row.commentBody)
      : undefined,
    climbName: undefined,
    climbUuid: undefined,
    boardType: undefined,
    isRead: row.readAt !== null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

export const socialNotificationQueries = {
  notifications: async (
    _: unknown,
    { unreadOnly, limit = 20, offset = 0 }: { unreadOnly?: boolean; limit?: number; offset?: number },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    // Build where clause
    const unreadFilter = unreadOnly ? sql`AND n."read_at" IS NULL` : sql``;

    // Single query with scalar subqueries for totalCount and unreadCount.
    // These must be computed over ALL user notifications (not filtered by unreadOnly),
    // so we use subqueries instead of window functions which would only count
    // the filtered result set.
    const rawResult = await db.execute(sql`
      SELECT
        n."uuid",
        n."type",
        n."actor_id" as "actorId",
        n."entity_type" as "entityType",
        n."entity_id" as "entityId",
        n."comment_id" as "commentId",
        n."read_at" as "readAt",
        n."created_at" as "createdAt",
        up."display_name" as "actorDisplayName",
        up."avatar_url" as "actorAvatarUrl",
        u."name" as "actorName",
        u."image" as "actorImage",
        c."body" as "commentBody",
        (SELECT COUNT(*) FROM "notifications" WHERE "recipient_id" = ${userId}) as "totalCount",
        (SELECT COUNT(*) FROM "notifications" WHERE "recipient_id" = ${userId} AND "read_at" IS NULL) as "unreadCount"
      FROM "notifications" n
      LEFT JOIN "users" u ON n."actor_id" = u."id"
      LEFT JOIN "user_profiles" up ON n."actor_id" = up."user_id"
      LEFT JOIN "comments" c ON n."comment_id" = c."id"
      WHERE n."recipient_id" = ${userId}
        ${unreadFilter}
      ORDER BY n."created_at" DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const rows = (rawResult as unknown as { rows: (NotificationRow & { totalCount: string; unreadCount: string })[] }).rows;

    const actorIds = [...new Set(rows.filter((r) => r.actorId).map((r) => r.actorId!))];
    const visibleActors = await filterVisibleUserIds(actorIds, userId);

    const commentNotifTypes = new Set(['comment_reply', 'comment_on_tick', 'comment_on_climb', 'vote_on_comment']);
    const commentIdsToCheck = new Set<number>();
    for (const row of rows) {
      if (row.actorId && !visibleActors.has(row.actorId) && commentNotifTypes.has(row.type) && row.commentId) {
        commentIdsToCheck.add(row.commentId);
      }
    }

    let publicCommentIds = new Set<number>();
    if (commentIdsToCheck.size > 0) {
      const publicComments = await db
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(
          and(
            inArray(dbSchema.comments.id, [...commentIdsToCheck]),
            eq(dbSchema.comments.isPublic, true),
          ),
        );
      publicCommentIds = new Set(publicComments.map((c) => c.id));
    }

    const filteredRows = rows.filter((row) => {
      if (!row.actorId) return true;
      if (visibleActors.has(row.actorId)) return true;
      if (commentNotifTypes.has(row.type) && row.commentId && publicCommentIds.has(row.commentId)) return true;
      return false;
    });

    const notifications = filteredRows.map(mapNotificationRow);
    const rawTotalCount = rows.length > 0 ? Number(rows[0].totalCount) : 0;
    const rawUnreadCount = rows.length > 0 ? Number(rows[0].unreadCount) : 0;

    return {
      notifications,
      totalCount: rawTotalCount,
      unreadCount: rawUnreadCount,
      hasMore: offset + rows.length < rawTotalCount,
    };
  },

  groupedNotifications: async (
    _: unknown,
    args: { limit?: number; offset?: number },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const validated = validateInput(GroupedNotificationsInputSchema, args, 'groupedNotifications');
    const limit = validated.limit ?? 20;
    const offset = validated.offset ?? 0;

    // Group notifications by (type, entity_type, entity_id) and return aggregated results.
    // Uses COUNT(*) OVER() window function to get total group count in a single query
    // instead of a separate N+1 count subquery.
    interface GroupedRow {
      type: string;
      entityType: string | null;
      entityId: string | null;
      actorCount: string;
      latestUuid: string;
      latestCreatedAt: Date;
      allRead: boolean;
      commentBody: string | null;
      actorIds: string[];
      actorDisplayNames: (string | null)[];
      actorAvatarUrls: (string | null)[];
      totalGroupCount: string;
    }

    const rawResult = await db.execute(sql`
      WITH all_groups AS (
        SELECT
          n."type",
          n."entity_type",
          n."entity_id",
          COUNT(DISTINCT n."actor_id") as "actorCount",
          (array_agg(n."uuid" ORDER BY n."created_at" DESC))[1] as "latestUuid",
          MAX(n."created_at") as "latestCreatedAt",
          BOOL_AND(n."read_at" IS NOT NULL) as "allRead",
          (array_agg(c."body" ORDER BY n."created_at" DESC))[1] as "commentBody",
          (array_agg(DISTINCT n."actor_id"))[1:3] as "actorIds"
        FROM "notifications" n
        LEFT JOIN "comments" c ON n."comment_id" = c."id"
        WHERE n."recipient_id" = ${userId}
        GROUP BY n."type", n."entity_type", n."entity_id"
      ),
      paged AS (
        SELECT
          *,
          COUNT(*) OVER() as "totalGroupCount"
        FROM all_groups
        ORDER BY "latestCreatedAt" DESC
        LIMIT ${limit}
        OFFSET ${offset}
      )
      SELECT
        p.*,
        array(
          SELECT COALESCE(up."display_name", u."name")
          FROM unnest(p."actorIds") AS aid(id)
          LEFT JOIN "users" u ON u."id" = aid.id
          LEFT JOIN "user_profiles" up ON up."user_id" = aid.id
        ) as "actorDisplayNames",
        array(
          SELECT COALESCE(up."avatar_url", u."image")
          FROM unnest(p."actorIds") AS aid(id)
          LEFT JOIN "users" u ON u."id" = aid.id
          LEFT JOIN "user_profiles" up ON up."user_id" = aid.id
        ) as "actorAvatarUrls"
      FROM paged p
    `);

    const rows = (rawResult as unknown as { rows: GroupedRow[] }).rows;

    // Total group count from window function (same value on every row)
    const totalCount = rows.length > 0 ? Number(rows[0].totalGroupCount) : 0;

    const groups = rows.map((row) => {
      const actorIds = row.actorIds || [];
      const actorDisplayNames = row.actorDisplayNames || [];
      const actorAvatarUrls = row.actorAvatarUrls || [];

      const actors = actorIds
        .filter((id): id is string => id != null)
        .map((id, i) => ({
          id,
          displayName: actorDisplayNames[i] || undefined,
          avatarUrl: actorAvatarUrls[i] || undefined,
        }));

      return {
        uuid: row.latestUuid,
        type: row.type,
        entityType: row.entityType,
        entityId: row.entityId,
        actorCount: Number(row.actorCount),
        actors,
        commentBody: row.commentBody
          ? (row.commentBody.length > 100 ? row.commentBody.slice(0, 100) + '...' : row.commentBody)
          : undefined,
        climbName: undefined as string | undefined,
        climbUuid: undefined as string | undefined,
        boardType: undefined as string | undefined,
        proposalUuid: undefined as string | undefined,
        setterUsername: undefined as string | undefined,
        isRead: row.allRead,
        createdAt: row.latestCreatedAt instanceof Date
          ? row.latestCreatedAt.toISOString()
          : String(row.latestCreatedAt),
      };
    });

    // Enrich groups with climb/proposal data (batched to avoid N+1)
    const proposalTypes = ['proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_vote'];
    const climbTypes = ['new_climb', 'new_climb_global'];

    // Collect entity IDs by type
    const climbEntityIds: string[] = [];
    const proposalEntityIds: string[] = [];
    for (const group of groups) {
      if (!group.entityId) continue;
      if (group.type === 'new_climbs_synced' || climbTypes.includes(group.type)) {
        climbEntityIds.push(group.entityId);
      } else if (proposalTypes.includes(group.type)) {
        proposalEntityIds.push(group.entityId);
      }
    }

    // Batch-fetch climbs
    const climbMap = new Map<string, { name: string | null; boardType: string; setterUsername: string | null }>();
    if (climbEntityIds.length > 0) {
      const climbRows = await db
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          name: dbSchema.boardClimbs.name,
          boardType: dbSchema.boardClimbs.boardType,
          setterUsername: dbSchema.boardClimbs.setterUsername,
        })
        .from(dbSchema.boardClimbs)
        .where(inArray(dbSchema.boardClimbs.uuid, climbEntityIds));
      for (const row of climbRows) {
        climbMap.set(row.uuid, { name: row.name, boardType: row.boardType, setterUsername: row.setterUsername });
      }
    }

    // Batch-fetch proposals
    const proposalMap = new Map<string, { climbUuid: string; boardType: string }>();
    if (proposalEntityIds.length > 0) {
      const proposalRows = await db
        .select({
          uuid: dbSchema.climbProposals.uuid,
          climbUuid: dbSchema.climbProposals.climbUuid,
          boardType: dbSchema.climbProposals.boardType,
        })
        .from(dbSchema.climbProposals)
        .where(inArray(dbSchema.climbProposals.uuid, proposalEntityIds));
      for (const row of proposalRows) {
        proposalMap.set(row.uuid, { climbUuid: row.climbUuid, boardType: row.boardType });
      }

      // Fetch climb names for proposal-linked climbs
      const proposalClimbUuids = [...new Set([...proposalMap.values()].map((p) => p.climbUuid))];
      if (proposalClimbUuids.length > 0) {
        const proposalClimbRows = await db
          .select({
            uuid: dbSchema.boardClimbs.uuid,
            name: dbSchema.boardClimbs.name,
            boardType: dbSchema.boardClimbs.boardType,
            setterUsername: dbSchema.boardClimbs.setterUsername,
          })
          .from(dbSchema.boardClimbs)
          .where(inArray(dbSchema.boardClimbs.uuid, proposalClimbUuids));
        for (const row of proposalClimbRows) {
          if (!climbMap.has(row.uuid)) {
            climbMap.set(row.uuid, { name: row.name, boardType: row.boardType, setterUsername: row.setterUsername });
          }
        }
      }
    }

    // Enrich groups using map lookups (no DB calls)
    for (const group of groups) {
      if (!group.entityId) continue;

      if (group.type === 'new_climbs_synced') {
        const climb = climbMap.get(group.entityId);
        if (climb) {
          group.climbUuid = group.entityId;
          group.climbName = climb.name ?? undefined;
          group.boardType = climb.boardType;
          group.setterUsername = climb.setterUsername ?? undefined;
        }
      } else if (climbTypes.includes(group.type)) {
        const climb = climbMap.get(group.entityId);
        if (climb) {
          group.climbUuid = group.entityId;
          group.climbName = climb.name ?? undefined;
          group.boardType = climb.boardType;
        }
      } else if (proposalTypes.includes(group.type)) {
        const proposal = proposalMap.get(group.entityId);
        if (proposal) {
          group.proposalUuid = group.entityId;
          group.climbUuid = proposal.climbUuid;
          group.boardType = proposal.boardType;
          const climb = climbMap.get(proposal.climbUuid);
          group.climbName = climb?.name ?? undefined;
        }
      }
    }

    // Unread count (individual notifications, not groups)
    const unreadCountResult = await db
      .select({ count: count() })
      .from(dbSchema.notifications)
      .where(
        and(
          eq(dbSchema.notifications.recipientId, userId),
          isNull(dbSchema.notifications.readAt),
        ),
      );
    const unreadCount = Number(unreadCountResult[0]?.count || 0);

    return {
      groups,
      totalCount,
      unreadCount,
      hasMore: offset + groups.length < totalCount,
    };
  },

  unreadNotificationCount: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<number> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const result = await db
      .select({ count: count() })
      .from(dbSchema.notifications)
      .where(
        and(
          eq(dbSchema.notifications.recipientId, userId),
          isNull(dbSchema.notifications.readAt),
        ),
      );

    return Number(result[0]?.count || 0);
  },
};

export const socialNotificationMutations = {
  markNotificationRead: async (
    _: unknown,
    { notificationUuid }: { notificationUuid: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'notification_read');
    const userId = ctx.userId!;

    await db
      .update(dbSchema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(dbSchema.notifications.uuid, notificationUuid),
          eq(dbSchema.notifications.recipientId, userId),
        ),
      );

    return true;
  },

  markGroupNotificationsRead: async (
    _: unknown,
    { type, entityType, entityId }: { type: string; entityType?: string | null; entityId?: string | null },
    ctx: ConnectionContext,
  ): Promise<number> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'notification_read');
    const userId = ctx.userId!;

    // Build conditions for the group
    const conditions = [
      eq(dbSchema.notifications.recipientId, userId),
      sql`${dbSchema.notifications.type} = ${type}`,
      isNull(dbSchema.notifications.readAt),
    ];

    if (entityType != null) {
      conditions.push(sql`${dbSchema.notifications.entityType} = ${entityType}`);
    } else {
      conditions.push(sql`${dbSchema.notifications.entityType} IS NULL`);
    }

    if (entityId != null) {
      conditions.push(sql`${dbSchema.notifications.entityId} = ${entityId}`);
    } else {
      conditions.push(sql`${dbSchema.notifications.entityId} IS NULL`);
    }

    const result = await db
      .update(dbSchema.notifications)
      .set({ readAt: new Date() })
      .where(and(...conditions))
      .returning();

    return result.length;
  },

  markAllNotificationsRead: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'notification_read_all');
    const userId = ctx.userId!;

    await db
      .update(dbSchema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(dbSchema.notifications.recipientId, userId),
          isNull(dbSchema.notifications.readAt),
        ),
      );

    return true;
  },
};

export const socialNotificationSubscriptions = {
  notificationReceived: {
    subscribe: async function* (_: unknown, __: unknown, ctx: ConnectionContext) {
      requireAuthenticated(ctx);
      const userId = ctx.userId!;

      const asyncIterator = await createAsyncIterator<NotificationEvent>((push) => {
        return pubsub.subscribeNotifications(userId, push);
      });

      for await (const event of asyncIterator) {
        yield { notificationReceived: event };
      }
    },
  },
};
