import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { rowsFromResult } from '@boardsesh/db/client';
import { gyms, locationSyncGymSources, userBoards, users } from '@boardsesh/db/schema';
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
import {
  chooseCanonicalGymCandidate,
  PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  type CanonicalGymCandidate,
} from '@boardsesh/db/queries';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

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

async function findAliasedGymId(db: DrizzleDb, sourceKey: string): Promise<number | null> {
  const [aliasedGym] = await db
    .select({ id: gyms.id })
    .from(locationSyncGymSources)
    .innerJoin(gyms, eq(locationSyncGymSources.gymId, gyms.id))
    .where(and(eq(locationSyncGymSources.sourceKey, sourceKey), sql`${gyms.deletedAt} IS NULL`))
    .limit(1);

  return aliasedGym?.id ?? null;
}

async function findPhysicalGymMatch(db: DrizzleDb, record: ValidBoardLocation): Promise<CanonicalGymCandidate | null> {
  const result = await db.execute(sql`
    WITH candidate_gyms AS (
      SELECT
        g.id,
        g.uuid,
        g.name,
        g.address,
        g.contact_email,
        g.contact_phone,
        g.description,
        g.image_url,
        g.latitude,
        g.longitude,
        g.created_at
      FROM gyms g
      WHERE g.owner_id = ${SYSTEM_USER_ID}
        AND g.is_public = true
        AND g.deleted_at IS NULL
        AND g.location IS NOT NULL
        AND lower(regexp_replace(trim(g.name), '[[:space:]]+', ' ', 'g')) =
            lower(regexp_replace(trim(${record.gymName}), '[[:space:]]+', ' ', 'g'))
        AND ST_DWithin(
          g.location,
          ST_MakePoint(${record.longitude}, ${record.latitude})::geography,
          ${PHYSICAL_GYM_MATCH_DISTANCE_METERS}
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
    )
    SELECT
      g.id AS "id",
      g.uuid AS "uuid",
      g.name AS "name",
      g.address AS "address",
      g.contact_email AS "contactEmail",
      g.contact_phone AS "contactPhone",
      g.description AS "description",
      g.image_url AS "imageUrl",
      g.latitude AS "latitude",
      g.longitude AS "longitude",
      g.created_at AS "createdAt",
      COALESCE(board_counts.count, 0)::int AS "boardCount",
      COALESCE(member_counts.count, 0)::int AS "memberCount",
      COALESCE(follower_counts.count, 0)::int AS "followerCount",
      COALESCE(comment_counts.count, 0)::int AS "commentCount"
    FROM candidate_gyms g
    LEFT JOIN board_counts ON board_counts.gym_id = g.id
    LEFT JOIN member_counts ON member_counts.gym_id = g.id
    LEFT JOIN follower_counts ON follower_counts.gym_id = g.id
    LEFT JOIN comment_counts ON comment_counts.entity_id = g.uuid
  `);

  const candidates = rowsFromResult<CanonicalGymCandidate>(result).map((candidate) => ({
    ...candidate,
    id: Number(candidate.id),
    latitude: Number(candidate.latitude),
    longitude: Number(candidate.longitude),
    boardCount: Number(candidate.boardCount),
    memberCount: Number(candidate.memberCount),
    followerCount: Number(candidate.followerCount),
    commentCount: Number(candidate.commentCount),
  }));

  return chooseCanonicalGymCandidate(candidates);
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
): Promise<number | null> {
  const aliasedGymId = await findAliasedGymId(db, sourceKey);
  if (aliasedGymId !== null) {
    await refreshSyncedGymMetadata(db, aliasedGymId, record);
    return aliasedGymId;
  }

  const physicalGymMatch = await findPhysicalGymMatch(db, record);
  if (physicalGymMatch) {
    await upsertSourceAlias(db, sourceKey, physicalGymMatch.id);
    await refreshSyncedGymMetadata(db, physicalGymMatch.id, record);
    return physicalGymMatch.id;
  }

  return createOrUpdateSourceGym(db, sourceKey, record);
}

async function resolveGymIdForSourceWithLock(
  db: DrizzleDb,
  sourceKey: string,
  record: ValidBoardLocation,
): Promise<number | null> {
  return db.transaction(async (transaction) => {
    const transactionDb = transaction as unknown as DrizzleDb;
    await transactionDb.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext('boardsesh:location-sync:gym-name'),
        hashtext(lower(regexp_replace(trim(${record.gymName}), '[[:space:]]+', ' ', 'g')))
      )
    `);
    return resolveGymIdForSource(transactionDb, sourceKey, record);
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
): Promise<LocationSyncSummary> {
  await ensureSystemUser(db);

  const { validRecords, skipped, gymsBySource } = buildLocationUpsertPlan(records);

  const gymIdBySource = new Map<string, number>();
  for (const [sourceKey, record] of gymsBySource) {
    const gymId = await resolveGymIdForSourceWithLock(db, sourceKey, record);
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
