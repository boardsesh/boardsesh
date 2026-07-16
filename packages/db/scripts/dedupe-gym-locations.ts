/**
 * Deduplicate public, system-owned gym rows that represent the same physical
 * location.
 *
 * Default mode is dry-run. Use --apply only after reading the candidate report.
 *
 * Usage:
 *   vp run db:dedupe-gyms
 *   vp run db:dedupe-gyms --only-name "Sandbox Bouldering"
 *   vp run db:dedupe-gyms --apply --limit 10
 *
 * Backfill mode (--backfill-pointers): re-cluster ALREADY soft-deleted twins that
 * predate the merged_into_gym_id pointer (the ~46–60 pre-M1 merged rows) against
 * live gyms and set each one's missing merged_into_gym_id so its old uuid/slug
 * resolves to the survivor. Report-only by default; add --apply to write.
 *
 *   vp run db:dedupe-gyms --backfill-pointers
 *   vp run db:dedupe-gyms --backfill-pointers --apply
 *
 * (A `--` separator before the flags also works — `vp` forwards it to the script
 * verbatim and parseArgs skips it — but it isn't needed.)
 */

import { sql, type SQLWrapper } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';
import {
  distanceMeters,
  groupPhysicalGymCandidates,
  normalizeGymName,
  PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  type CanonicalGymCandidate,
  type PhysicalGymCluster,
} from '../src/queries/gyms/location-dedupe.js';
import {
  addMergeCounts,
  emptyMergeCounts,
  mergeGymCluster,
  selectClusterCandidates,
  type MergeCounts,
  type MergeWarning,
} from '../src/queries/gyms/merge-gyms.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
// Backfill re-clusters against the observed cross-provider drift band (tier B).
const BACKFILL_MATCH_DISTANCE_METERS = 150;
const APPLY_FLAG = '--apply';
const LIMIT_FLAG = '--limit';
const ONLY_NAME_FLAG = '--only-name';
const BACKFILL_POINTERS_FLAG = '--backfill-pointers';
const INCLUDE_NON_SYSTEM_TWINS_FLAG = '--include-non-system-twins';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

// The script's Drizzle connection — has both `execute` and `transaction`.
type ScriptDbInstance = ReturnType<typeof createScriptDb>['db'];

type CandidateDatabaseRow = Omit<
  CanonicalGymCandidate,
  'id' | 'latitude' | 'longitude' | 'boardCount' | 'memberCount' | 'followerCount' | 'commentCount'
> & {
  id: number | string;
  latitude: number | string;
  longitude: number | string;
  boardCount: number | string;
  memberCount: number | string;
  followerCount: number | string;
  commentCount: number | string;
};

type ScriptArgs = {
  apply: boolean;
  limit: number | null;
  onlyName: string | null;
  backfillPointers: boolean;
  includeNonSystemTwins: boolean;
  help: boolean;
};

type CountRow = {
  count: number | string | null;
};

// A gym reduced to what the pointer backfill needs to match twins to survivors.
type GymLocationRow = {
  id: number | string;
  uuid: string;
  name: string;
  latitude: number | string;
  longitude: number | string;
};

type GymLocation = {
  id: number;
  uuid: string;
  name: string;
  latitude: number;
  longitude: number;
};

type PointerBackfillMatch = {
  twin: GymLocation;
  survivor: GymLocation;
  distance: number;
};

function parsePositiveInteger(rawValue: string | undefined, flagName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    console.error(`[dedupe-gyms] ${flagName} requires a positive integer.`);
    process.exit(2);
  }
  return parsedValue;
}

function readRequiredOptionValue(args: string[], optionIndex: number, flagName: string): string {
  const optionValue = args[optionIndex + 1];
  if (!optionValue || optionValue.startsWith('--')) {
    console.error(`[dedupe-gyms] ${flagName} requires a value.`);
    process.exit(2);
  }
  return optionValue;
}

