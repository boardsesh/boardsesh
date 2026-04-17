import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sessions } from '../../../db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { getConsensusDifficultyName } from '../shared/sql-expressions';
import { SaveTickInputSchema, UpdateTickInputSchema, AttachBetaLinkInputSchema } from '../../../validation/schemas';
import { resolveBoardFromPath } from '../social/boards';
import { publishSocialEvent } from '../../../events';
import { assignInferredSession } from '../../../jobs/inferred-session-builder';
import { publishDebouncedSessionStats } from '../sessions/debounced-stats-publisher';
import { InstagramBetaValidationError, parseInstagramMediaId, validateInstagramBetaLink } from '../../../utils/instagram-beta-validation';

async function getClimbNameForBetaValidation(boardType: string, climbUuid: string): Promise<string> {
  const [climb] = await db
    .select({ name: dbSchema.boardClimbs.name })
    .from(dbSchema.boardClimbs)
    .where(
      and(
        eq(dbSchema.boardClimbs.boardType, boardType),
        eq(dbSchema.boardClimbs.uuid, climbUuid),
      ),
    )
    .limit(1);

  const climbName = climb?.name?.trim();
  if (!climbName) {
    throw new Error('Couldn’t verify this Instagram link for the selected climb');
  }

  return climbName;
}

async function ensureInstagramShortcodeIsNotAlreadyLinked(
  boardType: string,
  selectedClimbUuid: string,
  instagramUrl: string,
): Promise<void> {
  const incomingShortcode = parseInstagramMediaId(instagramUrl);

  if (!incomingShortcode) {
    return;
  }

  const existingLinks = await db
    .select({
      climbName: dbSchema.boardClimbs.name,
      climbUuid: dbSchema.boardBetaLinks.climbUuid,
      link: dbSchema.boardBetaLinks.link,
    })
    .from(dbSchema.boardBetaLinks)
    .innerJoin(
      dbSchema.boardClimbs,
      and(
        eq(dbSchema.boardClimbs.boardType, dbSchema.boardBetaLinks.boardType),
        eq(dbSchema.boardClimbs.uuid, dbSchema.boardBetaLinks.climbUuid),
      ),
    )
    .where(
      eq(dbSchema.boardBetaLinks.boardType, boardType),
    );

  for (const entry of existingLinks) {
    const existingShortcode = parseInstagramMediaId(entry.link);

    if (existingShortcode !== incomingShortcode) {
      continue;
    }

    if (entry.climbUuid === selectedClimbUuid) {
      throw new InstagramBetaValidationError(
        'We already have this Instagram video linked for this climb. Try a different post or reel.',
      );
    }

    throw new InstagramBetaValidationError(
      `This Instagram video is already linked to "${entry.climbName}". Please use a post or reel for the selected climb instead.`,
    );
  }
}

