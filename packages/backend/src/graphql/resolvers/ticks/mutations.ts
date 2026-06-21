import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';
import { GraphQLError } from 'graphql';
import { betaLinkIdentity, type ConnectionContext, type TickStatus } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sessions } from '../../../db/schema';
import { applyRateLimit, requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { getConsensusDifficultyName } from '../shared/sql-expressions';
import { SaveTickInputSchema, UpdateTickInputSchema, AttachBetaLinkInputSchema } from '../../../validation/schemas';
import { resolveBoardFromPath } from '../social/boards';
import { findActiveBoardById, normalizeSetIds } from '../board-presence/shared';
import { queueBoardStatsPublish } from '../board-presence/stats';
import { publishSocialEvent } from '../../../events';
import { publishDebouncedSessionStats } from '../sessions/debounced-stats-publisher';
import { queueClimbStatsRecompute } from './debounced-climb-stats-publisher';
import { getInstagramMediaId, isInstagramUrl, normalizeBetaVideoUrl } from '../../../lib/instagram-meta';
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

export type ShortcodeConflict =
  | { kind: 'none' }
  | { kind: 'same-climb' }
  | { kind: 'cross-climb'; climbName: string; existingBoardType: string };

// Looks up whether the same canonical video is already attached anywhere.
// Returns a structured result so each caller can decide how to handle
// conflicts (attachBetaLink throws on both kinds; saveTick treats same-climb as
// a silent skip since the user just wanted to log a climb, not re-attach beta).
//
// Uses the indexed `video_identity` column for an exact-match lookup — no LIKE
// prefilter, no JS post-filter.
//
// Race: two concurrent attaches of the same canonical video can both pass this
// check. The partial unique index on `video_identity` + onConflictDoNothing
// makes the loser a silent no-op rather than a duplicate row. The loser misses
// the friendly "already linked" toast — accepted trade-off, see PR #1727
// review notes.
export async function findInstagramShortcodeConflict(
  boardType: string,
  selectedClimbUuid: string,
  instagramUrl: string,
): Promise<ShortcodeConflict> {
  return findBetaLinkIdentityConflict(boardType, selectedClimbUuid, instagramUrl);
}

export async function findBetaLinkIdentityConflict(
  boardType: string,
  selectedClimbUuid: string,
  videoUrl: string,
): Promise<ShortcodeConflict> {
  const incomingVideoIdentity = betaLinkIdentity(videoUrl);

  const existingLinks = await db
    .select({
      boardType: dbSchema.boardBetaLinks.boardType,
      climbName: dbSchema.boardClimbs.name,
      climbUuid: dbSchema.boardBetaLinks.climbUuid,
    })
    .from(dbSchema.boardBetaLinks)
    .leftJoin(
      dbSchema.boardClimbs,
      and(
        eq(dbSchema.boardClimbs.boardType, dbSchema.boardBetaLinks.boardType),
        eq(dbSchema.boardClimbs.uuid, dbSchema.boardBetaLinks.climbUuid),
      ),
    )
    .where(eq(dbSchema.boardBetaLinks.videoIdentity, incomingVideoIdentity));

  // Scan every match before deciding. If the same video is attached to *both*
  // the selected climb and a different climb (from a prior race or data drift),
  // the saveTick path's `onSameClimbDup: 'skip'` would otherwise silently no-op
  // when a same-climb row happens to come back first — letting a known
  // cross-climb dup pass through. Cross-climb conflicts must always win.
  let sawSameClimb = false;
  for (const entry of existingLinks) {
    if (entry.boardType === boardType && entry.climbUuid === selectedClimbUuid) {
      sawSameClimb = true;
      continue;
    }
    return { kind: 'cross-climb', climbName: entry.climbName ?? 'another climb', existingBoardType: entry.boardType };
  }
  if (sawSameClimb) return { kind: 'same-climb' };
  return { kind: 'none' };
}

const SAME_CLIMB_DUP_MESSAGE = 'We already have this video linked for this climb. Try a different post or reel.';
const crossClimbDupMessage = (otherClimbName: string, existingBoardType: string, requestedBoardType: string): string => {
  if (existingBoardType !== requestedBoardType) {
    return `This video is already attached to "${otherClimbName}" on a different board. A video can only belong to one climb across all boards — please post a separate clip for this climb.`;
  }
  return `This video is already attached to "${otherClimbName}". Multi-climb videos are hard to navigate - please post a separate clip for this climb and share that one instead.`;
};

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
  // The canonical video is already attached to *this* climb. saveTick treats this
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
  // Decides whether a same-climb video duplicate is fatal (attachBetaLink)
  // or a silent skip (saveTick).
  onSameClimbDup: 'throw' | 'skip';
  // Decides what happens when the same video is attached to a *different board
  // type* (e.g. the video is on a Kilter climb and saveTick is for a Tension
  // climb). video_identity is global, so a cross-board conflict can occur even
  // when the user is legitimately attaching beta for a completely different
  // climb. saveTick passes 'skip' because the video URL is incidental; the
  // tick itself is still valid. attachBetaLink passes 'throw' (the default)
  // because the user explicitly chose this URL.
  onCrossBoardDup?: 'throw' | 'skip';
};

