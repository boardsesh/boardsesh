import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { distanceMeters, isGenericGymName, normalizeGymName } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { FindSimilarGymsInputSchema } from '../../../validation/schemas';
import { logger } from '../../../utils/logger';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { getUserCommunityRoles, rolesGrantAdminOrLeader } from './roles';

// ============================================
// Shared gym-dedup matching helpers
// ============================================
//
// Both the createBoard auto-gym guard and the findSimilarGyms read resolver need
// to answer "is there already a live gym at these coordinates with (roughly) this
// name?". The production `gyms` table carries a PostGIS `location` geography,
// but nothing here depends on the extension being installed — a self-hosted
// deployment can be missing it, and the test DB has no pg_trgm — so everything
// stays portable: a cheap lat/lng bounding-box prefilter in SQL, then an exact
// Haversine refine in JS (`distanceMeters` from @boardsesh/db/queries). The
// bounding box is padded (BOUNDING_BOX_SAFETY_FACTOR) so it stays a superset of
// the true circle even where a metre-per-degree of latitude runs short of the
// 111_320 average (~0.7% at the equator) — otherwise the prefilter could drop a
// gym sitting just inside the circle near a box corner. Name similarity uses
// plain LIKE over the normalized name — no extension required — instead of pg_trgm.

/** Per-tier distance ceilings (metres) for findSimilarGyms. */
export const EXACT_NAME_MATCH_RADIUS_METERS = 5_000;
export const PROXIMITY_MATCH_RADIUS_METERS = 150;
export const SIMILAR_NAME_MATCH_RADIUS_METERS = 1_000;

/** Physical-match radius for the createBoard auto-gym guard. */
export const AUTO_GYM_MATCH_RADIUS_METERS = 150;

const MAX_SIMILAR_GYMS = 5;

// Pads the lat/lng bounding box so it fully contains the target circle despite
// metres-per-degree varying with latitude (111_320 is only an average; a degree
// of latitude is ~0.7% shorter at the equator). The JS Haversine still does the
// exact circle test — this just guarantees the SQL prefilter never drops a match.
const BOUNDING_BOX_SAFETY_FACTOR = 1.02;

export type GymNameMatch = {
  id: number;
  uuid: string;
  slug: string | null;
  name: string;
  address: string | null;
  website: string | null;
  ownerId: string;
  latitude: number | null;
  longitude: number | null;
  /** Metres from the supplied coordinates, or null when no coordinates were given. */
  distanceMeters: number | null;
};

const gymColumns = {
  id: dbSchema.gyms.id,
  uuid: dbSchema.gyms.uuid,
  slug: dbSchema.gyms.slug,
  name: dbSchema.gyms.name,
  address: dbSchema.gyms.address,
  website: dbSchema.gyms.website,
  ownerId: dbSchema.gyms.ownerId,
  latitude: dbSchema.gyms.latitude,
  longitude: dbSchema.gyms.longitude,
};

/**
 * SQL for the normalized gym name: trim, collapse internal whitespace, lowercase.
 * Mirrors `normalizeGymName` so DB-side matching agrees with the JS refine. Uses
 * the same expression the location-sync physical matcher uses (upsert.ts).
 */
const normalizedNameExpr: SQL = sql`lower(regexp_replace(trim(${dbSchema.gyms.name}), '[[:space:]]+', ' ', 'g'))`;

/** Escape LIKE metacharacters (default backslash escape) in an already-normalized string. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/** A lat/lng bounding box wide enough to contain the `radiusMeters` circle. Portable (no PostGIS). */
function withinBoundingBox(latitude: number, longitude: number, radiusMeters: number): SQL {
  const paddedRadius = radiusMeters * BOUNDING_BOX_SAFETY_FACTOR;
  const latDelta = paddedRadius / 111_320;
  const cosLat = Math.max(Math.cos((latitude * Math.PI) / 180), 1e-6);
  const lngDelta = paddedRadius / (111_320 * cosLat);
  return sql`${dbSchema.gyms.latitude} IS NOT NULL AND ${dbSchema.gyms.longitude} IS NOT NULL AND ${dbSchema.gyms.latitude} BETWEEN ${latitude - latDelta} AND ${latitude + latDelta} AND ${dbSchema.gyms.longitude} BETWEEN ${longitude - lngDelta} AND ${longitude + lngDelta}`;
}