export function parseArgs(args: string[]): ScriptArgs {
  const parsedArgs: ScriptArgs = {
    apply: false,
    limit: null,
    onlyName: null,
    backfillPointers: false,
    includeNonSystemTwins: false,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const currentArg = args[index];
    if (currentArg === ARG_SEPARATOR) {
      // `vp run db:dedupe-gyms -- --apply` forwards the `--` separator to the
      // script verbatim, so tolerate (skip) it rather than rejecting it as an
      // unknown argument. Both `-- --apply` and `--apply` then work.
      continue;
    }
    if (currentArg === APPLY_FLAG) {
      parsedArgs.apply = true;
      continue;
    }
    if (currentArg === BACKFILL_POINTERS_FLAG) {
      parsedArgs.backfillPointers = true;
      continue;
    }
    if (currentArg === INCLUDE_NON_SYSTEM_TWINS_FLAG) {
      parsedArgs.includeNonSystemTwins = true;
      continue;
    }
    if (currentArg === HELP_FLAG) {
      parsedArgs.help = true;
      continue;
    }
    if (currentArg === LIMIT_FLAG) {
      parsedArgs.limit = parsePositiveInteger(readRequiredOptionValue(args, index, LIMIT_FLAG), LIMIT_FLAG);
      index += 1;
      continue;
    }
    if (currentArg === ONLY_NAME_FLAG) {
      parsedArgs.onlyName = readRequiredOptionValue(args, index, ONLY_NAME_FLAG);
      index += 1;
      continue;
    }

    console.error(`[dedupe-gyms] Unknown argument: ${currentArg}`);
    process.exit(2);
  }

  return parsedArgs;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:dedupe-gyms
  vp run db:dedupe-gyms --only-name "Sandbox Bouldering"
  vp run db:dedupe-gyms --apply --limit 10
  vp run db:dedupe-gyms --backfill-pointers
  vp run db:dedupe-gyms --backfill-pointers --apply

Options:
  --apply               Write changes. Omit for dry-run.
  --limit <n>           Limit the number of clusters (merge) / twins (backfill) processed.
  --only-name <name>    Restrict candidates to one normalized gym name.
  --backfill-pointers   Set missing merged_into_gym_id on pre-pointer soft-deleted
                        twins by re-clustering them against live gyms. SYSTEM-owned
                        twins only, and only when exactly one live survivor sits in
                        the match band (ambiguous twins are reported, never pointed).
  --include-non-system-twins
                        Also consider user-owned soft-deleted twins for the backfill.
  --help                Show this help text.`);
}

function coerceCandidate(row: CandidateDatabaseRow): CanonicalGymCandidate {
  return {
    ...row,
    id: Number(row.id),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    boardCount: Number(row.boardCount),
    memberCount: Number(row.memberCount),
    followerCount: Number(row.followerCount),
    commentCount: Number(row.commentCount),
  };
}

function coerceGymLocation(row: GymLocationRow): GymLocation {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  };
}

function idsFromCandidates(candidates: CanonicalGymCandidate[]): number[] {
  return candidates.map((candidate) => candidate.id);
}

function candidateIdsKey(candidates: CanonicalGymCandidate[]): string {
  return idsFromCandidates(candidates)
    .sort((firstId, secondId) => firstId - secondId)
    .join(',');
}

function sqlNumberList(values: number[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function formatGymLabel(candidate: CanonicalGymCandidate): string {
  const addressLabel = candidate.address ? `, ${candidate.address}` : '';
  return `${candidate.name} (#${candidate.id}, ${candidate.uuid}${addressLabel})`;
}

function printCandidateReport(clusters: Array<PhysicalGymCluster<CanonicalGymCandidate>>, apply: boolean): void {
  const duplicateRowCount = clusters.reduce((total, cluster) => total + cluster.gyms.length - 1, 0);
  console.info(
    `[dedupe-gyms] Found ${clusters.length} duplicate cluster(s), ${duplicateRowCount} duplicate gym row(s).`,
  );

  for (const [clusterIndex, cluster] of clusters.entries()) {
    const { canonicalGym, duplicateGyms } = selectClusterCandidates(cluster);
    console.info('');
    console.info(`[dedupe-gyms] ${clusterIndex + 1}. ${cluster.normalizedName}`);
    console.info(`  canonical: ${formatGymLabel(canonicalGym)}`);
    console.info(
      `    boards=${canonicalGym.boardCount}, members=${canonicalGym.memberCount}, followers=${canonicalGym.followerCount}, comments=${canonicalGym.commentCount}`,
    );
    for (const duplicateGym of duplicateGyms) {
      console.info(`  duplicate: ${formatGymLabel(duplicateGym)}`);
      console.info(
        `    boards=${duplicateGym.boardCount}, members=${duplicateGym.memberCount}, followers=${duplicateGym.followerCount}, comments=${duplicateGym.commentCount}`,
      );
    }
  }

  if (!apply) {
    console.info('');
    console.info('[dedupe-gyms] Dry-run only. Re-run with --apply to merge these rows.');
  }
}

async function executeCount(commandDb: ExecuteDb, query: SQLWrapper): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

async function fetchCandidates(commandDb: ExecuteDb, onlyName: string | null): Promise<CanonicalGymCandidate[]> {
  const nameClause = onlyName
    ? sql`AND lower(regexp_replace(trim(g.name), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(trim(${onlyName}), '[[:space:]]+', ' ', 'g'))`
    : sql``;

  const rows = await executeRows<CandidateDatabaseRow>(
    commandDb,
    sql`
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
      FROM gyms g
      LEFT JOIN (
        SELECT gym_id, count(*) AS count
        FROM user_boards
        WHERE deleted_at IS NULL
        GROUP BY gym_id
      ) board_counts ON board_counts.gym_id = g.id
      LEFT JOIN (
        SELECT gym_id, count(*) AS count
        FROM gym_members
        GROUP BY gym_id
      ) member_counts ON member_counts.gym_id = g.id
      LEFT JOIN (
        SELECT gym_id, count(*) AS count
        FROM gym_follows
        GROUP BY gym_id
      ) follower_counts ON follower_counts.gym_id = g.id
      LEFT JOIN (
        SELECT entity_id, count(*) AS count
        FROM comments
        WHERE entity_type = 'gym' AND deleted_at IS NULL
        GROUP BY entity_id
      ) comment_counts ON comment_counts.entity_id = g.uuid
      WHERE g.owner_id = ${SYSTEM_USER_ID}
        AND g.is_public = true
        AND g.deleted_at IS NULL
        AND g.latitude IS NOT NULL
        AND g.longitude IS NOT NULL
        AND g.location IS NOT NULL
        ${nameClause}
      ORDER BY lower(g.name), g.id
    `,
  );

  return rows.map(coerceCandidate);
}

async function fetchCandidatesForApply(commandDb: ExecuteDb, gymIds: number[]): Promise<CanonicalGymCandidate[]> {
  const gymIdList = sqlNumberList(gymIds);
  const rows = await executeRows<CandidateDatabaseRow>(
    commandDb,
    sql`
      WITH locked_gyms AS (
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
        WHERE g.id IN (${gymIdList})
          AND g.owner_id = ${SYSTEM_USER_ID}
          AND g.is_public = true
          AND g.deleted_at IS NULL
          AND g.latitude IS NOT NULL
          AND g.longitude IS NOT NULL
          AND g.location IS NOT NULL
        FOR UPDATE
      ),
      board_counts AS (
        SELECT board.gym_id, count(*)::int AS count
        FROM user_boards board
        INNER JOIN locked_gyms locked_gym ON locked_gym.id = board.gym_id
        WHERE board.deleted_at IS NULL
        GROUP BY board.gym_id
      ),
      member_counts AS (
        SELECT gym_member.gym_id, count(*)::int AS count
        FROM gym_members gym_member
        INNER JOIN locked_gyms locked_gym ON locked_gym.id = gym_member.gym_id
        GROUP BY gym_member.gym_id
      ),
      follower_counts AS (
        SELECT gym_follow.gym_id, count(*)::int AS count
        FROM gym_follows gym_follow
        INNER JOIN locked_gyms locked_gym ON locked_gym.id = gym_follow.gym_id
        GROUP BY gym_follow.gym_id
      ),
      comment_counts AS (
        SELECT gym_comment.entity_id, count(*)::int AS count
        FROM comments gym_comment
        INNER JOIN locked_gyms locked_gym ON locked_gym.uuid = gym_comment.entity_id
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
      FROM locked_gyms g
      LEFT JOIN board_counts ON board_counts.gym_id = g.id
      LEFT JOIN member_counts ON member_counts.gym_id = g.id
      LEFT JOIN follower_counts ON follower_counts.gym_id = g.id
      LEFT JOIN comment_counts ON comment_counts.entity_id = g.uuid
      ORDER BY lower(g.name), g.id
    `,
  );

  return rows.map(coerceCandidate);
}

async function refetchClusterForApply(
  commandDb: ExecuteDb,
  cluster: PhysicalGymCluster<CanonicalGymCandidate>,
): Promise<PhysicalGymCluster<CanonicalGymCandidate>> {
  const originalGymIds = idsFromCandidates(cluster.gyms);
  const originalKey = candidateIdsKey(cluster.gyms);
  const lockedCandidates = await fetchCandidatesForApply(commandDb, originalGymIds);

  if (lockedCandidates.length !== originalGymIds.length) {
    throw new Error(
      `Cluster ${originalKey} changed before apply: expected ${originalGymIds.length} active system-owned rows, got ${lockedCandidates.length}.`,
    );
  }

  const matchingCluster = groupPhysicalGymCandidates(lockedCandidates, PHYSICAL_GYM_MATCH_DISTANCE_METERS).find(
    (candidateCluster) => candidateIdsKey(candidateCluster.gyms) === originalKey,
  );

  if (!matchingCluster) {
    throw new Error(`Cluster ${originalKey} no longer passes conservative physical matching checks.`);
  }

  return matchingCluster;
}

function printMergeSummary(totalCounts: MergeCounts, warnings: MergeWarning[]): void {
  console.info('');
  console.info('[dedupe-gyms] Merge complete:');
  console.info(`  board rows moved: ${totalCounts.boardRowsMoved}`);
  console.info(`  source aliases moved: ${totalCounts.sourceAliasesMoved}`);
  console.info(`  follows inserted/deleted: ${totalCounts.followsInserted}/${totalCounts.followsDeleted}`);
  console.info(
    `  members inserted-or-updated/deleted: ${totalCounts.membersInsertedOrUpdated}/${totalCounts.membersDeleted}`,
  );
  console.info(`  claims moved/expired: ${totalCounts.claimsMoved}/${totalCounts.claimsExpired}`);
  console.info(`  kiosks moved: ${totalCounts.kiosksMoved}`);
  console.info(`  comments moved: ${totalCounts.commentsMoved}`);
  console.info(`  feed items moved: ${totalCounts.feedItemsMoved}`);
  console.info(`  notifications moved: ${totalCounts.notificationsMoved}`);
  console.info(`  votes upserted/deleted: ${totalCounts.votesUpserted}/${totalCounts.votesDeleted}`);
  console.info(`  duplicate gyms soft-deleted: ${totalCounts.duplicateGymsSoftDeleted}`);

  if (warnings.length > 0) {
    console.info('');
    console.info(`[dedupe-gyms] ${warnings.length} warning(s):`);
    for (const warning of warnings) {
      console.info(
        `  kiosk "${warning.kioskName}" (${warning.kioskUuid}) re-slugged ${warning.previousSlug} -> ${warning.newSlug}; its printed install QR must be reprinted.`,
      );
    }
  }
}

/**
 * Load every live gym with coordinates as a potential merge survivor for the
 * pointer backfill, and every soft-deleted gym that lacks a merged_into pointer
 * as a candidate twin.
 */
async function fetchBackfillGyms(
  commandDb: ExecuteDb,
  onlyName: string | null,
  includeNonSystemTwins: boolean,
): Promise<{ liveGyms: GymLocation[]; orphanTwins: GymLocation[] }> {
  const nameClause = onlyName
    ? sql`AND lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(trim(${onlyName}), '[[:space:]]+', ' ', 'g'))`
    : sql``;
  // The pre-M1 dedupe only ever merged SYSTEM-owned listings, so default to those.
  // A false pointer redirects printed QRs to the wrong gym — worse than a 404.
  const twinOwnerClause = includeNonSystemTwins ? sql`` : sql`AND owner_id = ${SYSTEM_USER_ID}`;

  const liveRows = await executeRows<GymLocationRow>(
    commandDb,
    sql`
      SELECT id AS "id", uuid AS "uuid", name AS "name", latitude AS "latitude", longitude AS "longitude"
      FROM gyms
      WHERE deleted_at IS NULL
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        ${nameClause}
      ORDER BY id
    `,
  );

  const orphanRows = await executeRows<GymLocationRow>(
    commandDb,
    sql`
      SELECT id AS "id", uuid AS "uuid", name AS "name", latitude AS "latitude", longitude AS "longitude"
      FROM gyms
      WHERE deleted_at IS NOT NULL
        AND merged_into_gym_id IS NULL
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        ${twinOwnerClause}
        ${nameClause}
      ORDER BY id
    `,
  );

  return {
    liveGyms: liveRows.map(coerceGymLocation),
    orphanTwins: orphanRows.map(coerceGymLocation),
  };
}

/**
 * Match each pre-pointer soft-deleted twin to a live survivor sharing its
 * normalized name within the drift band — but only when the survivor is
 * UNAMBIGUOUS. If a second live gym also sits in the band, the twin is reported
 * and left un-pointed: a wrong pointer would redirect printed QRs to the wrong
 * gym, worse than the current 404.
 */
function matchTwinsToSurvivors(
  liveGyms: GymLocation[],
  orphanTwins: GymLocation[],
): { matches: PointerBackfillMatch[]; ambiguousTwins: Array<{ twin: GymLocation; candidateCount: number }> } {
  const liveByName = new Map<string, GymLocation[]>();
  for (const liveGym of liveGyms) {
    const normalizedName = normalizeGymName(liveGym.name);
    const matches = liveByName.get(normalizedName) ?? [];
    matches.push(liveGym);
    liveByName.set(normalizedName, matches);
  }

  const backfillMatches: PointerBackfillMatch[] = [];
  const ambiguousTwins: Array<{ twin: GymLocation; candidateCount: number }> = [];
  for (const twin of orphanTwins) {
    const candidates = liveByName.get(normalizeGymName(twin.name)) ?? [];
    const inBand = candidates
      .map((survivor) => ({ survivor, distance: distanceMeters(twin, survivor) }))
      .filter((entry) => entry.distance <= BACKFILL_MATCH_DISTANCE_METERS)
      .sort((first, second) => first.distance - second.distance);

    if (inBand.length === 0) {
      continue;
    }
    if (inBand.length > 1) {
      ambiguousTwins.push({ twin, candidateCount: inBand.length });
      continue;
    }
    backfillMatches.push({ twin, survivor: inBand[0].survivor, distance: inBand[0].distance });
  }

  return { matches: backfillMatches, ambiguousTwins };
}

async function runPointerBackfill(commandDb: ScriptDbInstance, scriptArgs: ScriptArgs): Promise<void> {
  const { liveGyms, orphanTwins } = await fetchBackfillGyms(
    commandDb,
    scriptArgs.onlyName,
    scriptArgs.includeNonSystemTwins,
  );
  const { matches: allMatches, ambiguousTwins } = matchTwinsToSurvivors(liveGyms, orphanTwins);
  const matches = scriptArgs.limit ? allMatches.slice(0, scriptArgs.limit) : allMatches;

  console.info(
    `[dedupe-gyms] Pointer backfill: ${orphanTwins.length} soft-deleted ${scriptArgs.includeNonSystemTwins ? '' : 'SYSTEM-owned '}twin(s) without a pointer, ` +
      `${matches.length} unambiguous survivor match(es) within ${BACKFILL_MATCH_DISTANCE_METERS} m, ${ambiguousTwins.length} skipped as ambiguous.`,
  );

  for (const match of matches) {
    const tier = match.distance <= PHYSICAL_GYM_MATCH_DISTANCE_METERS ? 'A' : 'B';
    console.info(
      `  twin #${match.twin.id} (${match.twin.uuid}) -> survivor #${match.survivor.id} (${match.survivor.uuid}) ` +
        `[${match.twin.name}] ${match.distance.toFixed(1)} m, tier ${tier}`,
    );
  }

  for (const ambiguous of ambiguousTwins) {
    console.info(
      `  SKIP (ambiguous) twin #${ambiguous.twin.id} (${ambiguous.twin.uuid}) [${ambiguous.twin.name}] — ` +
        `${ambiguous.candidateCount} live gyms within ${BACKFILL_MATCH_DISTANCE_METERS} m; not pointing.`,
    );
  }

  if (!scriptArgs.apply || matches.length === 0) {
    if (!scriptArgs.apply) {
      console.info('');
      console.info('[dedupe-gyms] Dry-run only. Re-run with --backfill-pointers --apply to set these pointers.');
    }
    return;
  }

  const pointersSet = await commandDb.transaction(async (transaction) => {
    let updated = 0;
    for (const match of matches) {
      // Only write the pointer when it is still unset (guards against a
      // concurrent merge having claimed the twin in the meantime).
      updated += await executeCount(
        transaction,
        sql`
          WITH pointed AS (
            UPDATE gyms
               SET merged_into_gym_id = ${match.survivor.id},
                   updated_at = NOW()
             WHERE id = ${match.twin.id}
               AND merged_into_gym_id IS NULL
               AND deleted_at IS NOT NULL
             RETURNING 1
          )
          SELECT count(*)::int AS count FROM pointed
        `,
      );
    }
    return updated;
  });

  console.info('');
  console.info(`[dedupe-gyms] Pointer backfill complete: ${pointersSet} pointer(s) set.`);
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  const { db, close } = createScriptDb();

  try {
    if (scriptArgs.backfillPointers) {
      await runPointerBackfill(db, scriptArgs);
      return;
    }

    const candidates = await fetchCandidates(db, scriptArgs.onlyName);
    const allClusters = groupPhysicalGymCandidates(candidates, PHYSICAL_GYM_MATCH_DISTANCE_METERS);
    const selectedClusters = scriptArgs.limit ? allClusters.slice(0, scriptArgs.limit) : allClusters;

    printCandidateReport(selectedClusters, scriptArgs.apply);

    if (!scriptArgs.apply || selectedClusters.length === 0) {
      return;
    }

    const { totalCounts, warnings } = await db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:gym-location-dedupe'))`);

      let aggregateCounts = emptyMergeCounts();
      const aggregateWarnings: MergeWarning[] = [];
      for (const cluster of selectedClusters) {
        const lockedCluster = await refetchClusterForApply(transaction, cluster);
        const clusterResult = await mergeGymCluster(transaction, lockedCluster);
        aggregateCounts = addMergeCounts(aggregateCounts, clusterResult.counts);
        aggregateWarnings.push(...clusterResult.warnings);
      }
      return { totalCounts: aggregateCounts, warnings: aggregateWarnings };
    });

    printMergeSummary(totalCounts, warnings);
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[dedupe-gyms] failed:', error);
    process.exit(1);
  });
}