export const tickMutations = {
  /**
   * Delete a tick (climb attempt/ascent) for the authenticated user.
   * Only the owner can delete their own ticks.
   */
  deleteTick: async (
    _: unknown,
    { uuid }: { uuid: string },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const [tick] = await db
      .select({
        uuid: dbSchema.boardseshTicks.uuid,
        userId: dbSchema.boardseshTicks.userId,
        sessionId: dbSchema.boardseshTicks.sessionId,
      })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, uuid))
      .limit(1);

    if (!tick) {
      throw new Error('Tick not found');
    }
    if (tick.userId !== userId) {
      throw new Error('You can only delete your own ticks');
    }

    await db.transaction(async (tx) => {
      // Collect comment IDs on this tick so we can clean up their notifications
      const tickComments = await tx
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(and(eq(dbSchema.comments.entityType, 'tick'), eq(dbSchema.comments.entityId, uuid)));
      const commentIds = tickComments.map((c) => c.id);

      // Delete notifications referencing these comments (commentId FK is SET NULL, so we must delete explicitly)
      if (commentIds.length > 0) {
        await tx.delete(dbSchema.notifications).where(
          inArray(dbSchema.notifications.commentId, commentIds)
        );
      }

      // Delete related social data for the tick itself
      await tx.delete(dbSchema.feedItems).where(
        and(eq(dbSchema.feedItems.entityType, 'tick'), eq(dbSchema.feedItems.entityId, uuid))
      );
      await tx.delete(dbSchema.votes).where(
        and(eq(dbSchema.votes.entityType, 'tick'), eq(dbSchema.votes.entityId, uuid))
      );
      await tx.delete(dbSchema.voteCounts).where(
        and(eq(dbSchema.voteCounts.entityType, 'tick'), eq(dbSchema.voteCounts.entityId, uuid))
      );
      await tx.delete(dbSchema.comments).where(
        and(eq(dbSchema.comments.entityType, 'tick'), eq(dbSchema.comments.entityId, uuid))
      );
      await tx.delete(dbSchema.notifications).where(
        and(eq(dbSchema.notifications.entityType, 'tick'), eq(dbSchema.notifications.entityId, uuid))
      );
      // Delete the tick itself
      await tx.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.uuid, uuid));

      if (tick.sessionId) {
        await tx
          .update(sessions)
          .set({ lastActivity: new Date() })
          .where(eq(sessions.id, tick.sessionId));
      }
    });

    return true;
  },

  /**
   * Save a tick (climb attempt/ascent) for the authenticated user
   */
  saveTick: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext
  ): Promise<unknown> => {
    requireAuthenticated(ctx);

    // Validate input with business rules
    const validatedInput = validateInput(SaveTickInputSchema, input, 'input');

    const userId = ctx.userId!;
    const uuid = uuidv4();
    const now = new Date().toISOString();
    const climbedAt = new Date(validatedInput.climbedAt).toISOString();

    // Resolve board ID from board config if provided
    let boardId: number | null = null;
    if (validatedInput.layoutId && validatedInput.sizeId && validatedInput.setIds) {
      boardId = await resolveBoardFromPath(
        userId,
        validatedInput.boardType,
        validatedInput.layoutId,
        validatedInput.sizeId,
        validatedInput.setIds,
      );
    }

    const shouldAttachBeta =
      validatedInput.videoUrl &&
      (validatedInput.status === 'flash' || validatedInput.status === 'send');
    if (shouldAttachBeta) {
      const climbName = await getClimbNameForBetaValidation(
        validatedInput.boardType,
        validatedInput.climbUuid,
      );
      await ensureInstagramShortcodeIsNotAlreadyLinked(
        validatedInput.boardType,
        validatedInput.climbUuid,
        validatedInput.videoUrl!,
      );
      await validateInstagramBetaLink(validatedInput.videoUrl!, climbName);
    }

    // Insert into database
    const [tick] = await db.transaction(async (tx) => {
      const [createdTick] = await tx
        .insert(dbSchema.boardseshTicks)
        .values({
          uuid,
          userId,
          boardType: validatedInput.boardType,
          climbUuid: validatedInput.climbUuid,
          angle: validatedInput.angle,
          isMirror: validatedInput.isMirror,
          status: validatedInput.status,
          attemptCount: validatedInput.attemptCount,
          quality: validatedInput.quality ?? null,
          difficulty: validatedInput.difficulty ?? null,
          isBenchmark: validatedInput.isBenchmark,
          comment: validatedInput.comment,
          climbedAt,
          createdAt: now,
          updatedAt: now,
          sessionId: validatedInput.sessionId ?? null,
          boardId,
          // Aurora sync fields are null - will be populated by periodic sync job
          auroraType: null,
          auroraId: null,
          auroraSyncedAt: null,
          auroraSyncError: null,
        })
        .returning();

      if (validatedInput.sessionId) {
        await tx
          .update(sessions)
          .set({ lastActivity: new Date() })
          .where(eq(sessions.id, validatedInput.sessionId));
      }

      // Attach the Instagram URL as community beta for this climb if the
      // user provided one on a successful ascent. Zod already validated the
      // URL format; the (boardType, climbUuid, link) PK makes re-submission
      // idempotent.
      if (shouldAttachBeta) {
        await tx
          .insert(dbSchema.boardBetaLinks)
          .values({
            boardType: validatedInput.boardType,
            climbUuid: validatedInput.climbUuid,
            link: validatedInput.videoUrl!,
            angle: validatedInput.angle,
            isListed: true,
            createdAt: now,
          })
          .onConflictDoNothing();
      }

      return [createdTick];
    });

    const result = {
      uuid: tick.uuid,
      userId: tick.userId,
      boardType: tick.boardType,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      attemptCount: tick.attemptCount,
      quality: tick.quality,
      difficulty: tick.difficulty,
      isBenchmark: tick.isBenchmark,
      comment: tick.comment,
      climbedAt: tick.climbedAt,
      createdAt: tick.createdAt,
      updatedAt: tick.updatedAt,
      sessionId: tick.sessionId,
      boardId: tick.boardId,
      auroraType: tick.auroraType,
      auroraId: tick.auroraId,
      auroraSyncedAt: tick.auroraSyncedAt,
    };

    // Assign inferred session for ticks not in party mode (fire-and-forget).
    // On failure, the tick stays unassigned until the daily safety-net cron picks it up.
    if (!validatedInput.sessionId) {
      assignInferredSession(uuid, userId, climbedAt, validatedInput.status).catch((err) => {
        console.error(`[saveTick] Failed to assign inferred session for tick ${uuid} (user ${userId}):`, err);
      });
    }

    // Publish ascent.logged event for feed fan-out (only for successful ascents)
    if (tick.status === 'flash' || tick.status === 'send') {
      // Fire-and-forget with retry: don't block the response on event publishing
      publishAscentEvent(tick, userId, boardId).catch(() => {
        // Final failure already logged inside publishAscentEvent
      });
    }

    // Publish live session stats updates for active party sessions (debounced, non-blocking).
    if (tick.sessionId) {
      publishDebouncedSessionStats(tick.sessionId);
    }

    return result;
  },

  /**
   * Attach an Instagram post or reel as beta for a climb.
   * Idempotent on (boardType, climbUuid, link).
   */
  attachBetaLink: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    requireAuthenticated(ctx);

    const validated = validateInput(AttachBetaLinkInputSchema, input, 'input');
    const now = new Date().toISOString();
    const climbName = await getClimbNameForBetaValidation(validated.boardType, validated.climbUuid);

    await ensureInstagramShortcodeIsNotAlreadyLinked(
      validated.boardType,
      validated.climbUuid,
      validated.link,
    );
    await validateInstagramBetaLink(validated.link, climbName);

    await db
      .insert(dbSchema.boardBetaLinks)
      .values({
        boardType: validated.boardType,
        climbUuid: validated.climbUuid,
        link: validated.link,
        angle: validated.angle ?? null,
        isListed: true,
        createdAt: now,
      })
      .onConflictDoNothing();

    return true;
  },

  /**
   * Update an existing tick. Only the owner can update their own ticks.
   */
  updateTick: async (
    _: unknown,
    { uuid, input }: { uuid: string; input: unknown },
    ctx: ConnectionContext
  ): Promise<unknown> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const validatedInput = validateInput(UpdateTickInputSchema, input, 'input');

    // Verify ownership and get current tick
    const existing = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, uuid))
      .limit(1);

    if (existing.length === 0) {
      throw new Error('Tick not found');
    }
    if (existing[0].userId !== userId) {
      throw new Error('Not authorized to update this tick');
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (validatedInput.status !== undefined) updates.status = validatedInput.status;
    if (validatedInput.attemptCount !== undefined) updates.attemptCount = validatedInput.attemptCount;
    if (validatedInput.quality !== undefined) updates.quality = validatedInput.quality;
    if (validatedInput.difficulty !== undefined) updates.difficulty = validatedInput.difficulty;
    if (validatedInput.isBenchmark !== undefined) updates.isBenchmark = validatedInput.isBenchmark;
    if (validatedInput.comment !== undefined) updates.comment = validatedInput.comment;

    const [updated] = await db
      .update(dbSchema.boardseshTicks)
      .set(updates)
      .where(eq(dbSchema.boardseshTicks.uuid, uuid))
      .returning();

    return {
      uuid: updated.uuid,
      userId: updated.userId,
      boardType: updated.boardType,
      climbUuid: updated.climbUuid,
      angle: updated.angle,
      isMirror: updated.isMirror,
      status: updated.status,
      attemptCount: updated.attemptCount,
      quality: updated.quality,
      difficulty: updated.difficulty,
      isBenchmark: updated.isBenchmark,
      comment: updated.comment || '',
      climbedAt: updated.climbedAt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  },
};