// Single gated entrypoint for write-time beta-link validation. Steps:
//   1. Apply the per-user rate limit on beta-link writes — 30/min, well above
//      legitimate use, well below what would let a caller spam writes or
//      probe video existence at scale via the dedup query below.
//      The limit gates the DB probe, the outbound IG fetch, AND non-IG
//      (TikTok et al.) write paths so every beta-link attach burns budget.
//   2. Run the cross-climb dedup check. Cross-climb dup -> friendly error
//      via InstagramBetaValidationError. Same-climb dup -> branch on the
//      caller's `onSameClimbDup`.
//   3. Non-Instagram URLs (TikTok, etc.) return `action: 'insert'` with null
//      enrichment after dedup — the read-time `betaLinks` resolver enriches
//      them lazily.
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
  // probe so an authenticated caller can't enumerate "is this video
  // attached anywhere?" by watching the error variant (cross-climb vs
  // same-climb vs none) without consuming budget. See review of PR #1745.
  await applyRateLimit(ctx, 30, 'beta-link-validation');

  const conflict = await findBetaLinkIdentityConflict(boardType, climbUuid, url);
  if (conflict.kind === 'cross-climb') {
    const isCrossBoard = conflict.existingBoardType !== boardType;
    if (isCrossBoard && (options.onCrossBoardDup ?? 'throw') === 'skip') {
      return { action: 'skip-existing' };
    }
    throw new InstagramBetaValidationError(crossClimbDupMessage(conflict.climbName, conflict.existingBoardType, boardType));
  }
  if (conflict.kind === 'same-climb') {
    if (options.onSameClimbDup === 'throw') {
      throw new InstagramBetaValidationError(SAME_CLIMB_DUP_MESSAGE);
    }
    return { action: 'skip-existing' };
  }

  if (!isInstagramUrl(url)) {
    return { action: 'insert', thumbnail: null, foreignUsername: null };
  }

  const metadata = await validateInstagramBetaLink(url);
  const enriched = await enrichInstagramBetaInsert(metadata);
  return { action: 'insert', thumbnail: enriched.thumbnail, foreignUsername: enriched.foreignUsername };
}

type BetaLinkTickContext = {
  tickUuid: string | null;
  boardId: number | null;
  angle: number | null;
};

const tickClimbAlias = aliasedTable(dbSchema.boardClimbAliases, 'beta_link_tick_climb_alias');
const inputClimbAlias = aliasedTable(dbSchema.boardClimbAliases, 'beta_link_input_climb_alias');

