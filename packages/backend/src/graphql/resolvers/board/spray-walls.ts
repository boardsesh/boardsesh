import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  MAX_HOLDS_PER_WALL,
  MAX_SPRAY_WALLS_PER_USER,
  MAX_VERSIONS_PER_WALL,
  SPRAY_SET,
  spraySizeIdForLayout,
} from '@boardsesh/board-config';
// `aliveHolds` is ALWAYS called with an explicit version number here, never in
// its no-version form. The no-version form means "alive at the wall's
// `current_version_id`", which is the right answer for a climber and the wrong one
// for the hold editor: a draft's own additions and removals are invisible to it
// until `publishSprayWallVersion`. Passing the version number makes each read say
// which generation it means, so neither reading is accidental.
import { allocateHoldIds, allocateWallIds, aliveHolds, createSprayWallCatalogueRows } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { enrichBoards, generateUniqueSlug, requireBoardEditAccess } from '../social/boards';
import { requireBoardGymLinkAccess } from '../social/gyms';
import { syncLocationGeography } from '../social/location-geography';
import {
  boundingSize,
  homographyFromAnchors,
  IDENTITY_HOMOGRAPHY,
  isValidAnchorQuad,
  type Quad,
} from '../../../lib/spray-wall-homography';
import {
  SPRAY_PHOTO_HEIGHT_METADATA_KEY,
  SPRAY_PHOTO_WIDTH_METADATA_KEY,
  sprayWallPhotoKey,
} from '../../../handlers/spray-wall-photos';
import { getS3ObjectMetadata, isS3Configured, presignGetObject } from '../../../storage/s3';
import { resizedVariantKey } from '../../../lib/image-resize';
import {
  CreateSprayWallInputSchema,
  CreateSprayWallVersionInputSchema,
  PublishSprayWallVersionInputSchema,
  RemoveSprayWallHoldsInputSchema,
  SPRAY_VERSION_STATUS_WIRE_NAME,
  UpsertSprayWallHoldsInputSchema,
  UUIDSchema,
} from '../../../validation/schemas';

/**
 * The spray wall API: create a wall, attach a photo, edit holds on a draft,
 * publish, delete.
 *
 * A wall is not a new kind of thing — it is a runtime-created catalogue layout
 * under the ninth board type, so queue, play, ticks, stats, playlists, feed,
 * comments, search and the duplicate gate work on it unchanged
 * (`docs/spray-walls.md`). What lives here is the per-wall state that does NOT
 * belong on immutable catalogue rows: which photograph is current, where each
 * hold sits in the canonical frame, and when each hold went on or came off.
 *
 * ## The two authorization rules, and why they differ
 *
 * **Viewing** a wall is the ordinary board-visibility question: the owner, a
 * member of the gym it is attached to, or anybody at all when the wall is public
 * or unlisted (an unlisted wall is reachable by uuid and nowhere else).
 *
 * **Editing** a wall is narrower than editing a board. Every mutation here goes
 * through `requireBoardEditAccess` UNCHANGED (epic decision 2026-09-14:
 * ownership grants editing, with no gym-`editor` extension), which means the
 * owner, a gym owner/admin for an attached wall, and a community admin/leader on
 * a public one. A gym `editor` — who can edit the gym's page — cannot touch a
 * wall's holds.
 *
 * ## What the server does NOT check
 *
 * It never re-runs detection on a submission (epic decision 2026-09-14): it is
 * the owner's wall and trash in is their call. Validation is shape only — the
 * ring contract, the caps, and that a hold id is alive on the version being
 * edited (`validation/schemas/spray-walls.ts`).
 */

/**
 * Per-minute ceilings.
 *
 * The issue asks for 5/hour on create and 10/min on publish. `applyRateLimit`
 * has one fixed 60s window (`RATE_LIMIT_WINDOW_MS`), so the create limit is
 * expressed as 5 per window and the REAL bound on wall volume is
 * `MAX_SPRAY_WALLS_PER_USER`, a hard cap this resolver enforces on every create.
 * Widening `applyRateLimit` to take a window would touch every caller in the
 * backend and is not worth it for one mutation whose absolute cap is 10.
 */
const CREATE_WALL_RATE_LIMIT = 5;
const PUBLISH_RATE_LIMIT = 10;
const WALL_MUTATION_RATE_LIMIT = 30;
const WALL_QUERY_RATE_LIMIT = 60;

/** The one resize variant the photo handler writes, used as the list-row thumbnail. */
const THUMBNAIL_SIZE = 280;

/** `extensions.code` values a rejection carries, so a client branches on the outcome. */
export const SPRAY_WALL_CODES = {
  notFound: 'SPRAY_WALL_NOT_FOUND',
  wallLimitReached: 'SPRAY_WALL_LIMIT_REACHED',
  holdLimitReached: 'SPRAY_WALL_HOLD_LIMIT_REACHED',
  versionLimitReached: 'SPRAY_WALL_VERSION_LIMIT_REACHED',
  versionNotDraft: 'SPRAY_WALL_VERSION_NOT_DRAFT',
  holdNotAlive: 'SPRAY_WALL_HOLD_NOT_ALIVE',
  photoMissing: 'SPRAY_WALL_PHOTO_MISSING',
  photosNotConfigured: 'SPRAY_WALL_PHOTOS_NOT_CONFIGURED',
} as const;

type SprayWallRow = typeof dbSchema.sprayWalls.$inferSelect;
type SprayWallVersionRow = typeof dbSchema.sprayWallVersions.$inferSelect;
type SprayWallHoldRow = typeof dbSchema.sprayWallHolds.$inferSelect;
type UserBoardRow = typeof dbSchema.userBoards.$inferSelect;

