import { and, asc, countDistinct, eq, gt, inArray, isNotNull, min, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraCredentials, userBoardMappings } from '../../schema/auth/mappings';
import { users } from '../../schema/auth/users';
import { boardClimbs } from '../../schema/boards/unified';

/**
 * Give an owner to climbs that are not public and have none.
 *
 * A draft or an unlisted climb is returned to its owner alone, and one with no
 * owner to no one (`publicReferenceClimbSql`). The manufacturer draft import
 * stamps the importing account from now on; this is for the rows written before
 * it did, and for unlisted manufacturer climbs, which never had one. Each of
 * those carries the manufacturer account that set it (`setter_id`). A climb
 * whose setter is linked by exactly ONE Boardsesh account on that board belongs
 * to that account, when the link proves the account controls the setter.
 *
 * Two tables hold links, and they do not prove the same thing:
 *  - `aurora_credentials`: written only by `saveAuroraCredential`, which signs
 *    in to the manufacturer account server-side first. Proof. Such a match is
 *    `matched`, and an apply run assigns it.
 *  - `user_board_mappings`: not always. Until 2026-08-15 (fac5032af2),
 *    `POST /api/internal/user-board-mapping` took the manufacturer user id from
 *    the request body for any signed-in web account and stored it unchecked,
 *    and those rows are still there. Unlinking deletes both rows, so a mapping
 *    with no credential behind it was either never checked or outlived a manual
 *    cleanup. Such a match is `matchedMappingOnly`: counted, and assigned only
 *    when the run asks for it (`includeMappingOnly`). Assigning a forged row
 *    would hand the forger another climber's drafts, readable and publishable.
 *
 * Everything else stays as it is, with no owner and so with no reader:
 *  - the setter id is linked by more than one Boardsesh account, in either
 *    table (links made before duplicate links were refused, or a forged
 *    mapping beside a real link), where picking one would hand a climb to an
 *    account that may not be its setter's;
 *  - no account links the setter id;
 *  - the climb has no setter id at all.
 *
 * A published, listed climb is never touched: it is public whoever owns it.
 */

type BackfillDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The two kinds of climb that are not public. */
export const CLIMB_OWNER_BACKFILL_KINDS = ['drafts', 'unlisted'] as const;
export type ClimbOwnerBackfillKind = (typeof CLIMB_OWNER_BACKFILL_KINDS)[number];

/** How the ownerless climbs of one kind divide up, for one board type or for all of them. */
export type ClimbOwnerBackfillCounts = {
  /** Climbs of this kind with no owner. The five counts below add up to this. */
  ownerless: number;
  /** Exactly one linked account, with a credential row: the rows an apply run assigns. */
  matched: number;
  /**
   * Exactly one linked account, through a mapping row alone. Assigned only when
   * the run asks for it (`includeMappingOnly`); see the file header.
   */
  matchedMappingOnly: number;
  /** More than one linked account. Left alone. */
  ambiguous: number;
  /** No account links the climb's setter id. Left alone. */
  noLinkedAccount: number;
  /** No setter id on the climb. Left alone. */
  noSetterId: number;
};

export type ClimbOwnerBackfillPlan = Record<
  ClimbOwnerBackfillKind,
  { totals: ClimbOwnerBackfillCounts; byBoardType: Record<string, ClimbOwnerBackfillCounts> }
>;

export type ClimbOwnerAssignment = { uuid: string; userId: string };

export type ClimbOwnerBackfillScope = {
  /** Which kinds to plan and assign. Both when omitted. */
  kinds?: readonly ClimbOwnerBackfillKind[];
  /** One board type, or every board when omitted. */
  boardType?: string;
};

/** Which links an apply run accepts as proof. */
export type ClimbOwnerBackfillEvidence = {
  /**
   * Also assign `matchedMappingOnly` climbs: a single account linked through a
   * mapping row with no credential behind it. Off unless asked for, because
   * such a row may have been written for an account that never signed in.
   */
  includeMappingOnly?: boolean;
};

export const CLIMB_OWNER_BACKFILL_BATCH_SIZE = 500;