export async function resolveBetaLinkTickContext(
  input: { boardType: string; climbUuid: string; angle?: number | null; tickUuid?: string | null; link?: string },
  userId: string,
): Promise<BetaLinkTickContext> {
  if (!input.tickUuid) {
    return { tickUuid: null, boardId: null, angle: input.angle ?? null };
  }

  const [tick] = await db
    .select({
      uuid: dbSchema.boardseshTicks.uuid,
      userId: dbSchema.boardseshTicks.userId,
      boardType: dbSchema.boardseshTicks.boardType,
      climbUuid: dbSchema.boardseshTicks.climbUuid,
      canonicalClimbUuid: tickClimbAlias.canonicalUuid,
      inputCanonicalClimbUuid: inputClimbAlias.canonicalUuid,
      angle: dbSchema.boardseshTicks.angle,
      status: dbSchema.boardseshTicks.status,
      boardId: dbSchema.boardseshTicks.boardId,
    })
    .from(dbSchema.boardseshTicks)
    .leftJoin(
      tickClimbAlias,
      and(
        eq(tickClimbAlias.boardType, dbSchema.boardseshTicks.boardType),
        eq(tickClimbAlias.aliasUuid, dbSchema.boardseshTicks.climbUuid),
      ),
    )
    .leftJoin(
      inputClimbAlias,
      and(eq(inputClimbAlias.boardType, input.boardType), eq(inputClimbAlias.aliasUuid, input.climbUuid)),
    )
    .where(eq(dbSchema.boardseshTicks.uuid, input.tickUuid))
    .limit(1);

  if (!tick) {
    throw new GraphQLError('Tick not found', { extensions: { code: 'TICK_NOT_FOUND' } });
  }
  if (tick.userId !== userId) {
    throw new GraphQLError('You can only attach beta to your own ticks', { extensions: { code: 'FORBIDDEN' } });
  }
  if (tick.status === 'attempt') {
    throw new GraphQLError('Beta videos can only be attached to sends or flashes', {
      extensions: { code: 'BETA_LINK_TICK_NOT_ASCENT' },
    });
  }
  if (tick.boardType !== input.boardType) {
    throw new GraphQLError('The selected tick is for a different board type', {
      extensions: { code: 'BETA_LINK_TICK_MISMATCH' },
    });
  }

  const canonicalTickClimbUuid = tick.canonicalClimbUuid ?? tick.climbUuid;
  const canonicalInputClimbUuid = tick.inputCanonicalClimbUuid ?? input.climbUuid;
  if (canonicalTickClimbUuid !== canonicalInputClimbUuid) {
    throw new GraphQLError('The selected tick is for a different climb', {
      extensions: { code: 'BETA_LINK_TICK_MISMATCH' },
    });
  }
  if (input.angle != null && input.angle !== tick.angle) {
    throw new GraphQLError('The selected tick is for a different angle', {
      extensions: { code: 'BETA_LINK_TICK_MISMATCH' },
    });
  }

  const [existingTickBetaLink] = await db
    .select({ link: dbSchema.boardBetaLinks.link })
    .from(dbSchema.boardBetaLinks)
    .where(eq(dbSchema.boardBetaLinks.tickUuid, tick.uuid))
    .limit(1);
  if (existingTickBetaLink) {
    // Idempotency: if the same canonical video is being re-submitted for the
    // same tick (e.g. mobile retry after a network blip), treat it as a
    // no-op success. A different video URL on an already-linked tick is
    // a genuine conflict and still throws.
    if (input.link && betaLinkIdentity(input.link) === betaLinkIdentity(existingTickBetaLink.link)) {
      return { tickUuid: tick.uuid, boardId: tick.boardId, angle: tick.angle };
    }
    throw new GraphQLError('This tick already has a beta video linked', {
      extensions: { code: 'BETA_LINK_TICK_ALREADY_LINKED' },
    });
  }

  return { tickUuid: tick.uuid, boardId: tick.boardId, angle: tick.angle };
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

    logger.info(
      `[deleteTick] user=${userId} tick=${uuid} ${tick.boardType}/${tick.climbUuid.slice(0, 8)}/${tick.angle}`,
    );

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

    logger.info(`[deleteTick] deleted tick=${uuid} user=${userId}`);

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
    logger.info(
      `[saveTick] user=${userId} ${validatedInput.boardType}/${validatedInput.climbUuid.slice(0, 8)}/${validatedInput.angle} ` +
        `status=${validatedInput.status}` +
        (validatedInput.sessionId ? ` session=${validatedInput.sessionId}` : ''),
    );
    const uuid = uuidv4();
    const now = new Date().toISOString();
    const climbedAt = new Date(validatedInput.climbedAt).toISOString();

    // Resolve the tick's board_id. Two explicit-board inputs feed the same FK,
    // each from a different surface:
    //  1. boardUuid — a named-board route (`/b/<slug>/...`); attaches to that
    //     exact board entity even when the climber doesn't own it (e.g. a
    //     seeded gym board owned by the system user). Best-effort: a deleted or
    //     stale uuid records the tick unassociated rather than rejecting it, and
    //     does NOT fall back to config resolution.
    //  2. boardId — the board-presence connected wall (resolveBoardForSerial),
    //     flag-gated. On a stale/mismatched id we warn and fall back to the
    //     config lookup rather than surfacing a raw FK/type mismatch.
    // Absent both, the legacy `/[board_name]/[layout_id]/...` config lookup runs.
    let boardId: number | null = null;
    if (validatedInput.boardUuid) {
      const [board] = await db
        .select({
          id: dbSchema.userBoards.id,
          boardType: dbSchema.userBoards.boardType,
          layoutId: dbSchema.userBoards.layoutId,
          sizeId: dbSchema.userBoards.sizeId,
          setIds: dbSchema.userBoards.setIds,
        })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1);

      // Board may have been deleted or the client sent a stale UUID — just
      // record the tick without a board association rather than rejecting it.
      // board_id is nullable (onDelete: 'set null') so this is always valid.
      if (board) {
        boardId = board.id;
      }
    } else if (validatedInput.boardId != null) {
      const explicitBoard = await findActiveBoardById(validatedInput.boardId);
      // Accept the explicit wall board only when its FULL config matches the
      // tick's target (type + layout + size + set). A stale presence boardId
      // from a different layout/size/set would otherwise stamp this tick onto
      // the wrong wall and corrupt that board's presence stats. Set ids are
      // compared normalized so order/format differences don't reject a match.
      const configMatches =
        explicitBoard != null &&
        explicitBoard.boardType === validatedInput.boardType &&
        explicitBoard.layoutId === validatedInput.layoutId &&
        explicitBoard.sizeId === validatedInput.sizeId &&
        normalizeSetIds(explicitBoard.setIds) === normalizeSetIds(validatedInput.setIds);
      if (configMatches) {
        boardId = explicitBoard.id;
      } else {
        logger.warn(
          `[board-presence] Ignoring tick boardId ${validatedInput.boardId} — config mismatch for ${validatedInput.boardType}`,
        );
      }
    }

    // Legacy `/[board_name]/[layout_id]/...` route (no specific board entity),
    // plus the fallback when a board-presence boardId didn't match. A
    // best-effort boardUuid that resolved to nothing is intentionally left
    // unassociated (handled above), so it does not fall through to here.
    if (
      boardId == null &&
      !validatedInput.boardUuid &&
      validatedInput.layoutId &&
      validatedInput.sizeId &&
      validatedInput.setIds
    ) {
      boardId = await resolveBoardFromPath(
        userId,
        validatedInput.boardType,
        validatedInput.layoutId,
        validatedInput.sizeId,
        validatedInput.setIds,
      );
    }

    // Run write-time beta-link validation before opening the transaction so a
    // bad video URL doesn't leave a half-state. Zod already validated the
    // surface shape; Instagram gets deep public/caption validation, while
    // TikTok and other supported platforms skip platform metadata validation.
    //
    // saveTick is treating beta-link attach as an *incidental* side effect of
    // logging a tick, so a same-climb video dup must NOT fail the tick —
    // we'd otherwise reject a perfectly valid tick because the user happened
    // to leave the video URL in the form.
    //
    // video_identity is global (not per board type), so a cross-board dup is
    // also silently skipped: if the user previously attached this video to a
    // Kilter climb, a new Tension tick with the same URL is still valid — we
    // just don't link the beta a second time. Cross-board conflicts are only
    // fatal for the explicit `attachBetaLink` mutation, where the user made a
    // deliberate choice.
    //
    // Same-board cross-climb dups (same board type, different climb) remain
    // fatal: the user explicitly chose this URL for this climb and should see
    // the "post a separate reel" message.
    const tickVideoUrl = videoUrlForTickStatus(validatedInput.status, validatedInput.videoUrl);
    const attachedVideoUrl = tickVideoUrl ? normalizeBetaVideoUrl(tickVideoUrl) : tickVideoUrl;
    const betaPlan: BetaLinkInsertPlan = attachedVideoUrl
      ? await validateAndEnrichBetaLinkInsert(
          ctx,
          validatedInput.boardType,
          validatedInput.climbUuid,
          attachedVideoUrl,
          {
            onSameClimbDup: 'skip',
            onCrossBoardDup: 'skip',
          },
        )
      : { action: 'no-url' };

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
            videoIdentity: betaLinkIdentity(attachedVideoUrl),
            tickUuid: createdTick.uuid,
            boardId: createdTick.boardId,
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

    // Bust the home-strip cache so newly-attached beta links surface on the
    // next read. Skip when the tick path didn't insert (no video URL, or
    // same-climb dup that was silently skipped) so we don't churn the cache
    // for the common "just logging an attempt" case.
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

    // Board presence: a tick on a connected wall changes that wall's durable
    // stats (sends / climbers / hardest / top grade). Push the freshly
    // recomputed snapshot over the board's live `boardNowPlaying` feed so every
    // watcher's stat tiles update without re-fetching. Debounced per board so a
    // burst of logs collapses into one recompute+publish and so concurrent
    // ticks can't pair a stale snapshot with a higher seq. Runs after the tick
    // has committed (the recompute sees it) and self-guards, so a presence push
    // can never fail the tick that triggered it.
    if (boardId != null) {
      queueBoardStatsPublish(boardId, tick.boardType);
    }

    logger.info(
      `[saveTick] saved tick=${tick.uuid} user=${userId} ` +
        `${tick.boardType}/${tick.climbUuid.slice(0, 8)}/${tick.angle} status=${tick.status}`,
    );

    return result;
  },

  /**
   * Attach an Instagram or TikTok video as beta for a climb.
   * Idempotent on (boardType, climbUuid, link) when tickUuid is absent.
   * When tickUuid is supplied, re-submitting the same canonical video for the
   * same tick is also idempotent. Submitting a *different* video for an
   * already-linked tick throws BETA_LINK_TICK_ALREADY_LINKED.
   */
  attachBetaLink: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);

    const validated = validateInput(AttachBetaLinkInputSchema, input, 'input');
    // Strip Instagram share-attribution params (`?igsh=...`) before the dedup
    // probe and insert so the stored `link` opens straight to the reel.
    const normalizedLink = normalizeBetaVideoUrl(validated.link);
    const userId = ctx.userId!;
    const now = new Date().toISOString();

    // Each attachBetaLink call burns 2 rate-limit tokens (effective ceiling:
    // 15 link-attaches/min per user, not 30):
    //   1. Here — gates the tick-context DB probe so an authenticated caller
    //      cannot enumerate tick UUIDs for free by watching which error code
    //      comes back (TICK_NOT_FOUND vs FORBIDDEN vs BETA_LINK_TICK_MISMATCH).
    //   2. Inside validateAndEnrichBetaLinkInsert — gates the cross-climb dedup
    //      probe and the outbound IG validation fetch.
    // Both burns are intentional. 15 link-attaches/min is well above legitimate
    // use; the two-token cost is a side effect of the gating architecture, not
    // a deliberate rate ceiling, but 15/min is still the effective limit.
    await applyRateLimit(ctx, 30, 'beta-link-validation');
    const tickContext = await resolveBetaLinkTickContext({ ...validated, link: normalizedLink }, userId);

    // Validation runs first — it's an outbound HTTP fetch we don't want to
    // hold a DB connection open for. attachBetaLink is a deliberate user
    // action so a same-climb video dup is fatal (the user gets the
    // friendly "already linked" message); cross-climb dup is also fatal.
    // The catch on the insert covers the rare case where validation passed
    // but the write fails (constraint, connection drop), surfacing an
    // explicit error rather than a generic toast.
    const betaPlan = await validateAndEnrichBetaLinkInsert(
      ctx,
      validated.boardType,
      validated.climbUuid,
      normalizedLink,
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
          link: normalizedLink,
          shortcode: getInstagramMediaId(normalizedLink),
          videoIdentity: betaLinkIdentity(normalizedLink),
          tickUuid: tickContext.tickUuid,
          boardId: tickContext.boardId,
          angle: tickContext.angle,
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

    const changedFields = Object.keys(validatedInput);
    logger.info(`[updateTick] user=${userId} tick=${uuid} fields=[${changedFields.join(',')}]`);

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (validatedInput.status !== undefined) updates.status = validatedInput.status;
    if (validatedInput.attemptCount !== undefined) updates.attemptCount = validatedInput.attemptCount;
    if (validatedInput.quality !== undefined) updates.quality = validatedInput.quality;
    if (validatedInput.difficulty !== undefined) updates.difficulty = validatedInput.difficulty;
    if (validatedInput.isBenchmark !== undefined) updates.isBenchmark = validatedInput.isBenchmark;
    if (validatedInput.comment !== undefined) updates.comment = validatedInput.comment;
    if (validatedInput.climbedAt !== undefined) updates.climbedAt = validatedInput.climbedAt;

    const finalStatus = validatedInput.status ?? existing[0].status;
    const finalAttemptCount = validatedInput.attemptCount ?? existing[0].attemptCount;
    if (finalStatus === 'flash' && finalAttemptCount !== 1) {
      logger.warn('[updateTick] Coerced flash tick attemptCount to 1', {
        tickUuid: uuid,
        userId,
        previousAttemptCount: finalAttemptCount,
      });
      updates.attemptCount = 1;
    }

    const [updated] = await db
      .update(dbSchema.boardseshTicks)
      .set(updates)
      .where(eq(dbSchema.boardseshTicks.uuid, uuid))
      .returning();

    // Status edits (attempt → send and back) flip whether this tick counts
    // toward ascensionist_count, and a quality/difficulty/comment edit can
    // also change downstream derived stats once we aggregate those. Recompute.
    queueClimbStatsRecompute(updated.boardType, updated.climbUuid, updated.angle);

    logger.info(
      `[updateTick] updated tick=${updated.uuid} user=${userId} ` +
        `${updated.boardType}/${updated.climbUuid.slice(0, 8)}/${updated.angle} status=${updated.status}`,
    );

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
