import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext, TickStatus } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sessions } from '../../../db/schema';
import { applyRateLimit, requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { getConsensusDifficultyName } from '../shared/sql-expressions';
import { SaveTickInputSchema, UpdateTickInputSchema, AttachBetaLinkInputSchema } from '../../../validation/schemas';
import { resolveBoardFromPath } from '../social/boards';
import { publishSocialEvent } from '../../../events';
import { assignInferredSession } from '../../../jobs/inferred-session-builder';
import { publishDebouncedSessionStats } from '../sessions/debounced-stats-publisher';
import { queueClimbStatsRecompute } from './debounced-climb-stats-publisher';
import { getInstagramMediaId, isInstagramUrl } from '../../../lib/instagram-meta';
import {
  InstagramBetaValidationError,
  validateInstagramBetaLink,
  type InstagramPageMetadata,
} from '../../../utils/instagram-beta-validation';
import { cacheInstagramThumbnail, isS3Configured } from '../../../lib/beta-link-thumbnails';
import { invalidateRecentBetaLinksCache } from '../beta-videos/queries';
import { logger } from '../../../utils/logger';

// Beta links are only attached on successful ascents (flash / send), never
// on `attempt`. Returns the URL to attach, or null if the tick shouldn't
// carry one. Typed against the shared TickStatus enum so adding a new
// status (e.g. 'project') forces a recompile here — otherwise a new value
// would silently drop video URLs for it.
export function videoUrlForTickStatus(status: TickStatus, videoUrl: string | null | undefined): string | null {
  if (!videoUrl) return null;
  switch (status) {
    case 'flash':
    case 'send':
      return videoUrl;
    case 'attempt':
      return null;
  }
}

export type ShortcodeConflict = { kind: 'none' } | { kind: 'same-climb' } | { kind: 'cross-climb'; climbName: string };

// Looks up whether the same Instagram shortcode is already attached to any
// climb on this board. Returns a structured result so each caller can decide
// how to handle conflicts (attachBetaLink throws on both kinds; saveTick
// treats same-climb as a silent skip since the user just wanted to log a
// climb, not re-attach beta).
//
// Uses the indexed `shortcode` column added in 0089_renumber_dedup_index for
// an exact-match lookup — no LIKE prefilter, no JS post-filter.
//
// Race: two concurrent attaches of the same shortcode can both pass this
// check. The (boardType, climbUuid, link) PK + onConflictDoNothing makes
// the loser a silent no-op rather than a duplicate row. The loser misses
// the friendly "already linked" toast — accepted trade-off, see PR #1727
// review notes.
export async function findInstagramShortcodeConflict(
  boardType: string,
  selectedClimbUuid: string,
  instagramUrl: string,
): Promise<ShortcodeConflict> {
  const incomingShortcode = getInstagramMediaId(instagramUrl);
  if (!incomingShortcode) return { kind: 'none' };

  const existingLinks = await db
    .select({
      climbName: dbSchema.boardClimbs.name,
      climbUuid: dbSchema.boardBetaLinks.climbUuid,
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
      and(eq(dbSchema.boardBetaLinks.boardType, boardType), eq(dbSchema.boardBetaLinks.shortcode, incomingShortcode)),
    );

  // Scan every match before deciding. If the same shortcode is attached to
  // *both* the selected climb and a different climb (from a prior race or
  // data drift), the saveTick path's `onSameClimbDup: 'skip'` would
  // otherwise silently no-op when a same-climb row happens to come back
  // first — letting a known cross-climb dup pass through. Cross-climb
  // conflicts must always win.
  let sawSameClimb = false;
  for (const entry of existingLinks) {
    if (entry.climbUuid === selectedClimbUuid) {
      sawSameClimb = true;
      continue;
    }
    return { kind: 'cross-climb', climbName: entry.climbName ?? 'another climb' };
  }
  if (sawSameClimb) return { kind: 'same-climb' };
  return { kind: 'none' };
}

const SAME_CLIMB_DUP_MESSAGE =
  'We already have this Instagram video linked for this climb. Try a different post or reel.';
const crossClimbDupMessage = (otherClimbName: string): string =>
  `This Instagram post is already attached to "${otherClimbName}". Multi-climb slideshows are hard to navigate — please post a separate reel for this climb and share that one instead.`;

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

export type BetaLinkInsertPlan =
  // Insert the row. For non-Instagram URLs (TikTok et al.) the enrichment
  // fields are null — the read-time resolver will fill them in lazily.
  | { action: 'insert'; thumbnail: string | null; foreignUsername: string | null }
  // The shortcode is already attached to *this* climb. saveTick treats this
  // as a silent skip (the user logged a climb; the video URL is incidental
  // and the existing row covers it). attachBetaLink should pass
  // `onSameClimbDup: 'throw'` and never observe this case.
  | { action: 'skip-existing' }
  // The caller never had a URL to attach (e.g. saveTick on `attempt` status,
  // or saveTick without `videoUrl`). Distinct from `skip-existing` so the
  // call site can differentiate "we deliberately skipped a dup" from "there
  // was nothing to do" — and so a future refactor that drops the
  // attachedVideoUrl guard doesn't silently start dropping legitimate
  // inserts.
  | { action: 'no-url' };

export type ValidateAndEnrichOptions = {
  // Decides whether a same-climb shortcode duplicate is fatal (attachBetaLink)
  // or a silent skip (saveTick). Cross-climb dups are always fatal.
  onSameClimbDup: 'throw' | 'skip';
};

// Single gated entrypoint for write-time beta-link validation. Steps:
//   1. Apply the per-user rate limit on beta-link writes — 30/min, well above
//      legitimate use, well below what would let a caller spam writes or
//      probe IG shortcode existence at scale via the dedup query below.
//      The limit gates the DB probe, the outbound IG fetch, AND non-IG
//      (TikTok et al.) write paths so every beta-link attach burns budget.
//   2. Non-Instagram URLs (TikTok, etc.) bypass the deep checks and return
//      `action: 'insert'` with null enrichment — the read-time `betaLinks`
//      resolver will enrich them lazily.
//   3. Run the cross-climb dedup check. Cross-climb dup -> friendly error
//      via InstagramBetaValidationError. Same-climb dup -> branch on the
//      caller's `onSameClimbDup`.
//   4. Fetch the canonical post page, validate it's public + the caption
//      mentions the climb name.
//   5. Eagerly cache the thumbnail to S3 if configured (best-effort; the
//      read resolver still has the lazy fallback).
//
// Exported for testing.
export async function validateAndEnrichBetaLinkInsert(
  ctx: ConnectionContext,
  boardType: string,
  climbUuid: string,
  url: string,
  options: ValidateAndEnrichOptions,
): Promise<BetaLinkInsertPlan> {
  // Rate limit BEFORE branching on platform so TikTok / future non-IG
  // platforms get the same write-budget as IG. Also runs before the dedup
  // probe so an authenticated caller can't enumerate "is this IG shortcode
  // attached anywhere?" by watching the error variant (cross-climb vs
  // same-climb vs none) without consuming budget. See review of PR #1745.
  await applyRateLimit(ctx, 30, 'beta-link-validation');

  if (!isInstagramUrl(url)) {
    return { action: 'insert', thumbnail: null, foreignUsername: null };
  }

  const conflict = await findInstagramShortcodeConflict(boardType, climbUuid, url);
  if (conflict.kind === 'cross-climb') {
    throw new InstagramBetaValidationError(crossClimbDupMessage(conflict.climbName));
  }
  if (conflict.kind === 'same-climb') {
    if (options.onSameClimbDup === 'throw') {
      throw new InstagramBetaValidationError(SAME_CLIMB_DUP_MESSAGE);
    }
    return { action: 'skip-existing' };
  }

  const metadata = await validateInstagramBetaLink(url);
  const enriched = await enrichInstagramBetaInsert(metadata);
  return { action: 'insert', thumbnail: enriched.thumbnail, foreignUsername: enriched.foreignUsername };
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

      if (tick.sessionId) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(eq(sessions.id, tick.sessionId));
      }
    });

    // Recompute the stats row so a deleted ascent doesn't leave the count
    // inflated or the FA pinned to a now-vanished tick.
    queueClimbStatsRecompute(tick.boardType, tick.climbUuid, tick.angle);

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
    // Use the client-supplied UUID (offline idempotency key) when present,
    // otherwise generate one as before. On replay the (unique) uuid collides and
    // the insert below is a no-op; we then return the original row without
    // re-firing any side effects.
    const uuid = validatedInput.uuid ?? uuidv4();
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
    //
    // saveTick is treating beta-link attach as an *incidental* side effect of
    // logging a tick, so a same-climb shortcode dup must NOT fail the tick —
    // we'd otherwise reject a perfectly valid tick because the user happened
    // to leave the video URL in the form. Cross-climb dup is still fatal:
    // the user explicitly chose this video URL and we want to surface the
    // friendly "post a separate reel" message.
    const attachedVideoUrl = videoUrlForTickStatus(validatedInput.status, validatedInput.videoUrl);
    const betaPlan: BetaLinkInsertPlan = attachedVideoUrl
      ? await validateAndEnrichBetaLinkInsert(
          ctx,
          validatedInput.boardType,
          validatedInput.climbUuid,
          attachedVideoUrl,
          {
            onSameClimbDup: 'skip',
          },
        )
      : { action: 'no-url' };

    // Insert into database. When the client supplied a uuid that already exists
    // (offline replay), the insert is a no-op and `createdTick` is undefined —
    // we detect that, return the original row, and skip every side effect below.
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
        .onConflictDoNothing({ target: dbSchema.boardseshTicks.uuid })
        .returning();

      // Conflict no-op: the tick already exists from a prior (online) save of
      // this same idempotency key. Don't touch session activity or beta links.
      if (!createdTick) {
        return [undefined];
      }

      if (validatedInput.sessionId) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(eq(sessions.id, validatedInput.sessionId));
      }

      // Attach the video URL as community beta for this climb if the user
      // provided one on a successful ascent and the helper said to insert
      // (i.e. it wasn't a same-climb dup we silently skipped). The
      // (boardType, climbUuid, link) PK makes re-submission idempotent.
      if (attachedVideoUrl && betaPlan.action === 'insert') {
        await tx
          .insert(dbSchema.boardBetaLinks)
          .values({
            boardType: validatedInput.boardType,
            climbUuid: validatedInput.climbUuid,
            link: attachedVideoUrl,
            shortcode: getInstagramMediaId(attachedVideoUrl),
            angle: validatedInput.angle,
            isListed: true,
            thumbnail: betaPlan.thumbnail,
            foreignUsername: betaPlan.foreignUsername,
            createdAt: now,
            createdByUserId: userId,
          })
          .onConflictDoNothing();
      }

      return [createdTick];
    });

    // Idempotent replay: the insert was a no-op because this uuid already exists.
    // Return the stored row verbatim and fire no side effects (the original save
    // already did). This is what makes the offline mutation queue safe to retry.
    if (!tick) {
      const [existing] = await db
        .select()
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.uuid, uuid))
        .limit(1);

      // Defensive: a conflict means the row exists, but guard against a racing
      // delete between the failed insert and this read.
      if (!existing) {
        throw new GraphQLError('Tick conflict resolved to a missing row', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        });
      }

      return {
        uuid: existing.uuid,
        userId: existing.userId,
        boardType: existing.boardType,
        climbUuid: existing.climbUuid,
        angle: existing.angle,
        isMirror: existing.isMirror,
        status: existing.status,
        attemptCount: existing.attemptCount,
        quality: existing.quality,
        difficulty: existing.difficulty,
        isBenchmark: existing.isBenchmark,
        comment: existing.comment,
        climbedAt: existing.climbedAt,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        sessionId: existing.sessionId,
        boardId: existing.boardId,
        auroraType: existing.auroraType,
        auroraId: existing.auroraId,
        auroraSyncedAt: existing.auroraSyncedAt,
      };
    }

    // Bust the home-strip cache so newly-attached beta links surface on the
    // next read. Skip when the tick path didn't insert (no video URL, or
    // same-climb dup that was silently skipped) so we don't churn the cache
    // for the common "just logging an attempt" case. Fire-and-forget so a
    // slow Redis doesn't add latency to saveTick — matches the
    // `assignInferredSession` pattern below.
    if (attachedVideoUrl && betaPlan.action === 'insert') {
      invalidateRecentBetaLinksCache().catch((err) => {
        logger.error('[saveTick] recent-beta-links cache invalidation failed:', err);
      });
    }

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
        logger.error(`[saveTick] Failed to assign inferred session for tick ${uuid} (user ${userId}):`, err);
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

    // Recompute board_climb_stats for this climb so the ascent count and FA
    // fields stay in sync with boardsesh_ticks. Debounced so a burst of saves
    // on the same climb collapses into one recompute.
    queueClimbStatsRecompute(tick.boardType, tick.climbUuid, tick.angle);

    return result;
  },

  /**
   * Attach an Instagram post or reel as beta for a climb.
   * Idempotent on (boardType, climbUuid, link).
   */
  attachBetaLink: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);

    const validated = validateInput(AttachBetaLinkInputSchema, input, 'input');
    const userId = ctx.userId!;
    const now = new Date().toISOString();

    // Validation runs first — it's an outbound HTTP fetch we don't want to
    // hold a DB connection open for. attachBetaLink is a deliberate user
    // action so a same-climb shortcode dup is fatal (the user gets the
    // friendly "already linked" message); cross-climb dup is also fatal.
    // The catch on the insert covers the rare case where validation passed
    // but the write fails (constraint, connection drop), surfacing an
    // explicit error rather than a generic toast.
    const betaPlan = await validateAndEnrichBetaLinkInsert(
      ctx,
      validated.boardType,
      validated.climbUuid,
      validated.link,
      { onSameClimbDup: 'throw' },
    );
    // With onSameClimbDup: 'throw' the helper either returns 'insert' or
    // throws. Asserting here keeps the type narrowing honest.
    if (betaPlan.action !== 'insert') {
      throw new GraphQLError('Unexpected beta-link plan for attachBetaLink', {
        extensions: { code: 'BETA_LINK_INTERNAL' },
      });
    }

    try {
      await db
        .insert(dbSchema.boardBetaLinks)
        .values({
          boardType: validated.boardType,
          climbUuid: validated.climbUuid,
          link: validated.link,
          shortcode: getInstagramMediaId(validated.link),
          angle: validated.angle ?? null,
          isListed: true,
          thumbnail: betaPlan.thumbnail,
          foreignUsername: betaPlan.foreignUsername,
          createdAt: now,
          createdByUserId: userId,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.error('[attachBetaLink] insert failed after validation passed:', err);
      throw new GraphQLError("Couldn't save the beta link. Please try again.", {
        extensions: { code: 'BETA_LINK_INSERT_FAILED' },
      });
    }

    // Bust the home-strip cache so this new link surfaces on the next read
    // instead of waiting for the 24h TTL. Fire-and-forget — never blocks
    // the mutation result on Redis.
    invalidateRecentBetaLinksCache().catch((err) => {
      logger.error('[attachBetaLink] recent-beta-links cache invalidation failed:', err);
    });

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

    const [updated] = await db
      .update(dbSchema.boardseshTicks)
      .set(updates)
      .where(eq(dbSchema.boardseshTicks.uuid, uuid))
      .returning();

    // Status edits (attempt → send and back) flip whether this tick counts
    // toward ascensionist_count, and a quality/difficulty/comment edit can
    // also change downstream derived stats once we aggregate those. Recompute.
    queueClimbStatsRecompute(updated.boardType, updated.climbUuid, updated.angle);

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
        logger.error(
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
