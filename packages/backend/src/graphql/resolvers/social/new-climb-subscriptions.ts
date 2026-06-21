import { and, eq, desc, sql } from 'drizzle-orm';
import type {
  ConnectionContext,
  NewClimbFeedInput,
  NewClimbFeedResult,
  NewClimbSubscription,
  NewClimbSubscriptionInput,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput, isNoMatchClimb } from '../shared/helpers';
import { NewClimbFeedInputSchema, NewClimbSubscriptionInputSchema } from '../../../validation/schemas';

export const newClimbSubscriptionResolvers = {
  Query: {
    /**
     * Public feed of newly created climbs for a board type + layout.
     * Offset-based pagination for simplicity.
     */
    newClimbFeed: async (_: unknown, { input }: { input: NewClimbFeedInput }): Promise<NewClimbFeedResult> => {
      const validated = validateInput(NewClimbFeedInputSchema, input, 'input');
      const limit = validated.limit ?? 20;
      const offset = validated.offset ?? 0;

      const climbs = await db
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          name: dbSchema.boardClimbs.name,
          description: dbSchema.boardClimbs.description,
          boardType: dbSchema.boardClimbs.boardType,
          layoutId: dbSchema.boardClimbs.layoutId,
          angle: dbSchema.boardClimbs.angle,
          frames: dbSchema.boardClimbs.frames,
          createdAt: dbSchema.boardClimbs.createdAt,
          setterDisplayName: sql<
            string | null
          >`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name}, ${dbSchema.boardClimbs.setterUsername})`,
          setterAvatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
          difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        })
        .from(dbSchema.boardClimbs)
        .leftJoin(dbSchema.users, eq(dbSchema.boardClimbs.userId, dbSchema.users.id))
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .leftJoin(
          dbSchema.boardClimbStats,
          and(
            eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
            eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
            eq(dbSchema.boardClimbStats.angle, dbSchema.boardClimbs.angle),
          ),
        )
        .leftJoin(
          dbSchema.boardDifficultyGrades,
          and(
            eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbs.boardType),
            eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardClimbStats.displayDifficulty),
          ),
        )
        .where(
          and(
            eq(dbSchema.boardClimbs.boardType, validated.boardType),
            eq(dbSchema.boardClimbs.layoutId, validated.layoutId),
          ),
        )
        .orderBy(desc(dbSchema.boardClimbs.createdAt))
        .limit(limit)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(dbSchema.boardClimbs)
        .where(
          and(
            eq(dbSchema.boardClimbs.boardType, validated.boardType),
            eq(dbSchema.boardClimbs.layoutId, validated.layoutId),
          ),
        );

      const totalCount = Number(total) || 0;
      const items = climbs.map((c) => ({
        uuid: c.uuid,
        name: c.name ?? '',
        boardType: c.boardType,
        layoutId: c.layoutId,
        setterDisplayName: c.setterDisplayName ?? null,
        setterAvatarUrl: c.setterAvatarUrl ?? null,
        angle: c.angle ?? null,
        frames: c.frames ?? null,
        difficultyName: c.difficultyName ?? null,
        isNoMatch: isNoMatchClimb(c.description),
        createdAt: c.createdAt ?? new Date().toISOString(),
      }));

      return {
        items,
        totalCount,
        hasMore: offset + items.length < totalCount,
      };
    },

    /**
     * Authenticated user's subscriptions to new climbs.
     */
    myNewClimbSubscriptions: async (
      _: unknown,
      _args: unknown,
      ctx: ConnectionContext,
    ): Promise<NewClimbSubscription[]> => {
      requireAuthenticated(ctx);
      const rows = await db
        .select()
        .from(dbSchema.newClimbSubscriptions)
        .where(eq(dbSchema.newClimbSubscriptions.userId, ctx.userId!));

      return rows.map((r) => ({
        id: String(r.id),
        boardType: r.boardType,
        layoutId: r.layoutId,
        createdAt: r.createdAt?.toISOString?.() ?? new Date().toISOString(),
      }));
    },
  },

  Mutation: {
    subscribeNewClimbs: async (
      _: unknown,
      { input }: { input: NewClimbSubscriptionInput },
      ctx: ConnectionContext,
    ): Promise<boolean> => {
      requireAuthenticated(ctx);
      await applyRateLimit(ctx, 20, 'subscribeNewClimbs');
      const validated = validateInput(NewClimbSubscriptionInputSchema, input, 'input');

      await db
        .insert(dbSchema.newClimbSubscriptions)
        .values({
          userId: ctx.userId!,
          boardType: validated.boardType,
          layoutId: validated.layoutId,
        })
        .onConflictDoNothing();

      return true;
    },

    unsubscribeNewClimbs: async (
      _: unknown,
      { input }: { input: NewClimbSubscriptionInput },
      ctx: ConnectionContext,
    ): Promise<boolean> => {
      requireAuthenticated(ctx);
      await applyRateLimit(ctx, 20, 'unsubscribeNewClimbs');
      const validated = validateInput(NewClimbSubscriptionInputSchema, input, 'input');

      await db
        .delete(dbSchema.newClimbSubscriptions)
        .where(
          and(
            eq(dbSchema.newClimbSubscriptions.userId, ctx.userId!),
            eq(dbSchema.newClimbSubscriptions.boardType, validated.boardType),
            eq(dbSchema.newClimbSubscriptions.layoutId, validated.layoutId),
          ),
        );

      return true;
    },
  },
};