const MAX_EVENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Fetch denormalized metadata and publish an ascent.logged event.
 * Retries up to MAX_EVENT_RETRIES times with exponential backoff.
 */
async function publishAscentEvent(
  tick: { uuid: string; climbUuid: string; boardType: string; status: string; angle: number; isMirror: boolean | null; isBenchmark: boolean | null; difficulty: number | null; quality: number | null; attemptCount: number; comment: string | null },
  userId: string,
  boardId: number | null,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_EVENT_RETRIES; attempt++) {
    try {
      const [climbData] = await db
        .select({
          name: dbSchema.boardClimbs.name,
          setterUsername: dbSchema.boardClimbs.setterUsername,
          layoutId: dbSchema.boardClimbs.layoutId,
          frames: dbSchema.boardClimbs.frames,
        })
        .from(dbSchema.boardClimbs)
        .where(
          and(
            eq(dbSchema.boardClimbs.uuid, tick.climbUuid),
            eq(dbSchema.boardClimbs.boardType, tick.boardType)
          )
        )
        .limit(1);

      const [userProfile] = await db
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

      let difficultyName: string | undefined;
      if (tick.difficulty) {
        const [grade] = await db
          .select({ boulderName: dbSchema.boardDifficultyGrades.boulderName })
          .from(dbSchema.boardDifficultyGrades)
          .where(
            and(
              eq(dbSchema.boardDifficultyGrades.difficulty, tick.difficulty),
              eq(dbSchema.boardDifficultyGrades.boardType, tick.boardType)
            )
          )
          .limit(1);
        difficultyName = grade?.boulderName ?? undefined;
      } else {
        difficultyName = await getConsensusDifficultyName(tick.climbUuid, tick.boardType, tick.angle);
      }

      let boardUuid: string | undefined;
      if (boardId) {
        const [board] = await db
          .select({ uuid: dbSchema.userBoards.uuid })
          .from(dbSchema.userBoards)
          .where(eq(dbSchema.userBoards.id, boardId))
          .limit(1);
        boardUuid = board?.uuid;
      }

      await publishSocialEvent({
        type: 'ascent.logged',
        actorId: userId,
        entityType: 'tick',
        entityId: tick.uuid,
        timestamp: Date.now(),
        metadata: {
          actorDisplayName: userProfile?.displayName || userProfile?.name || '',
          actorAvatarUrl: userProfile?.avatarUrl || userProfile?.image || '',
          climbName: climbData?.name || '',
          climbUuid: tick.climbUuid,
          boardType: tick.boardType,
          setterUsername: climbData?.setterUsername || '',
          layoutId: String(climbData?.layoutId ?? ''),
          frames: climbData?.frames || '',
          gradeName: difficultyName || '',
          difficulty: String(tick.difficulty ?? ''),
          difficultyName: difficultyName || '',
          status: tick.status,
          angle: String(tick.angle),
          isMirror: String(tick.isMirror ?? false),
          isBenchmark: String(tick.isBenchmark ?? false),
          quality: String(tick.quality ?? ''),
          attemptCount: String(tick.attemptCount),
          comment: tick.comment || '',
          // boardUuid may be null if the climb isn't associated with a user board;
          // this is intentional — board-scoped feed filtering simply won't match these items
          boardUuid: boardUuid || '',
        },
      });
      return; // Success
    } catch (error) {
      if (attempt === MAX_EVENT_RETRIES) {
        console.error(
          `[saveTick] Failed to publish ascent.logged event after ${MAX_EVENT_RETRIES} attempts for tick ${tick.uuid}:`,
          error,
        );
      } else {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
