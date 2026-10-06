import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
import { and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { lockWallForWrite } from '../../../services/spray-wall-lock';
export { lockWallForWrite } from '../../../services/spray-wall-lock';
import { lockSprayWallAccount } from '../../../services/spray-account-lock';
import { SPRAY_WALL_ARCHIVED_CODE, SPRAY_WALL_ARCHIVED_MESSAGE } from '../../../services/spray-wall-archive';
import { markDeletedSprayWallPhotoRetry } from '../../../services/spray-photo-erasure-retry';
import {
  MAX_ARCHIVED_SPRAY_WALLS_PER_USER,
  MAX_HOLDS_PER_WALL,
  MAX_SPRAY_WALLS_PER_USER,
  MAX_VERSIONS_PER_WALL,
  SPRAY_SET,
  spraySizeIdForLayout,
} from '@boardsesh/board-config';
// `aliveHolds`'s no-version form means "alive at the wall's `current_version_id`"
// — the climber's view, which does not include what an unpublished draft has
// drawn. Every WRITER here passes an explicit version number instead, because a
// draft's own additions and removals have to be visible to the session editing it
// and to nothing else. The two readings are never accidental: each call site says
// which generation it means.
//
// `proposeSprayWallReset` is the one deliberate no-version caller. A reset is a
// reset OF the published wall, and matching a new photo against the draft's own
// holds would compare the detections with themselves.
import {
  allocateHoldIds,
  allocateWallIds,
  aliveHolds,
  createSprayWallCatalogueRows,
  recomputeMissingHoldCounts,
} from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { canEditBoard, enrichBoards, generateUniqueSlug, requireBoardEditAccess } from '../social/boards';
import { requireBoardGymLinkAccess, resolveCanonicalGymByUuid } from '../social/gyms';
import { syncLocationGeography } from '../social/location-geography';
import {
  boundingSize,
  classifySprayDraft,
  sameSprayGeometry,
  homographyFromAnchors,
  IDENTITY_HOMOGRAPHY,
  isValidAnchorQuad,
  matchHolds,
  suggestMoves,
  type AliveHold,
  type Quad,
  type WallCircle,
} from '@boardsesh/spray-wall-geometry';
import {
  SPRAY_PHOTO_CONTENT_TYPE,
  SPRAY_PHOTO_HEIGHT_METADATA_KEY,
  SPRAY_PHOTO_WIDTH_METADATA_KEY,
  sprayWallFullPhotoKey,
  sprayWallPhotoKey,
  sprayWallPhotoMayHaveFullCopy,
  sprayWallPublicPhotoKey,
} from '../../../handlers/spray-wall-photos';
import {
  copyObjectBetweenBuckets,
  deleteFromS3,
  getPublicUrl,
  getS3ObjectMetadata,
  getS3ObjectMetadataStrict,
  isS3Configured,
  presignGetObject,
} from '../../../storage/s3';
import { sprayWallIsListable } from './spray-wall-listing';
import { resizedVariantKey } from '../../../lib/image-resize';
import { sprayVersionQuality, sprayWallArtState } from '../../../lib/spray-wall-art';
import { requestSprayWallArtOn, sprayWallArtNeedsRequest, sprayWallArtView } from '../../../services/spray-wall-art';
import {
  ClimbUuidSchema,
  CommitSprayWallVersionInputSchema,
  CreateSprayWallInputSchema,
  CreateSprayWallVersionInputSchema,
  ProposeSprayWallResetInputSchema,
  PublishSprayWallVersionInputSchema,
  RemoveSprayWallHoldsInputSchema,
  ResetSprayWallInputSchema,
  SetSprayWallRenderSettingsInputSchema,
  UpdateSprayWallInputSchema,
  SPRAY_VERSION_STATUS_WIRE_NAME,
  SPRAY_CLIMB_EDIT_POLICY_WIRE_NAME,
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
  anglePublished: 'SPRAY_WALL_ANGLE_PUBLISHED',
  publishWouldGoBackwards: 'SPRAY_WALL_PUBLISH_BACKWARDS',
  draftAlreadyOpen: 'SPRAY_WALL_DRAFT_ALREADY_OPEN',
  draftPurposeMismatch: 'SPRAY_WALL_DRAFT_PURPOSE_MISMATCH',
  resetReviewRequired: 'SPRAY_WALL_RESET_REVIEW_REQUIRED',
  sourceVersionNotCurrent: 'SPRAY_WALL_SOURCE_VERSION_NOT_CURRENT',
  anchorsRequired: 'SPRAY_WALL_ANCHORS_REQUIRED',
  visibilityOwnerOnly: 'SPRAY_WALL_VISIBILITY_OWNER_ONLY',
  climbEditPolicyOwnerOnly: 'SPRAY_WALL_CLIMB_EDIT_POLICY_OWNER_ONLY',
  archived: SPRAY_WALL_ARCHIVED_CODE,
  resetOwnerOnly: 'SPRAY_WALL_RESET_OWNER_ONLY',
  resetSourceUnpublished: 'SPRAY_WALL_RESET_SOURCE_UNPUBLISHED',
  archiveLimitReached: 'SPRAY_WALL_ARCHIVE_LIMIT_REACHED',
  artNotAvailable: 'SPRAY_WALL_ART_NOT_AVAILABLE',
} as const;

type SprayWallRow = typeof dbSchema.sprayWalls.$inferSelect;
type SprayWallVersionRow = typeof dbSchema.sprayWallVersions.$inferSelect;
type SprayWallHoldRow = typeof dbSchema.sprayWallHolds.$inferSelect;
type UserBoardRow = typeof dbSchema.userBoards.$inferSelect;

type LoadedWall = { wall: SprayWallRow; board: UserBoardRow };

/**
 * The part of a wall row the visibility rules read.
 *
 * Structural, not `SprayWallRow`, so a caller that selected only what it needs —
 * `requireVisibleSprayWall` in `../climbs/spray-authoring.ts` selects the whole
 * row, but a future one need not — can still be checked.
 */
export type SprayWallVisibility = { hiddenAt: Date | null };

/**
 * Anything that can run these reads and writes: the pooled client or a
 * transaction handle. Spelled out so the checks that MUST run inside the wall
 * lock cannot accidentally be handed the pool instead of the transaction.
 */
export type SprayWriteExecutor = typeof db | SprayWriteTransaction;

/**
 * A transaction handle, for checks and writes that must never run on the pooled
 * client: a transaction-scoped advisory lock taken on the pool is released the
 * moment that one statement commits.
 */
export type SprayWriteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function notFoundError(): GraphQLError {
  return new GraphQLError('Spray wall not found', { extensions: { code: SPRAY_WALL_CODES.notFound } });
}

/** The refusal every write that would change an archived wall gets. */
export function sprayWallArchivedError(): GraphQLError {
  return new GraphQLError(SPRAY_WALL_ARCHIVED_MESSAGE, { extensions: { code: SPRAY_WALL_CODES.archived } });
}

/**
 * Refuse a write to an archived wall, read UNDER THE WALL LOCK.
 *
 * The archive is stamped by the replacing wall's first publish, which takes this
 * wall's lock to do it. So a write that checks here, under the same lock, either
 * lands before the archive or sees it — there is no window in which a climb or a
 * hold edit slips onto a wall that has just been archived.
 *
 * Takes the lock itself; `pg_advisory_xact_lock` is re-entrant within a
 * transaction, so a caller that already holds it pays nothing.
 *
 * Only for writes that would change what the wall IS: setting or editing a
 * climb, and every hold and version writer. Ticks, deleting a draft climb,
 * discarding a draft version, renaming, the look and deleting the wall stay
 * allowed on an archived wall (docs/spray-walls.md, "Archive and reset").
 */
export async function assertSprayWallNotArchivedUnderLock(
  executor: SprayWriteTransaction,
  wallId: number,
): Promise<void> {
  await lockWallForWrite(executor, wallId);
  const [row] = await executor
    .select({ archivedAt: dbSchema.sprayWalls.archivedAt })
    .from(dbSchema.sprayWalls)
    .where(eq(dbSchema.sprayWalls.id, wallId))
    .limit(1);
  if (row?.archivedAt != null) throw sprayWallArchivedError();
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
async function viewerIsWallPrincipal(
  board: UserBoardRow,
  userId: string | null | undefined,
  isGymMember: GymMembershipResolver = viewerIsGymMember,
): Promise<boolean> {
  if (!userId) return false;
  if (board.ownerId === userId) return true;
  if (board.gymId == null) return false;
  return isGymMember(board.gymId, userId);
}

/** How a caller answers "is this viewer in that gym?". See `viewerIsGymMember`. */
type GymMembershipResolver = (gymId: number, userId: string) => Promise<boolean>;

/**
 * Whether `userId` has a `gym_members` row for `gymId`.
 *
 * Split out of `viewerIsWallPrincipal` so a caller that already knows every row
 * shares one gym — `gymSprayWalls` lists a single gym's walls — can substitute a
 * resolver that asks once for the whole page instead of once per wall.
 */
async function viewerIsGymMember(gymId: number, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: dbSchema.gymMembers.id })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gymId), eq(dbSchema.gymMembers.userId, userId)))
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
 * A wall an admin has HIDDEN (SW-17) short-circuits all of that: it reads exactly
 * like a private wall for everybody but its owner, who keeps seeing it with a
 * notice. Hiding has to take a wall off the internet, so it outranks both the
 * public flag and the share-link capability.
 *
 * `is_unlisted` is therefore not an identity check but a property of the lookup —
 * which is exactly why `sprayWallByLayout` must not use this function. Layout ids
 * come out of `spray_wall_catalog_id_seq`, i.e. 1, 2, 3, …, so treating unlisted
 * as world-readable on a layout lookup would let an anonymous caller walk the
 * sequence and collect a live presigned photo of every unlisted home wall in the
 * database. Use `viewerCanSeeSprayWallByLayout` for any enumerable key.
 */
export async function viewerCanSeeSprayWall(
  wall: SprayWallVisibility,
  board: UserBoardRow,
  userId: string | null | undefined,
): Promise<boolean> {
  if (wall.hiddenAt != null) return board.ownerId === userId;
  if (board.isPublic || board.isUnlisted) return true;
  return viewerIsWallPrincipal(board, userId);
}

/**
 * Whether the viewer may see this wall through a lookup on an ENUMERABLE key.
 *
 * Same rule minus the unlisted exemption: the owner, a gym member, or a public
 * wall. Nothing about the wall's existence is answerable from a guessed number.
 * A hidden wall is the owner's alone here too.
 */
export async function viewerCanSeeSprayWallByLayout(
  wall: SprayWallVisibility,
  board: UserBoardRow,
  userId: string | null | undefined,
  isGymMember: GymMembershipResolver = viewerIsGymMember,
): Promise<boolean> {
  if (wall.hiddenAt != null) return board.ownerId === userId;
  if (board.isPublic) return true;
  return viewerIsWallPrincipal(board, userId, isGymMember);
}

/**
 * Whether the caller may set or edit climbs on this wall.
 *
 * Climb writes are keyed on `layoutId`, which comes out of a sequence and is
 * therefore not a secret — so the by-layout rule is the default: the owner, a
 * member of the wall's gym, or a public wall. What this adds is the **share-link
 * capability**, which is the case the epic actually wants: somebody photographs
 * their home wall, sends the link to their crew, and the crew sets climbs on it.
 *
 * The capability is the wall's own uuid, and it only unlocks an **unlisted** wall:
 *
 *  - a PRIVATE wall refuses everyone but its principals, uuid or not. Private
 *    means private, and the owner has not handed a link to anybody.
 *  - a presented uuid has to be THIS wall's, matched against the row the
 *    request's `layoutId` resolved to. That pairing is the whole check: without
 *    it, one leaked uuid from any unlisted wall would authorize writes to every
 *    wall in the sequence.
 *
 * A mismatch is reported by the caller as "not found", exactly like an unknown
 * wall — so this is not an oracle for which layout ids are unlisted walls.
 */
export async function viewerCanWriteSprayClimbs(
  wall: SprayWallVisibility,
  board: UserBoardRow,
  userId: string | null | undefined,
  presentedWallUuid: string | null | undefined,
): Promise<boolean> {
  if (await viewerCanSeeSprayWallByLayout(wall, board, userId)) return true;
  // A hidden wall hands out no capability: the share link an owner sent before an
  // admin acted stops working, or hiding a wall would not take it off the
  // internet. The owner is already back at the line above.
  if (wall.hiddenAt != null) return false;
  if (!board.isUnlisted) return false;
  return presentedWallUuid != null && presentedWallUuid === board.uuid;
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
  return (await viewerCanSeeSprayWall(loaded.wall, loaded.board, userId)) ? loaded : undefined;
}

