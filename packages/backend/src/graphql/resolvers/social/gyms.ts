import { GraphQLError } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import {
  eq,
  ne,
  and,
  count,
  exists,
  isNull,
  isNotNull,
  notExists,
  sql,
  ilike,
  or,
  desc,
  inArray,
  type SQL,
} from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { getUserCommunityRoles, rolesGrantAdminOrLeader } from './roles';
import { createGymManageAccessNotification } from './gym-notifications';
import { assertNoGymClaimProbation } from './gym-claim-guardrails';
import {
  CreateGymInputSchema,
  UpdateGymInputSchema,
  AddGymMemberInputSchema,
  RemoveGymMemberInputSchema,
  FollowGymInputSchema,
  MyGymsInputSchema,
  SearchGymsInputSchema,
  GymMembersInputSchema,
  LinkBoardToGymInputSchema,
  GrantGymWriteAccessInputSchema,
  RevokeGymWriteAccessInputSchema,
  UUIDSchema,
  MAX_ACKNOWLEDGED_GYM_UUIDS,
} from '../../../validation/schemas';
import { distanceMeters } from '@boardsesh/db/queries';
import { computeCanClaimByDomain } from '@boardsesh/gym-claim';
import { logger } from '../../../utils/logger';
import { parsePostgresUtcTimestamp } from '../../../utils/postgres-timestamps';
import {
  findSimilarGymCandidates,
  MAX_SIMILAR_GYMS,
  PROXIMITY_MATCH_RADIUS_METERS,
  toSimilarGymResults,
} from './gym-matching';
import { assertGymCapNotReached, blockingSimilarGyms, lockGymCreate, similarGymsExistError } from './gym-create-guards';
import { syncLocationGeography } from './location-geography';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { boardIsNotArchivedSprayWall } from '../board/spray-wall-listing';
import { gymLocationFilter } from './gym-discovery-filters';
import { publicGymSitemap } from './gym-sitemap';
import type { GymListingState } from '@boardsesh/shared-schema';
import type { BoardModerationActorRole } from '@boardsesh/db/schema';
import {
  boardHeldOffGymError,
  isBoardHeldOffGym,
  recordOwnerGymLinkChange,
  resolveGymEditActorRole,
  viewerGymManagerRole,
} from './board-moderation-events';
import { onGymDetailsEdited, REPORT_FIXING_GYM_FIELDS } from './directory-reports/lifecycle';
import { afterCommit, transactionWithAfterCommit } from '../../../db/after-commit';
import { managedGymImageKey, removeManagedGymImage } from '../../../services/gym-image-storage';
import { getPostgresErrorCode, isUniqueViolation } from '../../../utils/postgres-errors';

// ============================================
// Helpers
// ============================================

/**
 * Generate a unique slug from a gym name.
 * Exported for reuse in board auto-gym creation.
 *
 * `executor` reads on a connection the caller already holds, e.g. createGym's
 * transaction, so the read sees what the create's locks serialized.
 */
export async function generateUniqueGymSlug(name: string, executor: Pick<typeof db, 'select'> = db): Promise<string> {
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'gym';

  // Find all existing slugs matching this base in a single query
  const existing = await executor
    .select({ slug: dbSchema.gyms.slug })
    .from(dbSchema.gyms)
    .where(
      and(
        or(eq(dbSchema.gyms.slug, baseSlug), ilike(dbSchema.gyms.slug, `${baseSlug.replace(/[%_\\]/g, '\\$&')}-%`)),
        // A merge tombstone still owns its old URL; reusing it would shadow
        // the survivor's redirect, including URLs exchanged by an admin repair.
        or(isNull(dbSchema.gyms.deletedAt), isNotNull(dbSchema.gyms.mergedIntoGymId)),
      ),
    );

  const existingSlugs = new Set(existing.map((r) => r.slug));

  if (!existingSlugs.has(baseSlug)) {
    return baseSlug;
  }

  for (let i = 2; i <= 100; i++) {
    const candidateSlug = `${baseSlug}-${i}`;
    if (!existingSlugs.has(candidateSlug)) {
      return candidateSlug;
    }
  }

  return `${baseSlug}-${uuidv4().slice(0, 8)}`;
}

// Non-string, non-Date inputs map to null on purpose: the driver only returns
// offset-less strings (or Date) for these columns.
function rawUtcTimestamp(value: unknown): Date | null {
  const iso = parsePostgresUtcTimestamp(value instanceof Date || typeof value === 'string' ? value : null);
  return iso ? new Date(iso) : null;
}

/**
 * Map a raw SQL row (snake_case columns) to the Drizzle gym schema shape.
 * Used for PostGIS proximity queries that bypass the Drizzle query builder.
 *
 * Exported for the test that guards the snake_case reads — every key here comes
 * off a raw `SELECT *`, so a camelCase typo type-checks fine and silently maps
 * to null forever on the proximity path while the Drizzle path looks healthy.
 */
export function mapRawGymRow(row: Record<string, unknown>): typeof dbSchema.gyms.$inferSelect {
  return {
    id: row.id as number,
    uuid: row.uuid as string,
    name: row.name as string,
    slug: (row.slug as string | null) ?? null,
    ownerId: row.owner_id as string,
    address: (row.address as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    // The raw query is a `SELECT *`, so the column is present; fall back to the
    // safe value (un-vouched) rather than trusting a missing key (#3431).
    websiteVouchedByOwner: row.website_vouched_by_owner === true,
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    isPublic: row.is_public as boolean,
    isListed: row.is_listed !== false,
    description: (row.description as string | null) ?? null,
    // Snake_case, like every other key here — `row.hoursUpdatedAt` would compile
    // and then hand the proximity path a permanent null "Confirmed" date while
    // the Drizzle text-search path renders it correctly (same class of bug as
    // website_vouched_by_owner above).
    reportingTimeZone: (row.reporting_time_zone as string | null) ?? null,
    hours: (row.hours as string | null) ?? null,
    hoursUpdatedAt: rawUtcTimestamp(row.hours_updated_at),
    imageUrl: (row.image_url as string | null) ?? null,
    logoUrl: (row.logo_url as string | null) ?? null,
    brandPrimaryColor: (row.brand_primary_color as string | null) ?? null,
    brandAccentColor: (row.brand_accent_color as string | null) ?? null,
    brandBackgroundColor: (row.brand_background_color as string | null) ?? null,
    mergedIntoGymId: row.merged_into_gym_id != null ? Number(row.merged_into_gym_id) : null,
    // Raw `db.execute` returns timestamps as offset-less strings (the Drizzle
    // query builder hydrates them to Date, reading them as UTC). Parse them as
    // UTC here too, so both paths agree on any host TZ (#4588).
    createdAt: rawUtcTimestamp(row.created_at) ?? (null as unknown as Date),
    updatedAt: rawUtcTimestamp(row.updated_at) ?? (null as unknown as Date),
    deletedAt: rawUtcTimestamp(row.deleted_at),
    syncFrozenAt: rawUtcTimestamp(row.sync_frozen_at),
  };
}

type GymRow = typeof dbSchema.gyms.$inferSelect;
type GymAccessExecutor = NonNullable<Parameters<typeof getUserCommunityRoles>[1]>;

// A real merge chain is 1–2 hops; the cap is a safety net against a corrupt or
// cyclic pointer in prod data so the resolver can never spin.
const MAX_MERGE_HOPS = 10;

/**
 * Follow a gym's `merged_into_gym_id` chain to the canonical LIVE row.
 *
 * A merge keeps one canonical row live and soft-deletes the twin with
 * `merged_into_gym_id` pointing at the survivor. Given any starting row:
 *  - a live row (deletedAt null) is already canonical — returned as-is;
 *  - a soft-deleted row WITHOUT a pointer is a plain deletion — returns null,
 *    preserving the historical 404 for genuinely deleted gyms;
 *  - a soft-deleted row WITH a pointer is a merged twin — walk to the survivor.
 *
 * Bounded to MAX_MERGE_HOPS with a visited-id cycle guard, so a corrupt loop in
 * the data resolves to null instead of hanging.
 */
export async function resolveCanonicalGym(startGym: GymRow, executor: GymAccessExecutor = db): Promise<GymRow | null> {
  let current = startGym;
  const visited = new Set<number>([current.id]);

  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    if (current.deletedAt == null) {
      return current;
    }
    const nextId = current.mergedIntoGymId;
    if (nextId == null || visited.has(nextId)) {
      return null;
    }
    visited.add(nextId);
    const [parent] = await executor.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, nextId)).limit(1);
    if (!parent) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Look up a gym by uuid (soft-deleted rows included) and resolve it to the
 * canonical live row. Used by every by-uuid read/write lookup so a deduped gym's
 * old uuid resolves to the survivor instead of 404ing.
 */
export async function resolveCanonicalGymByUuid(
  gymUuid: string,
  executor: GymAccessExecutor = db,
): Promise<GymRow | null> {
  const [gym] = await executor.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.uuid, gymUuid)).limit(1);
  if (!gym) {
    return null;
  }
  return resolveCanonicalGym(gym, executor);
}

/**
 * Look up a gym by slug and resolve it to the canonical live row. A live row
 * (unique among live rows via the partial slug index) is preferred and returned
 * directly. Otherwise the slug may belong to a merged twin — the twin's slug
 * isn't in the live-only unique index, so match the most-recently-merged
 * soft-deleted row carrying that slug and follow its chain.
 */