type LoadedWall = { wall: SprayWallRow; board: UserBoardRow };

function notFoundError(): GraphQLError {
  return new GraphQLError('Spray wall not found', { extensions: { code: SPRAY_WALL_CODES.notFound } });
}

/**
 * Load a live wall with the `user_boards` row that carries its owner, name,
 * angle and visibility. `undefined` for a missing or soft-deleted wall — callers
 * turn that into a null query result or a not-found mutation error.
 */
async function loadWall(where: 'uuid' | 'layoutId', value: string | number): Promise<LoadedWall | undefined> {
  const [row] = await db
    .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        where === 'uuid'
          ? eq(dbSchema.sprayWalls.boardUuid, value as string)
          : eq(dbSchema.sprayWalls.layoutId, value as number),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);

  return row ?? undefined;
}

/**
 * Whether the viewer may see this wall on the strength of WHO THEY ARE — the
 * owner, or a member of the gym the wall is attached to.
 *
 * Split out from `viewerCanSeeSprayWall` because `is_unlisted` is not an identity
 * claim, it is a property of the LOOKUP: see the note there.
 */
async function viewerIsWallPrincipal(board: UserBoardRow, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (board.ownerId === userId) return true;
  if (board.gymId == null) return false;

  const [membership] = await db
    .select({ id: dbSchema.gymMembers.id })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, board.gymId), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);

  return !!membership;
}

/**
 * Whether the viewer may see this wall through a lookup BY UUID.
 *
 * The owner, a member of the wall's gym, or anyone at all when the wall is public
 * or unlisted. An unlisted wall opens up here and NOWHERE else: a uuid is an
 * unguessable 122-bit capability, so knowing one is the whole of the claim.
 *
 * `is_unlisted` is therefore not an identity check but a property of the lookup —
 * which is exactly why `sprayWallByLayout` must not use this function. Layout ids
 * come out of `spray_wall_catalog_id_seq`, i.e. 1, 2, 3, …, so treating unlisted
 * as world-readable on a layout lookup would let an anonymous caller walk the
 * sequence and collect a live presigned photo of every unlisted home wall in the
 * database. Use `viewerCanSeeSprayWallByLayout` for any enumerable key.
 */
export async function viewerCanSeeSprayWall(board: UserBoardRow, userId: string | null | undefined): Promise<boolean> {
  if (board.isPublic || board.isUnlisted) return true;
  return viewerIsWallPrincipal(board, userId);
}

/**
 * Whether the viewer may see this wall through a lookup on an ENUMERABLE key.
 *
 * Same rule minus the unlisted exemption: the owner, a gym member, or a public
 * wall. Nothing about the wall's existence is answerable from a guessed number.
 */
export async function viewerCanSeeSprayWallByLayout(
  board: UserBoardRow,
  userId: string | null | undefined,
): Promise<boolean> {
  if (board.isPublic) return true;
  return viewerIsWallPrincipal(board, userId);
}

/**
 * The wall named by `uuid`, when the viewer may see it — otherwise undefined.
 *
 * "Not visible" and "does not exist" are deliberately the same answer: telling a
 * stranger that a uuid IS a wall they may not see is itself a leak, and a wall
 * is somebody's home.
 */
async function loadVisibleWall(uuid: string, userId: string | null | undefined): Promise<LoadedWall | undefined> {
  const loaded = await loadWall('uuid', uuid);
  if (!loaded) return undefined;
  return (await viewerCanSeeSprayWall(loaded.board, userId)) ? loaded : undefined;
}

/** Load a wall for a mutation and assert the caller may edit it. */
async function loadEditableWall(ctx: ConnectionContext, uuid: string): Promise<LoadedWall> {
  const loaded = await loadWall('uuid', uuid);
  if (!loaded) throw notFoundError();
  await requireBoardEditAccess(ctx, loaded.board);
  return loaded;
}

/**
 * Presigned URLs for one version's photo.
 *
 * Minted per read and never stored: the photo is in the `private` bucket
 * precisely because there is no URL safe to persist. A version with no photo key
 * (or a backend with no private bucket configured) returns null, and the callers
 * decide whether that is a null field or a hard error.
 */
async function presignVersionPhoto(version: SprayWallVersionRow): Promise<{
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  expiresAt: string;
} | null> {
  if (!version.photoKey || !isS3Configured('private')) return null;

  const [full, thumb] = await Promise.all([
    presignGetObject('private', version.photoKey),
    // Best-effort: the variant is written before the base object, so a signature
    // for it should always resolve — but a thumbnail is a nicety and must never
    // be the reason a wall fails to render.
    presignGetObject('private', resizedVariantKey(version.photoKey, THUMBNAIL_SIZE)).catch((error) => {
      logger.warn('Failed to presign a spray wall thumbnail', { versionId: version.id }, error);
      return null;
    }),
  ]);

  return {
    url: full.url,
    thumbUrl: thumb?.url ?? null,
    width: version.photoWidth,
    height: version.photoHeight,
    expiresAt: full.expiresAt,
  };
}