/** Load a wall for a mutation and assert the caller may edit it. */
export async function loadEditableWall(ctx: ConnectionContext, uuid: string): Promise<LoadedWall> {
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
export async function presignVersionPhoto(version: SprayWallVersionRow): Promise<{
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

/**
 * Whether a base photo key has a full-resolution copy beside it, by photo key.
 *
 * Remembered per process because the answer never changes for a key: the copy is
 * written before the base (so before any version row can name the key), and the
 * only paths that delete it — the retention purge and account deletion — clear
 * `photo_key` too, so a remembered "yes" is never consulted for a deleted object.
 * Bounded so a long-lived process does not grow without limit; Map iteration is
 * insertion order, so the oldest entry goes first.
 */
const fullPhotoPresence = new Map<string, boolean>();
const FULL_PHOTO_PRESENCE_MAX_ENTRIES = 5000;

/** Forget every remembered full-copy answer. Test seam: the map is module state. */
export function resetSprayFullPhotoPresenceCache(): void {
  fullPhotoPresence.clear();
}

async function versionHasFullPhoto(photoKey: string): Promise<boolean> {
  const remembered = fullPhotoPresence.get(photoKey);
  if (remembered !== undefined) return remembered;

  // Strict, so an outage throws instead of reading as "missing" and being
  // remembered as a permanent no for this key.
  const present = (await getS3ObjectMetadataStrict('private', sprayWallFullPhotoKey(photoKey))) !== null;
  if (fullPhotoPresence.size >= FULL_PHOTO_PRESENCE_MAX_ENTRIES) {
    const oldest = fullPhotoPresence.keys().next();
    if (!oldest.done) fullPhotoPresence.delete(oldest.value);
  }
  fullPhotoPresence.set(photoKey, present);
  return present;
}

/**
 * Presigned GET for a version's full-resolution copy (#5911), or null when it
 * has none.
 *
 * Only the hold editor asks for this, and only once it zooms past the base
 * photo's resolution, so it is a field on `SprayWallRenderData` and not on
 * `SprayWallPhoto` — the version lists and moderation previews that also build
 * a `SprayWallPhoto` never pay for it. Signed in the same breath as the base, so
 * `photo.expiresAt` covers it too.
 *
 * Existence costs no storage call for most versions: a base whose long side is
 * not exactly the base cap cannot have a copy (`sprayWallPhotoMayHaveFullCopy`).
 * The rest — including every pre-#5911 photo the app compressed to exactly 2048
 * px — get one HEAD per key per process, remembered after. Best-effort: the base
 * photo always renders, so a storage error here is a null, never a failed read.
 */
export async function presignVersionFullPhoto(version: SprayWallVersionRow): Promise<string | null> {
  if (!version.photoKey || !isS3Configured('private')) return null;
  if (!sprayWallPhotoMayHaveFullCopy(version.photoWidth, version.photoHeight)) return null;

  try {
    if (!(await versionHasFullPhoto(version.photoKey))) return null;
    return (await presignGetObject('private', sprayWallFullPhotoKey(version.photoKey))).url;
  } catch (error) {
    logger.warn('Failed to presign a spray wall full-resolution photo', { versionId: version.id }, error);
    return null;
  }
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

/** Every version row for these walls, in one round trip, keyed by wall id. */
async function loadVersionRowsForWalls(wallIds: number[]): Promise<Map<number, SprayWallVersionRow[]>> {
  const byWall = new Map<number, SprayWallVersionRow[]>();
  for (const id of wallIds) byWall.set(id, []);
  if (wallIds.length === 0) return byWall;

  const rows = await db
    .select()
    .from(dbSchema.sprayWallVersions)
    .where(inArray(dbSchema.sprayWallVersions.wallId, wallIds))
    .orderBy(desc(dbSchema.sprayWallVersions.versionNumber));

  for (const row of rows) byWall.get(Number(row.wallId))?.push(row);
  return byWall;
}

/**
 * Build the `SprayWall` payload.
 *
 * `versions` hides drafts from everyone but an editor: a draft is a photograph
 * the owner has not decided to show yet, and the compare view of a half-finished
 * reset is not something a gym member should see.
 *
 * `preloadedVersions` / `preloadedDeltas` are how `mySprayWalls` avoids three
 * round trips per wall — pass them when the caller already read them in one go.
 */
async function toGraphQLWall(
  loaded: LoadedWall,
  userId: string | null | undefined,
  canEdit: boolean,
  preloadedVersions?: SprayWallVersionRow[],
  preloadedDeltas?: Map<number, { added: number; removed: number }>,
  presentedWallUuid?: string | null,
  preloadedArchiveFacts?: SprayWallArchiveFacts,
) {
  const { wall, board } = loaded;

  const versionRows =
    preloadedVersions ??
    (await db
      .select()
      .from(dbSchema.sprayWallVersions)
      .where(eq(dbSchema.sprayWallVersions.wallId, wall.id))
      .orderBy(desc(dbSchema.sprayWallVersions.versionNumber)));

  const visibleVersions = canEdit ? versionRows : versionRows.filter((version) => version.status !== 'draft');
  const deltas = preloadedDeltas ?? (await versionHoldDeltas(visibleVersions.map((version) => Number(version.id))));

  const [enrichedBoard] = await enrichBoards([{ board }], userId ?? undefined);

  const versions = await Promise.all(
    visibleVersions.map((version) => toGraphQLVersion(version, deltas.get(Number(version.id)))),
  );

  // The SAME object the `versions` list carries, not a second render of the same
  // row: `toGraphQLVersion` presigns the photo, so building it twice minted two
  // signatures (and two more for the thumbnail) for one version on every wall read.
  // The current version is always published, so it is never filtered out of
  // `visibleVersions` and this find only misses on a wall that has no published
  // version yet.
  const currentVersion = versions.find((version) => version.id === String(wall.currentVersionId)) ?? null;
  // An archived wall refuses every climb write, so nobody is offered one. This is
  // what keeps an app that predates archiving from showing an edit button that
  // can only fail.
  const viewerCanEditClimbs =
    wall.archivedAt == null && (await computeCanEditClimbs(userId, wall, board, canEdit, presentedWallUuid));

  const archiveFacts = preloadedArchiveFacts ?? (await loadSprayWallArchiveFacts([wall]));
  const source = wall.resetFromWallId == null ? undefined : archiveFacts.sourcesById.get(wall.resetFromWallId);
  const successor = archiveFacts.successorsBySourceId.get(wall.id);

  return {
    uuid: board.uuid,
    board: enrichedBoard,
    layoutId: wall.layoutId,
    sizeId: spraySizeIdForLayout(wall.layoutId),
    referenceWidth: wall.referenceWidth,
    referenceHeight: wall.referenceHeight,
    currentVersion,
    versions,
    holdCount: wall.holdCount,
    publicPhotoUrl: publicWallPhotoUrl(board, wall),
    viewerCanEdit: canEdit,
    climbEditPolicy: SPRAY_CLIMB_EDIT_POLICY_WIRE_NAME[wall.climbEditPolicy ?? 'setter'],
    viewerCanEditClimbs,
    // Only ever non-null for the owner: `loadVisibleWall` refuses a hidden wall to
    // everybody else, so nobody else can reach this field to read it.
    hiddenAt: wall.hiddenAt ? wall.hiddenAt.toISOString() : null,
    renderSettings: wall.renderSettings ?? null,
    archivedAt: wall.archivedAt ? wall.archivedAt.toISOString() : null,
    resetOfWallUuid:
      source && (await viewerCanSeeSprayWallByLayout(source.wall, source.board, userId)) ? source.board.uuid : null,
    replacedByWallUuid:
      successor && (await viewerMayFollowToSuccessor(loaded, successor, userId)) ? successor.board.uuid : null,
    holdsLocked: wall.archivedAt != null || archiveFacts.layoutsWithPublishedClimbs.has(wall.layoutId),
  };
}

/**
 * What `toGraphQLWall` needs to answer the archive and reset fields, for a set of
 * walls in a fixed number of queries rather than three per wall.
 */
type SprayWallArchiveFacts = {
  /** Layout ids of the walls that have at least one published (non-draft) climb. */
  layoutsWithPublishedClimbs: Set<number>;
  /** The live wall each clone was made from, by the clone's `reset_from_wall_id`. */
  sourcesById: Map<number, LoadedWall>;
  /** The live, PUBLISHED clone that replaced each wall, by the replaced wall's id. */
  successorsBySourceId: Map<number, LoadedWall>;
};

async function loadSprayWallArchiveFacts(walls: SprayWallRow[]): Promise<SprayWallArchiveFacts> {
  const facts: SprayWallArchiveFacts = {
    layoutsWithPublishedClimbs: new Set(),
    sourcesById: new Map(),
    successorsBySourceId: new Map(),
  };
  if (walls.length === 0) return facts;

  const sourceIds = [...new Set(walls.map((wall) => wall.resetFromWallId).filter((sourceId) => sourceId != null))];
  const [climbLayouts, sources, successors] = await Promise.all([
    // A semi-join, one EXISTS per wall: each stops at the first published climb
    // it finds on `board_climbs_layout_filter_idx` (board_type, layout_id,
    // is_listed, is_draft), so a wall with thousands of climbs costs one probe.
    db
      .select({ layoutId: dbSchema.sprayWalls.layoutId })
      .from(dbSchema.sprayWalls)
      .where(
        and(
          inArray(
            dbSchema.sprayWalls.id,
            walls.map((wall) => wall.id),
          ),
          exists(
            db
              .select({ uuid: dbSchema.boardClimbs.uuid })
              .from(dbSchema.boardClimbs)
              .where(
                and(
                  eq(dbSchema.boardClimbs.boardType, 'spray'),
                  eq(dbSchema.boardClimbs.layoutId, dbSchema.sprayWalls.layoutId),
                  eq(dbSchema.boardClimbs.isDraft, false),
                ),
              ),
          ),
        ),
      ),
    sourceIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
          .from(dbSchema.sprayWalls)
          .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
          .where(
            and(
              inArray(dbSchema.sprayWalls.id, sourceIds),
              isNull(dbSchema.sprayWalls.deletedAt),
              isNull(dbSchema.userBoards.deletedAt),
            ),
          ),
    // Only a PUBLISHED clone has replaced anything: an unfinished one is still
    // the owner's wizard, and the wall it would replace is live.
    db
      .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
      .from(dbSchema.sprayWalls)
      .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
      .where(
        and(
          inArray(
            dbSchema.sprayWalls.resetFromWallId,
            walls.map((wall) => wall.id),
          ),
          isNotNull(dbSchema.sprayWalls.currentVersionId),
          isNull(dbSchema.sprayWalls.deletedAt),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(asc(dbSchema.sprayWalls.id)),
  ]);

  for (const row of climbLayouts) facts.layoutsWithPublishedClimbs.add(row.layoutId);
  for (const row of sources) facts.sourcesById.set(row.wall.id, row);
  // Ascending, so the newest successor wins if a wall somehow has two.
  for (const row of successors) {
    if (row.wall.resetFromWallId != null) facts.successorsBySourceId.set(row.wall.resetFromWallId, row);
  }
  return facts;
}

/**
 * Whether a viewer of a wall may be told the uuid of the wall that REPLACED it
 * (`replacedByWallUuid`).
 *
 * The by-layout rule on the successor (its owner, a member of its gym, or a
 * public wall), because the viewer did not reach the successor by uuid, and a
 * uuid is the capability that opens an unlisted wall. Plus one carry-forward:
 * when the old wall is unlisted and NOT public, and the successor is unlisted
 * too, a crew holding the old share link may follow it to the new wall. That is
 * the audience the owner already gave the old link to, and without it every
 * share link would dead-end at the archive. A public old wall carries nobody
 * forward this way: its viewers did not need a link to get there.
 *
 * Old to new only. The reverse link (`resetOfWallUuid`) uses the by-layout rule
 * alone, so the new wall's link never hands out the old wall's capability.
 */
async function viewerMayFollowToSuccessor(
  archived: LoadedWall,
  successor: LoadedWall,
  userId: string | null | undefined,
): Promise<boolean> {
  if (await viewerCanSeeSprayWallByLayout(successor.wall, successor.board, userId)) return true;
  return (
    successor.wall.hiddenAt == null &&
    archived.wall.hiddenAt == null &&
    archived.board.isUnlisted &&
    !archived.board.isPublic &&
    successor.board.isUnlisted
  );
}

/**
 * Whether the viewer can edit published climbs on this wall (#6025).
 * True for wall editors (canEdit), and — when policy is 'collaborators' — also
 * for anyone who can set climbs on the wall (viewerCanWriteSprayClimbs).
 */
async function computeCanEditClimbs(
  userId: string | null | undefined,
  wall: SprayWallRow,
  board: UserBoardRow,
  canEdit: boolean,
  presentedWallUuid?: string | null,
): Promise<boolean> {
  if (canEdit) return true;
  if (!userId) return false;
  if (wall.climbEditPolicy === 'collaborators') {
    return viewerCanWriteSprayClimbs(wall, board, userId, presentedWallUuid);
  }
  return false;
}

/** Whether the caller can edit, without throwing — the `viewerCanEdit` field. */
async function computeCanEdit(ctx: ConnectionContext, board: UserBoardRow): Promise<boolean> {
  if (!ctx.isAuthenticated || !ctx.userId) return false;
  return canEditBoard(ctx.userId, board);
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
 *
 * Takes an executor because it has to be re-run INSIDE the wall lock. Reading it
 * outside is a fast path that returns a nicer error for the common case; the read
 * that decides is the one under the lock.
 */
async function loadDraftVersion(
  executor: SprayWriteExecutor,
  wallId: number,
  versionId: number,
): Promise<SprayWallVersionRow> {
  const [version] = await executor
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

/** The published source is re-read under the wall lock for every publishing decision. */
async function draftPurpose(executor: SprayWriteExecutor, wallId: number, version: SprayWallVersionRow) {
  const [published] = await executor
    .select({ version: dbSchema.sprayWallVersions })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.sprayWallVersions, eq(dbSchema.sprayWalls.currentVersionId, dbSchema.sprayWallVersions.id))
    .where(eq(dbSchema.sprayWalls.id, wallId))
    .limit(1);
  const photo = (row: SprayWallVersionRow) => ({
    photoIdentity: row.photoKey,
    width: row.photoWidth,
    height: row.photoHeight,
    anchors: row.anchors,
    homography: row.homography,
  });
  return classifySprayDraft(photo(version), published ? photo(published.version) : null);
}

function wrongDraftPurposeError() {
  return new GraphQLError('This draft belongs to a different wall-editing flow. Reopen the matching editor.', {
    extensions: { code: SPRAY_WALL_CODES.draftPurposeMismatch },
  });
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

/**
 * `Cache-Control` for a public wall's photo copy.
 *
 * Immutable is safe here and nowhere else in this feature: the key carries 128
 * random bits and is never reused, so the bytes behind one URL never change.
 * Demotion deletes the object AND forgets the key, and the next promotion mints
 * a new one — so a cache that holds the old URL for a year is holding a URL that
 * no longer resolves and that nothing will ever point at again.
 */
const PUBLIC_PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The private-bucket photo key of the wall's published version, if it has one. */
async function publishedPhotoKey(wall: SprayWallRow): Promise<string | null> {
  if (wall.currentVersionId == null) return null;
  const [version] = await db
    .select({ photoKey: dbSchema.sprayWallVersions.photoKey })
    .from(dbSchema.sprayWallVersions)
    .where(eq(dbSchema.sprayWallVersions.id, wall.currentVersionId))
    .limit(1);
  return version?.photoKey ?? null;
}

/**
 * Copy a wall photo from the private bucket into the public `media` one, under a
 * fresh random key.
 *
 * Null — never a throw — when there is nothing to copy or nowhere to copy it to:
 * a wall with no published photo yet, a backend with no `media` bucket, a source
 * object that has gone. Going public is a visibility decision and it must not
 * fail because object storage is unconfigured in this environment; the wall goes
 * public, its climbs start reaching feeds, and `publicPhotoUrl` is null until a
 * publish copies one. The alternative — refusing the whole mutation — would make
 * a local backend unable to share a wall at all.
 */
async function copyWallPhotoToPublicBucket(boardUuid: string, photoKey: string | null): Promise<string | null> {
  if (!photoKey) return null;
  if (!isS3Configured('private') || !isS3Configured('media')) {
    logger.warn('Spray wall went public with no public bucket to copy its photo into', { boardUuid });
    return null;
  }

  const publicKey = sprayWallPublicPhotoKey(boardUuid);
  const copied = await copyObjectBetweenBuckets('private', photoKey, 'media', publicKey, {
    contentType: SPRAY_PHOTO_CONTENT_TYPE,
    cacheControl: PUBLIC_PHOTO_CACHE_CONTROL,
  });

  if (!copied) {
    logger.warn('Spray wall photo was missing when the wall went public', { boardUuid, photoKey });
    return null;
  }
  return copied.key;
}

/**
 * Delete a wall's public photo copy, best effort.
 *
 * Best effort because the row is the source of truth for whether a wall is
 * public: once `public_photo_key` is null, nothing in Boardsesh hands that URL
 * out again. A failed delete leaves an object nobody links to under a key nobody
 * can guess — worth a loud log and the SW-17 sweep, not worth failing a climber's
 * "make this private" on.
 */
async function deletePublicWallPhoto(key: string | null | undefined): Promise<void> {
  if (!key || !isS3Configured('media')) return;
  try {
    await deleteFromS3('media', key);
  } catch (error) {
    logger.error('Failed to delete a spray wall public photo copy', { key }, error);
    // Public copies staged before deletion can finish after the prefix purge.
    // Failed cleanup must re-open that tombstone's durable retry marker.
    const wallUuid = /^spray-walls\/([^/]+)\//.exec(key)?.[1];
    if (wallUuid) {
      try {
        await markDeletedSprayWallPhotoRetry(wallUuid);
      } catch (retryError) {
        logger.error('Failed to mark withdrawn public photo for erasure retry', { wallUuid }, retryError);
      }
    }
  }
}

/**
 * The stable, unsigned URL for a public wall's photo, or null.
 *
 * Null for every wall that is not public, whatever `public_photo_key` says — the
 * row is only ever written together with the flag, but this field is what a web
 * page and a crawler read, so it re-asserts the rule rather than trusting the
 * pair to be consistent.
 *
 * Null for a HIDDEN wall too, owner included. Hidden reads as private, and a
 * private wall has no public URL for anybody; the owner's own reads use the
 * presigned private photo, not this.
 */
function publicWallPhotoUrl(board: UserBoardRow, wall: SprayWallRow): string | null {
  if (!board.isPublic || wall.hiddenAt != null || !wall.publicPhotoKey || !isS3Configured('media')) return null;
  try {
    return getPublicUrl('media', wall.publicPhotoKey);
  } catch (error) {
    logger.warn('Spray wall public photo has no derivable URL', { layoutId: wall.layoutId }, error);
    return null;
  }
}

/**
 * Re-point a public wall's public photo copy at a newly published version.
 *
 * Copy first, then write, then delete the object the write replaced: a failure
 * between the copy and the write leaves an orphan in `media` (harmless, and swept
 * by SW-17), where the other order leaves a public wall whose photo URL 404s.
 *
 * Everything else here is about WHERE this runs: after the publish transaction has
 * committed and released the wall lock, because copying an object is a network
 * round trip and the lock must not be held across one. By the time the copy
 * finishes the wall may have moved on, in three ways:
 *
 *  - **Two publishes overtaking each other.** The copy takes as long as the photo
 *    is big, so an older publish's copy can land last and attach last year's wall
 *    to the row.
 *  - **A demotion committing first.** `updateSprayWall` going private nulls the key
 *    and deletes the object; an unconditional write after that would put a fresh
 *    world-readable object and a live `publicPhotoUrl` back onto a wall that is now
 *    private. That is a leak, not an orphan.
 *  - **Read-then-write on the key itself.** Two refreshes that each SELECT the
 *    previous key before either UPDATEs both believe they replaced it, so one new
 *    object is left in `media` with nothing pointing at it.
 *
 * So the guard, the read and the write are ONE row-locked statement: it locks the
 * wall row, re-checks under that lock that `publishedVersionId` is still the
 * published generation and that the board is still public and undeleted, writes the
 * new key, and returns the key it replaced. Raw `sql` because the query builder
 * cannot express `UPDATE … FROM (SELECT … FOR UPDATE) … RETURNING <the value from
 * before the update>`, and splitting it into a `.select()` plus an `.update()` is
 * exactly the gap being closed.
 *
 * No row back means the conditions stopped holding: nothing is written, and the
 * copy just made is deleted rather than left in a world-readable bucket. Never
 * throws — the caller has already committed the publish.
 */
export async function refreshPublicWallPhoto(
  wallId: number,
  boardUuid: string,
  photoKey: string | null,
  /**
   * The version this refresh is FOR — `spray_wall_versions.id` of the generation
   * whose publish started it. The write is skipped if the wall has moved past it.
   */
  publishedVersionId: number,
): Promise<void> {
  let nextKey: string | null = null;
  try {
    // One retry on a THROW, never on a null (a null means there is nothing to
    // copy, which a second try will not change). This runs after the publish has
    // committed, and a resumed first publish has no later call from the client
    // to heal a failed copy with (#5513) — so one transient object-storage error
    // should not be enough to leave a public wall without a photo.
    try {
      nextKey = await copyWallPhotoToPublicBucket(boardUuid, photoKey);
    } catch (firstError) {
      logger.warn('Retrying a spray wall public photo copy', { boardUuid }, firstError);
      nextKey = await copyWallPhotoToPublicBucket(boardUuid, photoKey);
    }
    if (!nextKey) return;

    const result = await db.execute(sql`
      UPDATE spray_walls
      SET public_photo_key = ${nextKey}, updated_at = now()
      FROM (
        SELECT locked.id, locked.public_photo_key
        FROM spray_walls AS locked
        JOIN user_boards AS board ON board.uuid = locked.board_uuid
        WHERE locked.id = ${wallId}
          AND locked.current_version_id = ${publishedVersionId}
          AND locked.deleted_at IS NULL
          -- An admin-hidden wall reads as private to everybody but its owner, so
          -- its photo has no business in the world-readable bucket either.
          AND locked.hidden_at IS NULL
          AND board.is_public = true
          AND board.deleted_at IS NULL
        FOR UPDATE OF locked
      ) AS previous
      WHERE spray_walls.id = previous.id
      RETURNING previous.public_photo_key AS previous_public_photo_key
    `);

    const [replaced] = rowsFromResult<{ previous_public_photo_key: string | null }>(result);
    if (!replaced) {
      // A newer publish, a demotion or a delete won the race. Its own bookkeeping
      // is correct; this copy is the one with nothing pointing at it.
      logger.info('Skipped a public spray wall photo refresh the wall had moved past', {
        boardUuid,
        publishedVersionId,
      });
      await deletePublicWallPhoto(nextKey);
      return;
    }

    if (replaced.previous_public_photo_key && replaced.previous_public_photo_key !== nextKey) {
      await deletePublicWallPhoto(replaced.previous_public_photo_key);
    }
  } catch (error) {
    // The copy is NOT deleted here, deliberately. A throw out of the statement
    // leaves it unknowable whether the row took the key, and deleting an object a
    // committed row points at would 404 a legitimately public wall's photo — worse
    // than the orphan, which SW-17 sweeps. Only the "no row back" path above knows
    // the write did not happen, and only it deletes.
    logger.error('Failed to refresh a public spray wall photo after a publish', { boardUuid, nextKey }, error);
    // An uncertain live-wall write must retain its copy. If account deletion
    // won, reopen its durable purge instead: the copy may postdate that purge.
    try {
      await markDeletedSprayWallPhotoRetry(boardUuid);
    } catch (retryError) {
      logger.error('Failed to reopen deleted spray wall photo cleanup', { boardUuid }, retryError);
    }
  }
}

/**
 * Drop every already-materialised feed row for a wall's climbs.
 *
 * The read gates keep a private wall out of the feeds from now on, but
 * `feed_items` is a MATERIALISED fan-out: rows written while the wall was public
 * sit in each follower's feed and are served straight from that table, with no
 * further look at the wall. So making a wall private — or deleting it — has to
 * retract what was already handed out, or "private" only means "private to people
 * who were not following you at the time".
 *
 * Both event shapes, because both carry the climb: `climb.created` files under
 * `entity_type = 'climb'` keyed on the climb uuid, and `ascent.logged` under
 * `'tick'` keyed on the tick uuid.
 *
 * Runs in the caller's transaction so the visibility flip and the retraction land
 * together — a crash between them would leave the wall private and its feed rows
 * standing.
 */
export async function purgeSprayWallFeedItems(tx: SprayWriteExecutor, layoutId: number): Promise<number> {
  const wallClimbUuids = tx
    .select({ uuid: dbSchema.boardClimbs.uuid })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.boardType, 'spray'), eq(dbSchema.boardClimbs.layoutId, layoutId)));

  const wallTickUuids = tx
    .select({ uuid: dbSchema.boardseshTicks.uuid })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        eq(dbSchema.boardseshTicks.boardType, 'spray'),
        inArray(
          dbSchema.boardseshTicks.climbUuid,
          tx
            .select({ uuid: dbSchema.boardClimbs.uuid })
            .from(dbSchema.boardClimbs)
            .where(and(eq(dbSchema.boardClimbs.boardType, 'spray'), eq(dbSchema.boardClimbs.layoutId, layoutId))),
        ),
      ),
    );

  const deleted = await tx
    .delete(dbSchema.feedItems)
    .where(
      or(
        and(eq(dbSchema.feedItems.entityType, 'climb'), inArray(dbSchema.feedItems.entityId, wallClimbUuids)),
        and(eq(dbSchema.feedItems.entityType, 'tick'), inArray(dbSchema.feedItems.entityId, wallTickUuids)),
      ),
    )
    .returning({ id: dbSchema.feedItems.id });
  return deleted.length;
}

/**
 * What a publish did: the now-published row, and how many climbs' integrity
 * numbers moved as a result.
 *
 * A named type rather than an inline one because `spray-wall-write-locks.test.ts`
 * finds a function's body by taking the first `{` after its parameter list, and an
 * inline object in the RETURN type gets there first — so the guard would read the
 * return type as the body and report that this function never locks.
 */
type PublishedDraft = {
  version: SprayWallVersionRow;
  climbsChanged: number;
  /** The creation-time visibility this publish applied to the board row, or null (#5513). */
  appliedVisibility: PendingVisibility | null;
};

/** The pair `createSprayWall` parks on `spray_walls.pending_is_*` until the first publish. */
type PendingVisibility = { isPublic: boolean; isUnlisted: boolean };

/**
 * The `spray_walls` columns that hold a creation-time visibility request.
 *
 * Both NULL when the climber left the wall private — nothing to apply, and the
 * board row already says so. Otherwise always the full pair, so the publish that
 * applies it never has to guess the half a client left out.
 */
function pendingVisibilityColumns(input: { isPublic?: boolean; isUnlisted?: boolean }): {
  pendingIsPublic: boolean | null;
  pendingIsUnlisted: boolean | null;
} {
  const isPublic = input.isPublic ?? false;
  const isUnlisted = input.isUnlisted ?? false;
  if (!isPublic && !isUnlisted) return { pendingIsPublic: null, pendingIsUnlisted: null };
  return { pendingIsPublic: isPublic, pendingIsUnlisted: isUnlisted };
}

/**
 * How far a visibility pair reaches, lowest first. A public wall that is also
 * unlisted is public by layout but kept out of search, so it ranks below a plain
 * public one.
 */
function visibilityReach(visibility: PendingVisibility): number {
  if (visibility.isPublic) return visibility.isUnlisted ? 2 : 3;
  return visibility.isUnlisted ? 1 : 0;
}

/**
 * The visibility a reset clone publishes with: the NARROWER of what was parked
 * when the reset started and what the old wall has now. Private beats unlisted
 * beats public, and a tie keeps the parked pair.
 *
 * Takes the old wall's lock first, so a visibility change to it either lands
 * before this read or waits for the publish. The publish already holds the
 * clone's lock: new wall, then old wall, the order every two-lock path uses. A
 * deleted old wall has no audience left to follow, so the parked pair stands.
 */
async function narrowToResetSourceUnderLock(
  tx: SprayWriteTransaction,
  sourceWallId: number,
  parked: PendingVisibility,
): Promise<PendingVisibility> {
  await lockWallForWrite(tx, sourceWallId);
  const [source] = await tx
    .select({ isPublic: dbSchema.userBoards.isPublic, isUnlisted: dbSchema.userBoards.isUnlisted })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        eq(dbSchema.sprayWalls.id, sourceWallId),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);
  if (!source) return parked;
  return visibilityReach(source) < visibilityReach(parked) ? source : parked;
}

/** Rows per INSERT when follows and pins carry over, well under Postgres's 65535 parameters. */
const CARRY_OVER_BATCH_SIZE = 1000;

/**
 * Archive the wall a reset clone replaces, and carry its follows and pins over
 * to the clone. Called from `publishDraftUnderLock` on the clone's first publish.
 *
 * ## Lock order
 *
 * The CLONE's lock is already held (the publish took it), and this takes the
 * SOURCE's. New wall first, then old wall, always. A clone is inserted after its
 * source exists, so its `bigserial` id is always the higher of the two, and
 * `deleteAccountSprayWalls` — the only other path that holds two wall locks at
 * once — walks walls by id DESCENDING to take them in the same order.
 * `resetSprayWall` holds the source's lock but never the clone's.
 *
 * ## What carries over
 *
 * Only to people the clone is shared with, so a reset cannot put a wall in front
 * of someone its owner has not shown it to. A follow, and a new-climb
 * subscription (keyed by layout, so the old one would never fire again), carry
 * over on the rule `followBoard` enforces (a public board, or its owner). A pin carries over to
 * the owner, to everyone when the board is public, and to members of its gym.
 * An unlisted wall's crew follows the `replacedByWallUuid` link instead.
 *
 * A wall already archived or deleted is left alone, and then nothing is carried:
 * those follows were never this clone's to take.
 */
async function archiveResetSourceUnderLock(
  tx: SprayWriteTransaction,
  sourceWallId: number,
  successor: { boardUuid: string; layoutId: number },
): Promise<void> {
  const successorBoardUuid = successor.boardUuid;
  await lockWallForWrite(tx, sourceWallId);

  const archivedAt = new Date();
  const [archived] = await tx
    .update(dbSchema.sprayWalls)
    // `updated_at` too: it is what tells every cached and offline copy of the
    // wall that something about it changed.
    .set({ archivedAt, updatedAt: archivedAt })
    .where(
      and(
        eq(dbSchema.sprayWalls.id, sourceWallId),
        isNull(dbSchema.sprayWalls.archivedAt),
        isNull(dbSchema.sprayWalls.deletedAt),
      ),
    )
    .returning({ boardUuid: dbSchema.sprayWalls.boardUuid, layoutId: dbSchema.sprayWalls.layoutId });
  if (!archived) return;

  const [successorBoard] = await tx
    .select({
      ownerId: dbSchema.userBoards.ownerId,
      isPublic: dbSchema.userBoards.isPublic,
      gymId: dbSchema.userBoards.gymId,
    })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.uuid, successorBoardUuid))
    .limit(1);
  if (!successorBoard) return;

  const followers = await tx
    .select({ userId: dbSchema.boardFollows.userId, createdAt: dbSchema.boardFollows.createdAt })
    .from(dbSchema.boardFollows)
    .where(eq(dbSchema.boardFollows.boardUuid, archived.boardUuid));
  const carriedFollows = followers.filter(
    (follow) => successorBoard.isPublic || follow.userId === successorBoard.ownerId,
  );
  for (let offset = 0; offset < carriedFollows.length; offset += CARRY_OVER_BATCH_SIZE) {
    await tx
      .insert(dbSchema.boardFollows)
      .values(
        carriedFollows.slice(offset, offset + CARRY_OVER_BATCH_SIZE).map((follow) => ({
          userId: follow.userId,
          boardUuid: successorBoardUuid,
          createdAt: follow.createdAt,
        })),
      )
      .onConflictDoNothing();
  }

  // "Tell me about new climbs" is keyed by layout, and the new wall has a new
  // layout. Same audience rule as a follow: it announces the wall's climbs.
  const subscribers = await tx
    .select({ userId: dbSchema.newClimbSubscriptions.userId, createdAt: dbSchema.newClimbSubscriptions.createdAt })
    .from(dbSchema.newClimbSubscriptions)
    .where(
      and(
        eq(dbSchema.newClimbSubscriptions.boardType, 'spray'),
        eq(dbSchema.newClimbSubscriptions.layoutId, archived.layoutId),
      ),
    );
  const carriedSubscriptions = subscribers.filter(
    (subscription) => successorBoard.isPublic || subscription.userId === successorBoard.ownerId,
  );
  for (let offset = 0; offset < carriedSubscriptions.length; offset += CARRY_OVER_BATCH_SIZE) {
    await tx
      .insert(dbSchema.newClimbSubscriptions)
      .values(
        carriedSubscriptions.slice(offset, offset + CARRY_OVER_BATCH_SIZE).map((subscription) => ({
          userId: subscription.userId,
          boardType: 'spray',
          layoutId: successor.layoutId,
          createdAt: subscription.createdAt,
        })),
      )
      .onConflictDoNothing();
  }

  const pins = await tx
    .select({ userId: dbSchema.userBoardActivity.userId, pinnedAt: dbSchema.userBoardActivity.pinnedAt })
    .from(dbSchema.userBoardActivity)
    .where(
      and(eq(dbSchema.userBoardActivity.boardUuid, archived.boardUuid), isNotNull(dbSchema.userBoardActivity.pinnedAt)),
    );
  const gymMemberIds = new Set<string>();
  if (!successorBoard.isPublic && successorBoard.gymId != null && pins.length > 0) {
    const members = await tx
      .select({ userId: dbSchema.gymMembers.userId })
      .from(dbSchema.gymMembers)
      .where(
        and(
          eq(dbSchema.gymMembers.gymId, successorBoard.gymId),
          inArray(
            dbSchema.gymMembers.userId,
            pins.map((pin) => pin.userId),
          ),
        ),
      );
    for (const member of members) gymMemberIds.add(member.userId);
  }
  const carriedPins = pins.filter(
    (pin) => successorBoard.isPublic || pin.userId === successorBoard.ownerId || gymMemberIds.has(pin.userId),
  );
  for (let offset = 0; offset < carriedPins.length; offset += CARRY_OVER_BATCH_SIZE) {
    await tx
      .insert(dbSchema.userBoardActivity)
      .values(
        carriedPins.slice(offset, offset + CARRY_OVER_BATCH_SIZE).map((pin) => ({
          userId: pin.userId,
          boardUuid: successorBoardUuid,
          pinnedAt: pin.pinnedAt,
        })),
      )
      // Not DO NOTHING: the owner has usually opened the clone while setting it
      // up, which writes an activity row with no pin. Fill the pin in, and keep
      // a pin the clone already has.
      .onConflictDoUpdate({
        target: [dbSchema.userBoardActivity.userId, dbSchema.userBoardActivity.boardUuid],
        set: {
          pinnedAt: sql`COALESCE(${dbSchema.userBoardActivity.pinnedAt}, excluded.pinned_at)`,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Publish a draft version: supersede the previous generation, flip this one to
 * `published`, refresh what the wall advertises, and re-materialise every climb's
 * integrity number. One sequence, called from `publishSprayWallVersion` (a plain
 * publish) and from `commitSprayWallVersion` (a reset that has just written its
 * decisions in the same transaction).
 *
 * It takes the wall lock itself. `pg_advisory_xact_lock` is re-entrant within a
 * transaction, so a caller that already holds it pays nothing — and a caller that
 * forgot cannot land a publish without it.
 *
 * Everything it decides on is re-read INSIDE the lock, because both callers check
 * the same things outside it for a nicer error and both of those checks can be
 * stale by the time the transaction opens.
 */
async function publishDraftUnderLock(
  tx: SprayWriteTransaction,
  wall: Pick<SprayWallRow, 'id' | 'layoutId'>,
  versionId: number,
): Promise<PublishedDraft> {
  await lockWallForWrite(tx, wall.id);

  // Re-read under the lock: an interleaved publish or a hold edit may have landed
  // since the caller's fast-path check, and publishing a version twice would
  // supersede the wrong generation.
  const draft = await loadDraftVersion(tx, wall.id, versionId);

  // …and re-read the wall, because `current_version_id` is what the supersede
  // below keys on and a concurrent publish moves it.
  //
  // …and scoped to a LIVE wall. `loadEditableWall` ran before the transaction
  // opened, and `deleteSprayWall` takes this same lock — so a delete cannot
  // interleave inside it, but one that committed in the window between the authz
  // read and this lock is entirely possible. Without the `deleted_at` scope the
  // row still comes back and the publish lands on a wall nobody can reach; with
  // it, the row is absent, and an absent row has to be an error rather than
  // `wallNow?.currentVersionId == null`, which both guards below would read as
  // "nothing published yet" and publish straight through.
  const [wallNow] = await tx
    .select({
      currentVersionId: dbSchema.sprayWalls.currentVersionId,
      boardUuid: dbSchema.sprayWalls.boardUuid,
      pendingIsPublic: dbSchema.sprayWalls.pendingIsPublic,
      pendingIsUnlisted: dbSchema.sprayWalls.pendingIsUnlisted,
      resetFromWallId: dbSchema.sprayWalls.resetFromWallId,
    })
    .from(dbSchema.sprayWalls)
    .where(and(eq(dbSchema.sprayWalls.id, wall.id), isNull(dbSchema.sprayWalls.deletedAt)))
    .limit(1);
  if (!wallNow) throw notFoundError();

  // Publishing a version that is not NEWER than the published one would walk
  // `current_version_id` backwards, and every hold read is bounded by the
  // published version NUMBER — so the wall would silently revert to an older
  // generation and climbs set since would point at holds that are no longer
  // alive. The one-draft rule makes this unreachable today; the guard stays
  // because it is the invariant, not a consequence of that rule.
  if (wallNow?.currentVersionId != null) {
    const [publishedNow] = await tx
      .select({ versionNumber: dbSchema.sprayWallVersions.versionNumber })
      .from(dbSchema.sprayWallVersions)
      .where(eq(dbSchema.sprayWallVersions.id, wallNow.currentVersionId))
      .limit(1);
    if (publishedNow != null && draft.versionNumber <= publishedNow.versionNumber) {
      throw new GraphQLError(
        `This wall is already published at version ${publishedNow.versionNumber}, ` +
          `so version ${draft.versionNumber} cannot replace it.`,
        { extensions: { code: SPRAY_WALL_CODES.publishWouldGoBackwards } },
      );
    }
  }

  // The previous published generation becomes `superseded` — it is still the
  // generation older climbs were set against, so it is never deleted.
  if (wallNow?.currentVersionId != null) {
    const superseded = await tx
      .update(dbSchema.sprayWallVersions)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(dbSchema.sprayWallVersions.id, wallNow.currentVersionId),
          eq(dbSchema.sprayWallVersions.status, 'published'),
        ),
      )
      .returning({ id: dbSchema.sprayWallVersions.id });

    // The `status = 'published'` half of that WHERE is a guard, and a guard that
    // matches nothing used to be a silent no-op: the publish below moved
    // `current_version_id` on anyway and the old generation kept whatever status
    // it had, so the wall ended with two published versions or with a
    // `current_version_id` pointing at a superseded row — an inconsistency no
    // later read can distinguish from the real thing. Fail loudly instead; the
    // state is not reachable through this API, so it means a hand-edited row.
    if (superseded.length === 0) {
      throw new GraphQLError('This wall\u2019s published version is in an unexpected state. Reload and try again.', {
        extensions: {
          code: SPRAY_WALL_CODES.versionNotDraft,
          currentVersionId: String(wallNow.currentVersionId),
        },
      });
    }
  }

  const [row] = await tx
    .update(dbSchema.sprayWallVersions)
    .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(dbSchema.sprayWallVersions.id, draft.id))
    .returning();

  // Counted AS OF the version being published, not as `removed_version_id IS
  // NULL`. A wall can carry more than one draft at a time, and a raw still-alive
  // count would fold another draft's unpublished additions into the number
  // climbers see.
  const alive = (await aliveHolds(tx, wall.id, row.versionNumber)).length;

  // The visibility the owner picked when they created the wall, applied now that
  // there is something to see (#5513). It is the OWNER's choice even when a gym
  // admin presses publish: only the owner creates a wall, and only the owner can
  // change a pending request (`updateSprayWall` clears it).
  //
  // FIRST publish only, decided on `current_version_id` read under the lock above
  // rather than on the pair being non-null. The pair is also nulled on every
  // publish below, but "exactly once" must not rest on every earlier writer having
  // cleared it: a backend rolled back across this change publishes and changes
  // visibility without knowing the columns exist, and a pair left standing through
  // that would otherwise overturn the owner's later choice on their next reset.
  const isFirstPublish = wallNow.currentVersionId == null;
  const parkedVisibility: PendingVisibility | null =
    isFirstPublish && (wallNow.pendingIsPublic != null || wallNow.pendingIsUnlisted != null)
      ? { isPublic: wallNow.pendingIsPublic === true, isUnlisted: wallNow.pendingIsUnlisted === true }
      : null;
  // A reset clone parked the OLD wall's audience when the reset started. The
  // owner may have narrowed the old wall since, and the new wall must never
  // reach further than the old one does now.
  const appliedVisibility =
    parkedVisibility && wallNow.resetFromWallId != null
      ? await narrowToResetSourceUnderLock(tx, wallNow.resetFromWallId, parkedVisibility)
      : parkedVisibility;
  if (appliedVisibility) {
    await tx
      .update(dbSchema.userBoards)
      .set({ isPublic: appliedVisibility.isPublic, isUnlisted: appliedVisibility.isUnlisted })
      .where(eq(dbSchema.userBoards.uuid, wallNow.boardUuid));
  }

  await tx
    .update(dbSchema.sprayWalls)
    .set({
      currentVersionId: row.id,
      holdCount: alive,
      pendingIsPublic: null,
      pendingIsUnlisted: null,
      updatedAt: new Date(),
    })
    .where(eq(dbSchema.sprayWalls.id, wall.id));

  // A reset clone's first publish is the moment it replaces the wall it was
  // cloned from: the old wall is archived in this same transaction, so there is
  // no instant at which both walls are live or neither is. AFTER the visibility
  // apply above, because who the follows and pins carry over to depends on it.
  if (isFirstPublish && wallNow.resetFromWallId != null) {
    await archiveResetSourceUnderLock(tx, wallNow.resetFromWallId, {
      boardUuid: wallNow.boardUuid,
      layoutId: wall.layoutId,
    });
  }

  // The catalogue's join row carries the image filename every board reader looks
  // for. It is the PRIVATE-bucket key, not a URL: nothing may serve a wall photo
  // without minting a signature first, so storing a URL here would be an
  // invitation to skip that step.
  if (row.photoKey) {
    await tx
      .update(dbSchema.boardProductSizesLayoutsSets)
      .set({ imageFilename: row.photoKey })
      .where(
        and(
          eq(dbSchema.boardProductSizesLayoutsSets.boardType, 'spray'),
          eq(dbSchema.boardProductSizesLayoutsSets.id, wall.layoutId),
        ),
      );
  }

  // Re-materialise every climb's integrity number. This publish is the moment a
  // removal becomes real, so without it a climb that just lost two holds reads
  // `missing_hold_count = 0` everywhere — the badge, the Intact / Lost holds
  // filter, the remix prompt and the offline mirror all say the climb is fine.
  // AFTER the status flip, because the recompute only counts removals by
  // generations that have landed, and until that update this version is a draft.
  const climbsChanged = await recomputeMissingHoldCounts(tx, wall.id);

  // The generated wall looks for the new generation, queued with the publish so
  // the job commits (or rolls back) with it. Whatever background the wall
  // shows, so the owner's picker has art to offer straight away. Refused here,
  // with no job, when the photo fails the quality gate. Never fails the publish.
  const [frame] = await tx
    .select({
      referenceWidth: dbSchema.sprayWalls.referenceWidth,
      referenceHeight: dbSchema.sprayWalls.referenceHeight,
    })
    .from(dbSchema.sprayWalls)
    .where(eq(dbSchema.sprayWalls.id, wall.id))
    .limit(1);
  if (frame) await requestSprayWallArtOn(tx, row, frame);

  if (climbsChanged > 0) {
    logger.info('Spray wall publish re-materialised climb integrity', {
      layoutId: wall.layoutId,
      versionNumber: row.versionNumber,
      climbsChanged,
    });
  }

  return { version: row, climbsChanged, appliedVisibility };
}

/**
 * How far the new photo's aspect ratio may differ from the wall's canonical
 * frame before the proposal says so. A tenth is roughly a phone turned from 4:3
 * to 3:2 — noticeable, and worth a sentence in the review, but not a reason to
 * refuse a photograph of the owner's own wall.
 */
const ASPECT_MISMATCH_TOLERANCE = 0.1;

/**
 * Whether two frames are shaped differently enough to be worth a warning.
 *
 * A WARNING and never a block (epic decision 2026-09-14). The anchors are what
 * put two photographs in one coordinate frame, and by the time detections reach
 * the server they have already been applied — so a different aspect ratio means
 * the owner stood somewhere else, not that the reset is wrong. It is still worth
 * saying, because the one case where it IS wrong (anchors tapped on the wrong
 * corners) shows up here first.
 */
export function aspectRatiosDiffer(
  frame: { width: number | null; height: number | null },
  photo: { width: number | null; height: number | null },
): boolean {
  if (!frame.width || !frame.height || !photo.width || !photo.height) return false;
  const frameRatio = frame.width / frame.height;
  const photoRatio = photo.width / photo.height;
  if (frameRatio <= 0 || photoRatio <= 0) return false;
  return Math.abs(frameRatio - photoRatio) / frameRatio > ASPECT_MISMATCH_TOLERANCE;
}

/**
 * Refuse a reset whose photo was never pinned to the wall.
 *
 * The canonical frame is version 1's photo frame, forever. Version 1 may have no
 * anchors — with nothing to compare against, the frame IS that photo and the
 * identity homography is true by definition, not a fallback. It is never
 * re-anchored later, because every hold ever drawn is already stored in it.
 *
 * That makes anchors mandatory from version 2 on. Without them
 * `resolveVersionGeometry` stores the identity matrix again, which now asserts
 * that the new photograph has the same crop, framing and dimensions as the first
 * one — an assertion nobody made and a phone will not honour. The detections then
 * arrive as raw photo pixels labelled canonical, and the matcher, which is doing
 * nothing more than comparing two coordinate sets, reports the whole wall as
 * removed and the whole photo as added. Committing that would take every hold off
 * the wall and break every climb on it.
 *
 * Checked in BOTH `proposeSprayWallReset` and `commitSprayWallVersion`: the
 * proposal is the one a human reads, and the commit is the one that writes, and a
 * client is free to skip the first.
 */
function assertResetVersionIsAnchored(version: SprayWallVersionRow): void {
  if (version.versionNumber <= 1) return;
  if (isValidAnchorQuad(version.anchors)) return;
  throw new GraphQLError(
    'Tap the four corners of the wall in the new photo before resetting — without them ' +
      'there is no way to tell where a hold has moved to.',
    { extensions: { code: SPRAY_WALL_CODES.anchorsRequired, versionNumber: version.versionNumber } },
  );
}

/** A stored hold as the matcher wants it: canonical circle plus a string key. */
function toMatcherHold(hold: SprayWallHoldRow): AliveHold {
  return { holdId: String(hold.holdId), cx: hold.cx, cy: hold.cy, r: hold.r };
}

/** A submitted detection as the matcher wants it. Colour rides along when it is there. */
function toMatcherCircle(detection: { cx: number; cy: number; r: number; colour?: number[] | null }): WallCircle {
  return detection.colour && detection.colour.length > 0
    ? { cx: detection.cx, cy: detection.cy, r: detection.r, colour: detection.colour }
    : { cx: detection.cx, cy: detection.cy, r: detection.r };
}

/**
 * How many climbs on this wall use at least one of these holds.
 *
 * Reads `board_climb_holds` rather than `missing_hold_count`, because the whole
 * point of the number is to be shown BEFORE anything is written: the column still
 * says 0 for every one of these climbs.
 *
 * **Every climb on the wall counts, drafts and community-hidden ones included.**
 * That is deliberate, and the reason is consistency with what the commit does:
 * `recomputeMissingHoldCounts` stamps every climb on the layout without looking at
 * `is_draft` or `is_hidden`, so a preview that filtered either would promise the
 * owner a smaller number than the reset delivers. On the merits too — a setter's
 * unfinished climb losing a hold is exactly as broken as a published one, and a
 * hidden climb can be unhidden, at which point its badge had better be right.
 */
async function climbsUsingHolds(layoutId: number, holdIds: number[]): Promise<number> {
  if (holdIds.length === 0) return 0;
  const [row] = await db
    .select({ affected: sql<number>`COUNT(DISTINCT ${dbSchema.boardClimbHolds.climbUuid})::int` })
    .from(dbSchema.boardClimbHolds)
    .innerJoin(
      dbSchema.boardClimbs,
      and(
        eq(dbSchema.boardClimbs.uuid, dbSchema.boardClimbHolds.climbUuid),
        eq(dbSchema.boardClimbs.boardType, 'spray'),
      ),
    )
    .where(
      and(
        eq(dbSchema.boardClimbHolds.boardType, 'spray'),
        eq(dbSchema.boardClimbs.layoutId, layoutId),
        inArray(dbSchema.boardClimbHolds.holdId, holdIds),
      ),
    );
  return Number(row?.affected ?? 0);
}

// ============================================
// Queries
// ============================================

/**
 * The version a generated-background choice is checked against: the published
 * one, or before the first publish the newest version (the wizard's draft).
 */
async function versionForArtChoice(wall: SprayWallRow): Promise<SprayWallVersionRow | undefined> {
  const [version] = await db
    .select()
    .from(dbSchema.sprayWallVersions)
    .where(
      wall.currentVersionId != null
        ? eq(dbSchema.sprayWallVersions.id, wall.currentVersionId)
        : eq(dbSchema.sprayWallVersions.wallId, wall.id),
    )
    .orderBy(desc(dbSchema.sprayWallVersions.versionNumber))
    .limit(1);
  return version;
}

export const sprayWallQueries = {
  sprayWall: async (_: unknown, { uuid }: { uuid: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWall');
    const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');

    const loaded = await loadVisibleWall(validatedUuid, ctx.userId);
    if (!loaded) return null;
    return toGraphQLWall(
      loaded,
      ctx.userId,
      await computeCanEdit(ctx, loaded.board),
      undefined,
      undefined,
      loaded.board.uuid,
    );
  },

  sprayWallByLayout: async (_: unknown, { layoutId }: { layoutId: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWallByLayout');
    if (typeof layoutId !== 'number' || !Number.isInteger(layoutId) || layoutId <= 0) {
      throw new Error('Invalid layoutId');
    }

    // NOT `viewerCanSeeSprayWall`: a layout id is a small integer from a
    // sequence, so an unlisted wall must not resolve here. See that function.
    const loaded = await loadWall('layoutId', layoutId);
    if (!loaded || !(await viewerCanSeeSprayWallByLayout(loaded.wall, loaded.board, ctx.userId))) return null;
    return toGraphQLWall(
      loaded,
      ctx.userId,
      await computeCanEdit(ctx, loaded.board),
      undefined,
      undefined,
      loaded.board.uuid,
    );
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

    const [photoFullUrl, holds] = await Promise.all([
      presignVersionFullPhoto(versionRow),
      aliveHolds(db, loaded.wall.id, versionRow.versionNumber),
    ]);
    const versionNumberById = await loadVersionNumbers(loaded.wall.id);

    return {
      wall: await toGraphQLWall(loaded, ctx.userId, canEdit, undefined, undefined, loaded.board.uuid),
      versionNumber: versionRow.versionNumber,
      // A wall always has a frame by the time it has a photo — `createSprayWallVersion`
      // writes both in one transaction — so the photo fallbacks here only fire for
      // a row hand-edited in psql.
      boardWidth: loaded.wall.referenceWidth ?? versionRow.photoWidth ?? 0,
      boardHeight: loaded.wall.referenceHeight ?? versionRow.photoHeight ?? 0,
      photo,
      photoFullUrl,
      homography: versionRow.homography ?? [...IDENTITY_HOMOGRAPHY],
      holds: holds.map((hold) => toGraphQLHold(hold, versionNumberById)),
    };
  },

  /**
   * One version's generated wall looks and its quality verdict.
   *
   * The same gate as `sprayWallRenderData`, step for step: the wall's view
   * rule, then the version rule (a draft only for an editor). Its own query so
   * a backend that predates it fails only this read, never the render payload.
   */
  sprayWallArt: async (
    _: unknown,
    { uuid, version }: { uuid: unknown; version?: number | null },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'sprayWallArt');
    const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');

    const loaded = await loadVisibleWall(validatedUuid, ctx.userId);
    if (!loaded) return null;

    const canEdit = await computeCanEdit(ctx, loaded.board);
    const versionRow = await resolveReadableVersion(loaded.wall, version, canEdit);
    if (!versionRow?.photoKey) return null;

    const liveFail = sprayVersionQuality(versionRow, loaded.wall).verdict === 'fail';
    const state = sprayWallArtState(versionRow.art, liveFail);

    // Read-time backfill: the PUBLISHED version of a wall that chose a
    // generated look, whose art is missing, from an older recipe, or failed or
    // stuck past the job's deadline. Only queued, never rendered inline; the
    // singleton key dedupes concurrent readers, and a refused photo never
    // reaches here (`requeue` is false for it).
    // Never for an ARCHIVED wall: it gets no new generation, and its readers fall
    // back to the photo when the art is missing.
    const background = loaded.wall.renderSettings?.background;
    if (
      state.requeue &&
      loaded.wall.archivedAt == null &&
      versionRow.id === loaded.wall.currentVersionId &&
      (background === 'wall-crop' || background === 'hold-cutouts')
    ) {
      const outcome = await db.transaction((tx) => requestSprayWallArtOn(tx, versionRow, loaded.wall));
      if (outcome === 'queued') return sprayWallArtView(versionRow, loaded.wall, { status: 'PENDING', requeue: false });
    }

    return sprayWallArtView(versionRow, loaded.wall, state);
  },

  /**
   * Every spray wall attached to a gym that the caller may see.
   *
   * The gate is `viewerCanSeeSprayWallByLayout`, NOT `viewerCanSeeSprayWall`: a
   * listing is an enumerable surface, so the unlisted exemption must not apply
   * here. An unlisted wall is reachable by its uuid — the share link its owner
   * sent — and appearing in a gym's public list is the one thing "unlisted"
   * promises it will not do.
   *
   * So: the gym's members see the gym's walls including the private ones, and
   * everybody else — logged out included, which is how the web gym page reads
   * this — sees only the public ones.
   */
  gymSprayWalls: async (_: unknown, { gymUuid }: { gymUuid: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'gymSprayWalls');
    const validatedGymUuid = validateInput(UUIDSchema, gymUuid, 'gymUuid');

    // Through the canonical gym, so a wall stays listed on the surviving page
    // after a duplicate-gym merge rather than disappearing with the merged uuid.
    const gym = await resolveCanonicalGymByUuid(validatedGymUuid);
    if (!gym) return [];

    const rows = await db
      .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
      .from(dbSchema.sprayWalls)
      .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
      .where(
        and(
          eq(dbSchema.userBoards.gymId, gym.id),
          isNull(dbSchema.sprayWalls.deletedAt),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(asc(dbSchema.userBoards.name));

    // One membership query for the whole page, not one per row. Every row here is
    // attached to `gym.id` — it is in the WHERE — and the viewer is fixed, so the
    // answer cannot differ between rows; asking per row was an N+1 that grew with
    // the gym's wall count. Lazily, so a page of public walls (the logged-out web
    // gym page, and the common member case) still asks nothing at all: the
    // `board.isPublic` and owner short-circuits run before the resolver is called.
    let gymMembershipAnswer: Promise<boolean> | undefined;
    const isGymMember: GymMembershipResolver = (gymId, userId) => {
      // Defensive, not expected: a row from another gym would make the memo lie,
      // so it goes straight to the database rather than borrowing this answer.
      if (gymId !== gym.id) return viewerIsGymMember(gymId, userId);
      gymMembershipAnswer ??= viewerIsGymMember(gymId, userId);
      return gymMembershipAnswer;
    };

    const visible: LoadedWall[] = [];
    for (const row of rows) {
      // Two gates, and they answer different questions. `sprayWallIsListable`
      // asks whether the wall is FINISHED — a wall with no published version has
      // no photo and no holds, so listing it offers a board nobody can climb on,
      // and only its owner sees it so they can go and finish it. The visibility
      // gate then asks who it is finished FOR.
      if (!sprayWallIsListable(row.wall, row.board, ctx.userId)) continue;
      if (await viewerCanSeeSprayWallByLayout(row.wall, row.board, ctx.userId, isGymMember)) visible.push(row);
    }

    const archiveFacts = await loadSprayWallArchiveFacts(visible.map((row) => row.wall));
    return Promise.all(
      visible.map(async (row) =>
        toGraphQLWall(
          row,
          ctx.userId,
          await computeCanEdit(ctx, row.board),
          undefined,
          undefined,
          row.board.uuid,
          archiveFacts,
        ),
      ),
    );
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

    // One version query for the whole list rather than one per wall: a climber with
    // four walls was paying four round trips for rows that come out of one index.
    const versionsByWall = await loadVersionRowsForWalls(rows.map((row) => Number(row.wall.id)));
    // …and one hold-delta pair for every version across every wall, for the same
    // reason. The caller owns these walls, so no version is filtered out below and
    // this set is exactly the one each payload needs.
    const deltas = await versionHoldDeltas([...versionsByWall.values()].flat().map((version) => Number(version.id)));
    // …and the archive and reset fields for every wall in three queries. ARCHIVED
    // walls are deliberately still here: this list is where the owner finds them.
    const archiveFacts = await loadSprayWallArchiveFacts(rows.map((row) => row.wall));

    // The caller owns every row here, so `viewerCanEdit` is true without asking.
    return Promise.all(
      rows.map((row) =>
        toGraphQLWall(
          row,
          ctx.userId,
          true,
          versionsByWall.get(Number(row.wall.id)) ?? [],
          deltas,
          row.board.uuid,
          archiveFacts,
        ),
      ),
    );
  },

  proposeSprayWallReset: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'proposeSprayWallReset');

    const validated = validateInput(ProposeSprayWallResetInputSchema, input, 'input');
    // Editor access, not view access: a proposal describes an unpublished draft,
    // and "here is what your wall would look like" is the owner's business.
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);

    // A proposal only means anything against a DRAFT. A published or superseded
    // version's holds are what climbs are already set on, so "here is what would
    // change" against one describes a commit that can never happen — and
    // `commitSprayWallVersion` would refuse it a moment later, after the owner had
    // reviewed a whole screen of decisions. Same check, same error, one step
    // earlier. No lock: nothing is written, and the commit re-reads under one.
    const draft = await loadDraftVersion(db, wall.id, validated.versionId);
    if ((await draftPurpose(db, wall.id, draft)) === 'hold-edit') throw wrongDraftPurposeError();
    assertResetVersionIsAnchored(draft);

    // The wall as CLIMBERS see it — alive at `current_version_id` — which is what
    // a reset is a reset OF. Deliberately not the draft's own view: the draft's
    // holds are whatever the last editing session left behind, and matching a new
    // photo against those would compare the detections with themselves.
    const current = await aliveHolds(db, wall.id);
    const previousAlive = current.map(toMatcherHold);
    const detections = validated.detections.map(toMatcherCircle);

    const result = matchHolds(previousAlive, detections);
    const moves = suggestMoves(previousAlive, detections, result);
    const removedHoldIds = result.removed.map(Number);

    return {
      versionNumber: draft.versionNumber,
      kept: result.kept.map((hold) => ({
        holdId: Number(hold.holdId),
        detectionIndex: hold.detectionIndex,
        confidence: hold.confidence,
      })),
      removed: removedHoldIds,
      added: result.added,
      lowConfidence: result.lowConfidence.map(Number),
      climbsAffected: await climbsUsingHolds(wall.layoutId, removedHoldIds),
      movesSuggested: moves.map((move) => ({
        movedFromHoldId: Number(move.movedFromHoldId),
        detectionIndex: move.detectionIndex,
        distance: move.distance,
      })),
      aspectMismatch: aspectRatiosDiffer(
        { width: wall.referenceWidth, height: wall.referenceHeight },
        { width: draft.photoWidth, height: draft.photoHeight },
      ),
    };
  },

  remixClimb: async (
    _: unknown,
    { parentUuid, sprayWallUuid }: { parentUuid: unknown; sprayWallUuid?: unknown },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_QUERY_RATE_LIMIT, 'remixClimb');

    // A climb uuid is Aurora's 32-hex form, not an RFC-4122 one — `UUIDSchema`
    // would refuse every climb in the database.
    const validatedUuid = validateInput(ClimbUuidSchema, parentUuid, 'parentUuid');

    const [parent] = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        name: dbSchema.boardClimbs.name,
        layoutId: dbSchema.boardClimbs.layoutId,
        angle: dbSchema.boardClimbs.angle,
        frames: dbSchema.boardClimbs.frames,
      })
      .from(dbSchema.boardClimbs)
      .where(and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, 'spray')))
      .limit(1);
    if (!parent) return null;

    // The SAME gate `saveClimb` applies to a spray climb write, and for the same
    // reason. A climb names its wall by layout id, which comes out of a sequence
    // and is therefore no secret, so the default is the by-layout rule: the owner,
    // a gym member, or a public wall. What the wall's own uuid adds is the
    // share-link capability — somebody photographs their home wall, sends the link
    // to their crew, and the crew sets climbs on it. A crew that can SET a climb
    // and cannot remix one is an arbitrary hole, so the two use one helper.
    //
    // A PRIVATE wall still refuses everyone but its principals, uuid or not, and a
    // uuid has to be THIS wall's: without that pairing one leaked uuid would open
    // every wall in the sequence. `loadWall` also drops a deleted wall, whose
    // climbs stop being remixable with it.
    const presentedWallUuid = sprayWallUuid == null ? null : validateInput(UUIDSchema, sprayWallUuid, 'sprayWallUuid');
    const loaded = await loadWall('layoutId', parent.layoutId);
    if (!loaded || !(await viewerCanWriteSprayClimbs(loaded.wall, loaded.board, ctx.userId, presentedWallUuid)))
      return null;

    // The wall as it stands, read ONCE and used for both halves below: it splits
    // the parent's own holds into kept and lost, and then filters the successors a
    // move linked, because a successor that has itself since come off is not
    // somewhere a remix can start.
    //
    // The parent is shown even when it is no longer climbable (epic decision
    // 2026-09-14) — a climb that lost three holds is exactly the one worth
    // remixing, and refusing the seed would strand it.
    const aliveRows = await aliveHolds(db, loaded.wall.id);
    const alive = new Set(aliveRows.map((hold) => hold.holdId));

    // The frames grammar is `p<placementId>r<code>`, concatenated. Split on the
    // token boundary rather than a separator: the string carries none, and a
    // regex over the whole thing is what every other reader of it does.
    const tokens = [...(parent.frames ?? '').matchAll(/p(\d+)r(\d+)/g)];
    const keptHoldIds: number[] = [];
    const lostHoldIds: number[] = [];
    const survivingTokens: string[] = [];
    for (const token of tokens) {
      const holdId = Number(token[1]);
      if (alive.has(holdId)) {
        keptHoldIds.push(holdId);
        survivingTokens.push(token[0]);
      } else {
        lostHoldIds.push(holdId);
      }
    }

    // What replaced each lost hold, when the reset review linked a move.
    //
    // Read off the alive rows already in hand rather than queried again. Those rows
    // ARE the answer: `aliveHolds` returned the published generation, and each one
    // carries the `moved_from_hold_id` a reset wrote — so a successor that has since
    // come off, and one an unpublished draft merely drew, are both absent by
    // construction instead of being fetched and filtered out. A wall with a long
    // reset history no longer ships every successor it has ever had over the wire,
    // and there is no second predicate to keep in step with the alive rule.
    //
    // `aliveHolds` orders by hold id, so this does too. There is no ranking to
    // preserve, but there IS a duplicate to collapse, and a commit alone does not
    // rule it out: `commitSprayWallVersion` refuses two additions naming one
    // `movedFromHoldId` AND pins the predecessor to that same commit's removals,
    // yet `upsertSprayWallHolds` — the ordinary hold editor — accepts a
    // `movedFromHoldId` at any hold the wall has ever had, an alive one included.
    // So a hold-editor move off a live hold, followed by a reset that later takes
    // that same hold off and links its own successor, leaves two alive rows
    // pointing at one predecessor. Keep the LAST, which is the higher hold id
    // under `aliveHolds`' ordering: it is the more recently installed of the two,
    // and the one whose predecessor genuinely came off the wall.
    const lost = new Set(lostHoldIds);
    const successorByLostHold = new Map<number, number>();
    for (const hold of aliveRows) {
      if (hold.movedFromHoldId != null && lost.has(hold.movedFromHoldId)) {
        successorByLostHold.set(hold.movedFromHoldId, hold.holdId);
      }
    }
    const suggestedHoldIds = [...successorByLostHold.values()].sort((left, right) => left - right);

    // `board_climbs.name` and `.angle` are both nullable, and `SprayRemixSeed`
    // declares neither nullable. `saveClimb` requires both on a spray climb, so
    // this is defence in depth — but without it a legacy NULL name would null the
    // whole seed on a non-null violation, which a client cannot tell apart from
    // "you may not see this wall", and a NULL angle would quietly read as 0°.
    return {
      parentUuid: parent.uuid,
      parentName: parent.name || 'Unknown Climb',
      layoutId: parent.layoutId,
      angle: Number(parent.angle ?? loaded.board.angle),
      frames: survivingTokens.join(''),
      lostHoldIds,
      keptHoldIds,
      suggestedHoldIds,
    };
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