export async function resolveCanonicalGymBySlug(slug: string): Promise<GymRow | null> {
  const [live] = await db
    .select()
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.slug, slug), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  if (live) {
    return live;
  }

  const [mergedTwin] = await db
    .select()
    .from(dbSchema.gyms)
    .where(
      and(
        eq(dbSchema.gyms.slug, slug),
        // A merged twin is always soft-deleted; make that explicit rather than
        // leaning on the live-row query above having already returned.
        isNotNull(dbSchema.gyms.deletedAt),
        isNotNull(dbSchema.gyms.mergedIntoGymId),
      ),
    )
    .orderBy(desc(dbSchema.gyms.updatedAt), desc(dbSchema.gyms.id))
    .limit(1);
  if (!mergedTwin) {
    return null;
  }
  return resolveCanonicalGym(mergedTwin);
}

/**
 * Cap on `Gym.boardSummaries`, applied PER BOARD TYPE rather than to the flat
 * list. A gym with a wall of boards must not ship a summary per board for a card
 * that visually truncates after a handful, but a flat cap over a list ordered
 * `board_type, angle` silently drops whole board types off the end: twelve
 * `(kilter, angle)` pairs plus one MoonBoard would render twelve Kilter chips
 * and no MoonBoard chip. `SEARCH_GYMS_DIRECTORY` selects `boardSummaries` and
 * not `boardTypes`, so on `/gyms/moonboard` a gym matched BY the moonboard
 * filter would then show zero MoonBoard chips. Capping after grouping keeps
 * every board type represented; `boardCount` remains the honest total.
 */
export const GYM_BOARD_SUMMARY_ANGLES_PER_TYPE = 6;

/**
 * Who runs a gym listing, for every viewer alike (docs/product/gym-board-governance.md,
 * decision 4):
 * - UNCLAIMED: the SYSTEM import account owns it; nobody has claimed it.
 * - RUN_BY_GYM: its owner got it through an approved claim or an admin handover.
 * - CLIMBER_LISTED: a climber owns it some other way, usually by naming a gym
 *   while setting up their board.
 */
export function gymListingState(ownerId: string, ownerHoldsClaimOrHandover: boolean): GymListingState {
  if (ownerId === SYSTEM_BOARD_OWNER_ID) return 'UNCLAIMED';
  return ownerHoldsClaimOrHandover ? 'RUN_BY_GYM' : 'CLIMBER_LISTED';
}

/**
 * Whether the gym's current owner holds an approved claim on it or received it
 * through an admin reassignment: two EXISTS probes, folded into enrichGym's
 * owner query so the directory pays no extra round trip per gym. Its correlated
 * twin, for a query over many gyms, is `ownerHoldsClaimOrHandoverColumn` in
 * gym-run-by-staff.ts. Change both together.
 */
function ownerHoldsClaimOrHandoverSql(gym: Pick<typeof dbSchema.gyms.$inferSelect, 'id' | 'uuid' | 'ownerId'>) {
  const approvedClaim = db
    .select({ one: sql`1` })
    .from(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.gymId, gym.id),
        eq(dbSchema.gymClaims.claimantUserId, gym.ownerId),
        eq(dbSchema.gymClaims.status, 'approved'),
      ),
    );
  const adminHandover = db
    .select({ one: sql`1` })
    .from(dbSchema.gymOwnerReassignments)
    .where(
      and(
        eq(dbSchema.gymOwnerReassignments.gymUuid, gym.uuid),
        eq(dbSchema.gymOwnerReassignments.newOwnerId, gym.ownerId),
      ),
    );
  return sql<boolean>`(${exists(approvedClaim)} OR ${exists(adminHandover)})`;
}

/**
 * Enrich a gym row with computed fields (counts, follow status, membership).
 * Exported so the kiosk resolvers can attach the same branding-carrying `Gym`
 * payload (logo + colours) to a public kiosk without duplicating the enrichment.
 */
export async function enrichGym(gym: typeof dbSchema.gyms.$inferSelect, authenticatedUserId?: string) {
  const [
    ownerResult,
    boardCountResult,
    boardVariantsResult,
    memberCountResult,
    followerCountResult,
    commentCountResult,
    followCheckResult,
    memberCheckResult,
    viewerRolesResult,
  ] = await Promise.all([
    // Get owner profile, and whether they run the gym (listingState)
    db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        holdsClaimOrHandover: ownerHoldsClaimOrHandoverSql(gym),
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, gym.ownerId))
      .limit(1),

    // Count linked boards. Not a spray wall a reset archived: its successor is
    // the same physical wall, and counting both would grow the gym by one per reset.
    db
      .select({ count: count() })
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.gymId, gym.id),
          isNull(dbSchema.userBoards.deletedAt),
          boardIsNotArchivedSprayWall(),
        ),
      ),

    // Distinct (board type, angle) pairs at this gym. ONE query feeds both
    // `boardTypes` (filtering + badges) and `boardSummaries` (directory board
    // chips) — deliberately widened rather than joined by a second query, because
    // enrichGym already fires nine round trips per gym and searchGyms runs it per
    // row (limit up to 50), so a 24-card directory page costs ~216 queries; a
    // tenth per gym would make it 240. Ordered so the summary cap below slices a
    // stable prefix.
    db
      .selectDistinct({ boardType: dbSchema.userBoards.boardType, angle: dbSchema.userBoards.angle })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt)))
      .orderBy(dbSchema.userBoards.boardType, dbSchema.userBoards.angle),

    // Count members
    db.select({ count: count() }).from(dbSchema.gymMembers).where(eq(dbSchema.gymMembers.gymId, gym.id)),

    // Count followers
    db.select({ count: count() }).from(dbSchema.gymFollows).where(eq(dbSchema.gymFollows.gymId, gym.id)),

    // Count comments
    db
      .select({ count: count() })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, 'gym'),
          eq(dbSchema.comments.entityId, gym.uuid),
          isNull(dbSchema.comments.deletedAt),
        ),
      ),

    // Check if authenticated user follows this gym
    authenticatedUserId
      ? db
          .select({ count: count() })
          .from(dbSchema.gymFollows)
          .where(and(eq(dbSchema.gymFollows.userId, authenticatedUserId), eq(dbSchema.gymFollows.gymId, gym.id)))
      : Promise.resolve([]),

    // Check if authenticated user is a member
    authenticatedUserId
      ? db
          .select({ role: dbSchema.gymMembers.role })
          .from(dbSchema.gymMembers)
          .where(and(eq(dbSchema.gymMembers.userId, authenticatedUserId), eq(dbSchema.gymMembers.gymId, gym.id)))
          .limit(1)
      : Promise.resolve([]),

    // Viewer's community roles (for canEdit: a community admin/leader scoped to
    // one of the gym's board types, or global, may edit the gym)
    authenticatedUserId ? getUserCommunityRoles(authenticatedUserId) : Promise.resolve([]),
  ]);

  const ownerInfo = ownerResult[0];
  const boardCount = Number(boardCountResult[0]?.count || 0);
  // Both derived from the single widened distinct query above. Grouping first
  // means the per-type angle cap can never drop a board type from the chips, and
  // `boardTypes` still comes off EVERY row (the map keys), so it stays the
  // uncapped set the filters and badges have always used. Insertion order is the
  // query's `ORDER BY board_type, angle`, so the output is deterministic.
  const anglesByBoardType = new Map<string, number[]>();
  for (const row of boardVariantsResult) {
    const anglesForType = anglesByBoardType.get(row.boardType);
    if (!anglesForType) {
      anglesByBoardType.set(row.boardType, [Number(row.angle)]);
    } else if (anglesForType.length < GYM_BOARD_SUMMARY_ANGLES_PER_TYPE) {
      anglesForType.push(Number(row.angle));
    }
  }
  const boardSummaries = [...anglesByBoardType].flatMap(([boardType, angles]) =>
    angles.map((angle) => ({ boardType, angle })),
  );
  const boardTypes = [...anglesByBoardType.keys()];
  const memberCount = Number(memberCountResult[0]?.count || 0);
  const followerCount = Number(followerCountResult[0]?.count || 0);
  const commentCount = Number(commentCountResult[0]?.count || 0);
  const isFollowedByMe = Number(followCheckResult[0]?.count || 0) > 0;

  // Determine membership: owner is always a member with "admin" implied
  const isOwner = authenticatedUserId === gym.ownerId;
  const memberRow = (memberCheckResult as Array<{ role: string }>)[0];
  const isMember = isOwner || !!memberRow;
  const myRole = isOwner ? 'admin' : ((memberRow?.role as 'admin' | 'editor' | 'member' | undefined) ?? null);

  // A community admin/leader whose role is global or scoped to one of the gym's
  // board types. Drives both edit and grant permissions below.
  const viewerRoles = viewerRolesResult as Array<{ role: string; boardType: string | null }>;
  const hasCommunityAccess =
    rolesGrantAdminOrLeader(viewerRoles, null) ||
    boardTypes.some((boardType) => rolesGrantAdminOrLeader(viewerRoles, boardType));

  // Editable by gym owner/admin/editor, or a covering community admin/leader.
  const canEdit = isOwner || memberRow?.role === 'admin' || memberRow?.role === 'editor' || hasCommunityAccess;
  // Grantable (write-access grants) by owner/gym-admin or a covering community
  // admin/leader — NOT plain editors. Mirrors requireGymGrantAccess.
  const canGrantAccess = isOwner || memberRow?.role === 'admin' || hasCommunityAccess;
  // Viewer-independent like isClaimed, so anonymous SSR can show it too.
  const listingState = gymListingState(gym.ownerId, ownerInfo?.holdsClaimOrHandover === true);

  // A signed-in viewer who has no edit access can start a claim. Owners, gym
  // admins/editors, and covering community leaders are excluded — they can
  // already edit the gym, so the self-service claim path isn't for them (and the
  // domain path would reject them anyway). Nobody can claim a gym its staff run:
  // a dispute goes through Report a problem, and requestGymClaim refuses it.
  const canClaim =
    !!authenticatedUserId &&
    listingState !== 'RUN_BY_GYM' &&
    !isOwner &&
    memberRow?.role !== 'admin' &&
    memberRow?.role !== 'editor' &&
    !hasCommunityAccess;

  // Whether a real person owns this gym. Gyms created by the location sync are
  // parked on the system import user, so ownership by anyone else means someone
  // claimed it. This reads `gym.ownerId` ONLY — never `authenticatedUserId` — so
  // the value is identical for every viewer and is therefore safe to cache for
  // anonymous SSR. That is the whole point of the field: `canClaim` is false for
  // every signed-out viewer, and signed-out viewers are the public directory's
  // entire audience, so a card gated on `canClaim` would render nothing for them
  // while looking correct in a logged-in dev session.
  const isClaimed = gym.ownerId !== SYSTEM_BOARD_OWNER_ID;

  // Viewer-independent listing capability for choosing the claim form, including
  // anonymous SSR. requestGymClaim still enforces the same website conditions
  // and separately checks the viewer's access before accepting any claim.
  const canClaimByDomain = computeCanClaimByDomain(gym);

  return {
    uuid: gym.uuid,
    slug: gym.slug,
    ownerId: gym.ownerId,
    ownerDisplayName: ownerInfo?.displayName || ownerInfo?.name || undefined,
    ownerAvatarUrl: ownerInfo?.avatarUrl || ownerInfo?.image || undefined,
    name: gym.name,
    description: gym.description,
    hours: gym.hours,
    hoursUpdatedAt: gym.hoursUpdatedAt ? gym.hoursUpdatedAt.toISOString() : null,
    address: gym.address,
    website: gym.website,
    contactEmail: gym.contactEmail,
    contactPhone: gym.contactPhone,
    latitude: gym.latitude,
    longitude: gym.longitude,
    isPublic: gym.isPublic,
    isListed: gym.isListed !== false,
    imageUrl: gym.imageUrl,
    logoUrl: gym.logoUrl,
    brandPrimaryColor: gym.brandPrimaryColor,
    brandAccentColor: gym.brandAccentColor,
    brandBackgroundColor: gym.brandBackgroundColor,
    createdAt: gym.createdAt.toISOString(),
    boardCount,
    boardTypes,
    boardSummaries,
    memberCount,
    followerCount,
    commentCount,
    isFollowedByMe,
    isMember,
    myRole,
    canEdit,
    canGrantAccess,
    canClaim,
    isClaimed,
    canClaimByDomain,
    listingState,
  };
}

