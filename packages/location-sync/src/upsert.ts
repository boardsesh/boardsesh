import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { rowsFromResult } from '@boardsesh/db/client';
import { gymClaims, gyms, locationSyncGymSources, userBoards, users } from '@boardsesh/db/schema';
import {
  boardUuidForSource,
  gymUuidForSource,
  shortHash,
  slugifyLocationName,
  SYSTEM_USER_EMAIL,
  SYSTEM_USER_ID,
} from './ids';
import { isValidCoordinate } from './coords';
import type { LocationSyncSummary, PublicBoardLocationInput, SkippedLocationRecord } from './types';
import { noopLocationSyncLogger, type LocationSyncLogger } from './logger';
import {
  chooseCanonicalGymCandidate,
  GYM_MATCH_GUARDED_DISTANCE_METERS,
  isGenericGymName,
  PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  type CanonicalGymCandidate,
} from '@boardsesh/db/queries';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * A physical-match candidate enriched with the fields the guarded (150 m) tier
 * and the alias-and-leave-alone rule need: how far the pin is, who owns the gym,
 * whether an approved claim exists, and which provider source keys already point
 * at it (used to reject same-provider twins from auto-matching at 150 m).
 */
type GymMatchCandidate = CanonicalGymCandidate & {
  ownerId: string;
  distanceMeters: number;
  hasApprovedClaim: boolean;
  aliasSourceKeys: string[];
};

/** A resolved alias row plus the ownership facts that gate a metadata refresh. */
type AliasedGym = {
  id: number;
  ownerId: string;
  hasApprovedClaim: boolean;
};

/**
 * A gym is "owner-curated" when a real user owns it or an approved claim exists.
 * The importer may bind a provider source to such a gym (aliasing), but must
 * never overwrite its name, coords, or metadata — those belong to the owner.
 */
function isOwnerCurated(gym: { ownerId: string; hasApprovedClaim: boolean }): boolean {
  return gym.ownerId !== SYSTEM_USER_ID || gym.hasApprovedClaim;
}

/** Provider prefix of a source key, e.g. `tension:gym-1` -> `tension`. */
function providerPrefixOf(sourceKey: string): string {
  const separatorIndex = sourceKey.indexOf(':');
  return separatorIndex === -1 ? sourceKey : sourceKey.slice(0, separatorIndex);
}

export type ValidBoardLocation = PublicBoardLocationInput & {
  latitude: number;
  longitude: number;
};

async function ensureSystemUser(db: DrizzleDb): Promise<void> {
  await db
    .insert(users)
    .values({
      id: SYSTEM_USER_ID,
      email: SYSTEM_USER_EMAIL,
      name: 'Boardsesh',
    })
    .onConflictDoNothing({ target: users.id });
}

export function collectValidLocationRecords(records: PublicBoardLocationInput[]): {
  validRecords: ValidBoardLocation[];
  skipped: SkippedLocationRecord[];
} {
  const validRecords: ValidBoardLocation[] = [];
  const skipped: SkippedLocationRecord[] = [];

  for (const record of records) {
    if (!isValidCoordinate(record.latitude, record.longitude)) {
      skipped.push({ sourceKey: record.sourceKey, reason: 'invalid coordinates' });
      continue;
    }
    validRecords.push(record as ValidBoardLocation);
  }

  return { validRecords, skipped };
}

export function collectUniqueGymLocationRecords(validRecords: ValidBoardLocation[]): Map<string, ValidBoardLocation> {
  const gymsBySource = new Map<string, ValidBoardLocation>();
  for (const record of validRecords) {
    if (!gymsBySource.has(record.gymSourceKey)) {
      gymsBySource.set(record.gymSourceKey, record);
    }
  }
  return gymsBySource;
}

export function buildLocationUpsertPlan(records: PublicBoardLocationInput[]): {
  validRecords: ValidBoardLocation[];
  skipped: SkippedLocationRecord[];
  gymsBySource: Map<string, ValidBoardLocation>;
} {
  const { validRecords, skipped } = collectValidLocationRecords(records);
  return {
    validRecords,
    skipped,
    gymsBySource: collectUniqueGymLocationRecords(validRecords),
  };
}