/**
 * The rules a wall must meet to be reset, checked before the transaction for a
 * fast answer and again under the wall lock where they decide.
 */
function assertResetAllowed(loaded: LoadedWall, userId: string): void {
  if (loaded.board.ownerId !== userId) {
    throw new GraphQLError('Only the wall\u2019s owner can reset it.', {
      extensions: { code: SPRAY_WALL_CODES.resetOwnerOnly },
    });
  }
  if (loaded.wall.archivedAt != null) throw sprayWallArchivedError();
  if (loaded.wall.currentVersionId == null) {
    throw new GraphQLError('Publish this wall before resetting it. There is nothing to replace yet.', {
      extensions: { code: SPRAY_WALL_CODES.resetSourceUnpublished },
    });
  }
}

/**
 * Everything a new wall is created from. `createSprayWall` fills it from the
 * climber's input; `resetSprayWall` fills it from the wall being replaced.
 */
type NewSprayWallSettings = {
  ownerId: string;
  boardUuid: string;
  slug: string;
  name: string;
  description: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  gymId: number | null;
  hideLocation: boolean;
  angle: number;
  /** Null takes the column default (`setter`). */
  climbEditPolicy: SprayWallRow['climbEditPolicy'] | null;
  pendingVisibility: { pendingIsPublic: boolean | null; pendingIsUnlisted: boolean | null };
  renderSettings: SprayWallRow['renderSettings'];
  /** The wall this one is a reset clone of, or null for a fresh wall. */
  resetFromWallId: number | null;
};