/**
 * `SearchGymsInput.requireSlug` predicate: keep only gyms that can produce a
 * `/gym/[slug]` URL. A slugless gym renders as `/gym/null` in the public
 * directory, so the directory opts in; every other caller omits the flag and
 * gets `null` back, leaving its emitted SQL byte-identical.
 *
 * ONE exported function, parameterised by the slug expression, because
 * searchGyms has two code paths and the proximity path issues its count and its
 * rows as two SEPARATE `db.execute` calls that only agree because both
 * interpolate the same filter clause. A predicate added to the rows query but
 * not the count makes `totalCount`/`hasMore` disagree with the rows returned —
 * broken pagination that no test catches unless it asserts on both statements.
 * Callers pass `gyms.slug` (raw PostGIS path) or the Drizzle column (text path).
 */
export function slugPresentFilter(requireSlug: boolean | undefined, slugColumn: SQL): SQL | null {
  // Empty string is excluded alongside NULL: `/gym/` is as broken a link as
  // `/gym/null`, and the column has no NOT NULL / non-empty constraint.
  return requireSlug ? sql`${slugColumn} IS NOT NULL AND ${slugColumn} <> ''` : null;
}

type GymMemberRole = 'admin' | 'editor' | 'member';

/** Callers locking evidence must already hold the canonical gym row in their transaction. */
export interface GymAccessOptions {
  lock?: boolean;
}

const GYM_EDIT_MEMBER_ROLES = ['admin', 'editor'] as const;
type GymAccessLevel = 'view' | 'edit' | 'grant' | 'admin';

/**
 * Load a gym and the caller's per-gym role (null if not owner/member). Shared
 * building block for the gym gates below.
 */
async function loadGymWithMemberRole(
  gymUuid: string,
  userId: string,
  executor: GymAccessExecutor = db,
): Promise<{ gym: typeof dbSchema.gyms.$inferSelect; isOwner: boolean; memberRole: GymMemberRole | null }> {
  // Resolve merged twins to the canonical survivor so every write-access gate
  // (edit / grant / owner-or-admin) runs against the live row a stale uuid now
  // points at, never the soft-deleted twin.
  const gym = await resolveCanonicalGymByUuid(gymUuid, executor);

  if (!gym) {
    throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
  }

  if (gym.ownerId === userId) {
    return { gym, isOwner: true, memberRole: null };
  }

  const [member] = await executor
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);

  return { gym, isOwner: false, memberRole: (member?.role as GymMemberRole | undefined) ?? null };
}

/**
 * Whether a user holds a community admin/leader role that covers this gym —
 * global (boardType null) or scoped to one of the gym's board types. Shared by
 * the edit + grant gates and mirrored read-side in enrichGym.
 */
async function hasGymCommunityAccess(
  gym: GymRow,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
  knownRoles?: Awaited<ReturnType<typeof getUserCommunityRoles>>,
): Promise<boolean> {
  const roles = knownRoles ?? (await getUserCommunityRoles(userId, executor, options));
  if (rolesGrantAdminOrLeader(roles, null)) return true;
  const coveredTypes = [
    ...new Set(
      roles.flatMap((role) =>
        role.boardType !== null && rolesGrantAdminOrLeader([role], role.boardType) ? [role.boardType] : [],
      ),
    ),
  ];
  if (coveredTypes.length === 0) return false;
  const witness = executor
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.gymId, gym.id),
        isNull(dbSchema.userBoards.deletedAt),
        inArray(dbSchema.userBoards.boardType, coveredTypes),
      ),
    )
    .orderBy(dbSchema.userBoards.id)
    .limit(1);
  try {
    return (options.lock ? await witness.for('share', { noWait: true }) : await witness).length > 0;
  } catch (error) {
    if (getPostgresErrorCode(error) !== '55P03') throw error;
    throw new GraphQLError('This board is changing. Retry the same action in a moment.', {
      extensions: { code: 'CONFLICT' },
    });
  }
}

/** Website and delegated writes share the verdict; locking changes only the lifetime of its evidence. */
async function userHasGymAccess(
  gym: GymRow,
  userId: string,
  level: GymAccessLevel,
  executor: GymAccessExecutor,
  options: GymAccessOptions,
): Promise<boolean> {
  if (!options.lock && (gym.ownerId === userId || (level === 'view' && gym.isPublic))) return true;
  const members = executor
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);
  const [member] = options.lock ? await members.for('share') : await members;
  // Child-board actions may use a different role from the gym edit permission.
  // Pin all existing role rows even when a membership already permits editing.
  const roles = options.lock ? await getUserCommunityRoles(userId, executor, options) : undefined;
  if (gym.ownerId === userId || (level === 'view' && gym.isPublic)) return true;
  if (member?.role === 'admin' || ((level === 'edit' || level === 'view') && member?.role === 'editor')) return true;
  if (level === 'admin') return false;
  return hasGymCommunityAccess(gym, userId, executor, options, roles);
}

/**
 * Whether a user already has edit access to a gym (owner, gym admin/editor
 * member, or a covering community admin/leader). Exported so the claim flow can
 * refuse the self-service domain path to anyone who can already edit the gym's
 * `website` — otherwise they could rewrite it and self-verify into ownership.
 */
export async function userCanEditGym(
  gym: typeof dbSchema.gyms.$inferSelect,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<boolean> {
  return userHasGymAccess(gym, userId, 'edit', executor, options);
}

export async function userCanGrantGymAccess(
  gym: GymRow,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<boolean> {
  return userHasGymAccess(gym, userId, 'grant', executor, options);
}

export async function userCanAdminGym(
  gym: GymRow,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<boolean> {
  return userHasGymAccess(gym, userId, 'admin', executor, options);
}

/** SQL twin of userCanEditGym, applied before pagination. Keep its parity regression with this rule. */
export function managedGymPredicate(userId: string, executor: GymAccessExecutor = db) {
  const staff = executor
    .select({ gymId: dbSchema.gymMembers.gymId })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.userId, userId), inArray(dbSchema.gymMembers.role, GYM_EDIT_MEMBER_ROLES)));
  const coveringRole = executor
    .select({ userId: dbSchema.communityRoles.userId })
    .from(dbSchema.communityRoles)
    .where(
      and(
        eq(dbSchema.communityRoles.userId, userId),
        inArray(dbSchema.communityRoles.role, ['admin', 'community_leader']),
        or(
          isNull(dbSchema.communityRoles.boardType),
          exists(
            executor
              .select({ id: dbSchema.userBoards.id })
              .from(dbSchema.userBoards)
              .where(
                and(
                  eq(dbSchema.userBoards.gymId, dbSchema.gyms.id),
                  isNull(dbSchema.userBoards.deletedAt),
                  eq(dbSchema.userBoards.boardType, dbSchema.communityRoles.boardType),
                ),
              ),
          ),
        ),
      ),
    );
  return and(
    isNull(dbSchema.gyms.deletedAt),
    isNull(dbSchema.gyms.mergedIntoGymId),
    or(eq(dbSchema.gyms.ownerId, userId), inArray(dbSchema.gyms.id, staff), exists(coveringRole)),
  );
}

/**
 * Gate for gym MANAGEMENT (add/remove members, link boards): owner or gym admin
 * member only. Community moderators are intentionally excluded here — otherwise
 * a board-type-scoped role could self-promote to a persistent gym admin (a
 * gym_members row that outlives the community role) or evict other admins.
 */