export function buildGymWriteIdentifiers(
  sourceKey: string,
  record: ValidBoardLocation,
): {
  uuid: string;
  slug: string;
} {
  return {
    uuid: gymUuidForSource(sourceKey),
    slug: slugifyLocationName(record.gymName, shortHash(sourceKey)),
  };
}

export function buildBoardWriteIdentifiers(record: ValidBoardLocation): {
  uuid: string;
  slug: string;
} {
  const uuid = boardUuidForSource(record.sourceKey);
  return {
    uuid,
    slug: slugifyLocationName(record.slugBase, uuid),
  };
}

async function upsertSourceAlias(db: DrizzleDb, sourceKey: string, gymId: number): Promise<void> {
  await db
    .insert(locationSyncGymSources)
    .values({ sourceKey, gymId })
    .onConflictDoUpdate({
      target: locationSyncGymSources.sourceKey,
      set: {
        gymId,
        updatedAt: sql`NOW()`,
      },
    });
}

async function refreshSyncedGymMetadata(db: DrizzleDb, gymId: number, record: ValidBoardLocation): Promise<void> {
  await db
    .update(gyms)
    .set({
      name: record.gymName,
      address: sql`COALESCE(${record.gymAddress}, ${gyms.address})`,
      latitude: record.latitude,
      longitude: record.longitude,
      isPublic: true,
      updatedAt: sql`NOW()`,
      deletedAt: null,
    })
    .where(eq(gyms.id, gymId));
}

async function findAliasedGym(db: DrizzleDb, sourceKey: string): Promise<AliasedGym | null> {
  const [aliasedGym] = await db
    .select({
      id: gyms.id,
      ownerId: gyms.ownerId,
      // Squat protection: a user-owned (or approved-claim) gym that the importer
      // aliased earlier must keep its owner-curated fields. The alias-resolution
      // path reads this so it never refreshes metadata into such a gym.
      hasApprovedClaim: sql<boolean>`EXISTS (
        SELECT 1 FROM ${gymClaims} claim
        WHERE claim.gym_id = ${gyms.id} AND claim.status = 'approved'
      )`,
    })
    .from(locationSyncGymSources)
    .innerJoin(gyms, eq(locationSyncGymSources.gymId, gyms.id))
    .where(and(eq(locationSyncGymSources.sourceKey, sourceKey), sql`${gyms.deletedAt} IS NULL`))
    .limit(1);

  if (!aliasedGym) {
    return null;
  }

  return {
    id: Number(aliasedGym.id),
    ownerId: aliasedGym.ownerId,
    hasApprovedClaim: Boolean(aliasedGym.hasApprovedClaim),
  };
}

/**
 * Fetches every public, live gym that shares the record's exact normalized name
 * and sits within the guarded (150 m) radius. Unlike the old physical match this
 * intentionally spans BOTH SYSTEM-owned and user-owned gyms so the importer stops
 * re-minting gyms that owners already curate. Each row carries its distance,
 * owner, approved-claim flag, and the provider source keys already aliased to it;
 * {@link classifyGymMatch} turns that into a tier-1 / tier-2 / reject decision.
 */
