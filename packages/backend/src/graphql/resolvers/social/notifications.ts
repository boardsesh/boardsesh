import { eq, and, isNull, count, sql, inArray } from 'drizzle-orm';
import type { ConnectionContext, NotificationEvent } from '@boardsesh/shared-schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { GroupedNotificationsInputSchema, NotificationActorsInputSchema } from '../../../validation/schemas';
import { batchEnrichUserProfiles } from './helpers';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';

type NotificationRow = {
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
};

/**
 * The `board_climbs` columns every climb-bearing notification needs. `layoutId`
 * and `angle` are the two that let a client build a board URL that resolves:
 * `climb(uuid, layoutId)` filters on the layout, so a client that guesses the
 * board's first layout misses every Kilter Homewall / Tension Board 2 climb.
 * This is the only place the pair is resolved: www's `/api/internal/climb-redirect`
 * read the same two columns and went with the web notification centre in W-20b
 * (#4439).
 */
const NOTIFICATION_CLIMB_COLUMNS = {
  uuid: dbSchema.boardClimbs.uuid,
  name: dbSchema.boardClimbs.name,
  boardType: dbSchema.boardClimbs.boardType,
  setterUsername: dbSchema.boardClimbs.setterUsername,
  layoutId: dbSchema.boardClimbs.layoutId,
  angle: dbSchema.boardClimbs.angle,
  frames: dbSchema.boardClimbs.frames,
  compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
} as const;

type NotificationClimb = {
  uuid: string;
  name: string | null;
  boardType: string;
  setterUsername: string | null;
  layoutId: number;
  angle: number | null;
  frames: string | null;
  compatibleSizeIds: number[] | null;
};

type ClimbBoardFields = {
  climbLayoutId?: number;
  climbAngle?: number;
  climbFrames?: string;
  climbCompatibleSizeIds?: number[];
};

/**
 * Copy the climb's board coordinates onto the group. `angle` is nullable in
 * `board_climbs` (most climbs carry none), so it stays `undefined` rather than
 * collapsing to 0 — clients fall back to the reader's own board angle, which is
 * a better guess than flat.
 *
 * `frames` + `compatibleSizeIds` ride along so a row can draw the board art
 * without a follow-up climb query per row. The size list is not decoration:
 * boards that number holds independently per size (Woods) render a completely
 * different climb on the layout's default size — see docs/board-art-geometry.md.
 */
function applyClimbBoardFields(group: ClimbBoardFields, climb: NotificationClimb): void {
  group.climbLayoutId = climb.layoutId;
  group.climbAngle = climb.angle ?? undefined;
  group.climbFrames = climb.frames ?? undefined;
  group.climbCompatibleSizeIds = climb.compatibleSizeIds ?? undefined;
}