export async function requireGymOwnerOrAdmin(
  gymUuid: string,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<GymRow> {
  const gym = await resolveCanonicalGymByUuid(gymUuid, executor);
  if (!gym) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
  if (!(await userCanAdminGym(gym, userId, executor, options))) {
    throw new GraphQLError('Not authorized: must be gym owner or admin', { extensions: { code: 'FORBIDDEN' } });
  }
  return gym;
}

/**
 * How close a board must be to a gym for its owner to self-link it, when they
 * don't own or administer that gym. Shares the stray-board matching radius so
 * "at this gym" means one thing across the codebase.
 */
export const SELF_LINK_PROXIMITY_METERS = PROXIMITY_MATCH_RADIUS_METERS;

/**
 * Beyond this many DISTINCT gyms the caller neither owns nor admins, stop
 * allowing more. Counted per gym, not per board, so someone with three boards at
 * one gym spends one of their allowance rather than three. Set high enough to be
 * invisible to a real climber (who travels to a handful of gyms) while still
 * bounding a scripted spray across many listings.
 */
export const MAX_FOREIGN_GYM_LINKS = 20;

/**
 * Beyond this many of the caller's own boards listed at ONE gym they don't run,
 * stop allowing more. Bounds how far a single listing can be flooded, which the
 * distinct-gym cap above deliberately does not (it excludes the target gym so
 * several walls at your home gym cost one slot).
 */
export const MAX_BOARDS_PER_FOREIGN_GYM = 5;

/**
 * Gate for attaching a board to a gym: owner/admin of the gym as before, plus
 * an owner-only self-service path so a climber can put their board on the gym
 * they actually climb at without being staff there. Before #4166 this was
 * owner-or-admin only, which made the common case — "there's a MoonBoard at this
 * gym someone else listed, let me add it" — impossible.
 *
 * The proximity check is NOT a security boundary: the board's coordinates come
 * from the caller and a public gym's are readable by anyone, so it stops honest
 * mistakes, not deliberate spam. What actually bounds abuse is the combination
 * of public-gyms-only, own-boards-only, the per-caller cap, the dedicated rate
 * limit at the call site, and `detachBoardFromGym` letting gym staff undo it.
 *
 * Note a real consequence to surface in the UI: linking hands the gym's admins
 * edit rights over the board (see `viewerCanAdminGym` → `requireBoardEditAccess`).
 *
 * An existing board (`boardId`) that the gym's staff took off their listing is
 * held off it: its creator cannot self-link it back until staff relink it
 * (`isBoardHeldOffGym`). The staff path above is how they do that.
 */
export async function requireBoardGymLinkAccess(opts: {
  ctx: ConnectionContext;
  gymUuid: string;
  userId: string;
  // Stored board owner, or the authenticated creator when inserting a board.
  boardOwnerId: string;
  // The board being linked; omitted while inserting one, which has no history.
  boardId?: number;
  boardLatitude: number | null;
  boardLongitude: number | null;
}): Promise<typeof dbSchema.gyms.$inferSelect> {
  const { ctx, gymUuid, userId, boardOwnerId, boardId, boardLatitude, boardLongitude } = opts;
  const { gym, isOwner, memberRole } = await loadGymWithMemberRole(gymUuid, userId);

  // Staff keep the unconditional path — including for gyms or boards that have
  // no coordinates at all, which would otherwise fail the proximity test.
  if (isOwner || memberRole === 'admin') return gym;

  // A private gym must be indistinguishable from a non-existent one, or this
  // becomes a probe for private home-wall gyms.
  //
  // This MUST stay above the rate limit. A missing gym throws out of
  // loadGymWithMemberRole without ever reaching the bucket, so charging before
  // this check made the two cases distinguishable by bucket state even though
  // they share a message: probe five times, then call once against a known
  // public gym — "rate limit exceeded" means the uuid is a live private gym,
  // "not authorized" means it doesn't exist.
  if (!gym.isPublic) throw new Error('Gym not found');

  // Editing a wall through its current gym or a community role is not consent
  // to give another gym's staff edit rights. Only its owner can self-link it.
  if (boardOwnerId !== userId) throw new Error('Not authorized to link board to this gym');

  // Staff took this board off this gym. Said plainly, before the rate limit and
  // the proximity rules, so the creator learns who to ask rather than why a
  // distance check failed.
  if (boardId != null && (await isBoardHeldOffGym(boardId, gym.id))) throw boardHeldOffGymError();

  // The tight bucket belongs to the self-service path only. Charged here rather
  // than at the call site so a gym owner adding several boards to their OWN gym
  // isn't throttled by a limit named for a path they're not on.
  await applyRateLimit(ctx, 5, 'linkBoardToForeignGym');

  if (boardLatitude == null || boardLongitude == null || gym.latitude == null || gym.longitude == null) {
    throw new Error('Not authorized to link board to this gym');
  }

  const distance = distanceMeters(
    { latitude: boardLatitude, longitude: boardLongitude },
    { latitude: gym.latitude, longitude: gym.longitude },
  );
  if (distance > SELF_LINK_PROXIMITY_METERS) {
    throw new Error('Not authorized to link board to this gym');
  }

  // Distinct gyms, and live ones only: counting rows would spend three of the
  // allowance on three boards at one gym, and counting soft-deleted gyms would
  // permanently block someone whose past gyms were since removed.
  const [{ count: foreignGyms }] = await db
    .select({ count: sql<number>`count(DISTINCT ${dbSchema.gyms.id})::int` })
    .from(dbSchema.userBoards)
    .innerJoin(dbSchema.gyms, eq(dbSchema.userBoards.gymId, dbSchema.gyms.id))
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, userId),
        isNull(dbSchema.userBoards.deletedAt),
        isNull(dbSchema.gyms.deletedAt),
        ne(dbSchema.gyms.id, gym.id),
        ne(dbSchema.gyms.ownerId, userId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(dbSchema.gymMembers)
            .where(
              and(
                eq(dbSchema.gymMembers.gymId, dbSchema.gyms.id),
                eq(dbSchema.gymMembers.userId, userId),
                eq(dbSchema.gymMembers.role, 'admin'),
              ),
            ),
        ),
      ),
    );
  if (foreignGyms >= MAX_FOREIGN_GYM_LINKS) {
    throw new Error('Not authorized to link board to this gym');
  }

  // Depth, not just breadth. The count above deliberately excludes this gym so
  // several boards at the gym you actually climb at cost one slot — but that
  // left the number of boards one account can push onto a SINGLE gym's listing
  // unbounded. A climber has a handful of walls at one gym; a flood is someone
  // else's problem to clean up by hand, one detach at a time.
  const [{ count: boardsAtThisGym }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, userId),
        eq(dbSchema.userBoards.gymId, gym.id),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    );
  if (boardsAtThisGym >= MAX_BOARDS_PER_FOREIGN_GYM) {
    throw new Error('Not authorized to link board to this gym');
  }

  logger.warn('board linked to a gym the owner does not administer', {
    userId,
    gymId: gym.id,
    gymUuid: gym.uuid,
    distanceMeters: Math.round(distance),
    existingForeignGyms: foreignGyms,
    existingBoardsAtThisGym: boardsAtThisGym,
  });

  return gym;
}

/**
 * Gate for EDITING a gym's own details (updateGym): owner, gym admin member, gym
 * editor member, or a community admin/leader whose role is global or scoped to
 * one of the gym's board types. Mirrors the `canEdit` computation in enrichGym
 * so the edit UI and the mutation agree. Editing details only — never membership.
 * Exported so the kiosk CRUD mutations reuse the exact same edit gate as
 * updateGym (a gym's kiosks are part of "editing the gym's own details").
 */
export async function requireGymEditAccess(
  gymUuid: string,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<GymRow> {
  const gym = await resolveCanonicalGymByUuid(gymUuid, executor);
  if (!gym) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
  if (await userCanEditGym(gym, userId, executor, options)) return gym;
  throw new GraphQLError('Not authorized to edit this gym', { extensions: { code: 'FORBIDDEN' } });
}

/**
 * Gate for GRANTING/REVOKING write access (grant/revokeGymWriteAccess): owner,
 * gym admin member, or a community admin/leader covering the gym. Editors are
 * intentionally NOT grantors — write access can't spread itself.
 */
export async function requireGymGrantAccess(
  gymUuid: string,
  userId: string,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<typeof dbSchema.gyms.$inferSelect> {
  const gym = await resolveCanonicalGymByUuid(gymUuid, executor);
  if (!gym) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
  if (await userCanGrantGymAccess(gym, userId, executor, options)) return gym;
  throw new Error('Not authorized to grant write access for this gym');
}

/**
 * Add someone to a gym's staff under the gym's row lock, after reading the
 * caller's authority again under it: the owner, a gym admin, or (when
 * `allowCommunityAccess`) a community admin/leader covering the gym.
 *
 * `revertGymClaim` takes the same lock, gym row first, before it removes the
 * members added since the claim. Without it, a claimant who passed the gate
 * just before a revert could insert a member just after the revert's delete,
 * and that member would outlive the revert. Under it, their insert either lands
 * first and the revert removes it, or waits and is refused.
 */
async function withGymStaffLock<T>(
  gym: typeof dbSchema.gyms.$inferSelect,
  userId: string,
  { allowCommunityAccess, unauthorizedMessage }: { allowCommunityAccess: boolean; unauthorizedMessage: string },
  work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ ownerId: dbSchema.gyms.ownerId })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.id, gym.id), isNull(dbSchema.gyms.deletedAt)))
      .limit(1)
      .for('update');
    if (!locked) throw new Error('Gym not found');
    if (
      !(await userHasGymAccess(
        { ...gym, ownerId: locked.ownerId },
        userId,
        allowCommunityAccess ? 'grant' : 'admin',
        tx,
        {},
      ))
    )
      throw new Error(unauthorizedMessage);
    return work(tx);
  });
}