async function findGymMatchCandidates(db: DrizzleDb, record: ValidBoardLocation): Promise<GymMatchCandidate[]> {
  const result = await db.execute(sql`
    WITH candidate_gyms AS (
      SELECT
        g.id,
        g.uuid,
        g.name,
        g.owner_id,
        g.address,
        g.contact_email,
        g.contact_phone,
        g.description,
        g.image_url,
        g.latitude,
        g.longitude,
        g.created_at,
        ST_Distance(
          g.location,
          ST_MakePoint(${record.longitude}, ${record.latitude})::geography
        ) AS distance_meters
      FROM gyms g
      WHERE g.is_public = true
        AND g.deleted_at IS NULL
        AND g.location IS NOT NULL
        AND lower(regexp_replace(trim(g.name), '[[:space:]]+', ' ', 'g')) =
            lower(regexp_replace(trim(${record.gymName}), '[[:space:]]+', ' ', 'g'))
        AND ST_DWithin(
          g.location,
          ST_MakePoint(${record.longitude}, ${record.latitude})::geography,
          ${GYM_MATCH_GUARDED_DISTANCE_METERS}
        )
    ),
    board_counts AS (
      SELECT board.gym_id, count(*)::int AS count
      FROM user_boards board
      INNER JOIN candidate_gyms candidate_gym ON candidate_gym.id = board.gym_id
      WHERE board.deleted_at IS NULL
      GROUP BY board.gym_id
    ),
    member_counts AS (
      SELECT gym_member.gym_id, count(*)::int AS count
      FROM gym_members gym_member
      INNER JOIN candidate_gyms candidate_gym ON candidate_gym.id = gym_member.gym_id
      GROUP BY gym_member.gym_id
    ),
    follower_counts AS (
      SELECT gym_follow.gym_id, count(*)::int AS count
      FROM gym_follows gym_follow
      INNER JOIN candidate_gyms candidate_gym ON candidate_gym.id = gym_follow.gym_id
      GROUP BY gym_follow.gym_id
    ),
    comment_counts AS (
      SELECT gym_comment.entity_id, count(*)::int AS count
      FROM comments gym_comment
      INNER JOIN candidate_gyms candidate_gym ON candidate_gym.uuid = gym_comment.entity_id
      WHERE gym_comment.entity_type = 'gym'
        AND gym_comment.deleted_at IS NULL
      GROUP BY gym_comment.entity_id
    ),
    alias_source_keys AS (
      SELECT alias.gym_id, array_agg(alias.source_key) AS source_keys
      FROM location_sync_gym_sources alias
      INNER JOIN candidate_gyms candidate_gym ON candidate_gym.id = alias.gym_id
      GROUP BY alias.gym_id
    )
    SELECT
      g.id AS "id",
      g.uuid AS "uuid",
      g.name AS "name",
      g.owner_id AS "ownerId",
      g.address AS "address",
      g.contact_email AS "contactEmail",
      g.contact_phone AS "contactPhone",
      g.description AS "description",
      g.image_url AS "imageUrl",
      g.latitude AS "latitude",
      g.longitude AS "longitude",
      g.created_at AS "createdAt",
      g.distance_meters AS "distanceMeters",
      EXISTS (
        SELECT 1 FROM gym_claims claim
        WHERE claim.gym_id = g.id AND claim.status = 'approved'
      ) AS "hasApprovedClaim",
      COALESCE(alias_source_keys.source_keys, ARRAY[]::text[]) AS "aliasSourceKeys",
      COALESCE(board_counts.count, 0)::int AS "boardCount",
      COALESCE(member_counts.count, 0)::int AS "memberCount",
      COALESCE(follower_counts.count, 0)::int AS "followerCount",
      COALESCE(comment_counts.count, 0)::int AS "commentCount"
    FROM candidate_gyms g
    LEFT JOIN board_counts ON board_counts.gym_id = g.id
    LEFT JOIN member_counts ON member_counts.gym_id = g.id
    LEFT JOIN follower_counts ON follower_counts.gym_id = g.id
    LEFT JOIN comment_counts ON comment_counts.entity_id = g.uuid
    LEFT JOIN alias_source_keys ON alias_source_keys.gym_id = g.id
  `);

  return rowsFromResult<GymMatchCandidate>(result).map((candidate) => ({
    ...candidate,
    id: Number(candidate.id),
    latitude: Number(candidate.latitude),
    longitude: Number(candidate.longitude),
    distanceMeters: Number(candidate.distanceMeters),
    hasApprovedClaim: Boolean(candidate.hasApprovedClaim),
    aliasSourceKeys: Array.isArray(candidate.aliasSourceKeys) ? candidate.aliasSourceKeys : [],
    boardCount: Number(candidate.boardCount),
    memberCount: Number(candidate.memberCount),
    followerCount: Number(candidate.followerCount),
    commentCount: Number(candidate.commentCount),
  }));
}