/** How many holds a version put on, and took off, the wall. */
async function versionHoldDeltas(versionIds: number[]): Promise<Map<number, { added: number; removed: number }>> {
  const deltas = new Map<number, { added: number; removed: number }>();
  for (const id of versionIds) deltas.set(id, { added: 0, removed: 0 });
  if (versionIds.length === 0) return deltas;

  const [installed, removed] = await Promise.all([
    db
      .select({ versionId: dbSchema.sprayWallHolds.installedVersionId, total: count() })
      .from(dbSchema.sprayWallHolds)
      .where(inArray(dbSchema.sprayWallHolds.installedVersionId, versionIds))
      .groupBy(dbSchema.sprayWallHolds.installedVersionId),
    db
      .select({ versionId: dbSchema.sprayWallHolds.removedVersionId, total: count() })
      .from(dbSchema.sprayWallHolds)
      .where(inArray(dbSchema.sprayWallHolds.removedVersionId, versionIds))
      .groupBy(dbSchema.sprayWallHolds.removedVersionId),
  ]);

  for (const row of installed) {
    const entry = deltas.get(Number(row.versionId));
    if (entry) entry.added = Number(row.total);
  }
  for (const row of removed) {
    if (row.versionId == null) continue;
    const entry = deltas.get(Number(row.versionId));
    if (entry) entry.removed = Number(row.total);
  }
  return deltas;
}

/** A hold row on the wire: hold ids and version NUMBERS, never internal version ids. */
function toGraphQLHold(hold: SprayWallHoldRow, versionNumberById: Map<number, number>) {
  return {
    id: hold.holdId,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
    outline: hold.outline ?? null,
    installedVersion: versionNumberById.get(Number(hold.installedVersionId)) ?? 0,
    removedVersion:
      hold.removedVersionId == null ? null : (versionNumberById.get(Number(hold.removedVersionId)) ?? null),
    movedFromHoldId: hold.movedFromHoldId ?? null,
    source: hold.source === 'auto' ? 'AUTO' : 'MANUAL',
    confidence: hold.confidence ?? null,
  };
}

async function toGraphQLVersion(
  version: SprayWallVersionRow,
  deltas: { added: number; removed: number } = { added: 0, removed: 0 },
) {
  return {
    id: String(version.id),
    number: version.versionNumber,
    status: SPRAY_VERSION_STATUS_WIRE_NAME[version.status],
    photo: await presignVersionPhoto(version),
    anchors: version.anchors ?? null,
    homography: version.homography ?? null,
    notes: version.notes ?? null,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    addedHoldCount: deltas.added,
    removedHoldCount: deltas.removed,
  };
}

/**
 * Build the `SprayWall` payload.
 *
 * `versions` hides drafts from everyone but an editor: a draft is a photograph
 * the owner has not decided to show yet, and the compare view of a half-finished
 * reset is not something a gym member should see.
 */
async function toGraphQLWall(loaded: LoadedWall, userId: string | null | undefined, canEdit: boolean) {
  const { wall, board } = loaded;

  const versionRows = await db
    .select()
    .from(dbSchema.sprayWallVersions)
    .where(eq(dbSchema.sprayWallVersions.wallId, wall.id))
    .orderBy(desc(dbSchema.sprayWallVersions.versionNumber));

  const visibleVersions = canEdit ? versionRows : versionRows.filter((version) => version.status !== 'draft');
  const deltas = await versionHoldDeltas(visibleVersions.map((version) => Number(version.id)));

  const [enrichedBoard] = await enrichBoards([{ board }], userId ?? undefined);
  const currentVersionRow = versionRows.find((version) => Number(version.id) === Number(wall.currentVersionId));

  return {
    uuid: board.uuid,
    board: enrichedBoard,
    layoutId: wall.layoutId,
    sizeId: spraySizeIdForLayout(wall.layoutId),
    referenceWidth: wall.referenceWidth,
    referenceHeight: wall.referenceHeight,
    currentVersion: currentVersionRow
      ? await toGraphQLVersion(currentVersionRow, deltas.get(Number(currentVersionRow.id)))
      : null,
    versions: await Promise.all(
      visibleVersions.map((version) => toGraphQLVersion(version, deltas.get(Number(version.id)))),
    ),
    holdCount: wall.holdCount,
    viewerCanEdit: canEdit,
  };
}

