import { and, eq, inArray, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { executeRows } from '@boardsesh/db/client';
import {
  chooseCanonicalGymCandidate,
  compareCanonicalGymCandidates,
  computeClusterSignature,
  distanceMeters,
  groupPhysicalGymCandidates,
  mergeGymsIntoCanonical,
  PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  type CanonicalGymCandidate,
  type MergeCounts,
  type MergeWarning,
} from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { validateInput, applyRateLimit } from '../shared/helpers';
import { requireAdmin } from './roles';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import {
  DuplicateGymClustersInputSchema,
  OrphanGymsInputSchema,
  MergeGymsInputSchema,
  DismissGymClusterInputSchema,
} from '../../../validation/schemas';

// Members within this band but beyond the tier-A distance are the observed
// cross-provider coordinate-drift range.
const TIER_B_DISTANCE_METERS = 150;

type GymOwnerType = 'system' | 'user';
type GymClusterClaimStatus = 'none' | 'pending' | 'approved';

// Extra per-row signals the duplicate queue shows on top of the shared
// CanonicalGymCandidate fields (which already carry name/address/coords/counts).
type MemberExtra = {
  ownerType: GymOwnerType;
  claimStatus: GymClusterClaimStatus;
  providerOrigins: string[];
  kioskCount: number;
  claimCount: number;
};

type DuplicateCandidateRow = {
  id: number | string;
  uuid: string;
  name: string;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  description: string | null;
  imageUrl: string | null;
  latitude: number | string;
  longitude: number | string;
  createdAt: Date | string;
  ownerId: string;
  boardCount: number | string;
  memberCount: number | string;
  followerCount: number | string;
  commentCount: number | string;
  kioskCount: number | string;
  claimCount: number | string;
  hasPendingClaim: boolean | null;
  hasApprovedClaim: boolean | null;
  providerOrigins: string[] | null;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCandidate(row: DuplicateCandidateRow): CanonicalGymCandidate {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    name: row.name,
    address: row.address,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    description: row.description,
    imageUrl: row.imageUrl,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    createdAt: row.createdAt,
    boardCount: Number(row.boardCount),
    memberCount: Number(row.memberCount),
    followerCount: Number(row.followerCount),
    commentCount: Number(row.commentCount),
  };
}

function toMemberExtra(row: DuplicateCandidateRow): MemberExtra {
  const claimStatus: GymClusterClaimStatus = row.hasApprovedClaim
    ? 'approved'
    : row.hasPendingClaim
      ? 'pending'
      : 'none';
  return {
    ownerType: row.ownerId === SYSTEM_BOARD_OWNER_ID ? 'system' : 'user',
    claimStatus,
    providerOrigins: row.providerOrigins ?? [],
    kioskCount: Number(row.kioskCount),
    claimCount: Number(row.claimCount),
  };
}

/**
 * Load every live gym (with coordinates) whose normalized name is shared by at
 * least one other live gym, with the FK counts, owner type, claim state, and
 * provider origins the review queue shows. The normalized-name pre-filter and
 * the provider/claim aggregates are genuinely awkward in the Drizzle query
 * builder (regexp_replace name normalization, split_part provider prefixes,
 * array_agg DISTINCT, HAVING count > 1), so this stays raw SQL — the same
 * pattern the gym proximity search already uses.
 */
async function fetchDuplicateCandidateRows(): Promise<DuplicateCandidateRow[]> {
  return executeRows<DuplicateCandidateRow>(
    db,
    sql`
    WITH live_gyms AS (
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
        g.created_at,
        g.owner_id,
        lower(regexp_replace(trim(g.name), '[[:space:]]+', ' ', 'g')) AS norm_name
      FROM gyms g
      WHERE g.deleted_at IS NULL
        AND g.latitude IS NOT NULL
        AND g.longitude IS NOT NULL
    ),
    duplicate_names AS (
      SELECT norm_name FROM live_gyms GROUP BY norm_name HAVING count(*) > 1
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
      g.owner_id AS "ownerId",
      COALESCE(board_counts.count, 0)::int AS "boardCount",
      COALESCE(member_counts.count, 0)::int AS "memberCount",
      COALESCE(follower_counts.count, 0)::int AS "followerCount",
      COALESCE(comment_counts.count, 0)::int AS "commentCount",
      COALESCE(kiosk_counts.count, 0)::int AS "kioskCount",
      COALESCE(claim_info.claim_count, 0)::int AS "claimCount",
      COALESCE(claim_info.has_pending, false) AS "hasPendingClaim",
      COALESCE(claim_info.has_approved, false) AS "hasApprovedClaim",
      provider_info.providers AS "providerOrigins"
    FROM live_gyms g
    INNER JOIN duplicate_names d ON d.norm_name = g.norm_name
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM user_boards WHERE deleted_at IS NULL GROUP BY gym_id
    ) board_counts ON board_counts.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM gym_members GROUP BY gym_id
    ) member_counts ON member_counts.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM gym_follows GROUP BY gym_id
    ) follower_counts ON follower_counts.gym_id = g.id
    LEFT JOIN (
      SELECT entity_id, count(*) AS count FROM comments
      WHERE entity_type = 'gym' AND deleted_at IS NULL GROUP BY entity_id
    ) comment_counts ON comment_counts.entity_id = g.uuid
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM gym_kiosks WHERE deleted_at IS NULL GROUP BY gym_id
    ) kiosk_counts ON kiosk_counts.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id,
             count(*) AS claim_count,
             bool_or(status = 'pending') AS has_pending,
             bool_or(status = 'approved') AS has_approved
      FROM gym_claims GROUP BY gym_id
    ) claim_info ON claim_info.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id, array_agg(DISTINCT split_part(source_key, ':', 1)) AS providers
      FROM location_sync_gym_sources GROUP BY gym_id
    ) provider_info ON provider_info.gym_id = g.id
    ORDER BY lower(g.name), g.id
  `,
  );
}

/**
 * Pick the survivor the queue pre-selects: a claimed or user-owned row always
 * wins over a system row regardless of completeness; ties fall back to the shared
 * ranking (completeness, then oldest).
 */
function suggestCanonicalCandidate(
  candidates: CanonicalGymCandidate[],
  extraById: Map<number, MemberExtra>,
): CanonicalGymCandidate {
  const preferred = candidates.filter((candidate) => {
    const extra = extraById.get(candidate.id);
    return extra !== undefined && (extra.ownerType === 'user' || extra.claimStatus !== 'none');
  });
  const pool = preferred.length > 0 ? preferred : candidates;
  const chosen = chooseCanonicalGymCandidate(pool);
  // pool is always non-empty (a cluster has ≥2 members), so chosen is non-null.
  return chosen ?? candidates[0];
}

function maxPairwiseDistance(candidates: CanonicalGymCandidate[]): number {
  let maxDistance = 0;
  for (let outer = 0; outer < candidates.length; outer++) {
    for (let inner = outer + 1; inner < candidates.length; inner++) {
      const distance = distanceMeters(candidates[outer], candidates[inner]);
      if (distance > maxDistance) {
        maxDistance = distance;
      }
    }
  }
  return maxDistance;
}

type BuiltCluster = {
  signature: string;
  tier: 'A' | 'B';
  normalizedName: string;
  suggestedCanonicalGymUuid: string;
  maxDistanceMeters: number;
  members: Array<{
    gymUuid: string;
    name: string;
    address: string | null;
    ownerType: GymOwnerType;
    claimStatus: GymClusterClaimStatus;
    providerOrigins: string[];
    boardCount: number;
    followerCount: number;
    memberCount: number;
    kioskCount: number;
    claimCount: number;
    createdAt: string;
    latitude: number;
    longitude: number;
    distanceToCanonicalMeters: number;
    isSuggestedCanonical: boolean;
  }>;
};

function buildClusters(rows: DuplicateCandidateRow[]): BuiltCluster[] {
  const candidates = rows.map(toCandidate);
  const extraById = new Map<number, MemberExtra>();
  for (const row of rows) {
    extraById.set(Number(row.id), toMemberExtra(row));
  }

  const clusters = groupPhysicalGymCandidates(candidates, TIER_B_DISTANCE_METERS);

  return clusters.map((cluster) => {
    const canonical = suggestCanonicalCandidate(cluster.gyms, extraById);
    const maxDistance = maxPairwiseDistance(cluster.gyms);
    const signature = computeClusterSignature(cluster.gyms.map((gym) => gym.id));

    const members = [...cluster.gyms].sort(compareCanonicalGymCandidates).map((gym) => {
      const extra = extraById.get(gym.id);
      return {
        gymUuid: gym.uuid,
        name: gym.name,
        address: gym.address,
        ownerType: extra?.ownerType ?? 'system',
        claimStatus: extra?.claimStatus ?? 'none',
        providerOrigins: extra?.providerOrigins ?? [],
        boardCount: gym.boardCount,
        followerCount: gym.followerCount,
        memberCount: gym.memberCount,
        kioskCount: extra?.kioskCount ?? 0,
        claimCount: extra?.claimCount ?? 0,
        createdAt: toIsoString(gym.createdAt ?? new Date()),
        latitude: gym.latitude,
        longitude: gym.longitude,
        distanceToCanonicalMeters: distanceMeters(gym, canonical),
        isSuggestedCanonical: gym.id === canonical.id,
      };
    });

    return {
      signature,
      tier: maxDistance <= PHYSICAL_GYM_MATCH_DISTANCE_METERS ? ('A' as const) : ('B' as const),
      normalizedName: cluster.normalizedName,
      suggestedCanonicalGymUuid: canonical.uuid,
      maxDistanceMeters: maxDistance,
      members,
    };
  });
}

/**
 * Which of the given candidate-cluster signatures have a 'dismissed' audit row.
 * Bounded to the signatures actually present in this page's candidate clusters
 * (a handful), so the dismissal history never gets materialized into memory as it
 * grows — the filter is pushed into SQL via an IN over the current signatures.
 */
async function fetchDismissedSignaturesAmong(signatures: string[]): Promise<Set<string>> {
  if (signatures.length === 0) {
    return new Set();
  }
  const dismissed = await db
    .select({ signature: dbSchema.gymMergeAudit.clusterSignature })
    .from(dbSchema.gymMergeAudit)
    .where(
      and(eq(dbSchema.gymMergeAudit.action, 'dismissed'), inArray(dbSchema.gymMergeAudit.clusterSignature, signatures)),
    );
  return new Set(dismissed.map((row) => row.signature));
}

export const socialGymDuplicateQueries = {
  duplicateGymClusters: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validatedInput = validateInput(DuplicateGymClustersInputSchema, input || {}, 'input');
    const { limit, offset } = validatedInput;

    const candidateClusters = buildClusters(await fetchDuplicateCandidateRows());
    const dismissedSignatures = await fetchDismissedSignaturesAmong(
      candidateClusters.map((cluster) => cluster.signature),
    );

    const clusters = candidateClusters
      .filter((cluster) => !dismissedSignatures.has(cluster.signature))
      // Tier A (tight, high-confidence) first, then tightest cluster, then name.
      .sort((first, second) => {
        if (first.tier !== second.tier) {
          return first.tier === 'A' ? -1 : 1;
        }
        if (first.maxDistanceMeters !== second.maxDistanceMeters) {
          return first.maxDistanceMeters - second.maxDistanceMeters;
        }
        return first.normalizedName.localeCompare(second.normalizedName);
      });

    const totalCount = clusters.length;
    const page = clusters.slice(offset, offset + limit);

    return { clusters: page, totalCount, hasMore: offset + page.length < totalCount };
  },

  orphanGyms: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validatedInput = validateInput(OrphanGymsInputSchema, input || {}, 'input');
    const { limit, offset } = validatedInput;

    // Alias-less, system-owned live gyms: no location-sync source row on file.
    const orphanFilter = and(
      eq(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID),
      isNull(dbSchema.gyms.deletedAt),
      sql`NOT EXISTS (SELECT 1 FROM location_sync_gym_sources s WHERE s.gym_id = ${dbSchema.gyms.id})`,
    );

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(dbSchema.gyms)
      .where(orphanFilter);
    const totalCount = Number(countRow?.count ?? 0);

    const rows = await executeRows<{
      gymUuid: string;
      slug: string | null;
      name: string;
      address: string | null;
      createdAt: Date | string;
      boardCount: number | string;
      followerCount: number | string;
      memberCount: number | string;
      kioskCount: number | string;
    }>(
      db,
      sql`
      SELECT
        g.uuid AS "gymUuid",
        g.slug AS "slug",
        g.name AS "name",
        g.address AS "address",
        g.created_at AS "createdAt",
        COALESCE(board_counts.count, 0)::int AS "boardCount",
        COALESCE(follower_counts.count, 0)::int AS "followerCount",
        COALESCE(member_counts.count, 0)::int AS "memberCount",
        COALESCE(kiosk_counts.count, 0)::int AS "kioskCount"
      FROM gyms g
      LEFT JOIN (
        SELECT gym_id, count(*) AS count FROM user_boards WHERE deleted_at IS NULL GROUP BY gym_id
      ) board_counts ON board_counts.gym_id = g.id
      LEFT JOIN (
        SELECT gym_id, count(*) AS count FROM gym_follows GROUP BY gym_id
      ) follower_counts ON follower_counts.gym_id = g.id
      LEFT JOIN (
        SELECT gym_id, count(*) AS count FROM gym_members GROUP BY gym_id
      ) member_counts ON member_counts.gym_id = g.id
      LEFT JOIN (
        SELECT gym_id, count(*) AS count FROM gym_kiosks WHERE deleted_at IS NULL GROUP BY gym_id
      ) kiosk_counts ON kiosk_counts.gym_id = g.id
      WHERE g.owner_id = ${SYSTEM_BOARD_OWNER_ID}
        AND g.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM location_sync_gym_sources s WHERE s.gym_id = g.id)
      ORDER BY lower(g.name), g.id
      LIMIT ${limit} OFFSET ${offset}
    `,
    );

    const gyms = rows.map((row) => ({
      gymUuid: row.gymUuid,
      slug: row.slug ?? null,
      name: row.name,
      address: row.address ?? null,
      boardCount: Number(row.boardCount),
      followerCount: Number(row.followerCount),
      memberCount: Number(row.memberCount),
      kioskCount: Number(row.kioskCount),
      createdAt: toIsoString(row.createdAt),
    }));

    return { gyms, totalCount, hasMore: offset + gyms.length < totalCount };
  },
};