// ============================================
// Queries
// ============================================

/**
 * Whether this viewer may see the gym at all: a public gym is visible to
 * everyone, a private one only to a viewer who can edit it.
 *
 * Same `userCanEditGym` rule as `gymBoards` and `gymKiosk`, so every gym read
 * agrees. Its SQL twin, `gymVisibleCondition`, gates the gym's comment thread,
 * votes and feeds; change both together. Unlike the board reads this masks
 * AUTHENTICATED non-editors too.
 */
export async function viewerCanSeeGym(
  gym: typeof dbSchema.gyms.$inferSelect,
  viewerId: string | null | undefined,
  executor: GymAccessExecutor = db,
  options: GymAccessOptions = {},
): Promise<boolean> {
  if (!viewerId) return gym.isPublic;
  return userHasGymAccess(gym, viewerId, 'view', executor, options);
}

/**
 * Visibility gate shared by the `gym`/`gymBySlug` entity reads: a private gym is
 * enriched only for a viewer who can see it (`viewerCanSeeGym`), and reads as
 * `null` — the exact same response as a gym that doesn't exist — for everyone
 * else, so holding a uuid or slug can't confirm a private gym exists or disclose
 * its name, address, or contact details.
 *
 * `null` rather than a thrown NOT_FOUND because these fields are nullable in the
 * SDL — `null` already means "no such gym" here, so it is the genuinely
 * indistinguishable answer (see #3648).
 *
 * Runs AFTER canonical resolution: privacy belongs to the surviving gym, not the
 * stale alias row a merged twin's uuid/slug points at.
 */
async function resolveViewableGym(
  gym: typeof dbSchema.gyms.$inferSelect | null,
  ctx: ConnectionContext,
): Promise<Awaited<ReturnType<typeof enrichGym>> | null> {
  if (!gym) return null;
  const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
  if (!(await viewerCanSeeGym(gym, viewerId))) return null;
  return enrichGym(gym, viewerId);
}

export const socialGymQueries = {
  publicGymSitemap,
  gym: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext) => {
    validateInput(UUIDSchema, gymUuid, 'gymUuid');

    // A deduped gym's old uuid resolves to the canonical survivor (enrichGym then
    // returns the survivor's slug/uuid so the client can canonicalize its URL).
    const gym = await resolveCanonicalGymByUuid(gymUuid);

    return resolveViewableGym(gym, ctx);
  },

  gymBySlug: async (_: unknown, { slug }: { slug: string }, ctx: ConnectionContext) => {
    if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return null;
    }

    // A merged twin's slug resolves to the canonical survivor instead of 404ing.
    const gym = await resolveCanonicalGymBySlug(slug);

    return resolveViewableGym(gym, ctx);
  },

  myGyms: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(MyGymsInputSchema, input || {}, 'input');
    const userId = ctx.userId!;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const includeFollowed = validatedInput.includeFollowed ?? false;
    const includeManaged = validatedInput.includeManaged ?? false;

    // Gyms the viewer holds a gym_members row on (admin/editor/member) as a
    // correlated subquery — no extra round trip, no shipping an id array back to
    // the app. Staff access shows up in My Gyms alongside owned gyms, so a climber
    // granted editor/admin actually sees the gym they can manage; enrichGym then
    // fills in myRole/canEdit so the drawer's role chips light up.
    const memberGymIdsSubquery = db
      .select({ gymId: dbSchema.gymMembers.gymId })
      .from(dbSchema.gymMembers)
      .where(eq(dbSchema.gymMembers.userId, userId));

    // Get IDs of gyms the user follows (if requested)
    let followedGymIds: number[] = [];
    if (includeFollowed) {
      const followedGyms = await db
        .select({ gymId: dbSchema.gymFollows.gymId })
        .from(dbSchema.gymFollows)
        .where(eq(dbSchema.gymFollows.userId, userId));
      followedGymIds = followedGyms.map((f) => f.gymId);
    }

    // Build WHERE: owned OR a member OR followed, and not deleted. All are OR'd
    // against the single `gyms` table, so a gym matching more than one (an owner
    // who somehow also has a member row) still resolves to one row — dedupe is
    // inherent, no DISTINCT needed. The member subquery is always included; when
    // the viewer holds no member rows it simply matches nothing.
    const ownerCondition = eq(dbSchema.gyms.ownerId, userId);
    const memberCondition = inArray(dbSchema.gyms.id, memberGymIdsSubquery);
    const followedCondition = followedGymIds.length > 0 ? inArray(dbSchema.gyms.id, followedGymIds) : undefined;
    const matchConditions: SQL[] = [ownerCondition, memberCondition];
    if (followedCondition) matchConditions.push(followedCondition);
    if (includeManaged) {
      const coveringRole = db
        .select({ userId: dbSchema.communityRoles.userId })
        .from(dbSchema.communityRoles)
        .where(
          and(
            eq(dbSchema.communityRoles.userId, userId),
            inArray(dbSchema.communityRoles.role, ['admin', 'community_leader']),
            or(
              isNull(dbSchema.communityRoles.boardType),
              exists(
                db
                  .select({ boardId: dbSchema.userBoards.id })
                  .from(dbSchema.userBoards)
                  .where(
                    and(
                      eq(dbSchema.userBoards.gymId, dbSchema.gyms.id),
                      isNull(dbSchema.userBoards.deletedAt),
                      eq(dbSchema.userBoards.boardType, dbSchema.communityRoles.boardType),
                    ),
                  ),
              ),
            ),
          ),
        );
      matchConditions.push(exists(coveringRole));
    }
    const matchCondition = or(...matchConditions)!;
    const whereClause = and(matchCondition, isNull(dbSchema.gyms.deletedAt));

    const [countResult] = await db.select({ count: count() }).from(dbSchema.gyms).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const gymRows = await db
      .select()
      .from(dbSchema.gyms)
      .where(whereClause)
      // id breaks created_at ties (bulk sync imports share one) so OFFSET pages stay a total order.
      .orderBy(
        ...(includeManaged ? [desc(sql<boolean>`${or(ownerCondition, memberCondition)}`)] : []),
        desc(dbSchema.gyms.createdAt),
        dbSchema.gyms.id,
      )
      .limit(limit)
      .offset(offset);

    const enrichedGyms = await Promise.all(gymRows.map((g) => enrichGym(g, userId)));

    return {
      gyms: enrichedGyms,
      totalCount,
      hasMore: offset + gymRows.length < totalCount,
    };
  },

  searchGyms: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(SearchGymsInputSchema, input, 'input');
    const {
      query,
      boardTypes,
      layoutIds,
      sizeIds,
      angles,
      multiBoardTypeOnly,
      requireSlug,
      requireLocation,
      prioritizeClaimed,
      latitude,
      longitude,
      radiusKm,
    } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const useProximity = latitude !== undefined && longitude !== undefined;

    // A board-level match: the gym must own ONE board satisfying every active
    // board filter (type AND layout AND size AND angle), so they're ANDed inside a
    // single EXISTS — never separate ones, or a gym could pass by owning a Kilter and a
    // separate 16x10 board. Parameterised by the gym-id expression so the same
    // logic composes into the raw PostGIS SQL (`gyms.id`) and the text-only
    // Drizzle path (`dbSchema.gyms.id`). Returns null when no board filter is set.
    const boardMatchExists = (gymId: SQL): SQL | null => {
      const parts: SQL[] = [];
      if (boardTypes && boardTypes.length > 0) {
        parts.push(
          sql`ub.board_type IN (${sql.join(
            boardTypes.map((boardType) => sql`${boardType}`),
            sql`, `,
          )})`,
        );
      }
      if (layoutIds && layoutIds.length > 0) {
        parts.push(
          sql`ub.layout_id IN (${sql.join(
            layoutIds.map((layoutId) => sql`${layoutId}`),
            sql`, `,
          )})`,
        );
      }
      if (sizeIds && sizeIds.length > 0) {
        parts.push(
          sql`ub.size_id IN (${sql.join(
            sizeIds.map((sizeId) => sql`${sizeId}`),
            sql`, `,
          )})`,
        );
      }
      // Angle joins the same `parts` array deliberately: it must AND with the
      // others inside ONE EXISTS, so "a Kilter Homewall at 40" means one wall
      // that is all three. It is NOT widened by `ub.is_angle_adjustable` —
      // that column defaults to true and the location sync hardcodes true for
      // every Aurora wall it cannot read, so an `OR is_angle_adjustable`
      // disjunct would make nearly every gym match every angle and the filter
      // would read as broken. Reversible later behind its own input field.
      if (angles && angles.length > 0) {
        parts.push(
          sql`ub.angle IN (${sql.join(
            angles.map((angle) => sql`${angle}`),
            sql`, `,
          )})`,
        );
      }
      if (parts.length === 0) return null;
      return sql`EXISTS (SELECT 1 FROM user_boards ub WHERE ub.gym_id = ${gymId} AND ub.deleted_at IS NULL AND ${sql.join(
        parts,
        sql` AND `,
      )})`;
    };

    // A gym-level match: at least two distinct board types present.
    const multiBoardTypeExists = (gymId: SQL): SQL | null =>
      multiBoardTypeOnly
        ? sql`(SELECT count(DISTINCT ub2.board_type) FROM user_boards ub2 WHERE ub2.gym_id = ${gymId} AND ub2.deleted_at IS NULL) > 1`
        : null;

    if (useProximity) {
      const radiusMeters = (radiusKm ?? 50) * 1000;
      const lon = Number(longitude);
      const lat = Number(latitude);

      // Board/gym filters appended to the raw PostGIS WHERE. `gyms.id` is the
      // bare column in this raw query's FROM.
      const proximityFilters = [
        boardMatchExists(sql`gyms.id`),
        multiBoardTypeExists(sql`gyms.id`),
        // Shared by the count and the rows statements below — both interpolate
        // `proximityFilterClause`, so they can never disagree about which gyms
        // are in the result set.
        slugPresentFilter(requireSlug, sql`gyms.slug`),
        gymLocationFilter(requireLocation, sql`gyms.latitude`, sql`gyms.longitude`),
      ].filter((clause): clause is SQL => clause !== null);
      const proximityFilterClause =
        proximityFilters.length > 0 ? sql` AND ${sql.join(proximityFilters, sql` AND `)}` : sql.empty();

      const escapedQuery = query ? query.replace(/[%_\\]/g, '\\$&') : null;
      const likePattern = escapedQuery ? `%${escapedQuery}%` : null;
      const proximityOrder = sql.join(
        [
          ...(prioritizeClaimed ? [desc(ne(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID))] : []),
          sql`distance_meters ASC`,
          sql`gyms.id ASC`,
        ],
        sql`, `,
      );

      const countRows = await db.execute(
        likePattern
          ? sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND is_listed = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern})${proximityFilterClause}`
          : sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND is_listed = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters})${proximityFilterClause}`,
      );
      const totalCount = Number(rowsFromResult<Record<string, unknown>>(countRows)[0]?.count || 0);

      // `gyms.id` is the tiebreaker, not decoration: the directory pages this
      // query with OFFSET, and two gyms at an identical distance (a bulk sync
      // import can place several at the same coordinates) have no defined order
      // without it — Postgres is free to return them in a different order per
      // page, duplicating one row and skipping another across the boundary.
      const gymRows = await db.execute(
        likePattern
          ? sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND is_listed = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern})${proximityFilterClause} ORDER BY ${proximityOrder} LIMIT ${limit} OFFSET ${offset}`
          : sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND is_listed = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters})${proximityFilterClause} ORDER BY ${proximityOrder} LIMIT ${limit} OFFSET ${offset}`,
      );
      const rows = rowsFromResult<Record<string, unknown>>(gymRows);

      const mappedGyms = rows.map(mapRawGymRow);

      const enrichedGyms = await Promise.all(
        mappedGyms.map((g) => enrichGym(g, ctx.isAuthenticated ? ctx.userId : undefined)),
      );

      return {
        gyms: enrichedGyms,
        totalCount,
        hasMore: offset + mappedGyms.length < totalCount,
      };
    }

    // Text-only search path
    const conditions = [
      eq(dbSchema.gyms.isPublic, true),
      eq(dbSchema.gyms.isListed, true),
      isNull(dbSchema.gyms.deletedAt),
    ];

    if (query) {
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        or(ilike(dbSchema.gyms.name, `%${escapedQuery}%`), ilike(dbSchema.gyms.address, `%${escapedQuery}%`))!,
      );
    }

    const textBoardMatch = boardMatchExists(sql`${dbSchema.gyms.id}`);
    if (textBoardMatch) conditions.push(textBoardMatch);
    const textMultiBoardType = multiBoardTypeExists(sql`${dbSchema.gyms.id}`);
    if (textMultiBoardType) conditions.push(textMultiBoardType);
    // Pushed into the shared conditions array, so the count and the rows query
    // below both derive from the same `whereClause`.
    const textSlugPresent = slugPresentFilter(requireSlug, sql`${dbSchema.gyms.slug}`);
    if (textSlugPresent) conditions.push(textSlugPresent);
    const textLocation = gymLocationFilter(
      requireLocation,
      sql`${dbSchema.gyms.latitude}`,
      sql`${dbSchema.gyms.longitude}`,
    );
    if (textLocation) conditions.push(textLocation);

    const whereClause = and(...conditions);

    const [countResult] = await db.select({ count: count() }).from(dbSchema.gyms).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    // `gyms.id` breaks `created_at` ties. The directory pages this query with
    // OFFSET, and bulk sync imports write many rows sharing a `created_at`, so
    // without a unique tiebreaker tied rows have no defined order and can
    // duplicate or vanish across a page boundary.
    const gymRows = await db
      .select()
      .from(dbSchema.gyms)
      .where(whereClause)
      .orderBy(
        ...(prioritizeClaimed ? [desc(ne(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID))] : []),
        desc(dbSchema.gyms.createdAt),
        dbSchema.gyms.id,
      )
      .limit(limit)
      .offset(offset);

    const enrichedGyms = await Promise.all(
      gymRows.map((g) => enrichGym(g, ctx.isAuthenticated ? ctx.userId : undefined)),
    );

    return {
      gyms: enrichedGyms,
      totalCount,
      hasMore: offset + gymRows.length < totalCount,
    };
  },

  gymMembers: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(GymMembersInputSchema, input, 'input');
    const { gymUuid } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    // A private gym's staff list is the gym's own content: a viewer who cannot
    // see the gym gets the answer a missing gym gets, so the uuid confirms nothing.
    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
    if (!gym || !(await viewerCanSeeGym(gym, viewerId))) {
      throw new Error('Gym not found');
    }

    const [countResult] = await db
      .select({ count: count() })
      .from(dbSchema.gymMembers)
      .where(eq(dbSchema.gymMembers.gymId, gym.id));

    const totalCount = Number(countResult?.count || 0);

    const members = await db
      .select({
        userId: dbSchema.gymMembers.userId,
        role: dbSchema.gymMembers.role,
        createdAt: dbSchema.gymMembers.createdAt,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
      })
      .from(dbSchema.gymMembers)
      .leftJoin(dbSchema.users, eq(dbSchema.gymMembers.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.gymMembers.userId, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.gymMembers.gymId, gym.id))
      .orderBy(desc(dbSchema.gymMembers.createdAt), dbSchema.gymMembers.id)
      .limit(limit)
      .offset(offset);

    const enrichedMembers = members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName || m.userName || undefined,
      avatarUrl: m.avatarUrl || m.userImage || undefined,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    }));

    return {
      members: enrichedMembers,
      totalCount,
      hasMore: offset + members.length < totalCount,
    };
  },
};

