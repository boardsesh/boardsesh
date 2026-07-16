import { createHash } from 'node:crypto';
import { sql, type SQLWrapper } from 'drizzle-orm';
// Extensionless relative imports, matching the rest of packages/db/src (e.g.
// queries/gyms/index.ts). merge-gyms is pulled into the web import graph via
// @boardsesh/db, and Turbopack can't map a `.js` specifier onto the `.ts` source.
import { executeRows } from '../../client/index';
import {
  chooseCanonicalGymCandidate,
  compareCanonicalGymCandidates,
  hasText,
  type CanonicalGymCandidate,
  type PhysicalGymCluster,
} from './location-dedupe';

/**
 * The minimal database surface the merge needs: a single `execute` that runs a
 * Drizzle `sql` fragment. Both the backend's Drizzle client and a script/backend
 * transaction satisfy it, so the same merge runs from the CLI dedupe tool and
 * from the admin GraphQL mutation.
 */
export type MergeExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

/**
 * Counts of what a single canonical merge re-pointed. One object per merged
 * duplicate (or the sum across a cluster). Written to the merge audit and
 * surfaced in the admin confirm dialog.
 */
export type MergeCounts = {
  boardRowsMoved: number;
  sourceAliasesMoved: number;
  followsInserted: number;
  followsDeleted: number;
  membersInsertedOrUpdated: number;
  membersDeleted: number;
  claimsMoved: number;
  // Pending claims the claimant already duplicated on the canonical (or extra
  // twins of their own): instead of being deleted, they are re-pointed to the
  // canonical and flipped to `expired` so no content is lost — the claimant's
  // live canonical claim still stands.
  claimsExpired: number;
  kiosksMoved: number;
  commentsMoved: number;
  feedItemsMoved: number;
  notificationsMoved: number;
  votesUpserted: number;
  votesDeleted: number;
  duplicateGymsSoftDeleted: number;
};

/**
 * The identifiers of every row a merge re-pointed, per table. Written to the
 * merge audit (jsonb) so a bad merge can be traced and manually reversed —
 * aggregate counts alone can't tell you WHICH boards/members/claims moved.
 */
export type MergeMovedRows = {
  boardIds: number[];
  sourceKeys: string[];
  followUserIds: string[];
  memberUserIds: string[];
  // Claims re-pointed to the canonical keeping their status (pending promotions +
  // non-pending history).
  movedClaimIds: number[];
  // Claims re-pointed to the canonical AND flipped to `expired` (the collided /
  // extra pending claims that would otherwise trip the unique-pending index).
  expiredClaimIds: number[];
  kioskIds: number[];
  commentIds: number[];
  feedItemIds: number[];
  notificationIds: number[];
  voteUserIds: string[];
  softDeletedGymIds: number[];
};

/**
 * A non-fatal side effect the admin must be told about. Today the only kind is a
 * kiosk whose slug collided on the canonical gym and had to be suffixed — that
 * re-slug invalidates the kiosk's printed install QR, so the UI surfaces it.
 */
export type MergeWarning = {
  type: 'kiosk_slug_changed';
  kioskUuid: string;
  kioskName: string;
  previousSlug: string;
  newSlug: string;
};

export type MergeResult = {
  counts: MergeCounts;
  warnings: MergeWarning[];
  movedRows: MergeMovedRows;
};

export function emptyMergeMovedRows(): MergeMovedRows {
  return {
    boardIds: [],
    sourceKeys: [],
    followUserIds: [],
    memberUserIds: [],
    movedClaimIds: [],
    expiredClaimIds: [],
    kioskIds: [],
    commentIds: [],
    feedItemIds: [],
    notificationIds: [],
    voteUserIds: [],
    softDeletedGymIds: [],
  };
}

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// The social tables' entity_type is a `social_entity_type` enum in prod but a
// plain text column in the backend test schema. A bare untyped `'gym'` literal
// coerces to the enum in prod AND string-compares against the text column in
// tests — an explicit `::social_entity_type` cast would 500 against the test DB.

type CountRow = {
  count: number | string | null;
};

type IdRow = {
  id: number | string;
};

type UserIdRow = {
  userId: string;
};

type SourceKeyRow = {
  sourceKey: string;
};

type DuplicateKioskRow = {
  id: number | string;
  uuid: string;
  name: string;
  slug: string;
};

type SlugRow = {
  slug: string;
};

