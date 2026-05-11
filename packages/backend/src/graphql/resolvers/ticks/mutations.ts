import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray, like } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import {
  upsertUserClimbQuality,
  upsertUserClimbGrade,
  recomputeUserClimbQualityProjection,
  recomputeUserClimbGradeProjection,
  recomputeUserClimbProjectionsAfterTickDelete,
} from '@boardsesh/db/queries';
import { sessions } from '../../../db/schema';
import { applyRateLimit, requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { escapeLikePattern } from '../../../utils/like-pattern';
import { getConsensusDifficultyName } from '../shared/sql-expressions';
import { SaveTickInputSchema, UpdateTickInputSchema, AttachBetaLinkInputSchema } from '../../../validation/schemas';
import { resolveBoardFromPath } from '../social/boards';
import { publishSocialEvent } from '../../../events';
import { assignInferredSession } from '../../../jobs/inferred-session-builder';
import { publishDebouncedSessionStats } from '../sessions/debounced-stats-publisher';
import { getInstagramMediaId, isInstagramUrl } from '../../../lib/instagram-meta';
import {
  InstagramBetaValidationError,
  validateInstagramBetaLink,
  type InstagramPageMetadata,
} from '../../../utils/instagram-beta-validation';
import { cacheInstagramThumbnail, isS3Configured } from '../../../lib/beta-link-thumbnails';

// Beta links are only attached on successful ascents (flash / send), never on
// `attempt`. Returns the URL to attach, or null if the tick shouldn't carry
// one. Exported so the rule can be unit-tested without integration setup.
export function videoUrlForTickStatus(
  status: 'flash' | 'send' | 'attempt',
  videoUrl: string | null | undefined,
): string | null {
  if (!videoUrl) return null;
  if (status !== 'flash' && status !== 'send') return null;
  return videoUrl;
}

async function ensureInstagramShortcodeIsNotAlreadyLinked(
  boardType: string,
  selectedClimbUuid: string,
  instagramUrl: string,
): Promise<void> {
  const incomingShortcode = getInstagramMediaId(instagramUrl);
  if (!incomingShortcode) return;

  // Narrow at the DB level — the shortcode appears as `/p/<id>/`, `/reel/<id>/`,
  // or `/tv/<id>/` in the link. A LIKE prefilter avoids loading every beta
  // link for the board on every write. Drizzle parameterizes the value;
  // escapeLikePattern handles `_` / `%` since shortcodes can contain
  // underscores (which would otherwise act as wildcards). The post-fetch
  // `getInstagramMediaId(entry.link)` re-check still filters any false
  // positives (e.g. shortcodes appearing in non-canonical positions).
  //
  // Race: two concurrent attaches of the same shortcode can both pass this
  // check. The (boardType, climbUuid, link) PK + onConflictDoNothing makes
  // the loser a silent no-op rather than a duplicate row. The loser misses
  // the friendly "already linked" message — acceptable for a beta-link
  // feature; an advisory lock would be overkill.
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
      and(
        eq(dbSchema.boardBetaLinks.boardType, boardType),
        like(dbSchema.boardBetaLinks.link, `%${escapeLikePattern(incomingShortcode)}%`),
      ),
    );

  for (const entry of existingLinks) {
    if (getInstagramMediaId(entry.link) !== incomingShortcode) continue;

    if (entry.climbUuid === selectedClimbUuid) {
      throw new InstagramBetaValidationError(
        'We already have this Instagram video linked for this climb. Try a different post or reel.',
      );
    }

    throw new InstagramBetaValidationError(
      `This Instagram post is already attached to "${entry.climbName}". Multi-climb slideshows are hard to navigate — please post a separate reel for this climb and share that one instead.`,
    );
  }
}

type EnrichedBetaInsert = {
  thumbnail: string | null;
  foreignUsername: string | null;
};

async function enrichInstagramBetaInsert(metadata: InstagramPageMetadata): Promise<EnrichedBetaInsert> {
  const foreignUsername = metadata.username;

  if (!isS3Configured() || !metadata.imageUrl) {
    return { thumbnail: null, foreignUsername };
  }

  const mediaId = metadata.mediaId;
  if (!mediaId) {
    return { thumbnail: null, foreignUsername };
  }

  // Note: this S3 write happens before the boardseshTicks/boardBetaLinks
  // insert in saveTick. If that subsequent transaction rolls back (bad
  // sessionId, DB hiccup, dup conflict that we don't surface), the S3
  // object is orphaned. Acceptable trade-off: the cache key is the IG
  // media ID, so any future attach for the same post idempotently reuses
  // the existing object — orphans aren't duplicated, they just sit at a
  // few KB each indexed by media ID. If this becomes meaningful a
  // periodic GC keyed on `boardBetaLinks.thumbnail` could sweep them.
  const cached = await cacheInstagramThumbnail(mediaId, metadata.imageUrl);
  return { thumbnail: cached, foreignUsername };
}