/** Whether the candidate's normalized name is a substring of the query or vice-versa. */
function nameSimilarInJs(candidateName: string, normalizedQuery: string): boolean {
  const candidate = normalizeGymName(candidateName);
  if (candidate.length === 0 || normalizedQuery.length === 0) return false;
  return candidate.includes(normalizedQuery) || (candidate.length >= 3 && normalizedQuery.includes(candidate));
}

function haversineTo(
  center: { latitude: number; longitude: number },
  row: { latitude: number; longitude: number },
): number {
  return distanceMeters(center, { latitude: row.latitude, longitude: row.longitude });
}

/**
 * Live gyms of ANY owner whose normalized name exactly equals `name` and that sit
 * within `radiusMeters` of the given coordinates. Ordered nearest-first. Shared by
 * the createBoard auto-gym guard (radius 150 m) and findSimilarGyms's exact-name
 * tier. Portable: bounding-box prefilter + JS Haversine refine.
 */
export async function findExactNameMatchesWithin(opts: {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}): Promise<GymNameMatch[]> {
  const { name, latitude, longitude, radiusMeters } = opts;
  const normalized = normalizeGymName(name);

  const rows = await db
    .select(gymColumns)
    .from(dbSchema.gyms)
    .where(
      and(
        isNull(dbSchema.gyms.deletedAt),
        sql`${normalizedNameExpr} = ${normalized}`,
        withinBoundingBox(latitude, longitude, radiusMeters),
      ),
    );

  return rows
    .filter(
      (row): row is typeof row & { latitude: number; longitude: number } =>
        row.latitude != null && row.longitude != null,
    )
    .map((row) => ({ ...row, distanceMeters: haversineTo({ latitude, longitude }, row) }))
    .filter((row) => row.distanceMeters <= radiusMeters)
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
}

export type AutoGymDecision = { action: 'attach'; gymId: number } | { action: 'mint' };

/**
 * Given the nearest physical-name match for a board's location, decide whether to
 * attach the board to that existing gym or mint a fresh one. A SYSTEM-owned match
 * (upstream catalog) or one already owned by the requesting user is safe to reuse.
 * Any other owner's gym is left alone — no cross-user auto-attach — and the board
 * mints its own gym (the caller logs a warning so the admin dedup queue improves).
 *
 * A generic matched name (`isGenericGymName`) is NEVER auto-attached, even to a
 * SYSTEM/own gym: "home wall" / "garage" pins collide across unrelated residential
 * walls, and a false attach to a claimable SYSTEM pin would hand board-edit rights
 * to whoever later claims it. Generic names still get suggested (suggest path is
 * unaffected) — they just don't silently link.
 */
export function decideAutoGymAttachment(
  nearestMatch: Pick<GymNameMatch, 'id' | 'ownerId' | 'name'> | undefined,
  requestingUserId: string,
): AutoGymDecision {
  if (!nearestMatch) return { action: 'mint' };
  if (isGenericGymName(nearestMatch.name)) return { action: 'mint' };
  if (nearestMatch.ownerId === SYSTEM_BOARD_OWNER_ID || nearestMatch.ownerId === requestingUserId) {
    return { action: 'attach', gymId: nearestMatch.id };
  }
  return { action: 'mint' };
}

/** Beyond this many live gyms, stop minting new ones for a caller automatically. */
export const MAX_AUTO_MINTED_GYMS_PER_OWNER = 25;

export type AutoGymResolution =
  | { action: 'attach'; gymId: number }
  | { action: 'mint'; name: string }
  | { action: 'none' };