// A live gym loaded (and row-locked) for a merge, as the shared candidate shape
// plus the id/uuid the resolver keys on.
type MergeGymRow = {
  id: number;
  uuid: string;
};

// A merge candidate plus the two signals the SYSTEM-override guard needs.
type LoadedMergeCandidate = {
  candidate: CanonicalGymCandidate;
  ownerId: string;
  hasApprovedClaim: boolean;
};

async function loadLiveMergeCandidate(
  tx: { execute(query: SQLWrapper | string): PromiseLike<unknown> },
  gymUuid: string,
): Promise<LoadedMergeCandidate | null> {
  // Lock the gym row in a CTE (FOR UPDATE can't sit over the joined aggregate
  // subqueries), then attach the counts — the same pattern the CLI dedupe uses.
  const rows = await executeRows<DuplicateCandidateRow & { hasApprovedClaim: boolean | null }>(
    tx,
    sql`
    WITH locked_gym AS (
      SELECT g.id, g.uuid, g.name, g.address, g.contact_email, g.contact_phone,
             g.description, g.image_url, g.latitude, g.longitude, g.created_at, g.owner_id
      FROM gyms g
      WHERE g.uuid = ${gymUuid}
        AND g.deleted_at IS NULL
        AND g.merged_into_gym_id IS NULL
        AND g.latitude IS NOT NULL
        AND g.longitude IS NOT NULL
      FOR UPDATE
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
      g.owner_id AS "ownerId",
      COALESCE(board_counts.count, 0)::int AS "boardCount",
      COALESCE(member_counts.count, 0)::int AS "memberCount",
      COALESCE(follower_counts.count, 0)::int AS "followerCount",
      COALESCE(comment_counts.count, 0)::int AS "commentCount",
      EXISTS (
        SELECT 1 FROM gym_claims WHERE gym_id = g.id AND status = 'approved'
      ) AS "hasApprovedClaim"
    FROM locked_gym g
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM user_boards WHERE deleted_at IS NULL GROUP BY gym_id
    ) board_counts ON board_counts.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM gym_members GROUP BY gym_id
    ) member_counts ON member_counts.gym_id = g.id
    LEFT JOIN (
      SELECT gym_id, count(*) AS count FROM gym_follows GROUP BY gym_id
    ) follower_counts ON follower_counts.gym_id = g.id
    LEFT JOIN (
      SELECT entity_id, count(*) AS count FROM comments
      WHERE entity_type = 'gym' AND deleted_at IS NULL GROUP BY entity_id
    ) comment_counts ON comment_counts.entity_id = g.uuid
  `,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { candidate: toCandidate(row), ownerId: row.ownerId, hasApprovedClaim: Boolean(row.hasApprovedClaim) };
}

function toGymMergeCounts(counts: MergeCounts) {
  return {
    boards: counts.boardRowsMoved,
    follows: counts.followsInserted,
    members: counts.membersInsertedOrUpdated,
    claims: counts.claimsMoved,
    kiosks: counts.kiosksMoved,
    comments: counts.commentsMoved,
  };
}

function toKioskWarnings(warnings: MergeWarning[]) {
  return warnings.map((warning) => ({
    kioskUuid: warning.kioskUuid,
    kioskName: warning.kioskName,
    previousSlug: warning.previousSlug,
    newSlug: warning.newSlug,
  }));
}

export const socialGymDuplicateMutations = {
  mergeGyms: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'mergeGyms');
    const validatedInput = validateInput(MergeGymsInputSchema, input, 'input');
    const adminUserId = ctx.userId!;

    const uniqueDuplicateUuids = [...new Set(validatedInput.duplicateGymUuids)];
    if (uniqueDuplicateUuids.includes(validatedInput.canonicalGymUuid)) {
      throw new GraphQLError('The canonical gym cannot also be a duplicate.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const results = await db.transaction(async (tx) => {
      const canonical = await loadLiveMergeCandidate(tx, validatedInput.canonicalGymUuid);
      if (!canonical) {
        throw new GraphQLError('The canonical gym is not a live, un-merged gym.', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const duplicates: LoadedMergeCandidate[] = [];
      for (const duplicateUuid of uniqueDuplicateUuids) {
        const duplicate = await loadLiveMergeCandidate(tx, duplicateUuid);
        if (!duplicate) {
          throw new GraphQLError(`Duplicate gym ${duplicateUuid} is not a live, un-merged gym.`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }
        duplicates.push(duplicate);
      }

      // Guard against a silent inversion of the pre-selection rule: keeping a
      // SYSTEM row as the survivor while folding a user-owned or claim-approved
      // duplicate INTO it demotes a real owner's gym to a synced listing. The UI
      // pre-selects correctly; this rejects an inverted pick unless the admin
      // ticked the explicit override.
      const canonicalIsSystem = canonical.ownerId === SYSTEM_BOARD_OWNER_ID;
      const invertsPreselection =
        canonicalIsSystem &&
        duplicates.some((duplicate) => duplicate.ownerId !== SYSTEM_BOARD_OWNER_ID || duplicate.hasApprovedClaim);
      if (invertsPreselection && !validatedInput.allowSystemCanonicalOverride) {
        throw new GraphQLError(
          'This keeps a SYSTEM listing as the survivor over a user-owned or claimed gym. Confirm the override to proceed.',
          { extensions: { code: 'SYSTEM_CANONICAL_OVERRIDE_REQUIRED' } },
        );
      }

      // One stable signature for the whole cluster the admin acted on, stored on
      // every audit row so the merge is auditable as one decision.
      const clusterSignature = computeClusterSignature([
        canonical.candidate.id,
        ...duplicates.map((duplicate) => duplicate.candidate.id),
      ]);

      const perDuplicate: Array<{
        duplicateGymUuid: string;
        counts: ReturnType<typeof toGymMergeCounts>;
        warnings: ReturnType<typeof toKioskWarnings>;
      }> = [];

      // Merge one duplicate at a time so each audit row carries that duplicate's
      // own moved counts, moved-row ids, and warnings.
      for (const duplicate of duplicates) {
        const mergeResult = await mergeGymsIntoCanonical(tx, canonical.candidate, [duplicate.candidate]);

        await tx.insert(dbSchema.gymMergeAudit).values({
          action: 'merged',
          canonicalGymId: canonical.candidate.id,
          duplicateGymId: duplicate.candidate.id,
          clusterSignature,
          movedCounts: mergeResult.counts,
          movedRows: mergeResult.movedRows,
          warnings: mergeResult.warnings,
          performedBy: adminUserId,
        });

        perDuplicate.push({
          duplicateGymUuid: duplicate.candidate.uuid,
          counts: toGymMergeCounts(mergeResult.counts),
          warnings: toKioskWarnings(mergeResult.warnings),
        });
      }

      return perDuplicate;
    });

    return { canonicalGymUuid: validatedInput.canonicalGymUuid, results };
  },

  dismissGymCluster: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'dismissGymCluster');
    const validatedInput = validateInput(DismissGymClusterInputSchema, input, 'input');
    const adminUserId = ctx.userId!;

    const memberRows = (await db
      .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid })
      .from(dbSchema.gyms)
      .where(
        and(inArray(dbSchema.gyms.uuid, validatedInput.gymUuids), isNull(dbSchema.gyms.deletedAt)),
      )) as MergeGymRow[];

    if (memberRows.length !== new Set(validatedInput.gymUuids).size) {
      throw new GraphQLError('Every cluster member must be a live gym.', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const canonicalRow = memberRows.find((row) => row.uuid === validatedInput.canonicalGymUuid);
    if (!canonicalRow) {
      throw new GraphQLError('The canonical gym must be one of the cluster members.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const clusterSignature = computeClusterSignature(memberRows.map((row) => row.id));

    await db.insert(dbSchema.gymMergeAudit).values({
      action: 'dismissed',
      canonicalGymId: canonicalRow.id,
      duplicateGymId: null,
      clusterSignature,
      movedCounts: null,
      movedRows: null,
      warnings: null,
      performedBy: adminUserId,
    });

    return true;
  },
};