type GymMatchTier = 1 | 2;

/** A tier-2 candidate rejected because a same-provider alias already exists. */
type SameProviderConflict = {
  candidateGymId: number;
  conflictingSourceKeys: string[];
};

type GymMatchClassification = {
  match: { candidate: GymMatchCandidate; tier: GymMatchTier } | null;
  // A generic name blocked the guarded tier (there were 150 m candidates that a
  // non-generic name would have matched).
  genericNameBlocked: boolean;
  // Guarded-tier candidates rejected because a same-provider source already
  // points at them (likely genuinely distinct walls 150 m apart).
  sameProviderConflicts: SameProviderConflict[];
};

/**
 * Turns the raw candidate list into a match decision.
 *
 * - Tier 1 (<= 20 m) always wins, even for generic names — an exact-name pin
 *   almost on top of a gym is the same gym.
 * - Tier 2 (<= 150 m) only fires for a non-generic name AND only for candidates
 *   that don't already carry a same-provider alias. Same-provider twins 150 m
 *   apart are reported, not merged.
 */
function classifyGymMatch(
  sourceKey: string,
  record: ValidBoardLocation,
  candidates: GymMatchCandidate[],
): GymMatchClassification {
  const tierOneCandidates = candidates.filter(
    (candidate) => candidate.distanceMeters <= PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  );
  if (tierOneCandidates.length > 0) {
    const winner = chooseCanonicalGymCandidate(tierOneCandidates);
    return {
      match: winner ? { candidate: winner, tier: 1 } : null,
      genericNameBlocked: false,
      sameProviderConflicts: [],
    };
  }

  // No tier-1 candidate. The DB query already caps distance at the guarded
  // radius, so this filter is a no-op in production — but it keeps the tier
  // boundary owned here (not split across the query and the classifier) and lets
  // this function be unit-tested against raw candidate lists without a DB to
  // enforce the cap.
  const guardedCandidates = candidates.filter(
    (candidate) => candidate.distanceMeters <= GYM_MATCH_GUARDED_DISTANCE_METERS,
  );
  if (guardedCandidates.length === 0) {
    return { match: null, genericNameBlocked: false, sameProviderConflicts: [] };
  }

  if (isGenericGymName(record.gymName)) {
    return { match: null, genericNameBlocked: true, sameProviderConflicts: [] };
  }

  const providerPrefix = providerPrefixOf(sourceKey);
  const sameProviderConflicts: SameProviderConflict[] = [];
  const eligibleCandidates: GymMatchCandidate[] = [];
  for (const candidate of guardedCandidates) {
    const conflictingSourceKeys = candidate.aliasSourceKeys.filter(
      (aliasSourceKey) => aliasSourceKey !== sourceKey && providerPrefixOf(aliasSourceKey) === providerPrefix,
    );
    if (conflictingSourceKeys.length > 0) {
      sameProviderConflicts.push({ candidateGymId: candidate.id, conflictingSourceKeys });
    } else {
      eligibleCandidates.push(candidate);
    }
  }

  const winner = chooseCanonicalGymCandidate(eligibleCandidates);
  return {
    match: winner ? { candidate: winner, tier: 2 } : null,
    genericNameBlocked: false,
    sameProviderConflicts,
  };
}