// ============================================
// Mutations
// ============================================

export const socialGymMutations = {
  createGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'createGym');

    const validatedInput = validateInput(CreateGymInputSchema, input, 'input');
    const userId = ctx.userId!;
    // Absent means REJECT_IF_FOUND: every create is checked, old clients too.
    const duplicateCheckMode = validatedInput.duplicateCheck?.mode ?? 'REJECT_IF_FOUND';
    const acknowledgedGymUuids = validatedInput.duplicateCheck?.acknowledgedGymUuids ?? [];

    const uuid = uuidv4();
    const hours = validatedInput.hours?.trim() || null;

    // The cap, the similar-gym read, the slug and the insert share one
    // transaction under the create locks (owner, then normalized name), so a
    // double-tapped Save or two climbers adding one gym by name can't both
    // pass. Every read in here runs on the transaction's own connection.
    const createInTransaction = () =>
      transactionWithAfterCommit(async (tx) => {
        await lockGymCreate(tx, userId, validatedInput.name);
        await assertGymCapNotReached(tx, userId);

        // Reads past the five the form shows, so gyms after the first five a
        // climber acknowledged get their turn in the next refusal.
        const similarGyms = await findSimilarGymCandidates({
          name: validatedInput.name,
          latitude: validatedInput.latitude,
          longitude: validatedInput.longitude,
          viewerUserId: userId,
          limit: MAX_ACKNOWLEDGED_GYM_UUIDS,
          executor: tx,
        });
        const blocking = blockingSimilarGyms(similarGyms, duplicateCheckMode, acknowledgedGymUuids);
        if (blocking.length > 0) return { kind: 'refused' as const, blocking };

        if (similarGyms.length > 0) {
          // The one path that lists a gym beside ones the climber saw. Leave a
          // trail, as the board checks do, so a script confirming every call shows.
          logger.info('createGym: similar gyms acknowledged as separate', {
            userId,
            similarCount: similarGyms.length,
            acknowledgedCount: acknowledgedGymUuids.length,
          });
        }

        // Read after the locks, on the transaction. Two different names can
        // still share a slug ("Rock Hall", "Rock-Hall!") and hold different name
        // locks; the unique index catches that and the create is retried below.
        const slug = await generateUniqueGymSlug(validatedInput.name, tx);
        const [createdGym] = await tx
          .insert(dbSchema.gyms)
          .values({
            uuid,
            slug,
            ownerId: userId,
            name: validatedInput.name,
            description: validatedInput.description ?? null,
            hours,
            hoursUpdatedAt: hours === null ? null : new Date(),
            address: validatedInput.address ?? null,
            website: validatedInput.website ?? null,
            // The creator IS the owner, so a website supplied at creation is
            // owner-vouched and may drive the self-service domain claim (#3431).
            // Written explicitly rather than leaning on the DB default so the intent
            // reads here, next to the website it describes.
            websiteVouchedByOwner: validatedInput.website != null,
            contactEmail: validatedInput.contactEmail ?? null,
            contactPhone: validatedInput.contactPhone ?? null,
            latitude: validatedInput.latitude ?? null,
            longitude: validatedInput.longitude ?? null,
            isPublic: validatedInput.isPublic ?? true,
            isListed: validatedInput.isListed ?? true,
            imageUrl: validatedInput.imageUrl ?? null,
          })
          .returning();
        return { kind: 'created' as const, gym: createdGym };
      });

    let outcome: Awaited<ReturnType<typeof createInTransaction>>;
    try {
      outcome = await createInTransaction();
    } catch (error) {
      // Another create took the slug between this one's read and its insert.
      // The failed insert aborted the transaction, so run the whole create
      // again: it re-checks under the locks and picks the next free slug. Once:
      // a second collision in a row is not a race worth hiding.
      if (!isUniqueViolation(error, 'gyms_unique_slug')) throw error;
      logger.info('createGym: slug taken by a concurrent create, retrying', { userId });
      outcome = await createInTransaction();
    }

    if (outcome.kind === 'refused') {
      throw similarGymsExistError(await toSimilarGymResults(outcome.blocking.slice(0, MAX_SIMILAR_GYMS), userId));
    }
    const { gym } = outcome;

    // Populate PostGIS location column if lat/lon provided (guarded — see syncLocationGeography)
    if (validatedInput.latitude != null && validatedInput.longitude != null) {
      await syncLocationGeography({
        table: 'gyms',
        id: gym.id,
        latitude: validatedInput.latitude,
        longitude: validatedInput.longitude,
        operation: 'createGym',
      });
    }

    // Optionally link a board
    if (validatedInput.boardUuid) {
      const [board] = await db
        .select({ id: dbSchema.userBoards.id, ownerId: dbSchema.userBoards.ownerId })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1);

      if (board && board.ownerId === userId) {
        await transactionWithAfterCommit(async (tx) => {
          const [lockedBoard] = await tx
            .select({ gymId: dbSchema.userBoards.gymId })
            .from(dbSchema.userBoards)
            .where(
              and(
                eq(dbSchema.userBoards.id, board.id),
                eq(dbSchema.userBoards.ownerId, userId),
                isNull(dbSchema.userBoards.deletedAt),
              ),
            )
            .limit(1)
            .for('update');
          if (!lockedBoard) return;
          await tx.update(dbSchema.userBoards).set({ gymId: gym.id }).where(eq(dbSchema.userBoards.id, board.id));
          // The creator moving their own board, on the record for a staff re-list.
          await recordOwnerGymLinkChange(tx, {
            boardId: board.id,
            actorUserId: userId,
            fromGymId: lockedBoard.gymId,
            toGymId: gym.id,
            mutation: 'createGym',
          });
        });
      }
    }

    return enrichGym(gym, userId);
  },

  updateGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateGym');

    const validatedInput = validateInput(UpdateGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(validatedInput.gymUuid, userId);
    const callerIsGymOwner = gym.ownerId === userId;

    const updateValues: Record<string, unknown> = {
      updatedAt: new Date(),
      // A deliberate human edit — freeze the row so the location sync can never
      // overwrite these curated values on its next run.
      syncFrozenAt: new Date(),
    };

    if (validatedInput.name !== undefined) updateValues.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateValues.description = validatedInput.description;
    // Opening hours carry their own confirmation stamp: any write re-dates them
    // (the public page renders "Confirmed <date>"), and clearing the line clears
    // the stamp with it so no date outlives the hours it vouched for. An omitted
    // key leaves both columns alone — a save from a form that doesn't show the
    // field, or whose hours are unchanged, must not silently re-confirm a
    // schedule nobody looked at. Callers are expected to send this key only on
    // an actual change (see EditGymForm).
    //
    // Blank normalises to null, so `hours: ""` or `"   "` clears both columns
    // instead of storing an empty value under a fresh confirmation date. The web
    // form can't send that; the API can, and a date vouching for hours that
    // don't exist is exactly the lie this field exists to prevent.
    if (validatedInput.hours !== undefined) {
      const nextHours = validatedInput.hours?.trim() || null;
      updateValues.hours = nextHours;
      updateValues.hoursUpdatedAt = nextHours === null ? null : new Date();
    }
    if (validatedInput.address !== undefined) updateValues.address = validatedInput.address;
    if (validatedInput.website !== undefined) {
      const nextWebsite = validatedInput.website;
      updateValues.website = nextWebsite;
      // Provenance for the domain-claim path (#3431): only an actual write of the
      // website re-evaluates the vouch, and only the owner's own write vouches.
      // An unchanged website leaves the flag alone in both directions — the manage
      // form posts every field on every save, so an editor fixing the description
      // must not silently disable the owner's claim path, and an owner saving the
      // form must not silently re-vouch a URL an editor put there.
      //
      // "Changed?" is decided by the UPDATE itself, against the row as it stands
      // when the statement runs — NOT against the snapshot requireGymEditAccess
      // read above. Comparing in JS is a TOCTOU hole: an editor reads website=A
      // (their own attacker URL), the owner concurrently commits website=B and
      // vouches it, then the editor's write lands A while "A === snapshot A"
      // decides the flag is untouched — leaving the attacker's URL flagged as
      // owner-vouched. Inside one statement the CASE sees B, calls it a change,
      // and un-vouches. This is also the invariant the column's doc comment and
      // migration 0192 state: website and website_vouched_by_owner are always
      // written together, in the same statement.
      const vouchesOnChange = callerIsGymOwner && nextWebsite != null;
      updateValues.websiteVouchedByOwner = sql`CASE WHEN ${dbSchema.gyms.website} IS DISTINCT FROM ${nextWebsite}::text THEN ${vouchesOnChange}::boolean ELSE ${dbSchema.gyms.websiteVouchedByOwner} END`;
    }
    if (validatedInput.contactEmail !== undefined) updateValues.contactEmail = validatedInput.contactEmail;
    if (validatedInput.contactPhone !== undefined) updateValues.contactPhone = validatedInput.contactPhone;
    if (validatedInput.latitude !== undefined) updateValues.latitude = validatedInput.latitude;
    if (validatedInput.longitude !== undefined) updateValues.longitude = validatedInput.longitude;
    if (validatedInput.isPublic !== undefined) updateValues.isPublic = validatedInput.isPublic;
    if (validatedInput.isListed !== undefined) updateValues.isListed = validatedInput.isListed;
    if (validatedInput.imageUrl !== undefined) updateValues.imageUrl = validatedInput.imageUrl;
    // Branding: an explicit null clears the column (reset-to-default in the manage
    // UI); `undefined` (field omitted) leaves it untouched.
    if (validatedInput.logoUrl !== undefined) updateValues.logoUrl = validatedInput.logoUrl;
    if (validatedInput.brandPrimaryColor !== undefined)
      updateValues.brandPrimaryColor = validatedInput.brandPrimaryColor;
    if (validatedInput.brandAccentColor !== undefined) updateValues.brandAccentColor = validatedInput.brandAccentColor;
    if (validatedInput.brandBackgroundColor !== undefined)
      updateValues.brandBackgroundColor = validatedInput.brandBackgroundColor;

    // A change to the name, address, coordinates, website, phone or hours
    // closes the gym's "wrong address or details" reports as fixed, in this
    // transaction (docs/product/directory-reports.md). The manage form posts
    // every field on every save, so only a value that actually changed counts:
    // the row is read under its lock first and compared with what the update
    // wrote.
    const touchesReportedDetails = [...REPORT_FIXING_GYM_FIELDS].some(
      (field) => validatedInput[field as keyof typeof validatedInput] !== undefined,
    );
    const touchesMedia = validatedInput.imageUrl !== undefined || validatedInput.logoUrl !== undefined;
    const touchesSlug = validatedInput.slug !== undefined;
    const updated = await transactionWithAfterCommit(async (tx) => {
      const [before] =
        touchesReportedDetails || touchesMedia || touchesSlug
          ? await tx.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gym.id)).limit(1).for('update')
          : [];
      if (touchesSlug && (!before || before.deletedAt || before.mergedIntoGymId !== null)) {
        throw new GraphQLError('The gym changed. Read the current gym before changing its URL.', {
          extensions: { code: 'CONFLICT' },
        });
      }
      // Compare with the locked current row: a stale form's old no-op slug
      // must not undo a concurrent canonical URL repair. An actual no-op is
      // allowed even when a same-gym merge tombstone carries the current slug.
      if (validatedInput.slug !== undefined && validatedInput.slug !== before?.slug) {
        const [slugConflict] = await tx
          .select({ id: dbSchema.gyms.id })
          .from(dbSchema.gyms)
          .where(
            and(
              eq(dbSchema.gyms.slug, validatedInput.slug),
              or(isNull(dbSchema.gyms.deletedAt), isNotNull(dbSchema.gyms.mergedIntoGymId)),
              ne(dbSchema.gyms.id, gym.id),
            ),
          )
          .limit(1);
        if (slugConflict) throw new Error('Slug is already taken');
        updateValues.slug = validatedInput.slug;
      }
      const [row] = await tx.update(dbSchema.gyms).set(updateValues).where(eq(dbSchema.gyms.id, gym.id)).returning();
      if (before && row) {
        const previous: Record<string, unknown> = before;
        const next: Record<string, unknown> = row;
        const changedFields = [...REPORT_FIXING_GYM_FIELDS].filter((field) => previous[field] !== next[field]);
        const actorRole = changedFields.length > 0 ? await resolveGymEditActorRole(gym, userId, tx) : null;
        if (actorRole) await onGymDetailsEdited(tx, { gymId: gym.id, actorUserId: userId, actorRole, changedFields });
        if (
          managedGymImageKey(gym.uuid, 'photo', before.imageUrl) !== managedGymImageKey(gym.uuid, 'photo', row.imageUrl)
        ) {
          afterCommit(tx, () => removeManagedGymImage(gym.uuid, 'photo', before.imageUrl));
        }
        if (
          managedGymImageKey(gym.uuid, 'logo', before.logoUrl) !== managedGymImageKey(gym.uuid, 'logo', row.logoUrl)
        ) {
          afterCommit(tx, () => removeManagedGymImage(gym.uuid, 'logo', before.logoUrl));
        }
      }
      return row;
    });

    // Update PostGIS location column (guarded — see syncLocationGeography)
    if (validatedInput.latitude !== undefined || validatedInput.longitude !== undefined) {
      await syncLocationGeography({
        table: 'gyms',
        id: updated.id,
        latitude: validatedInput.latitude ?? updated.latitude,
        longitude: validatedInput.longitude ?? updated.longitude,
        operation: 'updateGym',
      });
    }

    return enrichGym(updated, userId);
  },

  deleteGym: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'deleteGym');

    validateInput(UUIDSchema, gymUuid, 'gymUuid');
    const userId = ctx.userId!;

    const [gym] = await db
      .select({ id: dbSchema.gyms.id, ownerId: dbSchema.gyms.ownerId })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    if (gym.ownerId !== userId) {
      throw new Error('Not authorized to delete this gym');
    }

    // Under the gym's row lock, taken first as `revertGymClaim` and the staff
    // changes take it, the owner and probation are read again: a revert that
    // commits after the read above hands the gym to SYSTEM, and its former
    // claimant must not delete it.
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ ownerId: dbSchema.gyms.ownerId })
        .from(dbSchema.gyms)
        .where(and(eq(dbSchema.gyms.id, gym.id), isNull(dbSchema.gyms.deletedAt)))
        .limit(1)
        .for('update');
      if (!locked) throw new Error('Gym not found');
      if (locked.ownerId !== userId) throw new Error('Not authorized to delete this gym');
      // Not in the 14 days after the gym's claim approved itself
      // (docs/product/gym-claims.md, "Probation").
      await assertNoGymClaimProbation(gym.id, userId, tx);

      // Soft-delete the gym. Freeze it too, so a later sync can't resurrect the
      // listing the owner deliberately removed (the sync clears deletedAt).
      const now = new Date();
      await tx.update(dbSchema.gyms).set({ deletedAt: now, syncFrozenAt: now }).where(eq(dbSchema.gyms.id, gym.id));

      // Unlink all boards
      await tx.update(dbSchema.userBoards).set({ gymId: null }).where(eq(dbSchema.userBoards.gymId, gym.id));
    });

    return true;
  },

  addGymMember: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'addGymMember');

    const validatedInput = validateInput(AddGymMemberInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

    // Verify target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, validatedInput.userId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    const unauthorizedMessage = 'Not authorized: must be gym owner or admin';
    const inserted = await withGymStaffLock(
      gym,
      userId,
      { allowCommunityAccess: false, unauthorizedMessage },
      async (tx) => {
        // A new admin is held during probation: a second account would get round
        // every other probation rule (docs/product/gym-claims.md).
        if (validatedInput.role === 'admin') await assertNoGymClaimProbation(gym.id, userId, tx);
        return tx
          .insert(dbSchema.gymMembers)
          .values({
            gymId: gym.id,
            userId: validatedInput.userId,
            role: validatedInput.role,
          })
          .onConflictDoNothing()
          .returning({ userId: dbSchema.gymMembers.userId });
      },
    );

    // A fresh admin member gets the same "you now manage this gym" heads-up as a
    // granted editor — admins manage staff, so they're being handed the keys too.
    // Plain members (social-only, no edit access) are not notified. RETURNING is
    // empty on an onConflictDoNothing no-op, so a re-add of an existing member
    // stays silent.
    if (validatedInput.role === 'admin' && inserted.length > 0) {
      await createGymManageAccessNotification(validatedInput.userId, gym.uuid, gym.name);
    }

    return true;
  },

  removeGymMember: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'removeGymMember');

    const validatedInput = validateInput(RemoveGymMemberInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

    // Prevent removing the owner
    if (validatedInput.userId === gym.ownerId) {
      throw new Error('Cannot remove the gym owner');
    }
    await assertNoGymClaimProbation(gym.id, userId);

    await db
      .delete(dbSchema.gymMembers)
      .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, validatedInput.userId)));

    return true;
  },

  grantGymWriteAccess: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'grantGymWriteAccess');

    const validatedInput = validateInput(GrantGymWriteAccessInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymGrantAccess(validatedInput.gymUuid, userId);

    // Verify target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, validatedInput.userId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    // The owner already has full access; granting them "editor" would plant a
    // stale member row that a later ownership change could misread.
    if (validatedInput.userId === gym.ownerId) {
      throw new Error('The gym owner already has full access');
    }

    // Upsert an editor row. The setWhere promotes ONLY a plain member — it leaves
    // an existing admin untouched (never downgraded) AND an existing editor
    // untouched (already editor, nothing to change). That makes RETURNING an
    // honest "a real grant happened" signal: it's non-empty exactly on a fresh
    // insert or a member→editor promotion, and empty on a no-op re-grant of an
    // existing editor/admin — so we don't re-ping someone who already manages the
    // gym.
    const unauthorizedMessage = 'Not authorized to grant write access for this gym';
    const granted = await withGymStaffLock(gym, userId, { allowCommunityAccess: true, unauthorizedMessage }, (tx) =>
      tx
        .insert(dbSchema.gymMembers)
        .values({
          gymId: gym.id,
          userId: validatedInput.userId,
          role: 'editor',
        })
        .onConflictDoUpdate({
          target: [dbSchema.gymMembers.gymId, dbSchema.gymMembers.userId],
          set: { role: 'editor' },
          setWhere: sql`${dbSchema.gymMembers.role} = 'member'`,
        })
        .returning({ userId: dbSchema.gymMembers.userId }),
    );

    // Tell the new editor they can manage the gym now (best-effort; the helper
    // swallows its own errors so a notification hiccup never fails the grant).
    if (granted.length > 0) {
      await createGymManageAccessNotification(validatedInput.userId, gym.uuid, gym.name);
    }

    return true;
  },

  revokeGymWriteAccess: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'revokeGymWriteAccess');

    const validatedInput = validateInput(RevokeGymWriteAccessInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymGrantAccess(validatedInput.gymUuid, userId);
    // Taking an editor's access away removes staff, like removeGymMember, so
    // it waits out the probation too (docs/product/gym-claims.md).
    await assertNoGymClaimProbation(gym.id, userId);

    // Only remove editor rows — never a gym admin or plain member.
    await db
      .delete(dbSchema.gymMembers)
      .where(
        and(
          eq(dbSchema.gymMembers.gymId, gym.id),
          eq(dbSchema.gymMembers.userId, validatedInput.userId),
          eq(dbSchema.gymMembers.role, 'editor'),
        ),
      );

    return true;
  },

  followGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'followGym');

    const validatedInput = validateInput(FollowGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const [gym] = await db
      .select({
        id: dbSchema.gyms.id,
        isPublic: dbSchema.gyms.isPublic,
        ownerId: dbSchema.gyms.ownerId,
      })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, validatedInput.gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    if (!gym.isPublic && gym.ownerId !== userId) {
      throw new Error('Cannot follow a private gym');
    }

    await db
      .insert(dbSchema.gymFollows)
      .values({
        gymId: gym.id,
        userId,
      })
      .onConflictDoNothing();

    return true;
  },

  unfollowGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'unfollowGym');

    const validatedInput = validateInput(FollowGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Look up gym by UUID to get id
    const [gym] = await db
      .select({ id: dbSchema.gyms.id })
      .from(dbSchema.gyms)
      .where(eq(dbSchema.gyms.uuid, validatedInput.gymUuid))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    await db
      .delete(dbSchema.gymFollows)
      .where(and(eq(dbSchema.gymFollows.userId, userId), eq(dbSchema.gymFollows.gymId, gym.id)));

    return true;
  },

  linkBoardToGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'linkBoardToGym');

    const validatedInput = validateInput(LinkBoardToGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Verify board ownership
    const [board] = await db
      .select({
        id: dbSchema.userBoards.id,
        ownerId: dbSchema.userBoards.ownerId,
        gymId: dbSchema.userBoards.gymId,
        latitude: dbSchema.userBoards.latitude,
        longitude: dbSchema.userBoards.longitude,
      })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (board.ownerId !== userId) {
      throw new Error('Not authorized to modify this board');
    }

    // The gate runs first, outside the lock, for its plain errors and rate
    // limits. Unlinking is always the board owner's own call and has none.
    const gym = validatedInput.gymUuid
      ? await requireBoardGymLinkAccess({
          ctx,
          gymUuid: validatedInput.gymUuid,
          userId,
          boardOwnerId: board.ownerId,
          boardId: board.id,
          boardLatitude: board.latitude,
          boardLongitude: board.longitude,
        })
      : null;
    const nextGymId = gym?.id ?? null;

    await transactionWithAfterCommit(async (tx) => {
      // Decided again under the board's row lock, which `detachBoardFromGym`
      // also takes. A staff removal committing between the gate and this write
      // would otherwise be overwritten, hold and all.
      const [lockedBoard] = await tx
        .select({ ownerId: dbSchema.userBoards.ownerId, gymId: dbSchema.userBoards.gymId })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.id, board.id), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1)
        .for('update');
      if (!lockedBoard) throw new Error('Board not found');
      if (lockedBoard.ownerId !== userId) throw new Error('Not authorized to modify this board');
      if (lockedBoard.gymId === nextGymId) return;

      // A held board only gets past the gate on the gym's own staff path, so
      // this link is staff putting it back: it lifts the hold, on the record.
      let linkActorRole: BoardModerationActorRole | undefined;
      if (nextGymId != null && (await isBoardHeldOffGym(board.id, nextGymId, tx))) {
        const managerRole = await viewerGymManagerRole(nextGymId, userId, tx);
        if (!managerRole) throw boardHeldOffGymError();
        linkActorRole = managerRole;
      }
      await tx.update(dbSchema.userBoards).set({ gymId: nextGymId }).where(eq(dbSchema.userBoards.id, board.id));
      await recordOwnerGymLinkChange(tx, {
        boardId: board.id,
        actorUserId: userId,
        fromGymId: lockedBoard.gymId,
        toGymId: nextGymId,
        mutation: 'linkBoardToGym',
        linkActorRole,
      });
    });

    return true;
  },
};