/** Whether the caller can edit, without throwing — the `viewerCanEdit` field. */
async function computeCanEdit(ctx: ConnectionContext, board: UserBoardRow): Promise<boolean> {
  if (!ctx.isAuthenticated || !ctx.userId) return false;
  try {
    await requireBoardEditAccess(ctx, board);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version a read should use: the one asked for, or the wall's published one.
 *
 * A draft is only resolvable by an editor, so a stranger asking for version 3 of
 * a wall whose version 3 is a draft gets nothing rather than a preview of an
 * unfinished reset.
 */
async function resolveReadableVersion(
  wall: SprayWallRow,
  versionNumber: number | null | undefined,
  canEdit: boolean,
): Promise<SprayWallVersionRow | undefined> {
  if (versionNumber == null) {
    if (wall.currentVersionId == null) return undefined;
    const [current] = await db
      .select()
      .from(dbSchema.sprayWallVersions)
      .where(eq(dbSchema.sprayWallVersions.id, wall.currentVersionId))
      .limit(1);
    return current ?? undefined;
  }

  const [version] = await db
    .select()
    .from(dbSchema.sprayWallVersions)
    .where(
      and(eq(dbSchema.sprayWallVersions.wallId, wall.id), eq(dbSchema.sprayWallVersions.versionNumber, versionNumber)),
    )
    .limit(1);

  if (!version) return undefined;
  if (version.status === 'draft' && !canEdit) return undefined;
  return version;
}

/**
 * The version being edited, asserted to be a DRAFT of this wall.
 *
 * Published and superseded versions are immutable: a climb set against a
 * published generation reads its holds by id, so rewriting that generation's
 * geometry would silently move every climb on it.
 */
async function loadDraftVersion(wallId: number, versionId: number): Promise<SprayWallVersionRow> {
  const [version] = await db
    .select()
    .from(dbSchema.sprayWallVersions)
    .where(and(eq(dbSchema.sprayWallVersions.id, versionId), eq(dbSchema.sprayWallVersions.wallId, wallId)))
    .limit(1);

  if (!version) throw notFoundError();
  if (version.status !== 'draft') {
    throw new GraphQLError('That wall version is already published and can no longer be edited', {
      extensions: { code: SPRAY_WALL_CODES.versionNotDraft },
    });
  }
  return version;
}

/**
 * The canonical frame a photo defines, and the homography onto it.
 *
 * Version 1 IS the definition: with anchors, the frame is the anchor quad's
 * bounding rectangle; without, it is the photo's own pixel box. Later versions
 * inherit the frame the wall already has — that is the whole point of a canonical
 * frame, and re-deriving it per version would move every existing hold. There are
 * no user-entered wall dimensions anywhere (epic decision 2026-09-14).
 */
export function resolveVersionGeometry(input: {
  anchors: Quad | null | undefined;
  photoWidth: number;
  photoHeight: number;
  existingFrame: { width: number | null; height: number | null };
}): { referenceWidth: number; referenceHeight: number; homography: number[] } {
  const { anchors, photoWidth, photoHeight, existingFrame } = input;

  const frame =
    existingFrame.width != null && existingFrame.height != null
      ? { width: existingFrame.width, height: existingFrame.height }
      : isValidAnchorQuad(anchors)
        ? boundingSize(anchors)
        : { width: photoWidth, height: photoHeight };

  return {
    referenceWidth: frame.width,
    referenceHeight: frame.height,
    homography: isValidAnchorQuad(anchors) ? homographyFromAnchors(anchors, frame) : [...IDENTITY_HOMOGRAPHY],
  };
}

// ============================================
// Queries
// ============================================

export const sprayWallQueries = {
  sprayWall: async (_: unknown, { uuid }: { uuid: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWall');
    const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');

    const loaded = await loadVisibleWall(validatedUuid, ctx.userId);
    if (!loaded) return null;
    return toGraphQLWall(loaded, ctx.userId, await computeCanEdit(ctx, loaded.board));
  },

  sprayWallByLayout: async (_: unknown, { layoutId }: { layoutId: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWallByLayout');
    if (typeof layoutId !== 'number' || !Number.isInteger(layoutId) || layoutId <= 0) {
      throw new Error('Invalid layoutId');
    }

    // NOT `viewerCanSeeSprayWall`: a layout id is a small integer from a
    // sequence, so an unlisted wall must not resolve here. See that function.
    const loaded = await loadWall('layoutId', layoutId);
    if (!loaded || !(await viewerCanSeeSprayWallByLayout(loaded.board, ctx.userId))) return null;
    return toGraphQLWall(loaded, ctx.userId, await computeCanEdit(ctx, loaded.board));
  },

  sprayWallRenderData: async (
    _: unknown,
    { uuid, version }: { uuid: unknown; version?: number | null },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWallRenderData');
    const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');

    const loaded = await loadVisibleWall(validatedUuid, ctx.userId);
    if (!loaded) return null;

    const canEdit = await computeCanEdit(ctx, loaded.board);
    const versionRow = await resolveReadableVersion(loaded.wall, version, canEdit);
    if (!versionRow) return null;

    const photo = await presignVersionPhoto(versionRow);
    // A version with no readable photo is not renderable, and a payload with a
    // null photo would make every client crash on a non-null field. Null is the
    // honest answer — the same one an invisible wall gets.
    if (!photo) return null;

    const holds = await aliveHolds(db, loaded.wall.id, versionRow.versionNumber);
    const versionNumberById = await loadVersionNumbers(loaded.wall.id);

    return {
      wall: await toGraphQLWall(loaded, ctx.userId, canEdit),
      versionNumber: versionRow.versionNumber,
      // A wall always has a frame by the time it has a photo — `createSprayWallVersion`
      // writes both in one transaction — so the photo fallbacks here only fire for
      // a row hand-edited in psql.
      boardWidth: loaded.wall.referenceWidth ?? versionRow.photoWidth ?? 0,
      boardHeight: loaded.wall.referenceHeight ?? versionRow.photoHeight ?? 0,
      photo,
      homography: versionRow.homography ?? [...IDENTITY_HOMOGRAPHY],
      holds: holds.map((hold) => toGraphQLHold(hold, versionNumberById)),
    };
  },

  mySprayWalls: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'mySprayWalls');

    const rows = await db
      .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
      .from(dbSchema.sprayWalls)
      .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, ctx.userId!),
          isNull(dbSchema.sprayWalls.deletedAt),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(desc(dbSchema.sprayWalls.createdAt));

    // The caller owns every row here, so `viewerCanEdit` is true without asking.
    return Promise.all(rows.map((row) => toGraphQLWall(row, ctx.userId, true)));
  },
};

/** Version number per internal version id, for mapping hold lifecycles onto the wire. */
async function loadVersionNumbers(wallId: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: dbSchema.sprayWallVersions.id, versionNumber: dbSchema.sprayWallVersions.versionNumber })
    .from(dbSchema.sprayWallVersions)
    .where(eq(dbSchema.sprayWallVersions.wallId, wallId));
  return new Map(rows.map((row) => [Number(row.id), row.versionNumber]));
}