export function emptyMergeCounts(): MergeCounts {
  return {
    boardRowsMoved: 0,
    sourceAliasesMoved: 0,
    followsInserted: 0,
    followsDeleted: 0,
    membersInsertedOrUpdated: 0,
    membersDeleted: 0,
    claimsMoved: 0,
    claimsExpired: 0,
    kiosksMoved: 0,
    commentsMoved: 0,
    feedItemsMoved: 0,
    notificationsMoved: 0,
    votesUpserted: 0,
    votesDeleted: 0,
    duplicateGymsSoftDeleted: 0,
  };
}

export function addMergeCounts(firstCounts: MergeCounts, secondCounts: MergeCounts): MergeCounts {
  return {
    boardRowsMoved: firstCounts.boardRowsMoved + secondCounts.boardRowsMoved,
    sourceAliasesMoved: firstCounts.sourceAliasesMoved + secondCounts.sourceAliasesMoved,
    followsInserted: firstCounts.followsInserted + secondCounts.followsInserted,
    followsDeleted: firstCounts.followsDeleted + secondCounts.followsDeleted,
    membersInsertedOrUpdated: firstCounts.membersInsertedOrUpdated + secondCounts.membersInsertedOrUpdated,
    membersDeleted: firstCounts.membersDeleted + secondCounts.membersDeleted,
    claimsMoved: firstCounts.claimsMoved + secondCounts.claimsMoved,
    claimsExpired: firstCounts.claimsExpired + secondCounts.claimsExpired,
    kiosksMoved: firstCounts.kiosksMoved + secondCounts.kiosksMoved,
    commentsMoved: firstCounts.commentsMoved + secondCounts.commentsMoved,
    feedItemsMoved: firstCounts.feedItemsMoved + secondCounts.feedItemsMoved,
    notificationsMoved: firstCounts.notificationsMoved + secondCounts.notificationsMoved,
    votesUpserted: firstCounts.votesUpserted + secondCounts.votesUpserted,
    votesDeleted: firstCounts.votesDeleted + secondCounts.votesDeleted,
    duplicateGymsSoftDeleted: firstCounts.duplicateGymsSoftDeleted + secondCounts.duplicateGymsSoftDeleted,
  };
}

/**
 * A stable identity for a candidate cluster: the sorted member gym ids hashed to
 * a fixed-length hex string. The queue keys dismissed clusters on this so the
 * same set of gyms (in any order) is hidden after an admin dismisses it.
 */