function truncateCommentBody(commentBody: string | null): string | undefined {
  if (!commentBody) return undefined;
  if (commentBody.length > 100) return commentBody.slice(0, 100) + '...';
  return commentBody;
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
    commentBody: truncateCommentBody(row.commentBody),
    climbName: undefined,
    climbUuid: undefined,
    boardType: undefined,
    gymName: undefined,
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
    const rows = await executeRows<
      NotificationRow & {
        totalCount: string;
        unreadCount: string;
      }
    >(
      db,
      sql`
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
    `,
    );

    const notifications = rows.map(mapNotificationRow);
    const totalCount = rows.length > 0 ? Number(rows[0].totalCount) : 0;
    const unreadCount = rows.length > 0 ? Number(rows[0].unreadCount) : 0;

    return {
      notifications,
      totalCount,
      unreadCount,
      hasMore: offset + notifications.length < totalCount,
    };
  },

  groupedNotifications: async (_: unknown, args: { limit?: number; offset?: number }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const validated = validateInput(GroupedNotificationsInputSchema, args, 'groupedNotifications');
    const limit = validated.limit ?? 20;
    const offset = validated.offset ?? 0;

    // Group notifications by (type, entity_type, entity_id) and return aggregated results.
    // Uses COUNT(*) OVER() window function to get total group count in a single query
    // instead of a separate N+1 count subquery.
    type GroupedRow = {
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
    };

    const rows = await executeRows<GroupedRow>(
      db,
      sql`
      WITH all_groups AS (
        SELECT
          n."type",
          -- Aliased, like every other column in this CTE. Unaliased, Postgres
          -- returns entity_type / entity_id while the row mapper reads
          -- entityType / entityId, so BOTH were silently undefined -- the
          -- enrichment loop skipped every group on its entityId guard and no
          -- climb, proposal or gym data was ever attached. Nothing errored:
          -- rows just arrived with null climb fields for ever (#5192 QA).
          n."entity_type" as "entityType",
          n."entity_id" as "entityId",
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
    `,
    );

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
        commentBody: truncateCommentBody(row.commentBody),
        climbName: undefined as string | undefined,
        climbUuid: undefined as string | undefined,
        boardType: undefined as string | undefined,
        climbLayoutId: undefined as number | undefined,
        climbAngle: undefined as number | undefined,
        climbFrames: undefined as string | undefined,
        climbCompatibleSizeIds: undefined as number[] | undefined,
        threadEntityType: undefined as string | undefined,
        threadEntityId: undefined as string | undefined,
        proposalUuid: undefined as string | undefined,
        proposalType: undefined as dbSchema.ClimbProposal['type'] | undefined,
        setterUsername: undefined as string | undefined,
        gymName: undefined as string | undefined,
        isRead: row.allRead,
        createdAt:
          row.latestCreatedAt instanceof Date ? row.latestCreatedAt.toISOString() : String(row.latestCreatedAt),
      };
    });

    // Enrich groups with climb/proposal data (batched to avoid N+1)
    const proposalTypes = [
      'proposal_created',
      'proposal_on_your_climb',
      'proposal_approved',
      'proposal_rejected',
      'proposal_vote',
    ];
    const climbTypes = ['new_climb', 'new_climb_global'];
    // The types that hang off a comment thread. Clients open the thread for
    // these rather than a climb, so they need `threadEntityType`/`threadEntityId`.
    const threadTypes = ['comment_reply', 'comment_on_tick', 'comment_on_climb', 'vote_on_tick', 'vote_on_comment'];

    // Collect entity IDs by type
    const climbEntityIds: string[] = [];
    const proposalEntityIds: string[] = [];
    const gymEntityIds: string[] = [];
    const commentEntityIds: string[] = [];
    const tickEntityIds: string[] = [];
    for (const group of groups) {
      if (!group.entityId) continue;
      if (group.type === 'new_climbs_synced' || climbTypes.includes(group.type)) {
        climbEntityIds.push(group.entityId);
      } else if (proposalTypes.includes(group.type)) {
        proposalEntityIds.push(group.entityId);
      } else if (group.type === 'gym_claim_approved') {
        gymEntityIds.push(group.entityId);
      } else if (threadTypes.includes(group.type)) {
        // A vote on a comment names the COMMENT; the thread it lives in is the
        // comment's own entity, one hop away. Every other thread type already
        // names the commented-on entity.
        if (group.entityType === 'comment') commentEntityIds.push(group.entityId);
        else if (group.entityType === 'tick') tickEntityIds.push(group.entityId);
      }
    }

    // Batch-fetch the thread behind a voted-on comment. Three sequential batched
    // lookups follow (comment → thread → climb), each one `inArray` over at most
    // `limit` groups rather than a query per row.
    const commentThreadMap = new Map<string, { entityType: string; entityId: string }>();
    if (commentEntityIds.length > 0) {
      const commentRows = await db
        .select({
          uuid: dbSchema.comments.uuid,
          entityType: dbSchema.comments.entityType,
          entityId: dbSchema.comments.entityId,
        })
        .from(dbSchema.comments)
        .where(inArray(dbSchema.comments.uuid, commentEntityIds));
      for (const row of commentRows) {
        commentThreadMap.set(row.uuid, { entityType: row.entityType, entityId: row.entityId });
        if (row.entityType === 'tick') tickEntityIds.push(row.entityId);
      }
    }

    // Batch-fetch the climb behind a tick, so a row about someone's ascent can
    // draw the same board art as a climb row.
    const tickClimbMap = new Map<string, { climbUuid: string; boardType: string }>();
    if (tickEntityIds.length > 0) {
      const tickRows = await db
        .select({
          uuid: dbSchema.boardseshTicks.uuid,
          climbUuid: dbSchema.boardseshTicks.climbUuid,
          boardType: dbSchema.boardseshTicks.boardType,
        })
        .from(dbSchema.boardseshTicks)
        .where(inArray(dbSchema.boardseshTicks.uuid, [...new Set(tickEntityIds)]));
      for (const row of tickRows) {
        tickClimbMap.set(row.uuid, { climbUuid: row.climbUuid, boardType: row.boardType });
        climbEntityIds.push(row.climbUuid);
      }
    }

    // Batch-fetch climbs. `layoutId` + `angle` ride along because a client can't
    // open a climb without them: `climb(uuid, layoutId)` filters on the layout,
    // so a client guessing the board's first layout misses every Kilter Homewall
    // and Tension Board 2 climb. www used to resolve the same two columns
    // server-side; that route went with the web notification centre in W-20b
    // (#4439), so this is now the only resolution.
    const climbMap = new Map<string, NotificationClimb>();
    if (climbEntityIds.length > 0) {
      const climbRows = await db
        .select(NOTIFICATION_CLIMB_COLUMNS)
        .from(dbSchema.boardClimbs)
        .where(inArray(dbSchema.boardClimbs.uuid, climbEntityIds));
      for (const row of climbRows) {
        climbMap.set(row.uuid, row);
      }
    }

    // Batch-fetch proposals
    const proposalMap = new Map<
      string,
      { climbUuid: string; boardType: string; type: dbSchema.ClimbProposal['type'] }
    >();
    if (proposalEntityIds.length > 0) {
      const proposalRows = await db
        .select({
          uuid: dbSchema.climbProposals.uuid,
          climbUuid: dbSchema.climbProposals.climbUuid,
          boardType: dbSchema.climbProposals.boardType,
          type: dbSchema.climbProposals.type,
        })
        .from(dbSchema.climbProposals)
        .where(inArray(dbSchema.climbProposals.uuid, proposalEntityIds));
      for (const row of proposalRows) {
        proposalMap.set(row.uuid, { climbUuid: row.climbUuid, boardType: row.boardType, type: row.type });
      }

      // Fetch climb names for proposal-linked climbs
      const proposalClimbUuids = [...new Set([...proposalMap.values()].map((p) => p.climbUuid))];
      if (proposalClimbUuids.length > 0) {
        const proposalClimbRows = await db
          .select(NOTIFICATION_CLIMB_COLUMNS)
          .from(dbSchema.boardClimbs)
          .where(inArray(dbSchema.boardClimbs.uuid, proposalClimbUuids));
        for (const row of proposalClimbRows) {
          if (!climbMap.has(row.uuid)) {
            climbMap.set(row.uuid, row);
          }
        }
      }
    }

    // Batch-fetch gym names (entityId is the gym UUID for gym_claim_approved)
    const gymNameMap = new Map<string, string>();
    if (gymEntityIds.length > 0) {
      const gymRows = await db
        .select({ uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
        .from(dbSchema.gyms)
        .where(inArray(dbSchema.gyms.uuid, gymEntityIds));
      for (const row of gymRows) {
        gymNameMap.set(row.uuid, row.name);
      }
    }

    // Enrich groups using map lookups (no DB calls)
    for (const group of groups) {
      if (!group.entityId) continue;

      if (group.type === 'gym_claim_approved') {
        group.gymName = gymNameMap.get(group.entityId) ?? undefined;
      } else if (group.type === 'new_climbs_synced') {
        const climb = climbMap.get(group.entityId);
        if (climb) {
          group.climbUuid = group.entityId;
          group.climbName = climb.name ?? undefined;
          group.boardType = climb.boardType;
          group.setterUsername = climb.setterUsername ?? undefined;
          applyClimbBoardFields(group, climb);
        }
      } else if (climbTypes.includes(group.type)) {
        const climb = climbMap.get(group.entityId);
        if (climb) {
          group.climbUuid = group.entityId;
          group.climbName = climb.name ?? undefined;
          group.boardType = climb.boardType;
          applyClimbBoardFields(group, climb);
        }
      } else if (proposalTypes.includes(group.type)) {
        const proposal = proposalMap.get(group.entityId);
        if (proposal) {
          group.proposalUuid = group.entityId;
          // The client needs the proposal type to word the row: a
          // `proposal_on_your_climb` reads "reported your climb" for a hide and
          // "proposed a grade change" for a grade.
          group.proposalType = proposal.type;
          group.climbUuid = proposal.climbUuid;
          group.boardType = proposal.boardType;
          const climb = climbMap.get(proposal.climbUuid);
          group.climbName = climb?.name ?? undefined;
          if (climb) applyClimbBoardFields(group, climb);
        }
      } else if (threadTypes.includes(group.type)) {
        const thread =
          group.entityType === 'comment'
            ? commentThreadMap.get(group.entityId)
            : group.entityType
              ? { entityType: group.entityType, entityId: group.entityId }
              : undefined;
        if (!thread) continue;

        group.threadEntityType = thread.entityType;
        group.threadEntityId = thread.entityId;

        // An ascent's thread carries the climb it was logged on, which is what
        // lets these rows draw board art like a climb row does.
        if (thread.entityType !== 'tick') continue;
        const tick = tickClimbMap.get(thread.entityId);
        if (!tick) continue;
        group.climbUuid = tick.climbUuid;
        group.boardType = tick.boardType;
        const climb = climbMap.get(tick.climbUuid);
        group.climbName = climb?.name ?? undefined;
        if (climb) applyClimbBoardFields(group, climb);
      }
    }

    // Unread count (individual notifications, not groups)
    const unreadCountResult = await db
      .select({ count: count() })
      .from(dbSchema.notifications)
      .where(and(eq(dbSchema.notifications.recipientId, userId), isNull(dbSchema.notifications.readAt)));
    const unreadCount = Number(unreadCountResult[0]?.count || 0);

    return {
      groups,
      totalCount,
      unreadCount,
      hasMore: offset + groups.length < totalCount,
    };
  },

  unreadNotificationCount: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<number> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const result = await db
      .select({ count: count() })
      .from(dbSchema.notifications)
      .where(and(eq(dbSchema.notifications.recipientId, userId), isNull(dbSchema.notifications.readAt)));

    return Number(result[0]?.count || 0);
  },

  /**
   * Every distinct actor behind one notification group, newest first.
   *
   * `groupedNotifications` caps `actors` at three, so "Sarah and 4 others
   * started following you" can't show the other four. The group key is the same
   * (type, entity_type, entity_id) triple that resolver groups by, and the
   * `notifications_dedup_idx (actor_id, recipient_id, type, entity_id)` index
   * covers the lookup.
   *
   * Scoped to the caller's own notifications — the recipient predicate is the
   * whole authorisation story, so there is nothing to leak by passing another
   * user's entity id.
   */
  notificationActors: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const { type, entityType, entityId, limit, offset } = validateInput(NotificationActorsInputSchema, input, 'input');
    const userId = ctx.userId!;

    // `IS NOT DISTINCT FROM` rather than `=`: `new_follower` carries a null
    // entity_type, and `= NULL` matches nothing.
    const groupPredicate = and(
      eq(dbSchema.notifications.recipientId, userId),
      sql`${dbSchema.notifications.type} = ${type}`,
      sql`${dbSchema.notifications.entityType} IS NOT DISTINCT FROM ${entityType ?? null}`,
      sql`${dbSchema.notifications.entityId} IS NOT DISTINCT FROM ${entityId ?? null}`,
      // `actor_id` is ON DELETE SET NULL, so a deleted account leaves an
      // actor-less row. The grouped resolver drops those too.
      sql`${dbSchema.notifications.actorId} IS NOT NULL`,
    );

    const [totalRow] = await db
      .select({ count: sql<number>`count(DISTINCT ${dbSchema.notifications.actorId})` })
      .from(dbSchema.notifications)
      .where(groupPredicate);
    const totalCount = Number(totalRow?.count ?? 0);

    const actorRows = await db
      .select({
        actorId: sql<string>`${dbSchema.notifications.actorId}`,
        latestCreatedAt: sql<Date>`max(${dbSchema.notifications.createdAt})`,
      })
      .from(dbSchema.notifications)
      .where(groupPredicate)
      .groupBy(dbSchema.notifications.actorId)
      .orderBy(sql`max(${dbSchema.notifications.createdAt}) DESC`)
      .limit(limit)
      .offset(offset);

    const actorIds = actorRows.map((row) => row.actorId);
    if (actorIds.length === 0) return { users: [], totalCount, hasMore: false };

    const [identityRows, enrichments] = await Promise.all([
      db
        .select({
          id: dbSchema.users.id,
          userName: dbSchema.users.name,
          userImage: dbSchema.users.image,
          displayName: dbSchema.userProfiles.displayName,
          avatarUrl: dbSchema.userProfiles.avatarUrl,
        })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
        .where(inArray(dbSchema.users.id, actorIds)),
      batchEnrichUserProfiles(actorIds, userId),
    ]);

    const identities = new Map(identityRows.map((row) => [row.id, row]));
    // Ordered by `actorIds`, not by the identity fetch — the newest-first order
    // is the point, and a join comes back in whatever order Postgres likes.
    const users = actorIds.flatMap((actorId) => {
      const identity = identities.get(actorId);
      if (!identity) return [];
      const enrichment = enrichments.get(actorId);
      return [
        {
          id: actorId,
          displayName: identity.displayName || identity.userName || undefined,
          avatarUrl: identity.avatarUrl || identity.userImage || undefined,
          followerCount: enrichment?.followerCount ?? 0,
          followingCount: enrichment?.followingCount ?? 0,
          isFollowedByMe: enrichment?.isFollowedByMe ?? false,
        },
      ];
    });

    return { users, totalCount, hasMore: offset + actorRows.length < totalCount };
  },
};

export const socialNotificationMutations = {
  markNotificationRead: async (
    _: unknown,
    { notificationUuid }: { notificationUuid: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'markNotificationRead');
    const userId = ctx.userId!;

    await db
      .update(dbSchema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(dbSchema.notifications.uuid, notificationUuid), eq(dbSchema.notifications.recipientId, userId)));

    return true;
  },

  markGroupNotificationsRead: async (
    _: unknown,
    { type, entityType, entityId }: { type: string; entityType?: string | null; entityId?: string | null },
    ctx: ConnectionContext,
  ): Promise<number> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'markGroupNotificationsRead');
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

  markAllNotificationsRead: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'markAllNotificationsRead');
    const userId = ctx.userId!;

    await db
      .update(dbSchema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(dbSchema.notifications.recipientId, userId), isNull(dbSchema.notifications.readAt)));

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