/** Live gyms owned by `userId` whose normalized name equals `name`, nearest-first when coordinates are given. */
async function findOwnGymsByExactName(opts: {
  userId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
}): Promise<GymNameMatch[]> {
  const { userId, name, latitude, longitude, radiusMeters } = opts;
  const normalized = normalizeGymName(name);
  if (normalized.length === 0) return [];

  const hasCoords = latitude != null && longitude != null;
  // No bounding box in SQL: it requires non-null lat/lng, which would drop the
  // caller's OWN same-named gym when that gym has no coordinates — and a gym
  // minted from a location name alone has none. Dropping it meant a second board
  // at the same typed place, this time with coordinates, minted a twin instead of
  // converging. Distance is applied below, and only where there is one.
  const rows = await db
    .select(gymColumns)
    .from(dbSchema.gyms)
    .where(
      and(
        isNull(dbSchema.gyms.deletedAt),
        eq(dbSchema.gyms.ownerId, userId),
        sql`${normalizedNameExpr} = ${normalized}`,
      ),
    );

  if (!hasCoords) {
    // Name-only match: no distance to compute, so any of the caller's same-named
    // gyms will do. Deterministic order so repeat creates converge on one gym.
    return rows.map((row) => ({ ...row, distanceMeters: null })).sort((first, second) => first.id - second.id);
  }

  const placed = rows
    .filter(
      (row): row is typeof row & { latitude: number; longitude: number } =>
        row.latitude != null && row.longitude != null,
    )
    .map((row) => ({ ...row, distanceMeters: haversineTo({ latitude, longitude }, row) }))
    .filter((row) => row.distanceMeters <= radiusMeters)
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
  if (placed.length > 0) return placed;

  // Fall back to the caller's same-named gyms that carry no coordinates at all.
  // Their name is the only evidence available, and it's their own gym, so reusing
  // it beats minting a duplicate. A later edit can give it coordinates.
  return rows
    .filter((row) => row.latitude == null || row.longitude == null)
    .map((row) => ({ ...row, distanceMeters: null }))
    .sort((first, second) => first.id - second.id);
}

/** Live gyms of any owner within `radiusMeters`, regardless of name. Nearest-first. */
async function findGymsWithin(opts: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}): Promise<GymNameMatch[]> {
  const { latitude, longitude, radiusMeters } = opts;
  const rows = await db
    .select(gymColumns)
    .from(dbSchema.gyms)
    .where(and(isNull(dbSchema.gyms.deletedAt), withinBoundingBox(latitude, longitude, radiusMeters)));

  return rows
    .filter(
      (row): row is typeof row & { latitude: number; longitude: number } =>
        row.latitude != null && row.longitude != null,
    )
    .map((row) => ({ ...row, distanceMeters: haversineTo({ latitude, longitude }, row) }))
    .filter((row) => row.distanceMeters <= radiusMeters)
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
}

/**
 * Which gym a newly created board belongs to, when the caller didn't name one.
 *
 * This resolves per LOCATION, not per user. It used to mint a gym only when the
 * caller owned zero gyms, so every second-and-later board landed with
 * `gym_id = NULL` — 29% of real user boards at the time of #4166 — and showed on
 * the map as a bare board pin instead of under the gym the user had just typed.
 *
 * The dedup tiers below are what keep per-location minting from spraying
 * duplicate gyms across the map.
 */