async function createOrUpdateSourceGym(
  db: DrizzleDb,
  sourceKey: string,
  record: ValidBoardLocation,
): Promise<number | null> {
  const gymIdentifiers = buildGymWriteIdentifiers(sourceKey, record);
  const [upsertedGym] = await db
    .insert(gyms)
    .values({
      uuid: gymIdentifiers.uuid,
      slug: gymIdentifiers.slug,
      ownerId: SYSTEM_USER_ID,
      name: record.gymName,
      address: record.gymAddress,
      latitude: record.latitude,
      longitude: record.longitude,
      isPublic: true,
    })
    .onConflictDoUpdate({
      target: gyms.uuid,
      set: {
        slug: sql`COALESCE(${gyms.slug}, excluded.slug)`,
        name: sql`excluded.name`,
        address: sql`COALESCE(excluded.address, ${gyms.address})`,
        latitude: sql`excluded.latitude`,
        longitude: sql`excluded.longitude`,
        isPublic: true,
        updatedAt: sql`NOW()`,
        deletedAt: null,
      },
    })
    .returning({ id: gyms.id });

  if (upsertedGym) {
    await upsertSourceAlias(db, sourceKey, upsertedGym.id);
  }

  return upsertedGym?.id ?? null;
}

async function resolveGymIdForSource(
  db: DrizzleDb,
  sourceKey: string,
  record: ValidBoardLocation,
  logger: LocationSyncLogger,
): Promise<number | null> {
  const aliasedGym = await findAliasedGym(db, sourceKey);
  if (aliasedGym !== null) {
    // Squat protection: an existing alias never licenses a metadata refresh into
    // an owner-curated gym. Only SYSTEM-owned, unclaimed gyms keep today's
    // refresh-on-every-sync behavior.
    if (isOwnerCurated(aliasedGym)) {
      logger.info('location-sync alias resolved into owner-curated gym; metadata left untouched', {
        sourceKey,
        gymId: aliasedGym.id,
        ownerId: aliasedGym.ownerId,
        hasApprovedClaim: aliasedGym.hasApprovedClaim,
      });
    } else {
      await refreshSyncedGymMetadata(db, aliasedGym.id, record);
    }
    return aliasedGym.id;
  }

  const candidates = await findGymMatchCandidates(db, record);
  const classification = classifyGymMatch(sourceKey, record, candidates);

  for (const conflict of classification.sameProviderConflicts) {
    logger.warn('location-sync guarded-tier match rejected: same-provider source already aliased', {
      sourceKey,
      gymName: record.gymName,
      candidateGymId: conflict.candidateGymId,
      conflictingSourceKeys: conflict.conflictingSourceKeys,
      guardedDistanceMeters: GYM_MATCH_GUARDED_DISTANCE_METERS,
    });
  }
  if (classification.genericNameBlocked) {
    logger.info('location-sync guarded-tier match rejected: generic gym name', {
      sourceKey,
      gymName: record.gymName,
      guardedDistanceMeters: GYM_MATCH_GUARDED_DISTANCE_METERS,
    });
  }

  const { match } = classification;
  if (match) {
    const { candidate, tier } = match;
    await upsertSourceAlias(db, sourceKey, candidate.id);

    if (isOwnerCurated(candidate)) {
      // Alias-and-leave-alone: bind the source so future syncs resolve here, but
      // never overwrite the owner's curated name / coords / metadata.
      logger.info('location-sync aliased source into user-owned gym; metadata left untouched', {
        sourceKey,
        gymId: candidate.id,
        ownerId: candidate.ownerId,
        hasApprovedClaim: candidate.hasApprovedClaim,
        tier,
        distanceMeters: candidate.distanceMeters,
      });
    } else {
      if (tier === 2) {
        logger.info('location-sync guarded-tier (150 m) match', {
          sourceKey,
          gymId: candidate.id,
          gymName: record.gymName,
          distanceMeters: candidate.distanceMeters,
        });
      }
      await refreshSyncedGymMetadata(db, candidate.id, record);
    }
    return candidate.id;
  }

  return createOrUpdateSourceGym(db, sourceKey, record);
}