const ZERO_COUNTS: ClimbOwnerBackfillCounts = {
  ownerless: 0,
  matched: 0,
  matchedMappingOnly: 0,
  ambiguous: 0,
  noLinkedAccount: 0,
  noSetterId: 0,
};

/**
 * One row per manufacturer account that any Boardsesh account links on a board:
 * how many distinct Boardsesh accounts link it, one of them, and whether any of
 * its links is a credential row. The account, and so the credential flag, is
 * only meaningful where the count is 1.
 *
 * Both link tables are read, so a second account in either one makes a setter
 * ambiguous. Only a credential row is proof of sign-in; see the file header.
 */
function setterOwners(db: BackfillDb) {
  const linkedAccounts = db
    .select({
      boardType: auroraCredentials.boardType,
      boardUserId: sql<number>`${auroraCredentials.auroraUserId}`.as('board_user_id'),
      userId: auroraCredentials.userId,
      viaCredential: sql<boolean>`true`.as('via_credential'),
    })
    .from(auroraCredentials)
    .where(isNotNull(auroraCredentials.auroraUserId))
    .union(
      db
        .select({
          boardType: userBoardMappings.boardType,
          boardUserId: sql<number>`${userBoardMappings.boardUserId}`.as('board_user_id'),
          userId: userBoardMappings.userId,
          viaCredential: sql<boolean>`false`.as('via_credential'),
        })
        .from(userBoardMappings)
        .where(isNotNull(userBoardMappings.boardUserId)),
    )
    .as('linked_account');

  return db
    .select({
      boardType: linkedAccounts.boardType,
      boardUserId: linkedAccounts.boardUserId,
      accountCount: countDistinct(linkedAccounts.userId).as('account_count'),
      userId: min(linkedAccounts.userId).as('owner_user_id'),
      hasCredential: sql<boolean>`bool_or(${linkedAccounts.viaCredential})`.as('has_credential'),
    })
    .from(linkedAccounts)
    .groupBy(linkedAccounts.boardType, linkedAccounts.boardUserId)
    .as('setter_owner');
}

/** The single linked account counts as proof: a credential row, or a mapping when the run asks for those too. */
function acceptedEvidence(owners: ReturnType<typeof setterOwners>, evidence: ClimbOwnerBackfillEvidence): SQL {
  return evidence.includeMappingOnly === true ? sql`TRUE` : sql`${owners.hasCredential} IS TRUE`;
}

/**
 * The row test of each kind. Together they are exactly the complement of the
 * public test (`is_draft IS NOT TRUE AND is_listed IS TRUE`), split in two, and
 * both are two-valued: `is_draft` and `is_listed` are nullable, NULL is not a
 * draft, and only TRUE is listed.
 */
const KIND_CONDITION: Record<ClimbOwnerBackfillKind, SQL> = {
  drafts: sql`${boardClimbs.isDraft} IS TRUE`,
  unlisted: sql`(${boardClimbs.isDraft} IS NOT TRUE AND ${boardClimbs.isListed} IS NOT TRUE)`,
};

const hasNoOwner = sql`${boardClimbs.userId} IS NULL`;

function scopedKinds(scope: ClimbOwnerBackfillScope): readonly ClimbOwnerBackfillKind[] {
  return scope.kinds && scope.kinds.length > 0 ? scope.kinds : CLIMB_OWNER_BACKFILL_KINDS;
}

/** The ownerless climbs an apply run may touch: of a requested kind, on the requested board. */
function ownerlessInScope(scope: ClimbOwnerBackfillScope): SQL {
  const ofRequestedKind = sql.join(
    scopedKinds(scope).map((kind) => KIND_CONDITION[kind]),
    sql` OR `,
  );
  const onBoard = scope.boardType === undefined ? sql`TRUE` : sql`${boardClimbs.boardType} = ${scope.boardType}`;
  return sql`(${hasNoOwner} AND (${ofRequestedKind}) AND ${onBoard})`;
}

/**
 * Count what an apply run would do, without writing. Reads the ownerless
 * non-public climbs once.
 */