/**
 * Create a wall's rows: its three catalogue rows, its `user_boards` row and its
 * `spray_walls` row. The one place a wall is born, so `createSprayWall` and
 * `resetSprayWall` cannot drift on what a new wall needs.
 *
 * Takes the owner's account lock first, so an account deletion cannot interleave
 * with the create. `resetSprayWall` has already taken it before its wall lock
 * (advisory locks are re-entrant within a transaction), which keeps the order
 * `deleteAccountSprayWalls` uses: account first, then walls.
 */
async function insertSprayWallRows(tx: SprayWriteTransaction, settings: NewSprayWallSettings): Promise<LoadedWall> {
  await lockSprayWallAccount(tx, settings.ownerId);
  const [account] = await tx
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, settings.ownerId))
    .limit(1);
  if (!account) throw notFoundError();
  // ONE sequence value is BOTH the layout id and the size id: a wall has
  // exactly one size, itself.
  const { layoutId, sizeId } = await allocateWallIds(tx);

  // All three catalogue rows are `is_listed = false`, and that is the primary
  // privacy defence rather than cosmetics — see the helper's own comment.
  // Inside the transaction so a half-written wall leaves a gap in the id
  // space (fine) rather than a catalogue row with no wall (not).
  //
  // `referenceWidth` / `referenceHeight` are deliberately NOT passed: the frame
  // is derived from version 1's photo and there is no photo yet, so the size
  // row's `edge_right` / `edge_top` start NULL and `createSprayWallVersion`
  // fills them in when the frame is decided. Passing a guess here would put a
  // wrong edge box on the catalogue that nothing later corrects.
  await createSprayWallCatalogueRows(tx, { layoutId, name: settings.name });

  const [board] = await tx
    .insert(dbSchema.userBoards)
    .values({
      uuid: settings.boardUuid,
      slug: settings.slug,
      ownerId: settings.ownerId,
      boardType: 'spray',
      layoutId,
      sizeId,
      setIds: String(SPRAY_SET.id),
      name: settings.name,
      description: settings.description,
      locationName: settings.locationName,
      latitude: settings.latitude,
      longitude: settings.longitude,
      gymId: settings.gymId,
      // ALWAYS private here, whatever the input asks for. The row exists from
      // now on — the photo handler authorises against it — but it has no
      // version, no photo and no holds, so a wall made public at creation would
      // be a public board with nothing on it for as long as the wizard takes,
      // and forever if it is abandoned. What the climber asked for is parked
      // on `spray_walls.pending_is_*` below and applied by the first publish
      // (#5513). Private is also the default: a wall is somebody's home until
      // they say otherwise, where every other board type defaults public.
      isPublic: false,
      isUnlisted: false,
      hideLocation: settings.hideLocation,
      isOwned: true,
      angle: settings.angle,
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
      boardUuid: settings.boardUuid,
      layoutId,
      // NULL until the first photo: the frame is derived from version 1's
      // photo, and there is nothing to derive it from yet.
      referenceWidth: null,
      referenceHeight: null,
      holdCount: 0,
      ...(settings.climbEditPolicy ? { climbEditPolicy: settings.climbEditPolicy } : {}),
      // Parked until the first publish applies it (#5513); see the callers.
      ...settings.pendingVisibility,
      renderSettings: settings.renderSettings,
      resetFromWallId: settings.resetFromWallId,
    })
    .returning();

  return { wall, board };
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
          // Archived walls have their own cap (`resetSprayWall`): a reset nets to
          // zero live walls, so the walls it retires must not eat this one.
          isNull(dbSchema.sprayWalls.archivedAt),
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

    const created = await db.transaction((tx) =>
      insertSprayWallRows(tx, {
        ownerId: userId,
        boardUuid,
        slug,
        name: validated.name,
        description: validated.description ?? null,
        locationName: validated.locationName ?? null,
        latitude,
        longitude,
        gymId,
        hideLocation: validated.hideLocation ?? false,
        angle: validated.angle,
        climbEditPolicy: validated.climbEditPolicy ?? null,
        // The visibility the climber picked, held server-side until the first
        // publish applies it. It used to live only in the wizard's React state,
        // so a climber who closed the app and resumed the wall published it
        // private whatever they had chosen (#5513). Nothing pending when they
        // left it private — that is already what the board row says.
        pendingVisibility: pendingVisibilityColumns(validated),
        renderSettings: null,
        resetFromWallId: null,
      }),
    );

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
      pendingIsPublic: created.wall.pendingIsPublic,
      pendingIsUnlisted: created.wall.pendingIsUnlisted,
    });

    return toGraphQLWall(created, userId, true, undefined, undefined, created.board.uuid);
  },

  /**
   * Start a reset by cloning the wall (docs/spray-walls.md, "Archive and reset").
   *
   * The clone copies settings only. The owner photographs the wall and marks its
   * holds from scratch in the add-wall wizard, and the clone's first publish
   * archives this wall (`archiveResetSourceUnderLock`). Until then this wall is
   * untouched and live, so an abandoned or deleted clone costs nothing.
   */
  resetSprayWall: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, CREATE_WALL_RATE_LIMIT, 'resetSprayWall');

    const validated = validateInput(ResetSprayWallInputSchema, input, 'input');
    const userId = ctx.userId!;

    // A wall the caller cannot see is "not found", like everywhere else. One
    // they can see but do not own is refused by name: a gym admin or a community
    // leader may edit the wall's holds, but replacing the wall is the owner's call.
    const loaded = await loadVisibleWall(validated.wallUuid, userId);
    if (!loaded) throw notFoundError();
    assertResetAllowed(loaded, userId);

    // Outside the transaction, like `createSprayWall`. Wasted on a retry that
    // returns the unfinished clone, which is a cheap read.
    const slug = await generateUniqueSlug(loaded.board.name);
    const cloneBoardUuid = uuidv4();

    const outcome = await db.transaction(async (tx) => {
      // Account lock, then the source's wall lock: the order
      // `deleteAccountSprayWalls` takes them in. The account lock also
      // serialises this owner's resets, which is what makes the archive cap
      // below exact rather than approximate.
      await lockSprayWallAccount(tx, userId);
      await lockWallForWrite(tx, loaded.wall.id);

      // Re-read under the lock: a concurrent delete, archive or publish may have
      // landed since the checks above.
      const [source] = await tx
        .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
        .from(dbSchema.sprayWalls)
        .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
        .where(
          and(
            eq(dbSchema.sprayWalls.id, loaded.wall.id),
            isNull(dbSchema.sprayWalls.deletedAt),
            isNull(dbSchema.userBoards.deletedAt),
          ),
        )
        .limit(1);
      if (!source) throw notFoundError();
      assertResetAllowed(source, userId);

      // Idempotent: a retry after a lost response, or the owner coming back to
      // the wizard, gets the clone they already started rather than a second one.
      const [unfinished] = await tx
        .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
        .from(dbSchema.sprayWalls)
        .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
        .where(
          and(
            eq(dbSchema.sprayWalls.resetFromWallId, source.wall.id),
            isNull(dbSchema.sprayWalls.currentVersionId),
            isNull(dbSchema.sprayWalls.deletedAt),
            isNull(dbSchema.userBoards.deletedAt),
          ),
        )
        .orderBy(desc(dbSchema.sprayWalls.id))
        .limit(1);
      if (unfinished) return { clone: unfinished, created: false };

      // The live-wall cap is skipped: the clone archives this wall when it
      // publishes, so a reset nets to zero live walls. The archive cap counts the
      // walls already archived AND every unfinished clone, because each of those
      // will archive one more wall when it publishes.
      const [{ archivedOrPending }] = await tx
        .select({ archivedOrPending: count() })
        .from(dbSchema.sprayWalls)
        .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
        .where(
          and(
            eq(dbSchema.userBoards.ownerId, userId),
            isNull(dbSchema.sprayWalls.deletedAt),
            isNull(dbSchema.userBoards.deletedAt),
            or(
              isNotNull(dbSchema.sprayWalls.archivedAt),
              and(isNotNull(dbSchema.sprayWalls.resetFromWallId), isNull(dbSchema.sprayWalls.currentVersionId)),
            ),
          ),
        );
      if (Number(archivedOrPending) >= MAX_ARCHIVED_SPRAY_WALLS_PER_USER) {
        throw new GraphQLError(
          `You've reached the limit of ${MAX_ARCHIVED_SPRAY_WALLS_PER_USER} archived walls. ` +
            `Delete an archived wall you no longer need to reset this one.`,
          {
            extensions: {
              code: SPRAY_WALL_CODES.archiveLimitReached,
              maxArchivedWalls: MAX_ARCHIVED_SPRAY_WALLS_PER_USER,
            },
          },
        );
      }

      const clone = await insertSprayWallRows(tx, {
        ownerId: userId,
        boardUuid: cloneBoardUuid,
        slug,
        name: source.board.name,
        description: source.board.description,
        locationName: source.board.locationName,
        latitude: source.board.latitude,
        longitude: source.board.longitude,
        // The gym link as it stands. It passed the gym-link gate when it was made,
        // and the clone is the same physical wall in the same place.
        gymId: source.board.gymId,
        hideLocation: source.board.hideLocation,
        angle: source.board.angle,
        climbEditPolicy: source.wall.climbEditPolicy,
        // The old wall's audience, parked until the clone's first publish applies
        // it — a clone with no photo is private until then, like any new wall.
        pendingVisibility: pendingVisibilityColumns({
          isPublic: source.board.isPublic,
          isUnlisted: source.board.isUnlisted,
        }),
        renderSettings: source.wall.renderSettings,
        resetFromWallId: source.wall.id,
      });
      return { clone, created: true };
    });

    if (outcome.created) {
      const { latitude, longitude } = outcome.clone.board;
      if (latitude != null && longitude != null) {
        await syncLocationGeography({
          table: 'user_boards',
          id: outcome.clone.board.id,
          latitude,
          longitude,
          operation: 'resetSprayWall',
        });
      }
      logger.info('Spray wall reset clone created', {
        userId,
        sourceLayoutId: loaded.wall.layoutId,
        cloneLayoutId: outcome.clone.wall.layoutId,
      });
    }

    return toGraphQLWall(outcome.clone, userId, true, undefined, undefined, outcome.clone.board.uuid);
  },

  createSprayWallVersion: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'createSprayWallVersion');

    const validated = validateInput(CreateSprayWallVersionInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);

    let uploadedPhoto: { key: string; width: number; height: number } | null = null;
    if (validated.photoId != null) {
      if (!isS3Configured('private')) {
        throw new GraphQLError('Spray wall photos are not configured on this server', {
          extensions: { code: SPRAY_WALL_CODES.photosNotConfigured },
        });
      }

      // Only a fresh upload needs a storage read. A reused version already has
      // trusted dimensions and a mapping; reading or recomputing either would
      // turn an ordinary hold edit into another photo upload.
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
      uploadedPhoto = { key: photoKey, width: photoWidth, height: photoHeight };
    }

    const version = await db.transaction(async (tx) => {
      // The wall lock, held for the one-draft check AND the insert. Checking
      // outside the transaction would let two concurrent creates both see no open
      // draft and both insert one — the exact state the rule exists to forbid.
      await lockWallForWrite(tx, wall.id);
      await assertSprayWallNotArchivedUnderLock(tx, wall.id);

      const [{ versions: versionCount }] = await tx
        .select({ versions: count() })
        .from(dbSchema.sprayWallVersions)
        .where(eq(dbSchema.sprayWallVersions.wallId, wall.id));

      // ONE active draft per wall.
      //
      // Without it two drafts can each mark the SAME inherited hold removed, and
      // `spray_wall_holds.removed_version_id` is a single column — the second write
      // overwrites the first, so publishing the first draft no longer removes the
      // hold and a climb that lost it reads intact. Making the column a range per
      // draft would be a schema change for a workflow nobody asked for: a wall has
      // one owner and a reset is one sitting.
      //
      // The way out is `publishSprayWallVersion` or `discardSprayWallVersion`; the
      // error names the draft so a client can offer both.
      const [openDraft] = await tx
        .select()
        .from(dbSchema.sprayWallVersions)
        .where(and(eq(dbSchema.sprayWallVersions.wallId, wall.id), eq(dbSchema.sprayWallVersions.status, 'draft')))
        .limit(1);
      if (openDraft) {
        // Retrying the same uploaded photo after a lost response is idempotent.
        // Another photo, mapping or editor's draft must never be silently adopted.
        if (
          uploadedPhoto &&
          openDraft.photoKey === uploadedPhoto.key &&
          openDraft.photoWidth === uploadedPhoto.width &&
          openDraft.photoHeight === uploadedPhoto.height &&
          sameSprayGeometry(openDraft.anchors, validated.anchors ?? null) &&
          openDraft.notes === (validated.notes ?? null)
        ) {
          return openDraft;
        }
        throw new GraphQLError(
          `This wall already has an unfinished photo (version ${openDraft.versionNumber}). ` +
            `Publish it or discard it before starting another.`,
          {
            extensions: {
              code: SPRAY_WALL_CODES.draftAlreadyOpen,
              draftVersionId: String(openDraft.id),
              draftVersionNumber: openDraft.versionNumber,
            },
          },
        );
      }

      if (Number(versionCount) >= MAX_VERSIONS_PER_WALL) {
        throw new GraphQLError(
          `This wall has reached the limit of ${MAX_VERSIONS_PER_WALL} photos. ` +
            `Each one keeps its own hold generation, so there is nothing to prune automatically.`,
          { extensions: { code: SPRAY_WALL_CODES.versionLimitReached } },
        );
      }

      // Lock the WALL row first, then count. Postgres refuses `FOR UPDATE`
      // alongside an aggregate, and the version numbers have to be dense per
      // wall — so the wall row is the thing two concurrent uploads queue behind,
      // and without that lock both would compute the same `MAX + 1` and one would
      // die on the `(wall_id, version_number)` unique index.
      //
      // The same statement re-reads the canonical FRAME, which is why it selects
      // more than the id: `resolveVersionGeometry` inherits the wall's existing
      // frame, and a concurrent `discardSprayWallVersion` clears it back to NULL
      // when it drops version 1. Read before the lock, this version would inherit a
      // frame that no longer exists and every hold on the recreated version 1 would
      // land in the discarded generation's coordinates. Inside the lock the frame is
      // whatever the wall actually has.
      const [lockedWall] = await tx
        .select({
          id: dbSchema.sprayWalls.id,
          currentVersionId: dbSchema.sprayWalls.currentVersionId,
          referenceWidth: dbSchema.sprayWalls.referenceWidth,
          referenceHeight: dbSchema.sprayWalls.referenceHeight,
        })
        .from(dbSchema.sprayWalls)
        .where(and(eq(dbSchema.sprayWalls.id, wall.id), isNull(dbSchema.sprayWalls.deletedAt)))
        .for('update');
      if (!lockedWall) throw notFoundError();

      const [{ maxNumber }] = await tx
        .select({ maxNumber: sql<number | null>`MAX(${dbSchema.sprayWallVersions.versionNumber})` })
        .from(dbSchema.sprayWallVersions)
        .where(eq(dbSchema.sprayWallVersions.wallId, wall.id));

      const versionNumber = Number(maxNumber ?? 0) + 1;

      if (validated.sourceVersionId != null) {
        // The source is checked after taking the lock: another device may have
        // published since the editor fetched its wall. Never reuse a stale or
        // foreign version, and never copy its geometry onto a newer photo.
        const [source] = await tx
          .select()
          .from(dbSchema.sprayWallVersions)
          .where(
            and(
              eq(dbSchema.sprayWallVersions.id, validated.sourceVersionId),
              eq(dbSchema.sprayWallVersions.wallId, wall.id),
              eq(dbSchema.sprayWallVersions.status, 'published'),
            ),
          )
          .limit(1);
        if (!source || source.id !== lockedWall.currentVersionId) {
          throw new GraphQLError('That photo is no longer the published wall. Reload the wall and try again.', {
            extensions: { code: SPRAY_WALL_CODES.sourceVersionNotCurrent },
          });
        }
        if (
          !source.photoKey ||
          source.photoWidth == null ||
          source.photoHeight == null ||
          !Number.isInteger(source.photoWidth) ||
          !Number.isInteger(source.photoHeight) ||
          source.photoWidth <= 0 ||
          source.photoHeight <= 0
        ) {
          throw new GraphQLError('That published photo is unavailable. Add a new photo to edit the wall.', {
            extensions: { code: SPRAY_WALL_CODES.photoMissing },
          });
        }

        const [inserted] = await tx
          .insert(dbSchema.sprayWallVersions)
          .values({
            wallId: wall.id,
            versionNumber,
            status: 'draft',
            photoKey: source.photoKey,
            photoWidth: source.photoWidth,
            photoHeight: source.photoHeight,
            anchors: source.anchors,
            homography: source.homography,
            notes: validated.notes ?? null,
            createdBy: ctx.userId!,
          })
          .returning();
        // No holds are copied: aliveHolds already inherits the published holds
        // by their existing ids. The canonical frame and catalogue stay put.
        await tx.update(dbSchema.sprayWalls).set({ updatedAt: new Date() }).where(eq(dbSchema.sprayWalls.id, wall.id));
        return inserted;
      }

      // Validation requires exactly one source, so the upload branch has a photo.
      if (!uploadedPhoto) throw new Error('An uploaded photo is required');
      const { key: photoKey, width: photoWidth, height: photoHeight } = uploadedPhoto;

      // Anchors are optional on version 1 ONLY, and that is not a convenience: on
      // version 1 the photo's own pixel box IS the canonical frame, so the identity
      // homography is correct. Every later version inherits a frame derived from a
      // DIFFERENT photograph, and without anchors to map this photo onto it the
      // identity homography silently puts every hold the owner draws at the wrong
      // place on the wall — and the climbs set on it with them.
      //
      // Checked under the lock, against the version number this insert will actually
      // take, so a concurrent discard of version 1 cannot make a v2 rule apply to a
      // version that turns out to be v1.
      if (versionNumber > 1 && !isValidAnchorQuad(validated.anchors ?? null)) {
        throw new GraphQLError(
          'Mark the four wall corners on this photo. Later photos need them to line up with the first one.',
          { extensions: { code: SPRAY_WALL_CODES.anchorsRequired } },
        );
      }

      const geometry = resolveVersionGeometry({
        anchors: validated.anchors ?? null,
        photoWidth,
        photoHeight,
        existingFrame: { width: lockedWall.referenceWidth, height: lockedWall.referenceHeight },
      });

      const [inserted] = await tx
        .insert(dbSchema.sprayWallVersions)
        .values({
          wallId: wall.id,
          versionNumber,
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

      // …and the SAME frame onto the catalogue's size row, which is the only place
      // a reader that knows nothing about spray can find it.
      //
      // `createSprayWall` could not write it — the frame is derived from this
      // photo, which did not exist yet — so without this the edge box stays NULL
      // for the wall's whole life. Three things read it and each fails differently:
      // `populateDenormalizedColumns` step 3 matches no size row at all (so
      // `compatible_size_ids` never derives, silently), the climb-search edge
      // filter has nothing to compare against, and SW-07's render path would get a
      // NULL box where every other board type has numbers. Written in the same
      // transaction as the frame it mirrors, so the two can never disagree.
      await tx
        .update(dbSchema.boardProductSizes)
        .set({ edgeLeft: 0, edgeBottom: 0, edgeRight: geometry.referenceWidth, edgeTop: geometry.referenceHeight })
        .where(
          and(
            eq(dbSchema.boardProductSizes.boardType, 'spray'),
            eq(dbSchema.boardProductSizes.id, spraySizeIdForLayout(wall.layoutId)),
          ),
        );

      return inserted;
    });

    return toGraphQLVersion(version);
  },

  updateSprayWall: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'updateSprayWall');

    const validated = validateInput(UpdateSprayWallInputSchema, input, 'input');
    const loaded = await loadEditableWall(ctx, validated.uuid);
    const { wall, board } = loaded;

    // Everything else on this mutation follows `requireBoardEditAccess`, which a
    // gym owner/admin and a community leader also pass. Visibility does not: this
    // is the switch that puts a photograph of somebody's home on the open web and
    // starts announcing their climbs, and the person who took the photograph is
    // the only one who gets to throw it. A gym admin can still edit the gym's
    // wall — they cannot publish it to the world.
    //
    // BOTH halves, not just `isPublic`. `is_unlisted` is not the lesser flag it
    // looks like: on a wall it is the SHARE LINK, and `viewerCanSeeSprayWall` and
    // `viewerCanWriteSprayClimbs` both honour a presented uuid the moment it is
    // set. Guarding only `isPublic` would let a gym admin flip a member's private
    // wall to unlisted and mint a capability over the photograph of their garage —
    // quieter than making it public and exactly as far from private.
    if ((validated.isPublic !== undefined || validated.isUnlisted !== undefined) && board.ownerId !== ctx.userId) {
      throw new GraphQLError('Only the climber who set this wall up can change who can see it', {
        extensions: { code: SPRAY_WALL_CODES.visibilityOwnerOnly },
      });
    }

    if (validated.climbEditPolicy !== undefined && board.ownerId !== ctx.userId) {
      throw new GraphQLError('Only the climber who set this wall up can change who can edit climbs', {
        extensions: { code: SPRAY_WALL_CODES.climbEditPolicyOwnerOnly },
      });
    }

    // The angle is the one field a published wall cannot change. `board_climb_stats`
    // is keyed by angle and every tick recorded so far sits at the old one, so
    // moving it would orphan the wall's whole history — the climbs would still be
    // there and their grades and ascents would not. Refused rather than cascaded:
    // rewriting stats across angles is a migration, not an edit.
    const changingAngle = validated.angle !== undefined && validated.angle !== Number(board.angle);
    if (changingAngle && wall.currentVersionId != null) {
      throw new GraphQLError(
        "A published wall's angle cannot change — its climbs' grades and ascents are recorded at " +
          `${board.angle}°. Create a new wall at ${validated.angle}° instead.`,
        { extensions: { code: SPRAY_WALL_CODES.anglePublished, wallAngle: Number(board.angle) } },
      );
    }

    // The shared gate: a gym owner/admin, or a nearby public gym the caller is
    // adding their own wall to. `null` detaches, which needs no permission — you
    // may always take your own wall off a gym.
    let nextGymId: number | null | undefined;
    if (validated.gymUuid !== undefined) {
      if (validated.gymUuid === null) {
        nextGymId = null;
      } else {
        const gym = await requireBoardGymLinkAccess({
          ctx,
          gymUuid: validated.gymUuid,
          userId: ctx.userId!,
          boardLatitude: board.latitude,
          boardLongitude: board.longitude,
        });
        nextGymId = gym.id;
      }
    }

    const updates: Partial<typeof dbSchema.userBoards.$inferInsert> = {};
    if (validated.name !== undefined) updates.name = validated.name;
    if (validated.description !== undefined) updates.description = validated.description;
    if (validated.isPublic !== undefined) updates.isPublic = validated.isPublic;
    if (validated.isUnlisted !== undefined) updates.isUnlisted = validated.isUnlisted;
    if (nextGymId !== undefined) updates.gymId = nextGymId;
    if (validated.angle !== undefined) updates.angle = validated.angle;

    // Losing public status has to RETRACT what was already fanned out, not just
    // stop future fan-out — see `purgeSprayWallFeedItems`. `is_unlisted` is not a
    // trigger: an unlisted wall is still shared, just not listed.
    //
    // Whether the wall IS public is decided under the lock, not here: a climb
    // created between a concurrent update that made the wall public and this one
    // announces itself (the announce decision is taken under the same lock), and a
    // `board.isPublic` captured before that would read false and skip the purge,
    // leaving the announcement in the feed for a wall that is now private.
    const goingPrivate = validated.isPublic === false;

    // The copy into the public bucket happens BEFORE the transaction, on purpose:
    // it is a round-trip to object storage, and making it while holding the wall's
    // advisory lock would block every concurrent hold edit on somebody else's
    // upload bandwidth. What that order costs is an orphaned object when the
    // transaction then fails, which the catch below cleans up. The other order
    // costs a public wall whose photo never got copied, which nothing cleans up.
    //
    // A wall that is already public but has no public copy is copied again, on ANY
    // update that does not make it private — a rename heals it as well as a
    // re-stated "public". That state is reachable: a publish commits the flag and
    // makes the copy afterwards, best effort (it retries once, see
    // `refreshPublicWallPhoto`), so a failed copy leaves a public wall with no
    // photo to show. A resumed wizard run never re-states public after its
    // publish, so the heal cannot wait for that one call. Costs one read and one
    // copy, and only on a wall that is in that broken state.
    //
    // Never for an admin-hidden wall (#5797): it reads as private to everybody but
    // its owner, so its photo has no business in the world-readable bucket even
    // when the owner flips the flag. Re-checked under the lock below, since a hide
    // can land while the copy is in flight.
    const promoting = validated.isPublic === true && !board.isPublic;
    const healing = board.isPublic && validated.isPublic !== false && wall.publicPhotoKey == null;
    const promotedPhotoKey =
      wall.hiddenAt == null && (promoting || healing)
        ? await copyWallPhotoToPublicBucket(board.uuid, await publishedPhotoKey(wall))
        : null;

    // Objects that outlived the row pointing at them. Deleted AFTER the commit —
    // never before, or a rolled-back demotion would leave a still-public wall
    // pointing at bytes that are gone.
    const orphanedPublicKeys: string[] = [];

    try {
      await db.transaction(async (tx) => {
        await lockWallForWrite(tx, wall.id);

        // Re-read the published version under the lock. The check above is a fast
        // path with a nicer error; a publish landing between it and here would
        // otherwise let an angle change through on a wall that has just acquired a
        // published generation — and every tick already recorded sits at the old
        // angle.
        if (changingAngle) {
          const [wallNow] = await tx
            .select({ currentVersionId: dbSchema.sprayWalls.currentVersionId })
            .from(dbSchema.sprayWalls)
            .where(eq(dbSchema.sprayWalls.id, wall.id))
            .limit(1);
          if (wallNow?.currentVersionId != null) {
            throw new GraphQLError(
              "A published wall's angle cannot change — its climbs' grades and ascents are recorded at " +
                `${board.angle}°. Create a new wall at ${validated.angle}° instead.`,
              { extensions: { code: SPRAY_WALL_CODES.anglePublished, wallAngle: Number(board.angle) } },
            );
          }
        }

        const [boardNow] = await tx
          .select({
            isPublic: dbSchema.userBoards.isPublic,
            deletedAt: dbSchema.userBoards.deletedAt,
            ownerId: dbSchema.userBoards.ownerId,
          })
          .from(dbSchema.userBoards)
          .where(eq(dbSchema.userBoards.id, board.id))
          .limit(1);
        const losingPublic = goingPrivate && boardNow?.isPublic === true;

        const [wallNow] = await tx
          .select({
            publicPhotoKey: dbSchema.sprayWalls.publicPhotoKey,
            hiddenAt: dbSchema.sprayWalls.hiddenAt,
            pendingIsPublic: dbSchema.sprayWalls.pendingIsPublic,
            pendingIsUnlisted: dbSchema.sprayWalls.pendingIsUnlisted,
            deletedAt: dbSchema.sprayWalls.deletedAt,
          })
          .from(dbSchema.sprayWalls)
          .where(eq(dbSchema.sprayWalls.id, wall.id))
          .limit(1);

        // A copy was staged outside the lock. Account or wall deletion may have
        // withdrawn ownership while it was copying; catch below erases the copy.
        if (!boardNow || !wallNow || boardNow.deletedAt || wallNow.deletedAt || boardNow.ownerId !== board.ownerId) {
          throw notFoundError();
        }
        if (Object.keys(updates).length > 0) {
          await tx.update(dbSchema.userBoards).set(updates).where(eq(dbSchema.userBoards.id, board.id));
        }

        if (losingPublic) {
          const retracted = await purgeSprayWallFeedItems(tx, wall.layoutId);
          if (retracted > 0) {
            logger.info('Spray wall went private; retracted its feed rows', {
              layoutId: wall.layoutId,
              feedItemsDeleted: retracted,
            });
          }
        }

        // The catalogue rows carry the wall's name so a psql session can read them,
        // so a rename has to reach them too or they drift from the wall forever.
        // Still `is_listed = false` — nothing here makes a wall listable.
        if (validated.name !== undefined) {
          await tx
            .update(dbSchema.boardLayouts)
            .set({ name: validated.name })
            .where(and(eq(dbSchema.boardLayouts.boardType, 'spray'), eq(dbSchema.boardLayouts.id, wall.layoutId)));
          await tx
            .update(dbSchema.boardProductSizes)
            .set({ name: validated.name })
            .where(
              and(
                eq(dbSchema.boardProductSizes.boardType, 'spray'),
                eq(dbSchema.boardProductSizes.id, spraySizeIdForLayout(wall.layoutId)),
              ),
            );
        }

        // The public copy tracks the flag, in the same transaction as the flag:
        // `public_photo_key` non-null is what makes `publicPhotoUrl` answer, so a
        // window where the two disagree is a window where a private wall's photo
        // has a world-readable URL.
        const wallUpdates: Partial<typeof dbSchema.sprayWalls.$inferInsert> = { updatedAt: new Date() };
        // An explicit visibility change supersedes what the climber picked at
        // creation (#5513) — field by field. Each flag this call states replaces
        // its half of the pending pair; a flag it leaves out keeps the creation-time
        // choice, exactly as the board row keeps a flag the update does not name.
        // Without the first half, a wall made private again before its first
        // publish would be flipped back by that publish; without the second,
        // `{ isUnlisted: false }` alone would silently drop a pending public.
        // Only while something is pending: there is nothing to merge into after
        // the first publish, which clears the pair.
        const hasPending = wallNow?.pendingIsPublic != null || wallNow?.pendingIsUnlisted != null;
        if (hasPending && (validated.isPublic !== undefined || validated.isUnlisted !== undefined)) {
          const merged = pendingVisibilityColumns({
            isPublic: validated.isPublic ?? wallNow?.pendingIsPublic === true,
            isUnlisted: validated.isUnlisted ?? wallNow?.pendingIsUnlisted === true,
          });
          wallUpdates.pendingIsPublic = merged.pendingIsPublic;
          wallUpdates.pendingIsUnlisted = merged.pendingIsUnlisted;
        }
        // A copy made for a HEAL (the board already public, this call not stating
        // it) has to find the board still public under the lock: a demotion that
        // committed after the read above would otherwise get a world-readable photo
        // key written onto a wall that is now private.
        const stillPublic = validated.isPublic === true || boardNow?.isPublic === true;
        if (promotedPhotoKey && (wallNow?.hiddenAt != null || !stillPublic)) {
          // Hidden, or no longer public, while the copy was in flight: the copy is
          // attached to nothing and goes on the post-commit delete list with the
          // other orphans.
          orphanedPublicKeys.push(promotedPhotoKey);
        } else if (promotedPhotoKey) {
          wallUpdates.publicPhotoKey = promotedPhotoKey;
          // A wall promoted twice without an intervening demotion would strand the
          // first copy; the old key goes on the sweep list rather than being left.
          if (wallNow?.publicPhotoKey) orphanedPublicKeys.push(wallNow.publicPhotoKey);
        } else if (losingPublic) {
          wallUpdates.publicPhotoKey = null;
          if (wallNow?.publicPhotoKey) orphanedPublicKeys.push(wallNow.publicPhotoKey);
        }

        if (validated.climbEditPolicy !== undefined) {
          wallUpdates.climbEditPolicy = validated.climbEditPolicy;
        }

        await tx.update(dbSchema.sprayWalls).set(wallUpdates).where(eq(dbSchema.sprayWalls.id, wall.id));
      });
    } catch (error) {
      // The row never took the key, so the copy is unreachable by anything. Drop
      // it rather than leave a photograph of somebody's wall in a public bucket
      // because their rename hit a constraint.
      await deletePublicWallPhoto(promotedPhotoKey);
      throw error;
    }

    for (const orphanedKey of orphanedPublicKeys) {
      await deletePublicWallPhoto(orphanedKey);
    }

    logger.info('Spray wall updated', {
      layoutId: wall.layoutId,
      userId: ctx.userId,
      fields: Object.keys(updates),
    });

    const reloaded = await loadWall('uuid', validated.uuid);
    if (!reloaded) throw notFoundError();
    return toGraphQLWall(reloaded, ctx.userId, true, undefined, undefined, reloaded.board.uuid);
  },

  /**
   * Store or clear the wall's default look.
   *
   * The plain `requireBoardEditAccess` gate and nothing stricter: unlike
   * visibility, a stored look decides nothing about who sees the wall. No wall
   * lock either — `render_settings` is touched by no other writer (holds,
   * versions and publish never read or write it), so there is no concurrent
   * write to order this against; the last call wins, which is what a setting is.
   *
   * A generated background (`wall-crop`, `hold-cutouts`) is refused when the
   * wall's photo fails the quality gate — the published version's, or the
   * newest draft's before the first publish — so no client can store a look
   * the wall cannot show. The read it decides on is a version's pins and
   * frame, which never change once written, so it still needs no lock: a
   * publish landing alongside requests its own art. When the published
   * version has no current art yet (a wall published before art existed),
   * choosing one queues it.
   */
  setSprayWallRenderSettings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'setSprayWallRenderSettings');

    const validated = validateInput(SetSprayWallRenderSettingsInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.uuid);

    // An older client sends `{ mode, boardsesh }` with no `background` key.
    // That is "change the look", not "go back to the photo", so the stored
    // background is kept. Only an explicit choice is gated: a kept one was
    // allowed when it was made, and a reset that fails the gate draws the
    // photo through the read-side fallback anyway.
    const explicitBackground = validated.renderSettings?.background;
    const renderSettings =
      validated.renderSettings && explicitBackground === undefined && wall.renderSettings?.background
        ? { ...validated.renderSettings, background: wall.renderSettings.background }
        : validated.renderSettings;
    const background = renderSettings?.background ?? 'photo';
    const artVersion = background === 'photo' ? undefined : await versionForArtChoice(wall);
    if (explicitBackground !== undefined && explicitBackground !== 'photo') {
      const quality = artVersion ? sprayVersionQuality(artVersion, wall) : null;
      if (!quality || quality.verdict === 'fail') {
        throw new GraphQLError(
          'This wall\u2019s photo is too angled to straighten. Retake it front-on to use this look.',
          {
            extensions: { code: SPRAY_WALL_CODES.artNotAvailable, reason: quality?.reason ?? 'no-photo' },
          },
        );
      }
    }

    await db
      .update(dbSchema.sprayWalls)
      .set({ renderSettings, updatedAt: new Date() })
      .where(eq(dbSchema.sprayWalls.id, wall.id));

    // Backfill: only for the PUBLISHED version of a live wall. A draft gets its
    // art when it is published; an archived wall gets no new art.
    if (
      artVersion &&
      wall.archivedAt == null &&
      artVersion.id === wall.currentVersionId &&
      sprayWallArtNeedsRequest(artVersion.art)
    ) {
      await db.transaction((tx) => requestSprayWallArtOn(tx, artVersion, wall));
    }

    logger.info('Spray wall render settings updated', {
      layoutId: wall.layoutId,
      userId: ctx.userId,
      mode: validated.renderSettings?.mode ?? null,
      background,
    });

    const reloaded = await loadWall('uuid', validated.uuid);
    if (!reloaded) throw notFoundError();
    return toGraphQLWall(reloaded, ctx.userId, true, undefined, undefined, reloaded.board.uuid);
  },

  upsertSprayWallHolds: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'upsertSprayWallHolds');

    const validated = validateInput(UpsertSprayWallHoldsInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);

    // EVERY check runs inside the lock. Reading the draft status and the alive set
    // outside it and writing after would let a publish land in the window, turning
    // this edit into a silent mutation of a PUBLISHED generation.
    const result = await db.transaction(async (tx) => {
      await lockWallForWrite(tx, wall.id);
      await assertSprayWallNotArchivedUnderLock(tx, wall.id);
      const version = await loadDraftVersion(tx, wall.id, validated.versionId);

      // The wall as THIS DRAFT sees it: holds installed at or before the draft's
      // own version number and not removed by it. That includes the holds this
      // same draft added, which is what lets an editing session correct a hold it
      // drew a moment ago, and excludes the ones it has already taken off.
      const existing = await aliveHolds(tx, wall.id, version.versionNumber);
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
      // never there. Scoped against EVERY hold this wall has ever had, not the
      // alive set: a move's whole point is that the predecessor has just come off.
      const movedFromIds = [
        ...new Set(
          validated.holds.map((hold) => hold.movedFromHoldId).filter((holdId): holdId is number => holdId != null),
        ),
      ];
      if (movedFromIds.length > 0) {
        const known = await tx
          .select({ holdId: dbSchema.sprayWallHolds.holdId })
          .from(dbSchema.sprayWallHolds)
          .where(
            and(eq(dbSchema.sprayWallHolds.wallId, wall.id), inArray(dbSchema.sprayWallHolds.holdId, movedFromIds)),
          );
        const knownIds = new Set(known.map((row) => row.holdId));
        const strayId = movedFromIds.find((holdId) => !knownIds.has(holdId));
        if (strayId != null) {
          throw new GraphQLError(`Hold ${strayId} has never been on this wall, so nothing can have moved from it`, {
            extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: strayId },
          });
        }
      }

      // The split that keeps a published generation immutable.
      //
      // A hold THIS DRAFT drew has never been on the real wall and no climb can
      // reference it, so correcting it is an ordinary in-place update. A hold
      // inherited from a version that LANDED is a different thing entirely: climbs
      // are already set on it, and `spray_wall_holds` is the geometry those climbs
      // render from — so an in-place update would move the hold under every climb
      // on the published wall, before this draft is published and even if it never
      // is.
      //
      // Correcting an inherited hold is therefore a REMOVAL plus an ADDITION, the
      // same shape a moved hold takes elsewhere in this table: the old row is
      // stamped `removed_version_id` at this draft, a new row gets a new catalogue
      // id, and `moved_from_hold_id` links the two so remix can suggest the
      // successor. The published generation keeps the geometry it was published
      // with, and the climbs on it stay exactly where they were.
      const inPlaceEdits = corrections.filter(
        (hold) => Number(aliveById.get(hold.id!)!.installedVersionId) === Number(version.id),
      );
      const supersedes = corrections.filter(
        (hold) => Number(aliveById.get(hold.id!)!.installedVersionId) !== Number(version.id),
      );

      const additions = validated.holds.filter((hold) => hold.id == null);
      // A supersede is one hold out and one in, so it does not move the total —
      // only genuine additions do. The `- uniqueSupersededIds` term is belt and
      // braces with the Zod uniqueness refine: a batch repeating one id would
      // otherwise remove that hold ONCE while adding a successor per occurrence, so
      // the extras are net additions and have to be counted as such.
      const uniqueSupersededIds = new Set(supersedes.map((hold) => hold.id!)).size;
      const nextTotal = existing.length + additions.length + (supersedes.length - uniqueSupersededIds);
      if (nextTotal > MAX_HOLDS_PER_WALL) {
        throw new GraphQLError(`A wall may hold at most ${MAX_HOLDS_PER_WALL} holds; this would make ${nextTotal}.`, {
          extensions: { code: SPRAY_WALL_CODES.holdLimitReached, maxHolds: MAX_HOLDS_PER_WALL },
        });
      }

      // Additions and supersedes both need a fresh catalogue id, so they are
      // allocated together in one ascending round trip — the hold editor relies on
      // that order to keep a freshly reviewed batch in the order it was reviewed.
      const newRows = [
        ...additions.map((hold) => ({ hold, predecessorId: hold.movedFromHoldId ?? null })),
        // The predecessor of a supersede IS the hold being corrected, so it wins
        // over any `movedFromHoldId` the client sent alongside.
        ...supersedes.map((hold) => ({ hold, predecessorId: hold.id! })),
      ];
      const newIds = await allocateHoldIds(tx, newRows.length);

      if (newRows.length > 0) {
        // The catalogue pair every hold needs: one `board_holes` row and one
        // `board_placements` row SHARING the id, because a climb's frames string
        // (`p<placementId>r<code>`) has to resolve to the row the wall editor drew
        // and a wall hold has no separate hole to mount into.
        await tx.insert(dbSchema.boardHoles).values(
          newRows.map(({ hold }, index) => ({
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
          newRows.map((_row, index) => ({
            boardType: 'spray' as const,
            id: newIds[index],
            layoutId: wall.layoutId,
            holeId: newIds[index],
            setId: SPRAY_SET.id,
            defaultPlacementRoleId: null,
          })),
        );

        // One statement for the batch: a detector run can be 800 holds, and a
        // round trip each would make the editor's save a multi-second wait.
        await tx.insert(dbSchema.sprayWallHolds).values(
          newRows.map(({ hold, predecessorId }, index) => ({
            wallId: wall.id,
            holdId: newIds[index],
            cx: hold.cx,
            cy: hold.cy,
            r: hold.r,
            outline: hold.outline ?? null,
            installedVersionId: version.id,
            movedFromHoldId: predecessorId,
            source: hold.source,
            confidence: hold.confidence ?? null,
          })),
        );
      }

      // Stamp the superseded originals as removed AT THIS DRAFT. Never deleted:
      // the climbs set on them have to stay findable, and `missing_hold_count` has
      // to stay countable once this draft publishes.
      if (supersedes.length > 0) {
        await tx
          .update(dbSchema.sprayWallHolds)
          .set({ removedVersionId: version.id, updatedAt: new Date() })
          .where(
            and(
              eq(dbSchema.sprayWallHolds.wallId, wall.id),
              inArray(
                dbSchema.sprayWallHolds.holdId,
                supersedes.map((hold) => hold.id!),
              ),
            ),
          );
      }

      // FOLLOW-UP (perf): the new rows above are three batched statements for the
      // whole run, but an in-place EDIT costs two round trips each — the side-table
      // update and the `board_holes` centre. A hold-editor session that nudges
      // fifty holds it just drew therefore burns a hundred statements. Both are
      // expressible as one `UPDATE … FROM (VALUES …)` per table; not done here
      // because the edit path is a human dragging holds one at a time, so the batch
      // is small in every flow that exists today.
      for (const hold of inPlaceEdits) {
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

        // Keep the hold's `board_holes` centre in step, so the catalogue never
        // disagrees with the wall about where a hold is.
        await tx
          .update(dbSchema.boardHoles)
          .set({ x: hold.cx, y: hold.cy })
          .where(and(eq(dbSchema.boardHoles.boardType, 'spray'), eq(dbSchema.boardHoles.id, hold.id!)));
      }

      // The ids the caller now owns: a supersede hands back the SUCCESSOR, not the
      // id it sent, because the id it sent is history as of this draft.
      const writtenHoldIds = [...newIds, ...inPlaceEdits.map((hold) => hold.id!)];

      const written =
        writtenHoldIds.length === 0
          ? []
          : await tx
              .select()
              .from(dbSchema.sprayWallHolds)
              .where(
                and(
                  eq(dbSchema.sprayWallHolds.wallId, wall.id),
                  inArray(dbSchema.sprayWallHolds.holdId, writtenHoldIds),
                ),
              )
              .orderBy(asc(dbSchema.sprayWallHolds.holdId));

      return written;
    });

    const versionNumberById = await loadVersionNumbers(wall.id);
    return result.map((hold) => toGraphQLHold(hold, versionNumberById));
  },

  removeSprayWallHolds: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'removeSprayWallHolds');

    const validated = validateInput(RemoveSprayWallHoldsInputSchema, input, 'input');
    const { wall } = await loadEditableWall(ctx, validated.wallUuid);

    // Every check inside the lock — see `upsertSprayWallHolds`.
    await db.transaction(async (tx) => {
      await lockWallForWrite(tx, wall.id);
      await assertSprayWallNotArchivedUnderLock(tx, wall.id);
      const version = await loadDraftVersion(tx, wall.id, validated.versionId);

      // The draft's own view of the wall — see `upsertSprayWallHolds`.
      const existing = await aliveHolds(tx, wall.id, version.versionNumber);
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

  commitSprayWallVersion: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, PUBLISH_RATE_LIMIT, 'commitSprayWallVersion');

    const validated = validateInput(CommitSprayWallVersionInputSchema, input, 'input');
    const { wall, board } = await loadEditableWall(ctx, validated.wallUuid);

    const committed = await db.transaction(async (tx) => {
      // EVERY check runs inside the lock, and the lock is the first statement.
      // A reset decides on a read — "these holds are alive, this version is a
      // draft" — and then writes on the strength of it, so a publish landing in
      // the window would turn the whole commit into a mutation of a PUBLISHED
      // generation and move every climb set on it.
      await lockWallForWrite(tx, wall.id);
      await assertSprayWallNotArchivedUnderLock(tx, wall.id);
      const version = await loadDraftVersion(tx, wall.id, validated.versionId);
      if ((await draftPurpose(tx, wall.id, version)) === 'hold-edit') throw wrongDraftPurposeError();
      assertResetVersionIsAnchored(version);

      // The decisions are re-validated against the wall as it is NOW, not against
      // whatever `proposeSprayWallReset` saw. A proposal is a screenshot: the owner
      // may have sat on it while another editor published, and applying it then
      // would remove holds that are already gone and keep ones that are.
      //
      // The draft's own view, like every other hold writer here: holds installed at
      // or before this draft and not removed by it, which includes anything a
      // previous editing session on this same draft already drew.
      const existing = await aliveHolds(tx, wall.id, version.versionNumber);
      const aliveById = new Map(existing.map((hold) => [hold.holdId, hold]));

      const decidedIds = [...validated.kept.map((decision) => decision.holdId), ...validated.removed];
      const strayId = decidedIds.find((holdId) => !aliveById.has(holdId));
      if (strayId != null) {
        throw new GraphQLError(`Hold ${strayId} is not on this wall`, {
          extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: strayId },
        });
      }

      // `movedFromHoldId` is lineage, and it has to name a hold THIS reset is
      // taking off the wall.
      //
      // A move is one removal and one addition in the same sitting — that is the
      // whole definition (`docs/spray-walls.md`, "Why a moved hold is removed +
      // added"). Anything looser corrupts remix permanently, and quietly:
      //
      //  - a predecessor that is still ALIVE means two holds now claim the same
      //    position on the wall, and the moment a later reset takes the
      //    predecessor off, `remixClimb` offers this unrelated older hold as its
      //    successor. Nothing ever notices, because by then the two events look
      //    exactly like a move;
      //  - a predecessor removed by an EARLIER version is history. Its successor
      //    was decided in that reset, or it had none; back-filling one now
      //    rewrites a generation that has already been published.
      //
      // The `removed` list has already been checked against the alive set above,
      // so membership in it is the whole test: it proves the hold is on the wall
      // today and is coming off in this commit.
      const removedNow = new Set(validated.removed);
      const strayPredecessor = validated.added
        .map((decision) => decision.movedFromHoldId)
        .find((holdId): holdId is number => holdId != null && !removedNow.has(holdId));
      if (strayPredecessor != null) {
        throw new GraphQLError(
          `Hold ${strayPredecessor} is not coming off the wall in this reset, so nothing can have moved from it`,
          { extensions: { code: SPRAY_WALL_CODES.holdNotAlive, holdId: strayPredecessor } },
        );
      }

      // What the wall would hold afterwards. An alive hold the decisions never
      // mention simply stays — a client that forgot one leaves a hold on the wall,
      // which is the safe direction; the alternative silently unsets every climb
      // through it.
      const nextTotal = existing.length - validated.removed.length + validated.added.length;
      if (nextTotal > MAX_HOLDS_PER_WALL) {
        throw new GraphQLError(`A wall may hold at most ${MAX_HOLDS_PER_WALL} holds; this would make ${nextTotal}.`, {
          extensions: { code: SPRAY_WALL_CODES.holdLimitReached, maxHolds: MAX_HOLDS_PER_WALL },
        });
      }

      // 1. Removals. Stamped, never deleted: the climbs set on these holds have to
      //    stay findable, and `missing_hold_count` has to stay countable.
      if (validated.removed.length > 0) {
        await tx
          .update(dbSchema.sprayWallHolds)
          .set({ removedVersionId: version.id, updatedAt: new Date() })
          .where(
            and(
              eq(dbSchema.sprayWallHolds.wallId, wall.id),
              inArray(dbSchema.sprayWallHolds.holdId, validated.removed),
            ),
          );
      }

      // 2. Additions: a fresh catalogue pair each, installed at this version.
      const added = validated.added;
      const newIds = await allocateHoldIds(tx, added.length);
      if (added.length > 0) {
        // The catalogue pair every hold needs — one `board_holes` row and one
        // `board_placements` row SHARING the id — because a climb's frames string
        // (`p<placementId>r<code>`) has to resolve to the row the reset drew.
        await tx.insert(dbSchema.boardHoles).values(
          added.map(({ detection }, index) => ({
            boardType: 'spray' as const,
            id: newIds[index],
            productId: null,
            name: null,
            x: detection.cx,
            y: detection.cy,
            mirroredHoleId: null,
          })),
        );

        await tx.insert(dbSchema.boardPlacements).values(
          added.map((_decision, index) => ({
            boardType: 'spray' as const,
            id: newIds[index],
            layoutId: wall.layoutId,
            holeId: newIds[index],
            setId: SPRAY_SET.id,
            defaultPlacementRoleId: null,
          })),
        );

        await tx.insert(dbSchema.sprayWallHolds).values(
          added.map(({ detection, movedFromHoldId }, index) => ({
            wallId: wall.id,
            holdId: newIds[index],
            cx: detection.cx,
            cy: detection.cy,
            r: detection.r,
            outline: detection.outline ?? null,
            installedVersionId: version.id,
            movedFromHoldId: movedFromHoldId ?? null,
            source: detection.source,
            confidence: detection.confidence ?? null,
          })),
        );
      }

      // 3. Kept holds take a fresher SILHOUETTE from the new photo, and nothing
      //    else.
      //
      //    `cx` / `cy` / `r` stay exactly as published, deliberately. Every climb
      //    on the wall renders from those numbers, and a kept hold matched its
      //    detection within six tenths of a radius — real, but enough to shift a
      //    climb's start hold under the climber if it were written through. Two
      //    photographs of a wall that did not change still disagree by a few
      //    pixels; the hold did not move, the camera did. An outline is a picture
      //    of the hold rather than a position, so a sharper one is free.
      //    ONE statement for the whole batch, not one per hold. A reset on a capped
      //    wall keeps 1,500 holds, and a round trip each would hold the wall lock
      //    open for 1,500 of them — every other writer on that wall queueing behind
      //    a loop whose only work is copying silhouettes.
      const refreshed = validated.kept.filter((decision) => decision.detection?.outline != null);
      if (refreshed.length > 0) {
        await tx.execute(sql`
          UPDATE spray_wall_holds
          SET outline = refresh.outline, updated_at = now()
          FROM (VALUES ${sql.join(
            refreshed.map(
              (decision) => sql`(${decision.holdId}::integer, ${JSON.stringify(decision.detection!.outline)}::jsonb)`,
            ),
            sql`, `,
          )}) AS refresh(hold_id, outline)
          WHERE spray_wall_holds.wall_id = ${wall.id}
            AND spray_wall_holds.hold_id = refresh.hold_id
        `);
      }

      // 4. A full reset is recorded on the version BEFORE the publish below,
      //    because the publish's recompute is what reads it: every climb using a
      //    hold this version removed comes out retired (#6024).
      if (validated.fullReset === true) {
        await tx
          .update(dbSchema.sprayWallVersions)
          .set({ isFullReset: true, updatedAt: new Date() })
          .where(eq(dbSchema.sprayWallVersions.id, version.id));
      }

      // 5. …and publish, which is the moment every removal above becomes real.
      //    Same transaction and same lock, so a reset is atomic: there is no
      //    instant at which the holds have gone but the version has not landed.
      const {
        version: published,
        climbsChanged,
        appliedVisibility,
      } = await publishDraftUnderLock(tx, wall, Number(version.id));

      return {
        published,
        climbsChanged,
        appliedVisibility,
        // What is still on the wall from the previous generation, not the length
        // of the `kept` list: an alive hold the decisions never mention stays,
        // and a client that listed only what it had something to say about would
        // otherwise be told most of its wall had vanished.
        keptCount: existing.length - validated.removed.length,
        removedCount: validated.removed.length,
        addedCount: added.length,
      };
    });

    logger.info('Spray wall reset committed', {
      layoutId: wall.layoutId,
      versionNumber: committed.published.versionNumber,
      removed: committed.removedCount,
      added: committed.addedCount,
      climbsChanged: committed.climbsChanged,
      fullReset: validated.fullReset === true,
    });

    // The same public-copy refresh `publishSprayWallVersion` makes, on the same
    // condition. A reset of a public wall moves the photo climbers see, so the
    // public copy has to follow it or the gym page keeps last generation's wall;
    // and a version-1 commit is a wall's FIRST publish, so it can be the one that
    // applies a public creation-time choice (#5513). After the commit and best
    // effort, for the reasons given there — `refreshPublicWallPhoto` re-checks the
    // board is still public under the row lock.
    if (board.isPublic || committed.appliedVisibility?.isPublic) {
      await refreshPublicWallPhoto(
        wall.id,
        wall.boardUuid,
        committed.published.photoKey,
        Number(committed.published.id),
      );
    }

    const deltas = await versionHoldDeltas([Number(committed.published.id)]);
    return {
      version: await toGraphQLVersion(committed.published, deltas.get(Number(committed.published.id))),
      keptCount: committed.keptCount,
      removedCount: committed.removedCount,
      addedCount: committed.addedCount,
      climbsChanged: committed.climbsChanged,
    };
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

    // A fast path with a nicer error. The read that DECIDES is the one inside the
    // lock below — two concurrent publishes of the same draft both get here.
    if (found.version.status !== 'draft') {
      throw new GraphQLError('That wall version is already published', {
        extensions: { code: SPRAY_WALL_CODES.versionNotDraft },
      });
    }

    const publishedDraft = await db.transaction(async (tx) => {
      // Stated here as well as inside the helper. `pg_advisory_xact_lock` is
      // re-entrant within a transaction, so the second take costs nothing, and a
      // reader of this resolver sees the rule where the transaction opens rather
      // than one call away.
      await lockWallForWrite(tx, found.wall.id);
      await assertSprayWallNotArchivedUnderLock(tx, found.wall.id);
      // The re-read and every write live in `publishDraftUnderLock`, so
      // this path and `commitSprayWallVersion` cannot drift on what publishing
      // means — the supersede, the hold count, the catalogue image and the
      // integrity recompute are one sequence with one owner.
      const draft = await loadDraftVersion(tx, found.wall.id, found.version.id);
      if ((await draftPurpose(tx, found.wall.id, draft)) === 'reset') {
        throw new GraphQLError('Review and confirm this reset before publishing the new photo.', {
          extensions: { code: SPRAY_WALL_CODES.resetReviewRequired },
        });
      }
      return publishDraftUnderLock(tx, found.wall, found.version.id);
    });
    const published = publishedDraft.version;

    logger.info('Spray wall version published', {
      layoutId: found.wall.layoutId,
      versionNumber: published.versionNumber,
    });

    // A public wall's photo copy is of the version climbers see, so a reset has to
    // move it. Without this the gym page would keep showing last year's wall
    // forever — the row it reads is only written on a visibility change.
    //
    // After the commit and outside the lock, best effort: the publish itself has
    // landed, and a copy that failed leaves the previous photo standing, which is
    // stale rather than wrong. `found.board.isPublic` is a fast path read before
    // the transaction; the write itself re-checks it under the wall's row lock, so a
    // demotion landing in this window cannot re-publish the photo.
    //
    // A first publish that has just applied a public creation-time choice (#5513)
    // needs the copy too: it is the moment the wall goes public, which is what
    // `updateSprayWall` copies the photo for on any other promotion.
    if (found.board.isPublic || publishedDraft.appliedVisibility?.isPublic) {
      await refreshPublicWallPhoto(found.wall.id, found.board.uuid, published.photoKey, published.id);
    }

    const deltas = await versionHoldDeltas([Number(published.id)]);
    return toGraphQLVersion(published, deltas.get(Number(published.id)));
  },

  discardSprayWallVersion: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, WALL_MUTATION_RATE_LIMIT, 'discardSprayWallVersion');

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

    await db.transaction(async (tx) => {
      await lockWallForWrite(tx, found.wall.id);
      // Re-read under the lock; the fast path above can be stale.
      const version = await loadDraftVersion(tx, found.wall.id, found.version.id);

      // A discarded draft is DELETED, not marked.
      //
      // There is no status that would work. `superseded` is the obvious candidate
      // and is exactly wrong: `aliveHolds` treats any non-draft version as having
      // LANDED, so the discarded draft's additions would come back as alive and its
      // removals would take effect — the abandoned-draft bug, made permanent. A new
      // `discarded` enum value would mean a migration for a state nobody reads.
      // Deleting leaves nothing to reason about, and is safe precisely because a
      // draft has never been published: no climb can reference its work.

      // 1. Un-mark what it removed. RESTRICT on `removed_version_id` means this has
      //    to happen before the version row goes.
      await tx
        .update(dbSchema.sprayWallHolds)
        .set({ removedVersionId: null, updatedAt: new Date() })
        .where(
          and(
            eq(dbSchema.sprayWallHolds.wallId, found.wall.id),
            eq(dbSchema.sprayWallHolds.removedVersionId, version.id),
          ),
        );

      // 2. Drop the holds it added, catalogue rows included — the same split
      //    `removeSprayWallHolds` makes for a hold drawn in the draft being edited.
      const drawn = await tx
        .select({ holdId: dbSchema.sprayWallHolds.holdId })
        .from(dbSchema.sprayWallHolds)
        .where(
          and(
            eq(dbSchema.sprayWallHolds.wallId, found.wall.id),
            eq(dbSchema.sprayWallHolds.installedVersionId, version.id),
          ),
        );
      const drawnIds = drawn.map((row) => row.holdId);
      if (drawnIds.length > 0) {
        await tx
          .delete(dbSchema.sprayWallHolds)
          .where(
            and(eq(dbSchema.sprayWallHolds.wallId, found.wall.id), inArray(dbSchema.sprayWallHolds.holdId, drawnIds)),
          );
        await tx
          .delete(dbSchema.boardPlacements)
          .where(and(eq(dbSchema.boardPlacements.boardType, 'spray'), inArray(dbSchema.boardPlacements.id, drawnIds)));
        await tx
          .delete(dbSchema.boardHoles)
          .where(and(eq(dbSchema.boardHoles.boardType, 'spray'), inArray(dbSchema.boardHoles.id, drawnIds)));
      }

      // 3. …and the version itself. Its photo object is now unreferenced; SW-17
      //    (#5450) sweeps the bucket.
      await tx.delete(dbSchema.sprayWallVersions).where(eq(dbSchema.sprayWallVersions.id, version.id));

      // 4. If that was the wall's ONLY version and nothing was ever published, the
      //    wall has no frame any more — so the frame that version DEFINED has to go
      //    with it.
      //
      //    `createSprayWallVersion` treats a non-null `reference_width` as "the
      //    frame is already decided, inherit it", which is right for a reset and
      //    wrong here: the next upload is version 1 again, and it would be mapped
      //    against the discarded photo's coordinate space. A replacement photo of a
      //    different size would put every hold drawn on it in the wrong place, and
      //    nothing later corrects that — the frame is inherited forever.
      const [{ remaining }] = await tx
        .select({ remaining: count() })
        .from(dbSchema.sprayWallVersions)
        .where(eq(dbSchema.sprayWallVersions.wallId, found.wall.id));

      if (Number(remaining) === 0) {
        await tx
          .update(dbSchema.sprayWalls)
          .set({ referenceWidth: null, referenceHeight: null, holdCount: 0, updatedAt: new Date() })
          .where(eq(dbSchema.sprayWalls.id, found.wall.id));

        // The catalogue's edge box mirrors that frame, and the join row's
        // `image_filename` points at the discarded photo's key.
        await tx
          .update(dbSchema.boardProductSizes)
          .set({ edgeLeft: 0, edgeBottom: 0, edgeRight: null, edgeTop: null })
          .where(
            and(
              eq(dbSchema.boardProductSizes.boardType, 'spray'),
              eq(dbSchema.boardProductSizes.id, spraySizeIdForLayout(found.wall.layoutId)),
            ),
          );
        await tx
          .update(dbSchema.boardProductSizesLayoutsSets)
          .set({ imageFilename: null })
          .where(
            and(
              eq(dbSchema.boardProductSizesLayoutsSets.boardType, 'spray'),
              eq(dbSchema.boardProductSizesLayoutsSets.id, found.wall.layoutId),
            ),
          );
      }
    });

    logger.info('Spray wall draft discarded', {
      layoutId: found.wall.layoutId,
      versionNumber: found.version.versionNumber,
    });
    return true;
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
    /** The public copy the tombstone orphans, deleted after the commit. */
    let orphanedPublicKey: string | null = null;
    await db.transaction(async (tx) => {
      // The same wall lock every other writer takes: without it a publish in
      // flight would stamp `current_version_id` onto a wall this transaction is
      // deleting.
      await lockWallForWrite(tx, wall.id);

      // A deleted wall stops being reachable, so its feed rows have to go too —
      // they are served straight from `feed_items` and would outlive it otherwise.
      await purgeSprayWallFeedItems(tx, wall.layoutId);

      // A wall that was public left a copy of its photo in the world-readable
      // `media` bucket, under a key `publicPhotoUrl` hands to crawlers and share
      // cards. Soft-deleting the rows stops Boardsesh serving that URL, and does
      // nothing at all about the object: anyone holding the URL would keep reading
      // the photograph of a wall its owner has deleted. So the key is cleared here,
      // under the same lock and in the same transaction as the tombstone — the same
      // pairing the going-private path in `updateSprayWall` makes, for the same
      // reason: a window where the flag and the key disagree is a window where a
      // deleted wall's photo still resolves.
      const [wallNow] = await tx
        .select({ publicPhotoKey: dbSchema.sprayWalls.publicPhotoKey })
        .from(dbSchema.sprayWalls)
        .where(eq(dbSchema.sprayWalls.id, wall.id))
        .limit(1);
      if (wallNow?.publicPhotoKey) orphanedPublicKey = wallNow.publicPhotoKey;

      await tx
        .update(dbSchema.sprayWalls)
        .set({ deletedAt, updatedAt: deletedAt, publicPhotoKey: null })
        .where(eq(dbSchema.sprayWalls.id, wall.id));
      await tx
        .update(dbSchema.userBoards)
        .set({ deletedAt, syncFrozenAt: deletedAt })
        .where(eq(dbSchema.userBoards.id, board.id));
    });

    // AFTER the commit, never before: a delete inside the transaction would destroy
    // the photo of a wall whose deletion then rolled back, leaving a live wall
    // pointing at bytes that are gone. Best effort, like every other public-copy
    // delete — the row has already stopped handing the URL out, and a failure is
    // logged and left to the SW-17 sweep.
    await deletePublicWallPhoto(orphanedPublicKey);

    logger.info('Spray wall deleted', { layoutId: wall.layoutId, userId: ctx.userId });
    return true;
  },
};