async function resolveGymIdForSourceWithLock(
  db: DrizzleDb,
  sourceKey: string,
  record: ValidBoardLocation,
  logger: LocationSyncLogger,
): Promise<number | null> {
  return db.transaction(async (transaction) => {
    const transactionDb = transaction as unknown as DrizzleDb;
    await transactionDb.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext('boardsesh:location-sync:gym-name'),
        hashtext(lower(regexp_replace(trim(${record.gymName}), '[[:space:]]+', ' ', 'g')))
      )
    `);
    return resolveGymIdForSource(transactionDb, sourceKey, record, logger);
  });
}

/**
 * Upserts public gym + board locations from a sync source.
 *
 * HARD DEPENDENCY on migration 0127: the PostGIS `location` geography is no
 * longer written here — it's derived from lat/lng by the gyms_set_location /
 * user_boards_set_location triggers. Run against a pre-0127 database (a stale
 * snapshot, a developer volume that never migrated) the upserts succeed but
 * `location` stays NULL and proximity search silently returns nothing. Always
 * migrate to >= 0127 before running a location sync. Covered by
 * packages/db's location-trigger integration test.
 */
export async function upsertPublicBoardLocations(
  db: DrizzleDb,
  records: PublicBoardLocationInput[],
  options: { logger?: LocationSyncLogger } = {},
): Promise<LocationSyncSummary> {
  const logger = options.logger ?? noopLocationSyncLogger;
  await ensureSystemUser(db);

  const { validRecords, skipped, gymsBySource } = buildLocationUpsertPlan(records);

  const gymIdBySource = new Map<string, number>();
  for (const [sourceKey, record] of gymsBySource) {
    const gymId = await resolveGymIdForSourceWithLock(db, sourceKey, record, logger);
    if (gymId !== null) {
      // The PostGIS `location` geography is derived from lat/lng by the
      // gyms_set_location trigger (migration 0127), so resolving the gym row
      // through an alias, physical match, or source upsert has no separate
      // geography write.
      gymIdBySource.set(sourceKey, gymId);
    }
  }

  let boardsUpserted = 0;
  for (const record of validRecords) {
    const gymId = gymIdBySource.get(record.gymSourceKey) ?? null;
    const boardIdentifiers = buildBoardWriteIdentifiers(record);

    const [upsertedBoard] = await db
      .insert(userBoards)
      .values({
        uuid: boardIdentifiers.uuid,
        slug: boardIdentifiers.slug,
        ownerId: SYSTEM_USER_ID,
        boardType: record.boardType,
        layoutId: record.layoutId,
        sizeId: record.sizeId,
        setIds: record.setIds,
        name: record.name,
        locationName: record.locationName,
        latitude: record.latitude,
        longitude: record.longitude,
        isPublic: true,
        isUnlisted: false,
        hideLocation: false,
        isOwned: false,
        angle: record.angle,
        isAngleAdjustable: record.isAngleAdjustable,
        serialNumber: record.serialNumber ?? null,
        gymId,
      })
      .onConflictDoUpdate({
        target: userBoards.uuid,
        set: {
          slug: sql`COALESCE(${userBoards.slug}, excluded.slug)`,
          boardType: sql`excluded.board_type`,
          layoutId: sql`excluded.layout_id`,
          sizeId: sql`excluded.size_id`,
          setIds: sql`excluded.set_ids`,
          name: sql`excluded.name`,
          locationName: sql`excluded.location_name`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          isPublic: sql`excluded.is_public`,
          isUnlisted: sql`excluded.is_unlisted`,
          hideLocation: sql`excluded.hide_location`,
          isOwned: sql`excluded.is_owned`,
          angle: sql`excluded.angle`,
          isAngleAdjustable: sql`excluded.is_angle_adjustable`,
          serialNumber: sql`excluded.serial_number`,
          gymId: sql`excluded.gym_id`,
          updatedAt: sql`NOW()`,
          deletedAt: null,
        },
      })
      .returning({ id: userBoards.id });

    if (upsertedBoard) {
      // `location` is maintained by the user_boards_set_location trigger
      // (migration 0127); the upsert's lat/lng write already set it.
      boardsUpserted += 1;
    }
  }

  return {
    boardsSeen: records.length,
    boardsUpserted,
    boardsSkipped: skipped.length,
    gymsSeen: gymsBySource.size,
    gymsUpserted: gymIdBySource.size,
    skipped,
  };
}