export async function resolveAutoGymForBoard(opts: {
  userId: string;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
}): Promise<AutoGymResolution> {
  const { userId, latitude, longitude } = opts;
  const locationName = opts.locationName?.trim() || null;
  const hasCoords = latitude != null && longitude != null;

  // No location of any kind: nothing to identify a gym by. Previously this minted
  // a gym named after the BOARD ("Marco's Kilter Original 12×12") with null
  // coordinates — a row that can never surface in proximity search. The board
  // still gets its own standalone map pin.
  if (locationName == null && !hasCoords) return { action: 'none' };

  // Coordinates but no name: we can't mint (no name to give it), but we can
  // attach when the answer is unambiguous — exactly one nearby gym that is safe
  // to reuse. Two or more candidates and we decline rather than guess.
  if (locationName == null) {
    const nearby = await findGymsWithin({
      latitude: latitude!,
      longitude: longitude!,
      radiusMeters: AUTO_GYM_MATCH_RADIUS_METERS,
    });
    const reusable = nearby.filter(
      (gym) => !isGenericGymName(gym.name) && (gym.ownerId === SYSTEM_BOARD_OWNER_ID || gym.ownerId === userId),
    );
    return reusable.length === 1 ? { action: 'attach', gymId: reusable[0].id } : { action: 'none' };
  }

  // Named. First converge on the caller's OWN gym of that name — this is what
  // makes a second board at a gym they already added land on the same gym rather
  // than minting a twin. Own-gym only, so the generic-name guard doesn't apply:
  // there's no cross-user capture risk in reusing your own "home wall".
  const ownMatches = await findOwnGymsByExactName({
    userId,
    name: locationName,
    latitude,
    longitude,
    radiusMeters: EXACT_NAME_MATCH_RADIUS_METERS,
  });
  if (ownMatches.length > 0) return { action: 'attach', gymId: ownMatches[0].id };

  // Then the existing cross-owner physical tier: a SYSTEM-synced gym (or one of
  // the caller's, already handled above) at these exact coordinates and name.
  if (hasCoords) {
    const physicalMatches = await findExactNameMatchesWithin({
      name: locationName,
      latitude: latitude!,
      longitude: longitude!,
      radiusMeters: AUTO_GYM_MATCH_RADIUS_METERS,
    });
    const nearest = physicalMatches[0];
    const decision = decideAutoGymAttachment(nearest, userId);
    if (decision.action === 'attach') return { action: 'attach', gymId: decision.gymId };
    if (nearest) {
      logger.warn('createBoard auto-gym: nearby name match not auto-attached; minting a separate gym', {
        userId,
        gymName: locationName,
        matchedGymId: nearest.id,
        matchedGymUuid: nearest.uuid,
        matchedOwnerId: nearest.ownerId,
        matchedOwnerIsSystem: nearest.ownerId === SYSTEM_BOARD_OWNER_ID,
        genericName: isGenericGymName(nearest.name),
        distanceMeters: Math.round(nearest.distanceMeters ?? 0),
      });
    }
  }

  // Backstop against a scripted create loop minting a gym per call. Rate limiting
  // caps the rate; this caps the total. Deliberately a plain read outside the
  // insert transaction: two concurrent creates can both see 24 and both mint, so
  // the cap is approximate by design. It exists to stop a runaway, not to hold an
  // invariant — paying for row locks on every create to make it exact would be
  // the wrong trade.
  const [{ count: ownedGymCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.ownerId, userId), isNull(dbSchema.gyms.deletedAt)));
  if (ownedGymCount >= MAX_AUTO_MINTED_GYMS_PER_OWNER) {
    logger.warn('createBoard auto-gym: owner at gym cap, creating board without a gym', {
      userId,
      ownedGymCount,
    });
    return { action: 'none' };
  }

  return { action: 'mint', name: locationName };
}

/**
 * Candidate gyms that resemble one the user is about to create. Matching tiers:
 *   (a) exact normalized name within 5 km,
 *   (b) any name within 150 m (name-agnostic close-proximity),
 *   (c) substring name similarity within 1 km.
 * When no coordinates are supplied, only name-based tiers (a exact / c substring)
 * apply, with no distance. Nearest-first, capped at five.
 */