// Single gated entrypoint for write-time beta-link validation. Non-Instagram
// URLs (TikTok and other zod-allowed platforms) skip the deep checks and
// return null thumbnail/username — the read-time `betaLinks` resolver will
// enrich them lazily. The `ctx` is used to apply per-user rate limiting on
// the outbound IG fetch (only when we'd actually hit the network).
// Exported for testing.
export async function validateAndEnrichBetaLinkInsert(
  ctx: ConnectionContext,
  boardType: string,
  climbUuid: string,
  url: string,
): Promise<EnrichedBetaInsert> {
  if (!isInstagramUrl(url)) {
    return { thumbnail: null, foreignUsername: null };
  }

  // Cap outbound IG fetches per user. 30/min is far above legitimate use
  // (you don't attach beta videos that fast manually) but stops a tight
  // loop from getting our IP rate-limited or blocked by Instagram.
  await applyRateLimit(ctx, 30, 'instagram-beta-validation');

  await ensureInstagramShortcodeIsNotAlreadyLinked(boardType, climbUuid, url);
  const metadata = await validateInstagramBetaLink(url);
  return enrichInstagramBetaInsert(metadata);
}

export const tickMutations = {
  /**
   * Delete a tick (climb attempt/ascent) for the authenticated user.
   * Only the owner can delete their own ticks.
   */
  deleteTick: async (_: unknown, { uuid }: { uuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const [tick] = await db
      .select({
        uuid: dbSchema.boardseshTicks.uuid,
        userId: dbSchema.boardseshTicks.userId,
        sessionId: dbSchema.boardseshTicks.sessionId,
        boardType: dbSchema.boardseshTicks.boardType,
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        angle: dbSchema.boardseshTicks.angle,
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
        await tx.delete(dbSchema.notifications).where(inArray(dbSchema.notifications.commentId, commentIds));
      }

      // Delete related social data for the tick itself
      await tx
        .delete(dbSchema.feedItems)
        .where(and(eq(dbSchema.feedItems.entityType, 'tick'), eq(dbSchema.feedItems.entityId, uuid)));
      await tx
        .delete(dbSchema.votes)
        .where(and(eq(dbSchema.votes.entityType, 'tick'), eq(dbSchema.votes.entityId, uuid)));
      await tx
        .delete(dbSchema.voteCounts)
        .where(and(eq(dbSchema.voteCounts.entityType, 'tick'), eq(dbSchema.voteCounts.entityId, uuid)));
      await tx
        .delete(dbSchema.comments)
        .where(and(eq(dbSchema.comments.entityType, 'tick'), eq(dbSchema.comments.entityId, uuid)));
      await tx
        .delete(dbSchema.notifications)
        .where(and(eq(dbSchema.notifications.entityType, 'tick'), eq(dbSchema.notifications.entityId, uuid)));
      // Delete the tick itself
      await tx.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.uuid, uuid));

      // Recompute the user's projection rows for this (climb, angle) pair —
      // the deleted tick may have been the source of the current opinion.
      // Runs after the tick delete so the recompute query sees the new state.
      await recomputeUserClimbProjectionsAfterTickDelete(tx, {
        userId,
        boardType: tick.boardType,
        climbUuid: tick.climbUuid,
        angle: tick.angle,
      });

      if (tick.sessionId) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(eq(sessions.id, tick.sessionId));
      }
    });

    return true;
  },

  /**
   * Save a tick (climb attempt/ascent) for the authenticated user
   */
  saveTick: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<unknown> => {
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

    // Run write-time Instagram validation before opening the transaction so a
    // bad video URL doesn't leave a half-state. Zod already validated the
    // surface shape; the helper confirms the post is actually public, mentions
    // the climb name, and isn't already attached to another climb. TikTok and
    // other supported platforms skip the deep validation.
    const attachedVideoUrl = videoUrlForTickStatus(validatedInput.status, validatedInput.videoUrl);
    const enrichedInsert: EnrichedBetaInsert = attachedVideoUrl
      ? await validateAndEnrichBetaLinkInsert(ctx, validatedInput.boardType, validatedInput.climbUuid, attachedVideoUrl)
      : { thumbnail: null, foreignUsername: null };

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

      // Project the user's "current opinion" forward into the
      // user_climb_{qualities,grades} tables so the search filter can read it
      // without scanning every tick. The upsert helpers guard against an older
      // tick (replay / out-of-order log) overwriting a newer opinion.
      if (createdTick.quality != null) {
        await upsertUserClimbQuality(tx, {
          userId,
          boardType: createdTick.boardType,
          climbUuid: createdTick.climbUuid,
          quality: createdTick.quality,
          recordedAt: createdTick.climbedAt,
        });
      }
      if (createdTick.difficulty != null) {
        await upsertUserClimbGrade(tx, {
          userId,
          boardType: createdTick.boardType,
          climbUuid: createdTick.climbUuid,
          angle: createdTick.angle,
          difficulty: createdTick.difficulty,
          recordedAt: createdTick.climbedAt,
        });
      }

      if (validatedInput.sessionId) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(eq(sessions.id, validatedInput.sessionId));
      }

      // Attach the video URL as community beta for this climb if the user
      // provided one on a successful ascent. The (boardType, climbUuid, link)
      // PK makes re-submission idempotent.
      if (attachedVideoUrl) {
        await tx
          .insert(dbSchema.boardBetaLinks)
          .values({
            boardType: validatedInput.boardType,
            climbUuid: validatedInput.climbUuid,
            link: attachedVideoUrl,
            angle: validatedInput.angle,
            isListed: true,
            thumbnail: enrichedInsert.thumbnail,
            foreignUsername: enrichedInsert.foreignUsername,
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
  attachBetaLink: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);

    const validated = validateInput(AttachBetaLinkInputSchema, input, 'input');
    const now = new Date().toISOString();

    // Validation runs first — it's an outbound HTTP fetch we don't want to
    // hold a DB connection open for. The insert is a single statement; no
    // need to wrap it in a transaction. The catch surfaces an explicit error
    // for the rare case where the insert fails (constraint, connection drop)
    // after validation already passed, so the user doesn't see the generic
    // "couldn't add video" toast.
    const enrichedInsert = await validateAndEnrichBetaLinkInsert(
      ctx,
      validated.boardType,
      validated.climbUuid,
      validated.link,
    );

    try {
      await db
        .insert(dbSchema.boardBetaLinks)
        .values({
          boardType: validated.boardType,
          climbUuid: validated.climbUuid,
          link: validated.link,
          angle: validated.angle ?? null,
          isListed: true,
          thumbnail: enrichedInsert.thumbnail,
          foreignUsername: enrichedInsert.foreignUsername,
          createdAt: now,
        })
        .onConflictDoNothing();
    } catch (err) {
      console.error('[attachBetaLink] insert failed after validation passed:', err);
      throw new GraphQLError("Couldn't save the beta link. Please try again.", {
        extensions: { code: 'BETA_LINK_INSERT_FAILED' },
      });
    }

    return true;
  },

  /**
   * Update an existing tick. Only the owner can update their own ticks.
   */
  updateTick: async (
    _: unknown,
    { uuid, input }: { uuid: string; input: unknown },
    ctx: ConnectionContext,
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

    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(dbSchema.boardseshTicks)
        .set(updates)
        .where(eq(dbSchema.boardseshTicks.uuid, uuid))
        .returning();

      // Reflect the user's edit into the projection tables.
      //   - new value set: upsert with the tick's climbedAt so an edit to an
      //     older tick can't clobber a newer projection (setWhere guard).
      //   - cleared (set to null): the tick no longer contributes; recompute
      //     the projection from the user's remaining ticks for that climb.
      //
      // Intentional silent no-op: if the user edits the quality on an *older*
      // tick and a newer tick already owns the projection row, the upsert's
      // staleness guard skips the update. The "current opinion" is by design
      // the most-recent tick's value, so an edit to a historical tick is a
      // correction of the historical record and shouldn't override that. The
      // mutation still returns success because the tick row itself updated;
      // the projection just doesn't change. This is the same shape as Aurora
      // replay handling and keeps both write paths consistent.
      if (validatedInput.quality !== undefined) {
        if (validatedInput.quality == null) {
          await recomputeUserClimbQualityProjection(tx, {
            userId,
            boardType: row.boardType,
            climbUuid: row.climbUuid,
          });
        } else {
          await upsertUserClimbQuality(tx, {
            userId,
            boardType: row.boardType,
            climbUuid: row.climbUuid,
            quality: validatedInput.quality,
            recordedAt: row.climbedAt,
          });
        }
      }
      if (validatedInput.difficulty !== undefined) {
        if (validatedInput.difficulty == null) {
          await recomputeUserClimbGradeProjection(tx, {
            userId,
            boardType: row.boardType,
            climbUuid: row.climbUuid,
            angle: row.angle,
          });
        } else {
          await upsertUserClimbGrade(tx, {
            userId,
            boardType: row.boardType,
            climbUuid: row.climbUuid,
            angle: row.angle,
            difficulty: validatedInput.difficulty,
            recordedAt: row.climbedAt,
          });
        }
      }

      return [row];
    });

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
  tick: {
    uuid: string;
    climbUuid: string;
    boardType: string;
    status: string;
    angle: number;
    isMirror: boolean | null;
    isBenchmark: boolean | null;
    difficulty: number | null;
    quality: number | null;
    attemptCount: number;
    comment: string | null;
  },
  userId: string,
  boardId: number | null,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_EVENT_RETRIES; attempt++) {
    try {
      const [climbData] = await db
        .select({
          name: dbSchema.boardClimbs.name,
          description: dbSchema.boardClimbs.description,
          setterUsername: dbSchema.boardClimbs.setterUsername,
          layoutId: dbSchema.boardClimbs.layoutId,
          frames: dbSchema.boardClimbs.frames,
        })
        .from(dbSchema.boardClimbs)
        .where(and(eq(dbSchema.boardClimbs.uuid, tick.climbUuid), eq(dbSchema.boardClimbs.boardType, tick.boardType)))
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
              eq(dbSchema.boardDifficultyGrades.boardType, tick.boardType),
            ),
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
          isNoMatch: String(isNoMatchClimb(climbData?.description)),
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