export async function planClimbOwnerBackfill(
  db: BackfillDb,
  scope: ClimbOwnerBackfillScope = {},
): Promise<ClimbOwnerBackfillPlan> {
  const owners = setterOwners(db);
  const isDraft = KIND_CONDITION.drafts;
  const rows = await db
    .select({
      boardType: boardClimbs.boardType,
      isDraft: sql<boolean>`${isDraft}`.as('is_draft_kind'),
      ownerless: sql<number>`count(*)::int`,
      matched: sql<number>`count(*) FILTER (WHERE ${owners.accountCount} = 1 AND ${owners.hasCredential} IS TRUE)::int`,
      matchedMappingOnly: sql<number>`count(*) FILTER (WHERE ${owners.accountCount} = 1 AND ${owners.hasCredential} IS NOT TRUE)::int`,
      ambiguous: sql<number>`count(*) FILTER (WHERE ${owners.accountCount} > 1)::int`,
      noLinkedAccount: sql<number>`count(*) FILTER (WHERE ${boardClimbs.setterId} IS NOT NULL AND ${owners.accountCount} IS NULL)::int`,
      noSetterId: sql<number>`count(*) FILTER (WHERE ${boardClimbs.setterId} IS NULL)::int`,
    })
    .from(boardClimbs)
    .leftJoin(owners, and(eq(owners.boardType, boardClimbs.boardType), eq(owners.boardUserId, boardClimbs.setterId)))
    .where(ownerlessInScope(scope))
    .groupBy(boardClimbs.boardType, sql`${isDraft}`);

  const plan: ClimbOwnerBackfillPlan = {
    drafts: { totals: { ...ZERO_COUNTS }, byBoardType: {} },
    unlisted: { totals: { ...ZERO_COUNTS }, byBoardType: {} },
  };
  for (const row of rows) {
    const kindPlan = plan[row.isDraft ? 'drafts' : 'unlisted'];
    const boardCounts = (kindPlan.byBoardType[row.boardType] ??= { ...ZERO_COUNTS });
    for (const counts of [kindPlan.totals, boardCounts]) {
      counts.ownerless += row.ownerless;
      counts.matched += row.matched;
      counts.matchedMappingOnly += row.matchedMappingOnly;
      counts.ambiguous += row.ambiguous;
      counts.noLinkedAccount += row.noLinkedAccount;
      counts.noSetterId += row.noSetterId;
    }
  }
  return plan;
}

/**
 * The next page of climbs an apply run assigns, and the account each goes to,
 * in uuid order after `afterUuid`. Keyset rather than offset: an assigned row
 * stops matching, so an offset would skip a page's worth of rows every batch.
 */
export async function selectClimbOwnerAssignments(
  db: BackfillDb,
  params: { afterUuid: string | null; limit: number } & ClimbOwnerBackfillScope & ClimbOwnerBackfillEvidence,
): Promise<ClimbOwnerAssignment[]> {
  const owners = setterOwners(db);
  const rows = await db
    .select({ uuid: boardClimbs.uuid, userId: owners.userId })
    .from(boardClimbs)
    .innerJoin(owners, and(eq(owners.boardType, boardClimbs.boardType), eq(owners.boardUserId, boardClimbs.setterId)))
    .where(
      and(
        ownerlessInScope(params),
        eq(owners.accountCount, 1),
        acceptedEvidence(owners, params),
        params.afterUuid === null ? undefined : gt(boardClimbs.uuid, params.afterUuid),
      ),
    )
    .orderBy(asc(boardClimbs.uuid))
    .limit(params.limit);
  return rows.flatMap((row) => (row.userId === null ? [] : [{ uuid: row.uuid, userId: row.userId }]));
}

/**
 * Assign one bounded batch in a transaction. Returns how many rows it wrote.
 *
 * The row is re-checked where it is written: still without an owner, still not
 * public, the account still exists, it is still the one account that links the
 * climb's setter, and that link is still accepted evidence (a credential row,
 * unless `includeMappingOnly`). So a row that gained an owner, was published,
 * lost its account, whose setter was linked by a second account, or whose
 * credential went since the page was read is skipped, and running the same
 * batch twice writes nothing the second time.
 *
 * Each written row fires `trg_board_climbs_set_sync_fields`, which moves its
 * `updated_at` and `sync_seq`. That is wanted: it is how the row reaches its
 * owner's devices on their next pull. No other device is sent it, and no
 * deletion marker is written: the row was not public before and is not after.
 */