export function computeClusterSignature(gymIds: number[]): string {
  const sortedIds = [...gymIds].sort((firstId, secondId) => firstId - secondId).join(',');
  return createHash('sha256').update(sortedIds).digest('hex');
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

async function executeCount(commandDb: MergeExecuteDb, query: SQLWrapper): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

async function setVoteCountMaintenanceSkipped(commandDb: MergeExecuteDb, skipped: boolean): Promise<void> {
  await commandDb.execute(sql`SELECT set_config('boardsesh.skip_vote_counts', ${skipped ? 'on' : 'off'}, true)`);
}

async function rebuildGymVoteCounts(commandDb: MergeExecuteDb, gymUuids: string[]): Promise<void> {
  const gymUuidList = sqlTextList(gymUuids);
  await commandDb.execute(sql`
    DELETE FROM vote_counts
     WHERE entity_type = 'gym'
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
      WHERE votes.entity_type = 'gym'
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

/**
 * Re-point every gym claim on a duplicate to the canonical gym, honouring the
 * `gym_claims_unique_pending` partial index (one pending claim per gym + claimant).
 *
 * A claimant mid-flight on a twin must land on the canonical without losing their
 * place. Because the target may already carry that claimant's pending claim (and
 * a claimant can even have pending claims on several twins in the same cluster),
 * a naive `UPDATE ... SET gym_id = canonical` would trip the unique index. So:
 *  1. Promote at most one duplicate pending claim per claimant who has no pending
 *     claim on the canonical yet — moved keeping its `pending` status.
 *  2. Re-point any REMAINING pending claims on the duplicates (they collided with
 *     an existing canonical claim, or were the claimant's extra twins) to the
 *     canonical AND flip them to `expired` — never delete. Their full content
 *     (claimant, method, message, timestamps) is preserved on the survivor for
 *     audit/reversal; `expired` keeps them clear of the unique-pending index.
 * Non-pending claims (approved/denied/expired) carry no unique constraint and are
 * moved wholesale so the ownership history follows the survivor.
 */
async function repointClaims(
  commandDb: MergeExecuteDb,
  canonicalGymId: number,
  duplicateGymIdList: SQLWrapper,
): Promise<{ movedClaimIds: number[]; expiredClaimIds: number[] }> {
  const promoted = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH promotable AS (
        SELECT DISTINCT ON (claimant_user_id) id
          FROM gym_claims
         WHERE gym_id IN (${duplicateGymIdList})
           AND status = 'pending'
           AND claimant_user_id NOT IN (
             SELECT claimant_user_id
               FROM gym_claims
              WHERE gym_id = ${canonicalGymId}
                AND status = 'pending'
           )
         ORDER BY claimant_user_id, created_at DESC, id DESC
      ),
      moved AS (
        UPDATE gym_claims
           SET gym_id = ${canonicalGymId},
               updated_at = NOW()
         WHERE id IN (SELECT id FROM promotable)
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  const expired = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH expired AS (
        UPDATE gym_claims
           SET gym_id = ${canonicalGymId},
               status = 'expired',
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
           AND status = 'pending'
         RETURNING id
      )
      SELECT id FROM expired
    `,
  );

  const history = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE gym_claims
           SET gym_id = ${canonicalGymId},
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
           AND status <> 'pending'
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  return {
    movedClaimIds: [...promoted.map((row) => Number(row.id)), ...history.map((row) => Number(row.id))],
    expiredClaimIds: expired.map((row) => Number(row.id)),
  };
}

/**
 * Move a duplicate's live kiosks onto the canonical gym. A kiosk slug is unique
 * per live gym, so a duplicate kiosk whose slug is already taken on the canonical
 * (or by an earlier-moved sibling in this same merge) gets a numeric suffix and a
 * warning — a re-slugged kiosk's printed install QR no longer resolves, and the
 * gym needs to reprint it. Soft-deleted kiosks stay on the dead twin; they're
 * already gone and never contend for a slug.
 */
async function repointKiosks(
  commandDb: MergeExecuteDb,
  canonicalGymId: number,
  duplicateGymIdList: SQLWrapper,
): Promise<{ kioskIds: number[]; warnings: MergeWarning[] }> {
  const duplicateKiosks = await executeRows<DuplicateKioskRow>(
    commandDb,
    sql`
      SELECT id, uuid, name, slug
        FROM gym_kiosks
       WHERE gym_id IN (${duplicateGymIdList})
         AND deleted_at IS NULL
       ORDER BY id
    `,
  );

  if (duplicateKiosks.length === 0) {
    return { kioskIds: [], warnings: [] };
  }

  const canonicalSlugs = await executeRows<SlugRow>(
    commandDb,
    sql`
      SELECT slug
        FROM gym_kiosks
       WHERE gym_id = ${canonicalGymId}
         AND deleted_at IS NULL
    `,
  );
  const takenSlugs = new Set(canonicalSlugs.map((row) => row.slug));

  const warnings: MergeWarning[] = [];
  const kioskIds: number[] = [];

  for (const kiosk of duplicateKiosks) {
    let nextSlug = kiosk.slug;
    if (takenSlugs.has(nextSlug)) {
      let suffix = 2;
      while (takenSlugs.has(`${kiosk.slug}-${suffix}`)) {
        suffix += 1;
      }
      nextSlug = `${kiosk.slug}-${suffix}`;
      warnings.push({
        type: 'kiosk_slug_changed',
        kioskUuid: kiosk.uuid,
        kioskName: kiosk.name,
        previousSlug: kiosk.slug,
        newSlug: nextSlug,
      });
    }
    takenSlugs.add(nextSlug);
    await commandDb.execute(sql`
      UPDATE gym_kiosks
         SET gym_id = ${canonicalGymId},
             slug = ${nextSlug},
             updated_at = NOW()
       WHERE id = ${Number(kiosk.id)}
    `);
    kioskIds.push(Number(kiosk.id));
  }

  return { kioskIds, warnings };
}

/**
 * Fold one or more duplicate gyms into an explicitly chosen canonical survivor.
 *
 * Re-points every owned/social/sync row (boards, source aliases, follows,
 * members, claims, kiosks, comments, feed items, notifications, votes), backfills
 * any empty canonical metadata from the duplicates, rebuilds the affected gyms'
 * vote counts, then soft-deletes each duplicate with `merged_into_gym_id` set to
 * the survivor so old uuids/slugs (printed kiosk QRs) resolve to the canonical.
 *
 * The caller supplies the canonical — the admin queue lets a human pick it. Runs
 * every statement on the passed connection, so wrap it in a transaction (and an
 * advisory lock for the batch CLI) at the call site.
 */
export async function mergeGymsIntoCanonical(
  commandDb: MergeExecuteDb,
  canonicalGym: CanonicalGymCandidate,
  duplicateGyms: CanonicalGymCandidate[],
): Promise<MergeResult> {
  if (duplicateGyms.length === 0) {
    return { counts: emptyMergeCounts(), warnings: [], movedRows: emptyMergeMovedRows() };
  }
  if (duplicateGyms.some((duplicate) => duplicate.id === canonicalGym.id)) {
    throw new Error('mergeGymsIntoCanonical: the canonical gym cannot also be a duplicate.');
  }

  const allCandidatesForMetadata = [canonicalGym, ...duplicateGyms].sort(compareCanonicalGymCandidates);
  const duplicateGymIds = idsFromCandidates(duplicateGyms);
  const duplicateGymUuids = uuidsFromCandidates(duplicateGyms);
  const duplicateGymIdList = sqlNumberList(duplicateGymIds);
  const duplicateGymUuidList = sqlTextList(duplicateGymUuids);
  const allGymUuidList = sqlTextList([canonicalGym.uuid, ...duplicateGymUuids]);

  // Backfill only EMPTY canonical metadata from the duplicates. Critically, the
  // canonical's own is_public is left untouched — merging into a user-owned
  // PRIVATE gym must never force-publish it. deleted_at is cleared defensively
  // (the caller always picks a live survivor, so this is a no-op in practice).
  await commandDb.execute(sql`
    UPDATE gyms
       SET address = COALESCE(NULLIF(address, ''), ${pickTextField(allCandidatesForMetadata, 'address')}),
           contact_email = COALESCE(NULLIF(contact_email, ''), ${pickTextField(allCandidatesForMetadata, 'contactEmail')}),
           contact_phone = COALESCE(NULLIF(contact_phone, ''), ${pickTextField(allCandidatesForMetadata, 'contactPhone')}),
           description = COALESCE(NULLIF(description, ''), ${pickTextField(allCandidatesForMetadata, 'description')}),
           image_url = COALESCE(NULLIF(image_url, ''), ${pickTextField(allCandidatesForMetadata, 'imageUrl')}),
           deleted_at = NULL,
           updated_at = NOW()
     WHERE id = ${canonicalGym.id}
  `);

  const boardRows = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE user_boards
           SET gym_id = ${canonicalGym.id},
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  const sourceRows = await executeRows<SourceKeyRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE location_sync_gym_sources
           SET gym_id = ${canonicalGym.id},
               updated_at = NOW()
         WHERE gym_id IN (${duplicateGymIdList})
         RETURNING source_key AS "sourceKey"
      )
      SELECT "sourceKey" FROM moved
    `,
  );

  const followRows = await executeRows<UserIdRow>(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO gym_follows (gym_id, user_id, created_at)
        SELECT ${canonicalGym.id}, user_id, MIN(created_at)
          FROM gym_follows
         WHERE gym_id IN (${duplicateGymIdList})
         GROUP BY user_id
        ON CONFLICT (gym_id, user_id) DO NOTHING
        RETURNING user_id AS "userId"
      )
      SELECT "userId" FROM inserted
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

  // Collapse each user's memberships across the duplicates to their STRONGEST
  // role, and on conflict keep the STRONGER of the canonical's own role and the
  // incoming one. Precedence admin > editor > member on both sides — a twin's
  // editor arrives as editor, and the canonical's existing editor is never
  // rewritten down to member.
  const memberRows = await executeRows<UserIdRow>(
    commandDb,
    sql`
      WITH upserted AS (
        INSERT INTO gym_members (gym_id, user_id, role, created_at)
        SELECT ${canonicalGym.id},
               user_id,
               CASE
                 WHEN bool_or(role = 'admin'::gym_member_role) THEN 'admin'::gym_member_role
                 WHEN bool_or(role = 'editor'::gym_member_role) THEN 'editor'::gym_member_role
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
            WHEN gym_members.role = 'editor'::gym_member_role OR excluded.role = 'editor'::gym_member_role
              THEN 'editor'::gym_member_role
            ELSE 'member'::gym_member_role
          END
        RETURNING user_id AS "userId"
      )
      SELECT "userId" FROM upserted
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

  const { movedClaimIds, expiredClaimIds } = await repointClaims(commandDb, canonicalGym.id, duplicateGymIdList);

  const { kioskIds, warnings } = await repointKiosks(commandDb, canonicalGym.id, duplicateGymIdList);

  const commentRows = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE comments
           SET entity_id = ${canonicalGym.uuid},
               updated_at = NOW()
         WHERE entity_type = 'gym'
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  const feedItemRows = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET entity_id = ${canonicalGym.uuid}
         WHERE entity_type = 'gym'
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  const notificationRows = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE notifications
           SET entity_id = ${canonicalGym.uuid}
         WHERE entity_type = 'gym'
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING id
      )
      SELECT id FROM moved
    `,
  );

  await setVoteCountMaintenanceSkipped(commandDb, true);
  // Vote consolidation is most-recent-wins: when a user voted on both the
  // canonical and a duplicate, their newest vote (by created_at, then id) is the
  // one kept on the survivor. This is the intended merge semantic — a person has
  // one current opinion of the gym, not a sum of stale ones.
  const voteRows = await executeRows<UserIdRow>(
    commandDb,
    sql`
      WITH latest_votes AS (
        SELECT DISTINCT ON (user_id)
               user_id,
               value,
               created_at
          FROM votes
         WHERE entity_type = 'gym'
           AND entity_id IN (${allGymUuidList})
         ORDER BY user_id, created_at DESC, id DESC
      ),
      upserted AS (
        INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
        SELECT user_id,
               'gym',
               ${canonicalGym.uuid},
               value,
               created_at
          FROM latest_votes
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
          SET value = excluded.value,
              created_at = excluded.created_at
        RETURNING user_id AS "userId"
      )
      SELECT "userId" FROM upserted
    `,
  );

  const votesDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM votes
         WHERE entity_type = 'gym'
           AND entity_id IN (${duplicateGymUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );
  await rebuildGymVoteCounts(commandDb, [canonicalGym.uuid, ...duplicateGymUuids]);
  await setVoteCountMaintenanceSkipped(commandDb, false);

  // Point each soft-deleted twin at the survivor so the backend's canonical
  // resolution can follow the pointer — a deduped gym's old uuid/slug (printed
  // kiosk QRs) then redirects to the canonical gym instead of 404ing.
  const softDeletedRows = await executeRows<IdRow>(
    commandDb,
    sql`
      WITH soft_deleted AS (
        UPDATE gyms
           SET is_public = false,
               deleted_at = NOW(),
               merged_into_gym_id = ${canonicalGym.id},
               updated_at = NOW()
         WHERE id IN (${duplicateGymIdList})
         RETURNING id
      )
      SELECT id FROM soft_deleted
    `,
  );

  const movedRows: MergeMovedRows = {
    boardIds: boardRows.map((row) => Number(row.id)),
    sourceKeys: sourceRows.map((row) => row.sourceKey),
    followUserIds: followRows.map((row) => row.userId),
    memberUserIds: memberRows.map((row) => row.userId),
    movedClaimIds,
    expiredClaimIds,
    kioskIds,
    commentIds: commentRows.map((row) => Number(row.id)),
    feedItemIds: feedItemRows.map((row) => Number(row.id)),
    notificationIds: notificationRows.map((row) => Number(row.id)),
    voteUserIds: voteRows.map((row) => row.userId),
    softDeletedGymIds: softDeletedRows.map((row) => Number(row.id)),
  };

  return {
    counts: {
      boardRowsMoved: movedRows.boardIds.length,
      sourceAliasesMoved: movedRows.sourceKeys.length,
      followsInserted: movedRows.followUserIds.length,
      followsDeleted,
      membersInsertedOrUpdated: movedRows.memberUserIds.length,
      membersDeleted,
      claimsMoved: movedRows.movedClaimIds.length,
      claimsExpired: movedRows.expiredClaimIds.length,
      kiosksMoved: movedRows.kioskIds.length,
      commentsMoved: movedRows.commentIds.length,
      feedItemsMoved: movedRows.feedItemIds.length,
      notificationsMoved: movedRows.notificationIds.length,
      votesUpserted: movedRows.voteUserIds.length,
      votesDeleted,
      duplicateGymsSoftDeleted: movedRows.softDeletedGymIds.length,
    },
    warnings,
    movedRows,
  };
}

/**
 * Choose the canonical + duplicate gyms for a cluster using the shared ranking
 * (completeness, then oldest). Used by the CLI dedupe tool, where no human picks
 * the survivor.
 */
export function selectClusterCandidates(cluster: PhysicalGymCluster<CanonicalGymCandidate>): {
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

/**
 * Rule-based cluster merge for the CLI dedupe tool: pick the canonical with the
 * shared ranking, then fold the rest in. The admin queue uses
 * `mergeGymsIntoCanonical` directly with a human-picked survivor.
 */
export async function mergeGymCluster(
  commandDb: MergeExecuteDb,
  cluster: PhysicalGymCluster<CanonicalGymCandidate>,
): Promise<MergeResult> {
  const { canonicalGym, duplicateGyms } = selectClusterCandidates(cluster);
  return mergeGymsIntoCanonical(commandDb, canonicalGym, duplicateGyms);
}

export { SYSTEM_USER_ID as MERGE_SYSTEM_USER_ID };
