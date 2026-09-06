import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';
import { GraphQLError } from 'graphql';
import { betaLinkIdentity, type ConnectionContext, type TickStatus } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sessions } from '../../../db/schema';
import { applyRateLimit, requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { getConsensusDifficultyName } from '../shared/sql-expressions';
import {
  SaveTickInputSchema,
  UpdateTickInputSchema,
  AttachBetaLinkInputSchema,
  BOARD_ANGLE_VALIDATION_MESSAGE,
  isBoardAngleSupported,
  readTimestampFractionalSeconds,
} from '../../../validation/schemas';
import { resolveBoardFromPath } from '../social/boards';
import { boardConfigMatchesTick, findActiveBoardById } from '../board-presence/shared';
import { queueBoardStatsPublish } from '../board-presence/stats';
import { publishSocialEvent } from '../../../events';
import { publishDebouncedSessionStats } from '../sessions/debounced-stats-publisher';
import { queueClimbStatsRecompute, recomputeClimbStatsNow } from './debounced-climb-stats-publisher';
import { getInstagramMediaId, isInstagramUrl, normalizeBetaVideoUrl } from '../../../lib/instagram-meta';
import {
  InstagramBetaValidationError,
  validateInstagramBetaLink,
  type InstagramPageMetadata,
} from '../../../utils/instagram-beta-validation';
import { cacheInstagramThumbnail, isS3Configured } from '../../../lib/beta-link-thumbnails';
import { invalidateRecentBetaLinksCache } from '../beta-videos/queries';
import { resolveClimbCatalogPresence } from '../../../db/queries/climbs';
import { resolveMoonBoardTickAngle } from '@boardsesh/db/queries';
import { captureBackendEvent } from '../../../services/analytics/posthog';
import { logger } from '../../../utils/logger';
import { reconcileInferredSessions } from '../../../services/inferred-sessions/reconcile';
import {
  acquireUserTickMutationLock,
  isDirectAuroraTwin,
  isRealAuroraPullRow,
  notAuroraTwinDuplicate,
  resolveCanonicalClimbUuid,
} from '@boardsesh/db/queries';

type TickBoardLockDb = Pick<typeof db, 'execute'>;

type LockedTickBoard = {
  id: number | string;
  uuid: string;
  deletedAt: Date | string | null;
  mergedIntoBoardUuid: string | null;
};

export function buildTickBoardLockQuery(requestedBoardId: number) {
  return sql`
    WITH RECURSIVE requested_board AS (
      SELECT id, uuid, serial_number, merged_into_board_uuid
        FROM user_boards
       WHERE id = ${requestedBoardId}
    ),
    merge_chain AS (
      SELECT id, uuid, merged_into_board_uuid, 0 AS depth
        FROM requested_board
      UNION ALL
      SELECT next_board.id,
             next_board.uuid,
             next_board.merged_into_board_uuid,
             merge_chain.depth + 1
        FROM merge_chain
        JOIN user_boards next_board
          ON next_board.uuid = merge_chain.merged_into_board_uuid
       WHERE merge_chain.depth < 3
    ),
    candidate_ids AS (
      SELECT id FROM merge_chain
      UNION
      SELECT active_board.id
        FROM requested_board
        JOIN user_boards active_board
          ON active_board.serial_number = requested_board.serial_number
         AND active_board.serial_number IS NOT NULL
         AND active_board.serial_number <> ''
         AND active_board.deleted_at IS NULL
       WHERE requested_board.serial_number IS NOT NULL
         AND requested_board.serial_number <> ''
    )
    SELECT board.id AS "id",
           board.uuid AS "uuid",
           board.deleted_at AS "deletedAt",
           board.merged_into_board_uuid AS "mergedIntoBoardUuid"
      FROM user_boards board
      JOIN candidate_ids ON candidate_ids.id = board.id
     ORDER BY board.id
     FOR NO KEY UPDATE OF board
  `;
}

/**
 * Pin a tick's board association against the serial-board dedupe transaction.
 *
 * The maintenance merge locks every board in a serial cluster in id order,
 * moves existing ticks, tombstones the losers, then commits. Merely relying on
 * the tick FK's later KEY SHARE lock leaves a gap: saveTick can resolve an
 * active loser before the merge, wait behind the merge during INSERT, and then
 * insert onto the loser after the one-time repoint has already run.
 *
 * Locking the complete same-serial set here, in the same deterministic order as
 * the merge, closes that gap without introducing a lock-order inversion. The
 * NO KEY UPDATE mode still conflicts with the merge's UPDATE/DELETE locks but
 * deliberately permits unrelated FK KEY SHARE checks, which may visit several
 * boards in caller order. If we win the lock, the tick commits before the merge
 * and is repointed with the rest. If the merge wins, this query resumes against
 * its committed tombstone and we follow the (bounded, flattened) chain to the
 * locked survivor.
 */
export async function lockCanonicalTickBoardId(
  transactionDb: TickBoardLockDb,
  requestedBoardId: number,
): Promise<number | null> {
  const lockedBoards = rowsFromResult<LockedTickBoard>(
    await transactionDb.execute(buildTickBoardLockQuery(requestedBoardId)),
  );

  const requestedBoard = lockedBoards.find((board) => Number(board.id) === requestedBoardId);
  if (!requestedBoard) return null;
  if (requestedBoard.deletedAt === null) return Number(requestedBoard.id);

  const boardsByUuid = new Map(lockedBoards.map((board) => [board.uuid, board]));
  let nextBoardUuid = requestedBoard.mergedIntoBoardUuid;
  for (let hop = 0; hop < 3 && nextBoardUuid; hop++) {
    const candidate = boardsByUuid.get(nextBoardUuid);
    if (!candidate) {
      logger.warn(
        `[saveTick] merged board ${requestedBoardId} points outside its locked serial cluster at ${nextBoardUuid}`,
      );
      return null;
    }
    if (candidate.deletedAt === null) return Number(candidate.id);
    nextBoardUuid = candidate.mergedIntoBoardUuid;
  }

  if (nextBoardUuid) {
    logger.warn(`[saveTick] merged board ${requestedBoardId} exceeded the tombstone hop limit at ${nextBoardUuid}`);
  }
  return null;
}

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

/**
 * Log-only catalog check for an incoming tick (#3528).
 *
 * `SaveTickInputSchema.climbUuid` is `ExternalUUIDSchema` — a 1-50 character
 * string, not even a UUID shape — and `boardsesh_ticks` has no FK to
 * `board_climbs`, so a tick can name a climb that does not exist. The permanent
 * damage that used to cause (a phantom `board_climb_stats` row, minted by the
 * recompute's defensive seed) is fixed at the seed itself in
 * `@boardsesh/db/queries` recomputeClimbStats, which covers every tick writer.
 *
 * This is the observation half, and it deliberately does NOT reject. Every
 * client-held climb UUID is believed to originate from `board_climbs`, so a
 * rejection should never fire on a real send — but a non-retryable GraphQL error
 * dead-letters immediately in the offline drainer, so being wrong about one path
 * costs a climber a send while being right only avoids a few junk rows. We take
 * the measurement first. #3942 flips this to a rejection once the counter has
 * held at zero over a real observation window; until then, log-only is the
 * finished state, not a half-finished one.
 *
 * The alias arm keeps the counter honest: the Kilter dedup path folds duplicate
 * catalog UUIDs into `board_climb_aliases` and writes no `board_climbs` row for
 * them, so an alias-borne tick is a legitimate send and must not read as a hit.
 *
 * Never throws: an observation must not be able to fail a real tick.
 */
async function reportTickClimbCatalogPresence(
  userId: string,
  boardType: string,
  climbUuid: string,
  angle: number,
): Promise<void> {
  try {
    const presence = await resolveClimbCatalogPresence(boardType, climbUuid);
    if (presence !== 'unknown') return;

    logger.warn(
      `[saveTick] climb not in catalog — saving anyway (#3528): ${boardType}/${climbUuid} angle=${angle} user=${userId}`,
    );
    captureBackendEvent('Tick Climb Not In Catalog', {
      distinctId: userId,
      // climbUuid rides along so the counter is triageable on its own. "12 hits"
      // means nothing until you know whether it's 12 climbs or one client
      // looping on one bad UUID — and that distinction is the answer #3942 needs.
      // Not PII: a catalog identifier, and the same value the warn log carries.
      properties: { boardType, angle, climbUuid },
      processPersonProfile: false,
    });
  } catch (error) {
    logger.error('[saveTick] climb catalog presence check failed:', error);
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
const crossClimbDupMessage = (
  otherClimbName: string,
  existingBoardType: string,
  requestedBoardType: string,
): string => {
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
    throw new InstagramBetaValidationError(
      crossClimbDupMessage(conflict.climbName, conflict.existingBoardType, boardType),
    );
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

function tickResult(tick: dbSchema.BoardseshTick): Record<string, unknown> {
  return {
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
}

const auroraMutationTwin = aliasedTable(dbSchema.boardseshTicks, 'aurora_mutation_twin');

type TickMutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Convert a client timestamp to the UTC wall-clock text PostgreSQL stores for
 * `timestamp without time zone`, without serializing its fraction through a
 * JavaScript Date.
 *
 * JavaScript Dates retain milliseconds only.  They are still useful for
 * resolving a numeric UTC offset, but their formatted fraction must never be
 * used here: a client is allowed to supply PostgreSQL's full six digits.
 *
 * The fraction is read with the same pattern the validator uses, so a shape it
 * fails to recognise can't be one that already passed the six-digit refine.
 * Callers must validate first; the slice is belt-and-braces against a caller
 * that forgets and would otherwise hand PostgreSQL a fraction it silently
 * rounds.
 */
function normalizeClimbedAt(value: string): string {
  const parsed = new Date(value);
  const utcDate = [
    String(parsed.getUTCFullYear()).padStart(4, '0'),
    String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    String(parsed.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const utcTime = [
    String(parsed.getUTCHours()).padStart(2, '0'),
    String(parsed.getUTCMinutes()).padStart(2, '0'),
    String(parsed.getUTCSeconds()).padStart(2, '0'),
  ].join(':');
  const utcSecond = `${utcDate}T${utcTime}`;
  const fractionalSeconds = readTimestampFractionalSeconds(value)?.slice(0, 6);

  return fractionalSeconds ? `${utcSecond}.${fractionalSeconds}Z` : `${utcSecond}.000Z`;
}

/**
 * Resolve the exact rows an authenticated tick mutation may affect.
 *
 * Lock order is global and shared by update/delete: per-user advisory lock,
 * addressed row, then direct twins ordered by UUID. The target expands only
 * when it is the currently visible, real Aurora-pull survivor. Hidden/stale
 * UUIDs and every non-Aurora origin deliberately retain single-row semantics.
 * A group is also refused when its pairwise witnesses would join two different
 * real Kilter ids through a NULL-link hub: those are distinct upstream facts.
 */
async function selectTickMutationGroupForUpdate(
  tx: TickMutationTransaction,
  uuid: string,
  userId: string,
  action: 'update' | 'delete',
): Promise<dbSchema.BoardseshTick[]> {
  const [targetResult] = await tx
    .select({
      tick: dbSchema.boardseshTicks,
      isVisible: sql<boolean>`${notAuroraTwinDuplicate(dbSchema.boardseshTicks)}`,
      isRealAuroraPull: sql<boolean>`${isRealAuroraPullRow(dbSchema.boardseshTicks)}`,
    })
    .from(dbSchema.boardseshTicks)
    .where(eq(dbSchema.boardseshTicks.uuid, uuid))
    .for('update');

  if (!targetResult) {
    throw new GraphQLError('Tick not found', { extensions: { code: 'TICK_NOT_FOUND' } });
  }
  if (targetResult.tick.userId !== userId) {
    const message = action === 'delete' ? 'You can only delete your own ticks' : 'Not authorized to update this tick';
    throw new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
  }

  if (!targetResult.isVisible || !targetResult.isRealAuroraPull) return [targetResult.tick];

  // Directional and pairwise on purpose: the addressed target must itself be
  // the smaller witness for every member. Never walk through a middle row.
  const directTwins = await tx
    .select({ tick: auroraMutationTwin })
    .from(auroraMutationTwin)
    .innerJoin(dbSchema.boardseshTicks, eq(dbSchema.boardseshTicks.uuid, uuid))
    .where(isDirectAuroraTwin(dbSchema.boardseshTicks, auroraMutationTwin))
    .orderBy(auroraMutationTwin.uuid)
    .for('update');

  const mutationGroup = [targetResult.tick, ...directTwins.map((row) => row.tick)];
  const kilterIds = new Set(mutationGroup.flatMap((tick) => (tick.kilterId ? [tick.kilterId] : [])));

  // `isDirectAuroraTwin` intentionally permits one NULL Kilter link. That is
  // safe pairwise, but a NULL target can individually witness two different
  // real links. Do not turn that V shape into one mutable logical ascent.
  if (kilterIds.size > 1) return [targetResult.tick];

  return mutationGroup;
}

function distinctTickStatsKeys(ticks: dbSchema.BoardseshTick[]): Array<{
  boardType: string;
  climbUuid: string;
  angle: number;
}> {
  const keys = new Map<string, { boardType: string; climbUuid: string; angle: number }>();
  for (const tick of ticks) {
    keys.set(`${tick.boardType}\u0000${tick.climbUuid}\u0000${tick.angle}`, {
      boardType: tick.boardType,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
    });
  }
  return [...keys.values()];
}

function distinctTickSessions(ticks: dbSchema.BoardseshTick[]): string[] {
  return [...new Set(ticks.flatMap((tick) => (tick.sessionId ? [tick.sessionId] : [])))];
}

function distinctTickBoards(ticks: dbSchema.BoardseshTick[]): Array<{ boardId: number; boardType: string }> {
  const boards = new Map<number, string>();
  for (const tick of ticks) {
    if (tick.boardId != null) boards.set(tick.boardId, tick.boardType);
  }
  return [...boards].map(([boardId, boardType]) => ({ boardId, boardType }));
}

export const tickMutations = {
  /**
   * Delete a tick (climb attempt/ascent) for the authenticated user.
   * Only the owner can delete their own ticks.
   */
  deleteTick: async (_: unknown, { uuid }: { uuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const mutationResult = await db.transaction(async (tx) => {
      await acquireUserTickMutationLock(tx, userId);
      const affectedTicks = await selectTickMutationGroupForUpdate(tx, uuid, userId, 'delete');
      const affectedUuids = affectedTicks.map((tick) => tick.uuid);

      // Collect comment IDs across the logical ascent so their notifications
      // are removed before the comments themselves.
      const tickComments = await tx
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(and(eq(dbSchema.comments.entityType, 'tick'), inArray(dbSchema.comments.entityId, affectedUuids)));
      const commentIds = tickComments.map((c) => c.id);

      // Delete notifications referencing these comments (commentId FK is SET NULL, so we must delete explicitly)
      if (commentIds.length > 0) {
        await tx.delete(dbSchema.notifications).where(inArray(dbSchema.notifications.commentId, commentIds));
      }

      // Delete related social data for the tick itself
      await tx
        .delete(dbSchema.feedItems)
        .where(and(eq(dbSchema.feedItems.entityType, 'tick'), inArray(dbSchema.feedItems.entityId, affectedUuids)));
      await tx
        .delete(dbSchema.votes)
        .where(and(eq(dbSchema.votes.entityType, 'tick'), inArray(dbSchema.votes.entityId, affectedUuids)));
      await tx
        .delete(dbSchema.voteCounts)
        .where(and(eq(dbSchema.voteCounts.entityType, 'tick'), inArray(dbSchema.voteCounts.entityId, affectedUuids)));
      await tx
        .delete(dbSchema.comments)
        .where(and(eq(dbSchema.comments.entityType, 'tick'), inArray(dbSchema.comments.entityId, affectedUuids)));
      await tx
        .delete(dbSchema.notifications)
        .where(
          and(eq(dbSchema.notifications.entityType, 'tick'), inArray(dbSchema.notifications.entityId, affectedUuids)),
        );
      // Detach explicitly instead of relying only on ON DELETE SET NULL, so a
      // successful-ascent beta disappearing from its tick invalidates the
      // 24-hour recent-beta cache after commit.
      const detachedBetaLinks = await tx
        .update(dbSchema.boardBetaLinks)
        .set({ tickUuid: null })
        .where(inArray(dbSchema.boardBetaLinks.tickUuid, affectedUuids))
        .returning({ link: dbSchema.boardBetaLinks.link });

      // The trigger writes one offline tombstone per UUID.
      await tx.delete(dbSchema.boardseshTicks).where(inArray(dbSchema.boardseshTicks.uuid, affectedUuids));

      const sessionIds = distinctTickSessions(affectedTicks);
      if (sessionIds.length > 0) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(inArray(sessions.id, sessionIds));
      }

      // Removing a climb can split a run in two or empty a session outright, so the
      // window around each deleted tick is redrawn. Deduped by timestamp because a
      // logical ascent's rows share one climbed_at and would otherwise reconcile the
      // same window repeatedly.
      for (const climbedAt of new Set(affectedTicks.map((tick) => tick.climbedAt))) {
        await reconcileInferredSessions(tx, userId, new Date(climbedAt));
      }

      return { affectedTicks, detachedBetaLinks: detachedBetaLinks.length > 0 };
    });

    const { affectedTicks: deletedTicks, detachedBetaLinks } = mutationResult;

    const targetTick = deletedTicks.find((tick) => tick.uuid === uuid)!;
    logger.info(
      `[deleteTick] user=${userId} tick=${uuid} ${targetTick.boardType}/${targetTick.climbUuid.slice(0, 8)}/${targetTick.angle} rows=${deletedTicks.length}`,
    );

    for (const key of distinctTickStatsKeys(deletedTicks)) {
      queueClimbStatsRecompute(key.boardType, key.climbUuid, key.angle);
    }
    if (detachedBetaLinks) {
      invalidateRecentBetaLinksCache().catch((err) => {
        logger.error('[deleteTick] recent-beta-links cache invalidation failed:', err);
      });
    }

    for (const { boardId, boardType } of distinctTickBoards(deletedTicks)) {
      queueBoardStatsPublish(boardId, boardType);
    }
    for (const sessionId of distinctTickSessions(deletedTicks)) {
      publishDebouncedSessionStats(sessionId);
    }

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
    const uuid = validatedInput.uuid ?? uuidv4();
    const now = new Date().toISOString();
    const climbedAt = normalizeClimbedAt(validatedInput.climbedAt);

    if (validatedInput.uuid) {
      const [existingTick] = await db
        .select()
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.uuid, validatedInput.uuid))
        .limit(1);

      if (existingTick) {
        if (existingTick.userId !== userId) {
          throw new GraphQLError('Tick UUID is already in use', {
            extensions: { code: 'TICK_UUID_CONFLICT' },
          });
        }
        return tickResult(existingTick);
      }
    }

    // Observation only — never rejects, never throws. See the function's docs.
    //
    // Started here but settled after the insert below, so its lookup overlaps
    // the board/session resolution and the transaction instead of adding a
    // serial round-trip to the hot path. Deliberately not fire-and-forget:
    // settling it keeps the counter deterministic, so a test can assert the
    // event fired — or, more to the point, that it did NOT fire for a
    // deduped-away alias UUID. It self-catches, so awaiting it cannot fail the
    // tick.
    //
    // The event fires from inside the helper the moment the probe resolves —
    // it is NOT conditional on the tick going on to commit. That is the
    // intended reading: what's being counted is "a client sent a climb_uuid the
    // catalog has never heard of", which is equally true whether the tick then
    // succeeded or failed on something unrelated (a beta-link rejection, a
    // constraint violation). A UUID we can't resolve is worth knowing about
    // either way, so #3942 should read a hit as "this client sent an unknown
    // UUID", not "an unknown-UUID tick was saved".
    //
    // Consequently, if something between here and the await throws, the promise
    // is simply no longer awaited — it still runs to completion on its own, and
    // the event may already have fired. Nothing leaks: the helper never
    // rejects, so an un-awaited promise cannot surface as an unhandled
    // rejection.
    const catalogPresenceReport = reportTickClimbCatalogPresence(
      userId,
      validatedInput.boardType,
      validatedInput.climbUuid,
      validatedInput.angle,
    );

    // Land the tick on the CANONICAL climb, not on whatever UUID the client
    // happened to be holding. Dedup migrations retire catalog UUIDs and record
    // the mapping in board_climb_aliases, but a phone carries an offline board
    // catalog and only learns a climb was retired on its next pull — so a send
    // logged from a stale catalog, or replayed by the offline drainer, arrives
    // naming a retired UUID. Stored verbatim it is stranded: every read path
    // resolves alias -> canonical FORWARD (get-climb.ts, web queries.ts), never
    // tick -> canonical backward, so the ascent never reaches the canonical's
    // board_climb_stats and never shows on the climb page, while the recompute
    // seeds a fresh stats row under the retired UUID.
    //
    // The lookup is a primary-key hit on (board_type, alias_uuid) and a miss
    // returns the input unchanged, so a non-aliased climb pays one index probe
    // and nothing else. A DB error propagates rather than falling back — that is
    // resolveCanonicalClimbUuid's documented contract, and it is the right call
    // here: a silent fallback would let a wave of ticks land on retired rows,
    // which is the failure this resolves.
    //
    // Resolved BEFORE the angle snap below on purpose: the angle resolution
    // reads the catalog rows for the climb the tick will actually land on, and
    // a retired alias row is delisted with its per-angle grades merged away —
    // probing it would resolve against a husk. Costs one serialized PK probe
    // before the angle query can start.
    //
    // updateTick needs no counterpart: UpdateTickInputSchema carries no
    // climbUuid, so an edit can never move a tick to a different climb.
    const climbUuid = await resolveCanonicalClimbUuid(db, validatedInput.boardType, validatedInput.climbUuid);

    // Which angle this tick actually belongs at (#3529). Started here, next to
    // the catalog probe, so it overlaps the board/session round-trips below;
    // awaited immediately before the transaction because the insert needs the
    // answer. Non-MoonBoard ticks resolve instantly with no query at all.
    //
    // Deliberately NOT folded into the probe above: the probe reports what the
    // CLIENT sent (an observation of the client, per #3528/#3942) and must keep
    // reporting the client's angle — and the client's uuid — even when we then
    // move the tick.
    const effectiveAnglePromise = resolveMoonBoardTickAngle(db, {
      boardType: validatedInput.boardType,
      climbUuid,
      requestedAngle: validatedInput.angle,
      onError: (error) => logger.error('[saveTick] moonboard tick angle resolution failed:', error),
    });

    // A stale/unknown sessionId (session ended, or never existed on this
    // backend — e.g. an offline-replayed tick) would otherwise FK-violate the
    // insert and lose the whole tick (#2386). Same best-effort drop-the-ref
    // trade-off as the board resolution below; no ownership check, since
    // party-mode ticks legitimately reference sessions other users made.
    // Resolved BEFORE the board, so the session's own board can disambiguate a
    // legacy config tick (rung 3).
    let resolvedSessionId: string | null = null;
    let sessionBoardId: number | null = null;
    if (validatedInput.sessionId) {
      const [session] = await db
        .select({ id: dbSchema.boardSessions.id, boardId: dbSchema.boardSessions.boardId })
        .from(dbSchema.boardSessions)
        .where(eq(dbSchema.boardSessions.id, validatedInput.sessionId))
        .limit(1);

      if (session) {
        resolvedSessionId = session.id;
        sessionBoardId = session.boardId;
      } else {
        logger.warn(`[saveTick] Dropping stale sessionId ${validatedInput.sessionId} — session not found`);
      }
    }

    // Resolve the tick's board_id. Four rungs, most specific first:
    //  1. boardUuid — a named-board route (`/b/<slug>/...`); attaches to that
    //     exact board entity even when the climber doesn't own it (e.g. a
    //     seeded gym board owned by the system user). Config-gated exactly like
    //     rungs 2 and 3, so knowing a uuid isn't enough to stamp a tick onto
    //     another board's stats (#4219). A merged loser UUID is canonicalised
    //     below. Best-effort otherwise: an unknown uuid, an ordinary
    //     soft-delete, a config mismatch, or an input carrying no
    //     layout/size/set all record the tick unassociated rather than rejecting
    //     it, and none of them fall back to config resolution.
    //  2. boardId — the board-presence connected wall (resolveBoardForSerial),
    //     flag-gated. On a stale/mismatched id we warn and fall back to the
    //     config lookup rather than surfacing a raw FK/type mismatch.
    //  3. the session's board — a session is held on one physical wall, so a
    //     tick logged into it belongs to that wall. Config-gated exactly like
    //     rung 2, and deliberately not ownership-gated: in party mode the
    //     session names someone else's board, and that board is still the wall
    //     the climber is standing at.
    //  4. the legacy `/[board_name]/[layout_id]/...` config lookup, which names
    //     a configuration rather than a board; it takes the owner's lowest-id
    //     board with that config.
    let boardId: number | null = null;
    let boardAssociationSource: 'boardUuid' | 'explicitBoardId' | 'config' | null = null;
    if (validatedInput.boardUuid) {
      boardAssociationSource = 'boardUuid';
      const [board] = await db
        .select({
          id: dbSchema.userBoards.id,
          boardType: dbSchema.userBoards.boardType,
          layoutId: dbSchema.userBoards.layoutId,
          sizeId: dbSchema.userBoards.sizeId,
          setIds: dbSchema.userBoards.setIds,
        })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.uuid, validatedInput.boardUuid),
            or(isNull(dbSchema.userBoards.deletedAt), isNotNull(dbSchema.userBoards.mergedIntoBoardUuid)),
          ),
        )
        .limit(1);

      // An ordinary soft-delete or unknown UUID is deliberately absent here;
      // record the tick without a board association rather than rejecting it.
      // A merge tombstone supplies its id so the transaction lock below can
      // follow it safely. board_id is nullable (onDelete: 'set null') so an
      // unresolved uuid is always valid. Same for a config mismatch: knowing a
      // board's uuid must not be enough to add a tick to a wall the climber
      // wasn't on (#4219).
      if (board && boardConfigMatchesTick(board, validatedInput)) {
        boardId = board.id;
      } else if (board) {
        // Two different reasons to land here, and they mean different things in
        // production triage: a client that sends no config at all is a client
        // to go fix, a real mismatch is a stale uuid or a pollution attempt.
        const hasConfig =
          validatedInput.layoutId != null && validatedInput.sizeId != null && Boolean(validatedInput.setIds);
        logger.warn(
          hasConfig
            ? `[saveTick] Ignoring tick boardUuid ${validatedInput.boardUuid} — config mismatch for ${validatedInput.boardType}/${validatedInput.layoutId}/${validatedInput.sizeId}/${validatedInput.setIds}`
            : `[saveTick] Ignoring tick boardUuid ${validatedInput.boardUuid} — input carries no layout/size/set to match against`,
        );
      }
    } else if (validatedInput.boardId != null) {
      const explicitBoard = await findActiveBoardById(validatedInput.boardId);
      // Accept the explicit wall board only when its FULL config matches the
      // tick's target (type + layout + size + set). A stale presence boardId
      // from a different layout/size/set would otherwise stamp this tick onto
      // the wrong wall and corrupt that board's presence stats.
      if (explicitBoard && boardConfigMatchesTick(explicitBoard, validatedInput)) {
        boardId = explicitBoard.id;
        boardAssociationSource = 'explicitBoardId';
      } else {
        logger.warn(
          `[board-presence] Ignoring tick boardId ${validatedInput.boardId} — config mismatch for ${validatedInput.boardType}`,
        );
      }
    }

    // Rung 3: the wall the session is being held on. This is what tells two
    // same-config boards apart — since #4174 an owner can have the same wall at
    // home and at a gym, and the config lookup below cannot see which one the
    // climber is at, while the session can.
    if (
      boardId == null &&
      !validatedInput.boardUuid &&
      sessionBoardId != null &&
      validatedInput.layoutId &&
      validatedInput.sizeId &&
      validatedInput.setIds
    ) {
      const sessionBoard = await findActiveBoardById(sessionBoardId);
      // Same full-config gate as rung 2: a session left open on another wall
      // must not stamp this tick onto it.
      if (sessionBoard && boardConfigMatchesTick(sessionBoard, validatedInput)) {
        boardId = sessionBoard.id;
      }
    }

    // Rung 4: legacy `/[board_name]/[layout_id]/...` route (no specific board
    // entity), plus the fallback when a board-presence boardId or the session's
    // board didn't match. A best-effort boardUuid that resolved to nothing is
    // intentionally left unassociated (handled above), so it does not fall
    // through to here.
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
      if (boardId !== null) boardAssociationSource = 'config';
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
      ? await validateAndEnrichBetaLinkInsert(ctx, validatedInput.boardType, climbUuid, attachedVideoUrl, {
          onSameClimbDup: 'skip',
          onCrossBoardDup: 'skip',
        })
      : { action: 'no-url' };

    // Settle the angle resolution started before the board/session lookups — the
    // insert below needs it. By now it has overlapped every round-trip since.
    //
    // The snap is only REPORTED after the transaction commits (below), never
    // here. Unlike the #3528 catalog probe — which counts what the client sent
    // and is deliberately independent of the tick surviving — this counter
    // measures ticks we actually moved, so it must not fire for a tick that
    // never landed: a concurrent replay of the same uuid (onConflictDoNothing
    // no-op) or a transaction that rolls back would otherwise each inflate it.
    const effectiveAngle = await effectiveAnglePromise;

    // Insert into database. When the client supplied a uuid that already exists
    // (offline replay), the insert is a no-op and `createdTick` is undefined —
    // we detect that, return the original row, and skip every side effect below.
    const [tick] = await db.transaction(
      async (tx) => {
        // Re-lock and canonicalise the association immediately before INSERT.
        // Board resolution above intentionally stays outside this transaction so
        // its network/catalog work does not lengthen the row-lock hold time.
        const lockedBoardId = boardId === null ? null : await lockCanonicalTickBoardId(tx, boardId);
        const boardAssociationBecameUnavailable = boardId !== null && lockedBoardId === null;
        const [createdTick] = await tx
          .insert(dbSchema.boardseshTicks)
          .values({
            uuid,
            userId,
            boardType: validatedInput.boardType,
            climbUuid,
            // The angle this tick actually belongs at (#3529), resolved before
            // the transaction opened so the lock below stays short. The snap is
            // reported after the commit, off the RETURNING row.
            angle: effectiveAngle,
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
            sessionId: resolvedSessionId,
            boardId: lockedBoardId,
            // Aurora sync fields are null - will be populated by periodic sync job
            auroraType: null,
            auroraId: null,
            auroraSyncedAt: null,
            auroraSyncError: null,
          })
          .onConflictDoNothing({
            target: dbSchema.boardseshTicks.uuid,
          })
          .returning();

        if (!createdTick) return [];

        if (boardAssociationBecameUnavailable) {
          // The board was valid when we resolved it above, but a concurrent
          // delete or dangling tombstone chain won the canonical row lock. Keep
          // the valid tick and deliberately leave its nullable association empty;
          // falling back to config here could stamp it onto a different wall.
          // Emit only after a new row was returned: a concurrent idempotent replay
          // that won the UUID insert must not produce this warning for our no-op.
          logger.warn('[saveTick] Board association became unavailable; saving tick without board association', {
            tickUuid: uuid,
            userId,
            requestedBoardId: boardId,
            boardAssociationSource,
            boardType: validatedInput.boardType,
            climbUuid,
            angle: effectiveAngle,
          });
        }

        if (resolvedSessionId) {
          await tx.update(sessions).set({ lastActivity: new Date() }).where(eq(sessions.id, resolvedSessionId));
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
              climbUuid,
              link: attachedVideoUrl,
              shortcode: getInstagramMediaId(attachedVideoUrl),
              videoIdentity: betaLinkIdentity(attachedVideoUrl),
              tickUuid: createdTick.uuid,
              boardId: createdTick.boardId,
              // The beta row's angle must move with the tick: the mobile home feed
              // opens the video at THIS angle, so a beta pinned to 25° on a
              // 40°-graded problem opens a page the problem isn't graded at. Same
              // reasoning as the updateTick beta-angle move below.
              angle: effectiveAngle,
              isListed: true,
              thumbnail: betaPlan.thumbnail,
              foreignUsername: betaPlan.foreignUsername,
              createdAt: now,
              createdByUserId: userId,
            })
            .onConflictDoNothing();
        }

        // Group this climb into the session it belongs to, inside the same
        // transaction so the tick and its assignment commit together. Inert unless
        // INFERRED_SESSIONS_ENABLED is set. A tick that already carries an explicit
        // session still goes through, because the run around it may need redrawing.
        await reconcileInferredSessions(tx, userId, new Date(createdTick.climbedAt));

        return [createdTick];
      },
      { isolationLevel: 'read committed' },
    );

    // Settle the catalog observation started before the board/session lookups.
    // By now it has overlapped every round-trip above, so this is a no-op wait
    // in practice — it exists so the counter is deterministic. Placed before
    // the early returns below so it covers every path that saves a tick.
    await catalogPresenceReport;

    if (!tick) {
      const [existingTick] = await db
        .select()
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.uuid, uuid))
        .limit(1);
      if (existingTick?.userId === userId) return tickResult(existingTick);
      throw new GraphQLError('Tick UUID is already in use', {
        extensions: { code: 'TICK_UUID_CONFLICT' },
      });
    }

    // Report the #3529 snap only now — past the commit and past the
    // "already existed, nothing was written" return above, so this row provably
    // landed. Compared and reported off `tick.angle` (the RETURNING value)
    // rather than the local, so the log and the counter can only ever say what
    // the database actually holds.
    if (tick.angle !== validatedInput.angle) {
      logger.warn(
        `[saveTick] moonboard tick angle snapped to the climb's graded angle (#3529): ` +
          `${validatedInput.boardType}/${validatedInput.climbUuid} requested=${validatedInput.angle} ` +
          `effective=${tick.angle} user=${userId}`,
      );
      // Mirrors the Tick Climb Not In Catalog counter: if this stays hot, a
      // client surface is sending the wrong angle and that client wants fixing
      // too. Counting USERS (distinctId) keeps one looping client from reading
      // as a fleet-wide problem.
      captureBackendEvent('MoonBoard Tick Angle Snapped', {
        distinctId: userId,
        properties: {
          climbUuid: validatedInput.climbUuid,
          requestedAngle: validatedInput.angle,
          effectiveAngle: tick.angle,
        },
        processPersonProfile: false,
      });
    }

    // Bust the home-strip cache so newly-attached beta links surface on the
    // next read. Skip when the tick path didn't insert (no video URL, or
    // same-climb dup that was silently skipped) so we don't churn the cache
    // for the common "just logging an attempt" case.
    if (attachedVideoUrl && betaPlan.action === 'insert') {
      invalidateRecentBetaLinksCache().catch((err) => {
        logger.error('[saveTick] recent-beta-links cache invalidation failed:', err);
      });
    }

    const result = tickResult(tick);

    // Publish ascent.logged event for feed fan-out (only for successful ascents)
    if (tick.status === 'flash' || tick.status === 'send') {
      // Fire-and-forget with retry: don't block the response on event publishing
      publishAscentEvent(tick, userId, tick.boardId).catch(() => {
        // Final failure already logged inside publishAscentEvent
      });
    }

    // Publish live session stats updates for active party sessions (debounced, non-blocking).
    if (tick.sessionId) {
      publishDebouncedSessionStats(tick.sessionId);
    }

    // Recompute board_climb_stats for this climb so the ascent count, grade and
    // FA fields stay in sync with boardsesh_ticks. Runs twice on purpose. The
    // inline pass lands first because clients invalidate their climb lists the
    // moment this mutation resolves, and that refetch would otherwise beat the
    // 2s debounce to the row — reading a stats row that is missing or ungraded
    // at an angle this tick just introduced (#4798). The debounced pass still
    // runs: it coalesces bursts of saves on the same climb and owns the
    // canonical climbStatsUpdated publish. The recompute is keyed on the stats
    // primary key and idempotent, so doing it twice is cheap and safe.
    await recomputeClimbStatsNow(tick.boardType, tick.climbUuid, tick.angle);
    queueClimbStatsRecompute(tick.boardType, tick.climbUuid, tick.angle);

    // Board presence: a tick on a connected wall changes that wall's durable
    // stats (sends / climbers / hardest / top grade). Push the freshly
    // recomputed snapshot over the board's live `boardNowPlaying` feed so every
    // watcher's stat tiles update without re-fetching. Debounced per board so a
    // burst of logs collapses into one recompute+publish and so concurrent
    // ticks can't pair a stale snapshot with a higher seq. Runs after the tick
    // has committed (the recompute sees it) and self-guards, so a presence push
    // can never fail the tick that triggered it.
    if (tick.boardId != null) {
      queueBoardStatsPublish(tick.boardId, tick.boardType);
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
    const canonicalClimbedAt =
      validatedInput.climbedAt === undefined ? undefined : normalizeClimbedAt(validatedInput.climbedAt);

    const changedFields = Object.keys(validatedInput);
    logger.info(`[updateTick] user=${userId} tick=${uuid} fields=[${changedFields.join(',')}]`);

    const mutationResult = await db.transaction(async (tx) => {
      await acquireUserTickMutationLock(tx, userId);
      const existingTicks = await selectTickMutationGroupForUpdate(tx, uuid, userId, 'update');
      const targetTick = existingTicks.find((tick) => tick.uuid === uuid)!;
      const affectedUuids = existingTicks.map((tick) => tick.uuid);

      if (!isBoardAngleSupported(targetTick.boardType, validatedInput.angle)) {
        throw new GraphQLError(BOARD_ANGLE_VALIDATION_MESSAGE, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const updates: Partial<typeof dbSchema.boardseshTicks.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (validatedInput.status !== undefined) updates.status = validatedInput.status;
      if (validatedInput.attemptCount !== undefined) updates.attemptCount = validatedInput.attemptCount;
      if (validatedInput.quality !== undefined) updates.quality = validatedInput.quality;
      if (validatedInput.difficulty !== undefined) updates.difficulty = validatedInput.difficulty;
      if (validatedInput.isBenchmark !== undefined) updates.isBenchmark = validatedInput.isBenchmark;
      if (validatedInput.comment !== undefined) updates.comment = validatedInput.comment;
      if (canonicalClimbedAt !== undefined) updates.climbedAt = canonicalClimbedAt;
      // Angle edits go through the same #3529 resolution as saveTick, against the
      // tick's OWN climb — an edit to 25° on a 40°-graded MoonBoard problem would
      // otherwise strand the tick exactly the way a fresh save used to.
      //
      // Resolved here, REPORTED after the UPDATE lands (below) — the same stance
      // saveTick takes, so the counter means one thing at both call sites: ticks
      // we actually moved.
      //
      // KNOWN, and an open question rather than a settled design: this branch keys
      // off the field being PRESENT, not off it having changed, and the two shipped
      // clients disagree about that. Web's logbook edit
      // (packages/web/app/components/library/logbook-feed-item.tsx, handleSave)
      // omits `angle` entirely, so a web edit never resolves. Mobile's
      // LogbookEditSheet (packages/mobile/src/components/you/LogbookEditSheet.tsx)
      // puts the tick's CURRENT angle in every save, so any edit from that sheet —
      // comment-only included — resolves, and on a historical wrong-angle tick it
      // moves the tick and fires the counter. Tightening this to
      // `validatedInput.angle !== targetTick.angle` would make an unchanged angle
      // field behave like an absent one; that is a behaviour decision, deliberately
      // not taken here.
      if (validatedInput.angle !== undefined) {
        updates.angle = await resolveMoonBoardTickAngle(tx, {
          boardType: targetTick.boardType,
          climbUuid: targetTick.climbUuid,
          requestedAngle: validatedInput.angle,
          onError: (error) => logger.error('[updateTick] moonboard tick angle resolution failed:', error),
        });
      }

      const finalStatus = validatedInput.status ?? targetTick.status;
      const finalAttemptCount = validatedInput.attemptCount ?? targetTick.attemptCount;
      if (finalStatus === 'flash') {
        if (finalAttemptCount !== 1) {
          logger.warn('[updateTick] Coerced flash tick attemptCount to 1', {
            tickUuid: uuid,
            userId,
            previousAttemptCount: finalAttemptCount,
          });
        }
        // A locally edited survivor can directly hide rows whose editable
        // payload differs. Reassert the flash invariant across every member.
        updates.attemptCount = 1;
      }

      const updatedTicks = await tx
        .update(dbSchema.boardseshTicks)
        .set(updates)
        .where(inArray(dbSchema.boardseshTicks.uuid, affectedUuids))
        .returning();
      const updatedTarget = updatedTicks.find((tick) => tick.uuid === uuid)!;

      // This symmetry is a RUNTIME one only — do not assume the #3529 repair
      // migration matches it. the moonboard_wrong_angle_stats_cleanup migration's statement A updates boardsesh_ticks.angle and
      // nothing else, so a historical tick it moves keeps its beta pinned at the
      // pre-move angle until someone edits that tick's angle by hand and lands
      // here. Accepted deliberately on 2026-08-02 rather than widening a migration
      // that was already signed off; the reasoning is in that file's header.
      let movedBetaLinks = false;
      if (existingTicks.some((tick) => tick.angle !== updatedTarget.angle)) {
        const moved = await tx
          .update(dbSchema.boardBetaLinks)
          .set({ angle: updatedTarget.angle })
          .where(inArray(dbSchema.boardBetaLinks.tickUuid, affectedUuids))
          .returning({ link: dbSchema.boardBetaLinks.link });
        movedBetaLinks = moved.length > 0;
      }

      const sessionIds = distinctTickSessions(existingTicks);
      if (sessionIds.length > 0) {
        await tx.update(sessions).set({ lastActivity: new Date() }).where(inArray(sessions.id, sessionIds));
      }

      // An edit can move climbed_at, which moves the tick between runs — so both the
      // window it left and the one it joined need redrawing. Reconciling the old
      // timestamp first leaves the tick's new home authoritative.
      for (const climbedAt of new Set([
        ...existingTicks.map((tick) => tick.climbedAt),
        ...updatedTicks.map((tick) => tick.climbedAt),
      ])) {
        await reconcileInferredSessions(tx, userId, new Date(climbedAt));
      }

      return { existingTicks, updatedTicks, updatedTarget, movedBetaLinks };
    });

    // Both the key the tick left and the key it joined, so an angle edit doesn't
    // strand a stale bucket. Inline first for the same reason as saveTick: the
    // client's refetch races the 2s debounce, and after an angle move the new
    // key may have no stats row at all yet (#4798). The keys are distinct rows,
    // each recompute is its own transaction, so they run concurrently: both
    // must finish before the response, but the wall-clock cost is the slower
    // of the two rather than their sum.
    const touchedStatsKeys = distinctTickStatsKeys([...mutationResult.existingTicks, ...mutationResult.updatedTicks]);
    await Promise.all(touchedStatsKeys.map((key) => recomputeClimbStatsNow(key.boardType, key.climbUuid, key.angle)));
    for (const key of touchedStatsKeys) {
      queueClimbStatsRecompute(key.boardType, key.climbUuid, key.angle);
    }
    if (mutationResult.movedBetaLinks) {
      invalidateRecentBetaLinksCache().catch((err) => {
        logger.error('[updateTick] recent-beta-links cache invalidation failed:', err);
      });
    }
    for (const { boardId, boardType } of distinctTickBoards(mutationResult.updatedTicks)) {
      queueBoardStatsPublish(boardId, boardType);
    }
    for (const sessionId of distinctTickSessions(mutationResult.existingTicks)) {
      publishDebouncedSessionStats(sessionId);
    }

    const updated = mutationResult.updatedTarget;

    // Report the #3529 snap only once the UPDATE has landed, off the RETURNING
    // row — the saveTick stance, applied here so one `MoonBoard Tick Angle
    // Snapped` event means the same thing whichever mutation emitted it. The
    // `angle !== undefined` guard keeps an edit that omits the field silent (the
    // web logbook edit's shape); an edit that carries the field reports whenever
    // the stored angle came back different, which includes the mobile sheet's
    // comment-only save on an already-stranded tick — see the note on the
    // resolve branch above.
    if (validatedInput.angle !== undefined && updated.angle !== validatedInput.angle) {
      logger.warn(
        `[updateTick] moonboard tick angle snapped to the climb's graded angle (#3529): ` +
          `tick=${uuid} requested=${validatedInput.angle} effective=${updated.angle} user=${userId}`,
      );
      captureBackendEvent('MoonBoard Tick Angle Snapped', {
        distinctId: userId,
        properties: {
          climbUuid: updated.climbUuid,
          requestedAngle: validatedInput.angle,
          effectiveAngle: updated.angle,
        },
        processPersonProfile: false,
      });
    }

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