export async function applyClimbOwnerAssignments(
  db: BackfillDb,
  assignments: ClimbOwnerAssignment[],
  evidence: ClimbOwnerBackfillEvidence = {},
): Promise<number> {
  if (assignments.length === 0) return 0;
  return db.transaction(
    async (transaction) => {
      // SHARE conflicts with every link-table writer, including unlink and
      // maintenance paths that do not take the backend advisory link lock. Wait
      // before taking the UPDATE snapshot, then retain both fences through commit.
      // This maintenance-only lock is released after each bounded batch.
      await transaction.execute(sql`LOCK TABLE public.aurora_credentials, public.user_board_mappings IN SHARE MODE`);
      const ownerByUuid = sql.join(
        assignments.map((assignment) => sql`WHEN ${assignment.uuid} THEN ${assignment.userId}`),
        sql` `,
      );
      const assignedOwner = sql`CASE ${boardClimbs.uuid} ${ownerByUuid} END`;
      const accountIds = [...new Set(assignments.map((assignment) => assignment.userId))];
      const existingAccounts = transaction.select({ id: users.id }).from(users).where(inArray(users.id, accountIds));
      // The match the page was read with, made again on the row being written. The
      // climb's columns are named with their table: inside the subquery a bare
      // `board_type` would be the link's own.
      const owners = setterOwners(transaction);
      const stillTheOnlyLinkedAccount = sql`EXISTS (
      SELECT 1 FROM ${owners}
      WHERE ${owners.boardType} = ${sql.raw('board_climbs.board_type')}
        AND ${owners.boardUserId} = ${sql.raw('board_climbs.setter_id')}
        AND ${owners.accountCount} = 1
        AND ${owners.userId} = ${assignedOwner}
        AND ${acceptedEvidence(owners, evidence)}
    )`;
      const written = await transaction
        .update(boardClimbs)
        .set({ userId: assignedOwner })
        .where(
          and(
            inArray(
              boardClimbs.uuid,
              assignments.map((assignment) => assignment.uuid),
            ),
            ownerlessInScope({}),
            inArray(assignedOwner, existingAccounts),
            stillTheOnlyLinkedAccount,
          ),
        )
        .returning({ uuid: boardClimbs.uuid });
      return written.length;
    },
    { isolationLevel: 'read committed' },
  );
}

export type ClimbOwnerBackfillResult = {
  plan: ClimbOwnerBackfillPlan;
  /** Rows written. Always 0 unless `apply` was set. */
  updated: number;
};

/**
 * Plan, and when `apply` is set, assign every matched climb in batches. Each
 * batch is its own transaction, so no lock is held across batches and a run that
 * stops part-way leaves a valid state that the next run finishes.
 */
export async function backfillClimbOwners(
  db: BackfillDb,
  options: {
    apply: boolean;
    batchSize?: number;
    onBatch?: (updatedSoFar: number) => void;
  } & ClimbOwnerBackfillScope &
    ClimbOwnerBackfillEvidence,
): Promise<ClimbOwnerBackfillResult> {
  const scope: ClimbOwnerBackfillScope = { kinds: options.kinds, boardType: options.boardType };
  const evidence: ClimbOwnerBackfillEvidence = { includeMappingOnly: options.includeMappingOnly === true };
  const plan = await planClimbOwnerBackfill(db, scope);
  if (!options.apply) return { plan, updated: 0 };

  const batchSize = options.batchSize ?? CLIMB_OWNER_BACKFILL_BATCH_SIZE;
  let updated = 0;
  let afterUuid: string | null = null;
  for (;;) {
    const assignments = await selectClimbOwnerAssignments(db, { ...scope, ...evidence, afterUuid, limit: batchSize });
    if (assignments.length === 0) break;
    updated += await applyClimbOwnerAssignments(db, assignments, evidence);
    options.onBatch?.(updated);
    afterUuid = assignments[assignments.length - 1].uuid;
    if (assignments.length < batchSize) break;
  }
  return { plan, updated };
}