export async function findSimilarGymCandidates(opts: {
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  viewerUserId: string;
}): Promise<GymNameMatch[]> {
  const { name, latitude, longitude, viewerUserId } = opts;
  const normalized = normalizeGymName(name);
  const hasCoords = latitude != null && longitude != null;

  // Never enumerate other users' PRIVATE gyms — otherwise the name-agnostic 150 m
  // tier leaks private home walls (name + address + metre-precise distance) to any
  // authenticated caller. Public gyms and the viewer's own private gyms are fair
  // game. Mirrors the visibility gate on searchGyms / gymBoards.
  const visibleCond: SQL = or(eq(dbSchema.gyms.isPublic, true), eq(dbSchema.gyms.ownerId, viewerUserId))!;

  const exactNameCond: SQL = sql`${normalizedNameExpr} = ${normalized}`;
  const similarNameCond: SQL | undefined =
    normalized.length >= 2
      ? sql`(${normalizedNameExpr} LIKE ${`%${escapeLike(normalized)}%`} OR ${normalized} LIKE '%' || ${normalizedNameExpr} || '%')`
      : undefined;

  if (hasCoords) {
    const tierExact = and(exactNameCond, withinBoundingBox(latitude, longitude, EXACT_NAME_MATCH_RADIUS_METERS));
    const tierProximity = withinBoundingBox(latitude, longitude, PROXIMITY_MATCH_RADIUS_METERS);
    const tierSimilar = similarNameCond
      ? and(similarNameCond, withinBoundingBox(latitude, longitude, SIMILAR_NAME_MATCH_RADIUS_METERS))
      : undefined;
    const tiers = [tierExact, tierProximity, tierSimilar].filter((clause): clause is SQL => clause != null);

    const rows = await db
      .select(gymColumns)
      .from(dbSchema.gyms)
      .where(and(isNull(dbSchema.gyms.deletedAt), visibleCond, or(...tiers)!));

    const center = { latitude, longitude };
    return rows
      .filter(
        (row): row is typeof row & { latitude: number; longitude: number } =>
          row.latitude != null && row.longitude != null,
      )
      .map((row) => ({ ...row, distanceMeters: haversineTo(center, row) }))
      .filter((row) => {
        const isExactName = normalizeGymName(row.name) === normalized;
        const isSimilarName = nameSimilarInJs(row.name, normalized);
        return (
          (isExactName && row.distanceMeters <= EXACT_NAME_MATCH_RADIUS_METERS) ||
          row.distanceMeters <= PROXIMITY_MATCH_RADIUS_METERS ||
          (isSimilarName && row.distanceMeters <= SIMILAR_NAME_MATCH_RADIUS_METERS)
        );
      })
      .sort((first, second) => first.distanceMeters - second.distanceMeters)
      .slice(0, MAX_SIMILAR_GYMS);
  }

  // No coordinates: name-only matching (exact + substring), no distance to sort by.
  const nameCond = similarNameCond ? or(exactNameCond, similarNameCond)! : exactNameCond;
  const rows = await db
    .select(gymColumns)
    .from(dbSchema.gyms)
    .where(and(isNull(dbSchema.gyms.deletedAt), visibleCond, nameCond))
    .limit(50);

  return (
    rows
      .map((row) => ({ ...row, distanceMeters: null as number | null }))
      // JS refine (mirrors the coords path): the SQL LIKE prefilter treats a gym
      // name's own %/_ as wildcards, so re-check with plain string semantics.
      .filter((row) => normalizeGymName(row.name) === normalized || nameSimilarInJs(row.name, normalized))
      .sort((first, second) => {
        const firstExact = normalizeGymName(first.name) === normalized ? 0 : 1;
        const secondExact = normalizeGymName(second.name) === normalized ? 0 : 1;
        if (firstExact !== secondExact) return firstExact - secondExact;
        return first.name.localeCompare(second.name);
      })
      .slice(0, MAX_SIMILAR_GYMS)
  );
}

/**
 * Distinct upstream provider origins (source-key prefixes, e.g. "kilter",
 * "tension") for each of the given gym ids, from the location-sync alias table.
 * User-created gyms have no aliases and map to an empty list. Batched into a
 * single query.
 */
async function providerOriginsByGymId(gymIds: number[]): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (gymIds.length === 0) return result;

  const rows = await db
    .select({ gymId: dbSchema.locationSyncGymSources.gymId, sourceKey: dbSchema.locationSyncGymSources.sourceKey })
    .from(dbSchema.locationSyncGymSources)
    .where(inArray(dbSchema.locationSyncGymSources.gymId, gymIds));

  const originsByGym = new Map<number, Set<string>>();
  for (const row of rows) {
    const prefix = row.sourceKey.split(':')[0]?.trim();
    if (!prefix) continue;
    const origins = originsByGym.get(row.gymId) ?? new Set<string>();
    origins.add(prefix);
    originsByGym.set(row.gymId, origins);
  }

  for (const [gymId, origins] of originsByGym) {
    result.set(gymId, [...origins].sort());
  }
  return result;
}