// ============================================
// Mutations
// ============================================

export const sprayWallMutations = {
  createSprayWall: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, CREATE_WALL_RATE_LIMIT, 'createSprayWall');

    const validated = validateInput(CreateSprayWallInputSchema, input, 'input');
    const userId = ctx.userId!;

    // The real bound on wall volume — see CREATE_WALL_RATE_LIMIT. A plain read
    // outside the transaction, the same approximate posture as
    // `assertBoardCapNotReached`: two concurrent creates can both see 9 and both
    // land, and the cap exists to stop a runaway rather than hold an invariant.
    const [{ owned }] = await db
      .select({ owned: count() })
      .from(dbSchema.sprayWalls)
      .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          isNull(dbSchema.sprayWalls.deletedAt),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      );

    if (Number(owned) >= MAX_SPRAY_WALLS_PER_USER) {
      throw new GraphQLError(
        `You've reached the limit of ${MAX_SPRAY_WALLS_PER_USER} spray walls. ` +
          `Delete one you no longer use to add another.`,
        { extensions: { code: SPRAY_WALL_CODES.wallLimitReached, maxWalls: MAX_SPRAY_WALLS_PER_USER } },
      );
    }

    const latitude = validated.latitude ?? null;
    const longitude = validated.longitude ?? null;

    // The shared gate: a gym owner/admin, or a nearby public gym the caller is
    // adding their own wall to. Ahead of the writes so a refused link leaves no
    // wall behind.
    let gymId: number | null = null;
    if (validated.gymUuid) {
      const gym = await requireBoardGymLinkAccess({
        ctx,
        gymUuid: validated.gymUuid,
        userId,
        boardLatitude: latitude,
        boardLongitude: longitude,
      });
      gymId = gym.id;
    }

    const boardUuid = uuidv4();
    const slug = await generateUniqueSlug(validated.name);

    const created = await db.transaction(async (tx) => {
      // ONE sequence value is BOTH the layout id and the size id: a wall has
      // exactly one size, itself.
      const { layoutId, sizeId } = await allocateWallIds(tx);

      // All three catalogue rows are `is_listed = false`, and that is the primary
      // privacy defence rather than cosmetics — see the helper's own comment.
      // Inside the transaction so a half-written wall leaves a gap in the id
      // space (fine) rather than a catalogue row with no wall (not).
      await createSprayWallCatalogueRows(tx, { layoutId, name: validated.name });

      const [board] = await tx
        .insert(dbSchema.userBoards)
        .values({
          uuid: boardUuid,
          slug,
          ownerId: userId,
          boardType: 'spray',
          layoutId,
          sizeId,
          setIds: String(SPRAY_SET.id),
          name: validated.name,
          description: validated.description ?? null,
          locationName: validated.locationName ?? null,
          latitude,
          longitude,
          gymId,
          // Private by default: a wall is somebody's home until they say
          // otherwise. Every other board type defaults public.
          isPublic: validated.isPublic ?? false,
          isUnlisted: validated.isUnlisted ?? false,
          hideLocation: validated.hideLocation ?? false,
          isOwned: true,
          angle: validated.angle,
          // ALWAYS false, and never taken from the client. There is no firmware
          // to encode for, and BLE suppression today is this per-row data rather
          // than the board type — `scanFamilyForBoard('spray')` still answers
          // 'aurora', because every non-MoonBoard board falls through to it. So a
          // wall created with `has_leds = true` would offer a climber a Bluetooth
          // scan for a wall that has no controller. See docs/spray-walls.md.
          hasLeds: false,
          // A wall's angle is fixed for its life: stats are keyed by angle and a
          // spray wall does not adjust.
          isAngleAdjustable: false,
          // No serial: there is no controller to bind one to, and leaving it null
          // keeps the wall out of every serial-based presence lookup.
          serialNumber: null,
          timerName: null,
        })
        .returning();

      const [wall] = await tx
        .insert(dbSchema.sprayWalls)
        .values({
          boardUuid,
          layoutId,
          // NULL until the first photo: the frame is derived from version 1's
          // photo, and there is nothing to derive it from yet.
          referenceWidth: null,
          referenceHeight: null,
          holdCount: 0,
        })
        .returning();

      return { wall, board };
    });

    // Outside the transaction, each guarded on its own — see the helper for why a
    // PostGIS failure must never fail the mutation.
    if (latitude != null && longitude != null) {
      await syncLocationGeography({
        table: 'user_boards',
        id: created.board.id,
        latitude,
        longitude,
        operation: 'createSprayWall',
      });
    }

    logger.info('Spray wall created', {
      userId,
      layoutId: created.wall.layoutId,
      gymId,
      isPublic: created.board.isPublic,
    });

    return toGraphQLWall(created, userId, true);
  },

  createSprayWallVersion: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'createSprayWallVersion');

    const validated = validateInput(CreateSprayWallVersionInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);

    if (!isS3Configured('private')) {
      throw new GraphQLError('Spray wall photos are not configured on this server', {
        extensions: { code: SPRAY_WALL_CODES.photosNotConfigured },
      });
    }

    const [{ versions: versionCount }] = await db
      .select({ versions: count() })
      .from(dbSchema.sprayWallVersions)
      .where(eq(dbSchema.sprayWallVersions.wallId, wall.id));

    if (Number(versionCount) >= MAX_VERSIONS_PER_WALL) {
      throw new GraphQLError(
        `This wall has reached the limit of ${MAX_VERSIONS_PER_WALL} photos. ` +
          `Each one keeps its own hold generation, so there is nothing to prune automatically.`,
        { extensions: { code: SPRAY_WALL_CODES.versionLimitReached } },
      );
    }

    // The dimensions come off the STORED object, not the request: they define the
    // canonical frame on version 1, so a client that lied about them would put
    // every hold on the wall at the wrong place. Reading them back also proves the
    // photo actually landed — a `photoId` naming no object is a client sending a
    // version for an upload that failed.
    const photoKey = sprayWallPhotoKey(validated.wallUuid, validated.photoId);
    const stored = await getS3ObjectMetadata('private', photoKey);
    const photoWidth = Number(stored?.metadata?.[SPRAY_PHOTO_WIDTH_METADATA_KEY]);
    const photoHeight = Number(stored?.metadata?.[SPRAY_PHOTO_HEIGHT_METADATA_KEY]);

    if (
      !stored ||
      !Number.isInteger(photoWidth) ||
      !Number.isInteger(photoHeight) ||
      photoWidth <= 0 ||
      photoHeight <= 0
    ) {
      throw new GraphQLError('That photo upload could not be found. Upload the photo again.', {
        extensions: { code: SPRAY_WALL_CODES.photoMissing },
      });
    }

    const geometry = resolveVersionGeometry({
      anchors: validated.anchors ?? null,
      photoWidth,
      photoHeight,
      existingFrame: { width: wall.referenceWidth, height: wall.referenceHeight },
    });

    const version = await db.transaction(async (tx) => {
      // Lock the WALL row first, then count. Postgres refuses `FOR UPDATE`
      // alongside an aggregate, and the version numbers have to be dense per
      // wall — so the wall row is the thing two concurrent uploads queue behind,
      // and without that lock both would compute the same `MAX + 1` and one would
      // die on the `(wall_id, version_number)` unique index.
      await tx
        .select({ id: dbSchema.sprayWalls.id })
        .from(dbSchema.sprayWalls)
        .where(eq(dbSchema.sprayWalls.id, wall.id))
        .for('update');

      const [{ maxNumber }] = await tx
        .select({ maxNumber: sql<number | null>`MAX(${dbSchema.sprayWallVersions.versionNumber})` })
        .from(dbSchema.sprayWallVersions)
        .where(eq(dbSchema.sprayWallVersions.wallId, wall.id));

      const [inserted] = await tx
        .insert(dbSchema.sprayWallVersions)
        .values({
          wallId: wall.id,
          versionNumber: Number(maxNumber ?? 0) + 1,
          status: 'draft',
          photoKey,
          photoWidth,
          photoHeight,
          anchors: validated.anchors ?? null,
          homography: geometry.homography,
          notes: validated.notes ?? null,
          createdBy: ctx.userId!,
        })
        .returning();

      // Version 1 defines the frame; later versions inherit it, and
      // `resolveVersionGeometry` has already returned the existing values in that
      // case, so this write is idempotent rather than conditional.
      await tx
        .update(dbSchema.sprayWalls)
        .set({
          referenceWidth: geometry.referenceWidth,
          referenceHeight: geometry.referenceHeight,
          updatedAt: new Date(),
        })
        .where(eq(dbSchema.sprayWalls.id, wall.id));

      return inserted;
    });

    return toGraphQLVersion(version);
  },

  upsertSprayWallHolds: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'upsertSprayWallHolds');

    const validated = validateInput(UpsertSprayWallHoldsInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);
    const version = await loadDraftVersion(wall.id, validated.versionId);

    // The wall as THIS DRAFT sees it: holds installed at or before the draft's own
    // version number and not removed by it. That includes the holds this same
    // draft added, which is what lets an editing session correct a hold it drew a
    // moment ago, and excludes the ones it has already taken off.
    const existing = await aliveHolds(db, wall.id, version.versionNumber);
    const aliveById = new Map(existing.map((hold) => [hold.holdId, hold]));

    // Every named id has to be alive on the wall. A hold that came off in an
    // earlier reset is history, and rewriting its geometry would move it under
    // every climb that still references it.
    const corrections = validated.holds.filter((hold) => hold.id != null);
    const unknownId = corrections.find((hold) => !aliveById.has(hold.id!));
    if (unknownId) {
      throw new GraphQLError(`Hold ${unknownId.id} is not on this wall`, {
        extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: unknownId.id },
      });
    }

    // `movedFromHoldId` is lineage, and a lineage pointer at another wall's hold
    // (or at nothing) would make remix suggest a successor for a hold that was
    // never there. Scoped against EVERY hold this wall has ever had, not the alive
    // set: a move's whole point is that the predecessor has just come off.
    const movedFromIds = [
      ...new Set(
        validated.holds.map((hold) => hold.movedFromHoldId).filter((holdId): holdId is number => holdId != null),
      ),
    ];
    if (movedFromIds.length > 0) {
      const known = await db
        .select({ holdId: dbSchema.sprayWallHolds.holdId })
        .from(dbSchema.sprayWallHolds)
        .where(and(eq(dbSchema.sprayWallHolds.wallId, wall.id), inArray(dbSchema.sprayWallHolds.holdId, movedFromIds)));
      const knownIds = new Set(known.map((row) => row.holdId));
      const strayId = movedFromIds.find((holdId) => !knownIds.has(holdId));
      if (strayId != null) {
        throw new GraphQLError(`Hold ${strayId} has never been on this wall, so nothing can have moved from it`, {
          extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: strayId },
        });
      }
    }

    const additions = validated.holds.filter((hold) => hold.id == null);
    if (existing.length + additions.length > MAX_HOLDS_PER_WALL) {
      throw new GraphQLError(
        `A wall may hold at most ${MAX_HOLDS_PER_WALL} holds; this would make ` +
          `${existing.length + additions.length}.`,
        { extensions: { code: SPRAY_WALL_CODES.holdLimitReached, maxHolds: MAX_HOLDS_PER_WALL } },
      );
    }

    const writtenHoldIds = await db.transaction(async (tx) => {
      const holdIds: number[] = [];

      // One round trip for the whole batch, ascending — the hold editor relies on
      // that order to keep a freshly detected batch in the order it was reviewed.
      const newIds = await allocateHoldIds(tx, additions.length);

      if (additions.length > 0) {
        // The catalogue pair every hold needs: one `board_holes` row and one
        // `board_placements` row SHARING the id, because a climb's frames string
        // (`p<placementId>r<code>`) has to resolve to the row the wall editor drew
        // and a wall hold has no separate hole to mount into.
        await tx.insert(dbSchema.boardHoles).values(
          additions.map((hold, index) => ({
            boardType: 'spray' as const,
            id: newIds[index],
            productId: null,
            name: null,
            // The catalogue's x/y is the canonical-frame centre, so any reader
            // that only knows `board_holes` still places the hold correctly.
            x: hold.cx,
            y: hold.cy,
            mirroredHoleId: null,
          })),
        );

        await tx.insert(dbSchema.boardPlacements).values(
          additions.map((hold, index) => ({
            boardType: 'spray' as const,
            id: newIds[index],
            layoutId: wall.layoutId,
            holeId: newIds[index],
            setId: SPRAY_SET.id,
            defaultPlacementRoleId: null,
          })),
        );
      }

      if (additions.length > 0) {
        // One statement for the batch: a detector run can be 800 holds, and a
        // round trip each would make the editor's save a multi-second wait.
        await tx.insert(dbSchema.sprayWallHolds).values(
          additions.map((hold, index) => ({
            wallId: wall.id,
            holdId: newIds[index],
            cx: hold.cx,
            cy: hold.cy,
            r: hold.r,
            outline: hold.outline ?? null,
            installedVersionId: version.id,
            movedFromHoldId: hold.movedFromHoldId ?? null,
            source: hold.source,
            confidence: hold.confidence ?? null,
          })),
        );
        holdIds.push(...newIds);
      }

      // FOLLOW-UP (perf): the additions above are three batched statements for the
      // whole run, but a CORRECTION costs two round trips each — the side-table
      // update and the `board_holes` centre. A hold-editor session that nudges
      // fifty holds therefore burns a hundred statements. Both are expressible as
      // one `UPDATE … FROM (VALUES …)` per table; not done here because the
      // correction path is a human dragging holds one at a time, so the batch is
      // small in every flow that exists today. Revisit if SW-08's compare mode
      // ever bulk-corrects a detector run.
      for (const hold of corrections) {
        holdIds.push(hold.id!);
        await tx
          .update(dbSchema.sprayWallHolds)
          .set({
            cx: hold.cx,
            cy: hold.cy,
            r: hold.r,
            outline: hold.outline ?? null,
            movedFromHoldId: hold.movedFromHoldId ?? null,
            source: hold.source,
            confidence: hold.confidence ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(dbSchema.sprayWallHolds.wallId, wall.id), eq(dbSchema.sprayWallHolds.holdId, hold.id!)));

        // A correction keeps the hold's `board_holes` centre in step, so the
        // catalogue never disagrees with the wall about where a hold is.
        await tx
          .update(dbSchema.boardHoles)
          .set({ x: hold.cx, y: hold.cy })
          .where(and(eq(dbSchema.boardHoles.boardType, 'spray'), eq(dbSchema.boardHoles.id, hold.id!)));
      }

      return holdIds;
    });

    const versionNumberById = await loadVersionNumbers(wall.id);
    const written = await db
      .select()
      .from(dbSchema.sprayWallHolds)
      .where(and(eq(dbSchema.sprayWallHolds.wallId, wall.id), inArray(dbSchema.sprayWallHolds.holdId, writtenHoldIds)))
      .orderBy(asc(dbSchema.sprayWallHolds.holdId));

    return written.map((hold) => toGraphQLHold(hold, versionNumberById));
  },

  removeSprayWallHolds: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'removeSprayWallHolds');

    const validated = validateInput(RemoveSprayWallHoldsInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);
    const version = await loadDraftVersion(wall.id, validated.versionId);

    // The draft's own view of the wall — see `upsertSprayWallHolds`.
    const existing = await aliveHolds(db, wall.id, version.versionNumber);
    const aliveById = new Map(existing.map((hold) => [hold.holdId, hold]));

    const unknownId = validated.holdIds.find((holdId) => !aliveById.has(holdId));
    if (unknownId != null) {
      throw new GraphQLError(`Hold ${unknownId} is not on this wall`, {
        extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: unknownId },
      });
    }

    // Two different removals, and the split is what keeps history honest. A hold
    // this same draft ADDED was never on the real wall — the owner drew it and
    // changed their mind — so it is deleted outright, catalogue rows included. A
    // hold installed by an earlier version is stamped removed and never deleted:
    // a climb set on it has to stay findable, and `missing_hold_count` has to
    // stay countable.
    const drawnInThisDraft = validated.holdIds.filter(
      (holdId) => Number(aliveById.get(holdId)!.installedVersionId) === Number(version.id),
    );
    const takenOffTheWall = validated.holdIds.filter(
      (holdId) => Number(aliveById.get(holdId)!.installedVersionId) !== Number(version.id),
    );

    await db.transaction(async (tx) => {
      if (drawnInThisDraft.length > 0) {
        await tx
          .delete(dbSchema.sprayWallHolds)
          .where(
            and(eq(dbSchema.sprayWallHolds.wallId, wall.id), inArray(dbSchema.sprayWallHolds.holdId, drawnInThisDraft)),
          );
        await tx
          .delete(dbSchema.boardPlacements)
          .where(
            and(
              eq(dbSchema.boardPlacements.boardType, 'spray'),
              inArray(dbSchema.boardPlacements.id, drawnInThisDraft),
            ),
          );
        await tx
          .delete(dbSchema.boardHoles)
          .where(and(eq(dbSchema.boardHoles.boardType, 'spray'), inArray(dbSchema.boardHoles.id, drawnInThisDraft)));
      }

      if (takenOffTheWall.length > 0) {
        await tx
          .update(dbSchema.sprayWallHolds)
          .set({ removedVersionId: version.id, updatedAt: new Date() })
          .where(
            and(eq(dbSchema.sprayWallHolds.wallId, wall.id), inArray(dbSchema.sprayWallHolds.holdId, takenOffTheWall)),
          );
      }
    });

    return validated.holdIds.length;
  },

  publishSprayWallVersion: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, PUBLISH_RATE_LIMIT, 'publishSprayWallVersion');

    const validated = validateInput(PublishSprayWallVersionInputSchema, input, 'input');

    const [found] = await db
      .select({ version: dbSchema.sprayWallVersions, wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
      .from(dbSchema.sprayWallVersions)
      .innerJoin(dbSchema.sprayWalls, eq(dbSchema.sprayWalls.id, dbSchema.sprayWallVersions.wallId))
      .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
      .where(
        and(
          eq(dbSchema.sprayWallVersions.id, validated.versionId),
          isNull(dbSchema.sprayWalls.deletedAt),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .limit(1);

    if (!found) throw notFoundError();
    await requireBoardEditAccess(ctx, found.board);

    if (found.version.status !== 'draft') {
      throw new GraphQLError('That wall version is already published', {
        extensions: { code: SPRAY_WALL_CODES.versionNotDraft },
      });
    }

    const published = await db.transaction(async (tx) => {
      // The previous published generation becomes `superseded` — it is still the
      // generation older climbs were set against, so it is never deleted.
      if (found.wall.currentVersionId != null) {
        await tx
          .update(dbSchema.sprayWallVersions)
          .set({ status: 'superseded', updatedAt: new Date() })
          .where(
            and(
              eq(dbSchema.sprayWallVersions.id, found.wall.currentVersionId),
              eq(dbSchema.sprayWallVersions.status, 'published'),
            ),
          );
      }

      const [row] = await tx
        .update(dbSchema.sprayWallVersions)
        .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
        .where(eq(dbSchema.sprayWallVersions.id, found.version.id))
        .returning();

      // Counted AS OF the version being published, not as `removed_version_id IS
      // NULL`. A wall can carry more than one draft at a time, and a raw
      // still-alive count would fold another draft's unpublished additions into
      // the number climbers see.
      const alive = (await aliveHolds(tx, found.wall.id, row.versionNumber)).length;

      await tx
        .update(dbSchema.sprayWalls)
        .set({ currentVersionId: row.id, holdCount: alive, updatedAt: new Date() })
        .where(eq(dbSchema.sprayWalls.id, found.wall.id));

      // The catalogue's join row carries the image filename every board reader
      // looks for. It is the PRIVATE-bucket key, not a URL: nothing may serve a
      // wall photo without minting a signature first, so storing a URL here would
      // be an invitation to skip that step.
      if (row.photoKey) {
        await tx
          .update(dbSchema.boardProductSizesLayoutsSets)
          .set({ imageFilename: row.photoKey })
          .where(
            and(
              eq(dbSchema.boardProductSizesLayoutsSets.boardType, 'spray'),
              eq(dbSchema.boardProductSizesLayoutsSets.id, found.wall.layoutId),
            ),
          );
      }

      return row;
    });

    logger.info('Spray wall version published', {
      layoutId: found.wall.layoutId,
      versionNumber: published.versionNumber,
    });

    const deltas = await versionHoldDeltas([Number(published.id)]);
    return toGraphQLVersion(published, deltas.get(Number(published.id)));
  },

  deleteSprayWall: async (_: unknown, { uuid }: { uuid: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'deleteSprayWall');

    const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');
    const { wall, board } = await loadEditableWall(ctx, validatedUuid);

    // Soft delete only, on both rows. The catalogue rows and every climb ever set
    // on the wall stay behind — a deleted wall stops being reachable, it does not
    // un-set the climbs. Stamping `spray_walls.deleted_at` is also what tombstones
    // the wall for offline clients (migration 0228's `log_deletion_spray_walls`
    // fires on the NULL → NOT NULL transition), so the two writes have to be one
    // transaction or a phone could keep a wall the server has dropped.
    const deletedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(dbSchema.sprayWalls)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(dbSchema.sprayWalls.id, wall.id));
      await tx.update(dbSchema.userBoards).set({ deletedAt }).where(eq(dbSchema.userBoards.id, board.id));
    });

    logger.info('Spray wall deleted', { layoutId: wall.layoutId, userId: ctx.userId });
    return true;
  },
};
