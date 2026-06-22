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
 * (A `--` separator before the flags also works — `vp` forwards it to the script
 * verbatim and parseArgs skips it — but it isn't needed.)
 */

import { sql, type SQLWrapper } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';
import {
  chooseCanonicalGymCandidate,
  compareCanonicalGymCandidates,
  groupPhysicalGymCandidates,
  hasText,
  PHYSICAL_GYM_MATCH_DISTANCE_METERS,
  type CanonicalGymCandidate,
  type PhysicalGymCluster,
} from '../src/queries/gyms/location-dedupe.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const APPLY_FLAG = '--apply';
const LIMIT_FLAG = '--limit';
const ONLY_NAME_FLAG = '--only-name';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

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
  help: boolean;
};

type MergeCounts = {
  boardRowsMoved: number;
  sourceAliasesMoved: number;
  followsInserted: number;
  followsDeleted: number;
  membersInsertedOrUpdated: number;
  membersDeleted: number;
  commentsMoved: number;
  feedItemsMoved: number;
  notificationsMoved: number;
  votesUpserted: number;
  votesDeleted: number;
  duplicateGymsSoftDeleted: number;
};

type CountRow = {
  count: number | string | null;
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

function parseArgs(args: string[]): ScriptArgs {
  const parsedArgs: ScriptArgs = {
    apply: false,
    limit: null,
    onlyName: null,
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

Options:
  --apply              Merge candidates. Omit for dry-run.
  --limit <n>          Limit the number of duplicate clusters processed.
  --only-name <name>   Restrict candidates to one normalized gym name.
  --help               Show this help text.`);
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

function pickTextField(
  candidates: CanonicalGymCandidate[],
  fieldName: 'address' | 'contactEmail' | 'contactPhone' | 'description' | 'imageUrl',
): string | null {
  for (const candidate of candidates) {
    const candidateValue = candidate[fieldName];
    if (hasText(candidateValue)) {
      return candidateValue;
    }
  }
  return null;
}

function idsFromCandidates(candidates: CanonicalGymCandidate[]): number[] {
  return candidates.map((candidate) => candidate.id);
}

function uuidsFromCandidates(candidates: CanonicalGymCandidate[]): string[] {
  return candidates.map((candidate) => candidate.uuid);
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

function sqlTextList(values: string[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function selectClusterCandidates(cluster: PhysicalGymCluster<CanonicalGymCandidate>): {
  canonicalGym: CanonicalGymCandidate;
  duplicateGyms: CanonicalGymCandidate[];
} {
  const canonicalGym = chooseCanonicalGymCandidate(cluster.gyms);
  if (!canonicalGym) {
    throw new Error(`Duplicate cluster for ${cluster.normalizedName} has no canonical gym candidate.`);
  }

  const duplicateGyms = cluster.gyms
    .filter((candidate) => candidate.id !== canonicalGym.id)
    .sort(compareCanonicalGymCandidates);

  return { canonicalGym, duplicateGyms };
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

async function setVoteCountMaintenanceSkipped(commandDb: ExecuteDb, skipped: boolean): Promise<void> {
  await commandDb.execute(sql`SELECT set_config('boardsesh.skip_vote_counts', ${skipped ? 'on' : 'off'}, true)`);
}

async function rebuildGymVoteCounts(commandDb: ExecuteDb, gymUuids: string[]): Promise<void> {
  const gymUuidList = sqlTextList(gymUuids);
  await commandDb.execute(sql`
    DELETE FROM vote_counts
     WHERE entity_type = 'gym'::social_entity_type
       AND entity_id IN (${gymUuidList})
  `);

  await commandDb.execute(sql`
    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
    SELECT
      vote_totals.entity_type,
      vote_totals.entity_id,
      vote_totals.upvotes,
      vote_totals.downvotes,
      vote_totals.score,
      SIGN(vote_totals.score) * LN(GREATEST(ABS(vote_totals.score), 1))
        + EXTRACT(EPOCH FROM COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())) / 45000.0,
      COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())
    FROM (
      SELECT
        votes.entity_type,
        votes.entity_id,
        SUM(CASE WHEN votes.value = 1 THEN 1 ELSE 0 END)::int AS upvotes,
        SUM(CASE WHEN votes.value = -1 THEN 1 ELSE 0 END)::int AS downvotes,
        SUM(votes.value)::int AS score,
        MIN(votes.created_at) AS first_vote_created_at
      FROM votes
      WHERE votes.entity_type = 'gym'::social_entity_type
        AND votes.entity_id IN (${gymUuidList})
      GROUP BY votes.entity_type, votes.entity_id
    ) vote_totals
    LEFT JOIN LATERAL (
      SELECT feed_items.created_at
      FROM feed_items
      WHERE feed_items.entity_type = vote_totals.entity_type
        AND feed_items.entity_id = vote_totals.entity_id
      ORDER BY feed_items.created_at ASC, feed_items.id ASC
      LIMIT 1
    ) feed_created_at ON true
    ON CONFLICT (entity_type, entity_id) DO UPDATE SET
      upvotes = excluded.upvotes,
      downvotes = excluded.downvotes,
      score = excluded.score,
      hot_score = excluded.hot_score,
      created_at = excluded.created_at
  `);
}

export async function mergeGymCluster(
  commandDb: ExecuteDb,
  cluster: PhysicalGymCluster<CanonicalGymCandidate>,
): Promise<MergeCounts> {
  const { canonicalGym, duplicateGyms } = selectClusterCandidates(cluster);
  const allCandidatesForMetadata = [canonicalGym, ...duplicateGyms].sort(compareCanonicalGymCandidates);
  const duplicateGymIds = idsFromCandidates(duplicateGyms);
  const duplicateGymUuids = uuidsFromCandidates(duplicateGyms);
  const duplicateGymIdList = sqlNumberList(duplicateGymIds);
  const duplicateGymUuidList = sqlTextList(duplicateGymUuids);
  const allGymUuidList = sqlTextList([canonicalGym.uuid, ...duplicateGymUuids]);

  await commandDb.execute(sql`
    UPDATE gyms
       SET address = COALESCE(NULLIF(address, ''), ${pickTextField(allCandidatesForMetadata, 'address')}),
           contact_email = COALESCE(NULLIF(contact_email, ''), ${pickTextField(allCandidatesForMetadata, 'contactEmail')}),
           contact_phone = COALESCE(NULLIF(contact_phone, ''), ${pickTextField(allCandidatesForMetadata, 'contactPhone')}),
           description = COALESCE(NULLIF(description, ''), ${pickTextField(allCandidatesForMetadata, 'description')}),
           image_url = COALESCE(NULLIF(image_url, ''), ${pickTextField(allCandidatesForMetadata, 'imageUrl')}),
           is_public = true,
           deleted_at = NULL,
           updated_at = NOW()
     WHERE id = ${canonicalGym.id}
  `);

  const boardRowsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE user_boards
           SET gym_id = ${canonicalGym.id},
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  const sourceAliasesMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE location_sync_gym_sources
           SET gym_id = ${canonicalGym.id},
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  const followsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO gym_follows (gym_id, user_id, created_at)
        SELECT ${canonicalGym.id}, user_id, MIN(created_at)
          FROM gym_follows
         WHERE gym_id IN (${duplicateGymIdList})
         GROUP BY user_id
        ON CONFLICT (gym_id, user_id) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );

  const followsDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM gym_follows
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  const membersInsertedOrUpdated = await executeCount(
    commandDb,
    sql`
      WITH upserted AS (
        INSERT INTO gym_members (gym_id, user_id, role, created_at)
        SELECT ${canonicalGym.id},
               user_id,
               CASE
                 WHEN bool_or(role = 'admin'::gym_member_role) THEN 'admin'::gym_member_role
                 ELSE 'member'::gym_member_role
               END,
               MIN(created_at)
          FROM gym_members
         WHERE gym_id IN (${duplicateGymIdList})
         GROUP BY user_id
        ON CONFLICT (gym_id, user_id) DO UPDATE
          SET role = CASE
            WHEN gym_members.role = 'admin'::gym_member_role OR excluded.role = 'admin'::gym_member_role
              THEN 'admin'::gym_member_role
            ELSE 'member'::gym_member_role
          END
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM upserted
    `,
  );

  const membersDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM gym_members
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  const commentsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE comments
           SET entity_id = ${canonicalGym.uuid},
               updated_at = NOW()
         WHERE entity_type = 'gym'::social_entity_type
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  const feedItemsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET entity_id = ${canonicalGym.uuid}
         WHERE entity_type = 'gym'::social_entity_type
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  const notificationsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE notifications
           SET entity_id = ${canonicalGym.uuid}
         WHERE entity_type = 'gym'::social_entity_type
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  let votesUpserted = 0;
  let votesDeleted = 0;
  await setVoteCountMaintenanceSkipped(commandDb, true);
  votesUpserted = await executeCount(
    commandDb,
    sql`
      WITH latest_votes AS (
        SELECT DISTINCT ON (user_id)
               user_id,
               value,
               created_at
          FROM votes
         WHERE entity_type = 'gym'::social_entity_type
           AND entity_id IN (${allGymUuidList})
         ORDER BY user_id, created_at DESC, id DESC
      ),
      upserted AS (
        INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
        SELECT user_id,
               'gym'::social_entity_type,
               ${canonicalGym.uuid},
               value,
               created_at
          FROM latest_votes
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
          SET value = excluded.value,
              created_at = excluded.created_at
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM upserted
    `,
  );

  votesDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM votes
         WHERE entity_type = 'gym'::social_entity_type
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );
  await rebuildGymVoteCounts(commandDb, [canonicalGym.uuid, ...duplicateGymUuids]);
  await setVoteCountMaintenanceSkipped(commandDb, false);

  const duplicateGymsSoftDeleted = await executeCount(
    commandDb,
    sql`
      WITH soft_deleted AS (
        UPDATE gyms
           SET is_public = false,
               deleted_at = NOW(),
               updated_at = NOW()
         WHERE id IN (${duplicateGymIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM soft_deleted
    `,
  );

  return {
    boardRowsMoved,
    sourceAliasesMoved,
    followsInserted,
    followsDeleted,
    membersInsertedOrUpdated,
    membersDeleted,
    commentsMoved,
    feedItemsMoved,
    notificationsMoved,
    votesUpserted,
    votesDeleted,
    duplicateGymsSoftDeleted,
  };
}

function emptyMergeCounts(): MergeCounts {
  return {
    boardRowsMoved: 0,
    sourceAliasesMoved: 0,
    followsInserted: 0,
    followsDeleted: 0,
    membersInsertedOrUpdated: 0,
    membersDeleted: 0,
    commentsMoved: 0,
    feedItemsMoved: 0,
    notificationsMoved: 0,
    votesUpserted: 0,
    votesDeleted: 0,
    duplicateGymsSoftDeleted: 0,
  };
}

function addMergeCounts(firstCounts: MergeCounts, secondCounts: MergeCounts): MergeCounts {
  return {
    boardRowsMoved: firstCounts.boardRowsMoved + secondCounts.boardRowsMoved,
    sourceAliasesMoved: firstCounts.sourceAliasesMoved + secondCounts.sourceAliasesMoved,
    followsInserted: firstCounts.followsInserted + secondCounts.followsInserted,
    followsDeleted: firstCounts.followsDeleted + secondCounts.followsDeleted,
    membersInsertedOrUpdated: firstCounts.membersInsertedOrUpdated + secondCounts.membersInsertedOrUpdated,
    membersDeleted: firstCounts.membersDeleted + secondCounts.membersDeleted,
    commentsMoved: firstCounts.commentsMoved + secondCounts.commentsMoved,
    feedItemsMoved: firstCounts.feedItemsMoved + secondCounts.feedItemsMoved,
    notificationsMoved: firstCounts.notificationsMoved + secondCounts.notificationsMoved,
    votesUpserted: firstCounts.votesUpserted + secondCounts.votesUpserted,
    votesDeleted: firstCounts.votesDeleted + secondCounts.votesDeleted,
    duplicateGymsSoftDeleted: firstCounts.duplicateGymsSoftDeleted + secondCounts.duplicateGymsSoftDeleted,
  };
}

function printMergeCounts(totalCounts: MergeCounts): void {
  console.info('');
  console.info('[dedupe-gyms] Merge complete:');
  console.info(`  board rows moved: ${totalCounts.boardRowsMoved}`);
  console.info(`  source aliases moved: ${totalCounts.sourceAliasesMoved}`);
  console.info(`  follows inserted/deleted: ${totalCounts.followsInserted}/${totalCounts.followsDeleted}`);
  console.info(
    `  members inserted-or-updated/deleted: ${totalCounts.membersInsertedOrUpdated}/${totalCounts.membersDeleted}`,
  );
  console.info(`  comments moved: ${totalCounts.commentsMoved}`);
  console.info(`  feed items moved: ${totalCounts.feedItemsMoved}`);
  console.info(`  notifications moved: ${totalCounts.notificationsMoved}`);
  console.info(`  votes upserted/deleted: ${totalCounts.votesUpserted}/${totalCounts.votesDeleted}`);
  console.info(`  duplicate gyms soft-deleted: ${totalCounts.duplicateGymsSoftDeleted}`);
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  const { db, close } = createScriptDb();

  try {
    const candidates = await fetchCandidates(db, scriptArgs.onlyName);
    const allClusters = groupPhysicalGymCandidates(candidates, PHYSICAL_GYM_MATCH_DISTANCE_METERS);
    const selectedClusters = scriptArgs.limit ? allClusters.slice(0, scriptArgs.limit) : allClusters;

    printCandidateReport(selectedClusters, scriptArgs.apply);

    if (!scriptArgs.apply || selectedClusters.length === 0) {
      return;
    }

    const totalCounts = await db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:gym-location-dedupe'))`);

      let aggregateCounts = emptyMergeCounts();
      for (const cluster of selectedClusters) {
        const lockedCluster = await refetchClusterForApply(transaction, cluster);
        const clusterCounts = await mergeGymCluster(transaction, lockedCluster);
        aggregateCounts = addMergeCounts(aggregateCounts, clusterCounts);
      }
      return aggregateCounts;
    });

    printMergeCounts(totalCounts);
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