/**
 * `isClaimable` per candidate for an authenticated viewer, batched: one
 * community-roles read + one member-roles read + one board-types read for ALL
 * candidates, instead of an N+1 `userCanEditGym` per card. Mirrors enrichGym's
 * `canClaim` — a viewer who cannot already edit a gym is the one who may claim it.
 */
async function computeClaimableFlags(
  candidates: Array<Pick<GymNameMatch, 'id' | 'ownerId'>>,
  viewerUserId: string,
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (candidates.length === 0) return result;

  const gymIds = candidates.map((candidate) => candidate.id);
  const communityRoles = await getUserCommunityRoles(viewerUserId);

  // A global community admin/leader can edit every gym → nothing is claimable.
  if (rolesGrantAdminOrLeader(communityRoles, null)) {
    for (const candidate of candidates) result.set(candidate.id, false);
    return result;
  }

  const [memberRows, boardTypeRows] = await Promise.all([
    db
      .select({ gymId: dbSchema.gymMembers.gymId, role: dbSchema.gymMembers.role })
      .from(dbSchema.gymMembers)
      .where(and(eq(dbSchema.gymMembers.userId, viewerUserId), inArray(dbSchema.gymMembers.gymId, gymIds))),
    db
      .selectDistinct({ gymId: dbSchema.userBoards.gymId, boardType: dbSchema.userBoards.boardType })
      .from(dbSchema.userBoards)
      .where(and(inArray(dbSchema.userBoards.gymId, gymIds), isNull(dbSchema.userBoards.deletedAt))),
  ]);

  const roleByGym = new Map<number, string>();
  for (const row of memberRows) roleByGym.set(row.gymId, row.role);

  const boardTypesByGym = new Map<number, string[]>();
  for (const row of boardTypeRows) {
    if (row.gymId == null) continue;
    const list = boardTypesByGym.get(row.gymId) ?? [];
    list.push(row.boardType);
    boardTypesByGym.set(row.gymId, list);
  }

  for (const candidate of candidates) {
    const isOwner = candidate.ownerId === viewerUserId;
    const memberRole = roleByGym.get(candidate.id);
    const canEditAsMember = memberRole === 'admin' || memberRole === 'editor';
    const boardTypes = boardTypesByGym.get(candidate.id) ?? [];
    const hasCommunityAccess = boardTypes.some((boardType) => rolesGrantAdminOrLeader(communityRoles, boardType));
    result.set(candidate.id, !(isOwner || canEditAsMember || hasCommunityAccess));
  }
  return result;
}

// ============================================
// Query resolver
// ============================================

/** The `SimilarGym` GraphQL payload shape returned by findSimilarGyms. */
export type SimilarGymResult = {
  uuid: string;
  slug: string | null;
  name: string;
  address: string | null;
  website: string | null;
  distanceMeters: number | null;
  ownerType: 'SYSTEM' | 'USER';
  isClaimable: boolean;
  providerOrigins: string[];
};

export const socialGymMatchQueries = {
  findSimilarGyms: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<SimilarGymResult[]> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 120, 'findSimilarGyms');

    const validatedInput = validateInput(FindSimilarGymsInputSchema, input, 'input');
    const userId = ctx.userId!;

    const candidates = await findSimilarGymCandidates({
      name: validatedInput.name,
      latitude: validatedInput.latitude,
      longitude: validatedInput.longitude,
      viewerUserId: userId,
    });

    if (candidates.length === 0) return [];

    const [originsByGym, claimableByGym] = await Promise.all([
      providerOriginsByGymId(candidates.map((candidate) => candidate.id)),
      computeClaimableFlags(candidates, userId),
    ]);

    return candidates.map((candidate) => ({
      uuid: candidate.uuid,
      slug: candidate.slug,
      name: candidate.name,
      address: candidate.address,
      website: candidate.website,
      distanceMeters: candidate.distanceMeters,
      ownerType: candidate.ownerId === SYSTEM_BOARD_OWNER_ID ? 'SYSTEM' : 'USER',
      isClaimable: claimableByGym.get(candidate.id) ?? false,
      providerOrigins: originsByGym.get(candidate.id) ?? [],
    }));
  },
};
