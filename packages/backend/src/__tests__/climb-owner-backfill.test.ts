import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import {
  applyClimbOwnerAssignments,
  backfillClimbOwners,
  planClimbOwnerBackfill,
  selectClimbOwnerAssignments,
} from '@boardsesh/db/queries';
import { db } from '../db/client';

// ---------------------------------------------------------------------------
// The climb owner backfill (real Postgres).
//
// A draft or an unlisted climb with no owner is returned to no one. The
// backfill gives an owner to the ones whose setter (the manufacturer account id
// on the row) is linked by exactly one Boardsesh account on that board, through
// a credential row, and leaves every other climb alone. A link through a
// mapping row alone is counted on its own and assigned only when asked for: a
// retired endpoint let any account write one. It must be a no-op by default,
// safe to run twice, and it must never touch a published, listed climb or a
// climb that already has an owner.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'tension';
const OTHER_BOARD = 'decoy';
const LAYOUT_ID = 9;

/** Linked by one account, through a credential and a mapping row. */
const SOLE_SETTER = 770_001;
/**
 * Linked by one account, through a mapping row only. No credential row proves
 * that account ever signed in to it, so it is not assigned by default.
 */
const UNLINKED_SETTER = 770_002;
/** Linked by two accounts. */
const SHARED_SETTER = 770_003;
/** Linked by nobody. */
const UNKNOWN_SETTER = 770_004;

const SOLE_ACCOUNT = 'draft-backfill-sole';
const UNLINKED_ACCOUNT = 'draft-backfill-unlinked';
const SHARED_ACCOUNT_A = 'draft-backfill-shared-a';
const SHARED_ACCOUNT_B = 'draft-backfill-shared-b';
const USERS = [SOLE_ACCOUNT, UNLINKED_ACCOUNT, SHARED_ACCOUNT_A, SHARED_ACCOUNT_B];

type SeedClimb = {
  uuid: string;
  boardType?: string;
  setterId: number | null;
  /** Default: a draft. `null` is the column's third state, which is not a draft. */
  isDraft?: boolean | null;
  /** Default: not listed. */
  isListed?: boolean | null;
  userId?: string;
};

const CLIMBS: SeedClimb[] = [
  // Drafts.
  { uuid: 'backfill-sole-a', setterId: SOLE_SETTER },
  { uuid: 'backfill-sole-b', setterId: SOLE_SETTER },
  { uuid: 'backfill-unlinked', setterId: UNLINKED_SETTER },
  { uuid: 'backfill-shared', setterId: SHARED_SETTER },
  { uuid: 'backfill-unknown', setterId: UNKNOWN_SETTER },
  { uuid: 'backfill-no-setter', setterId: null },
  // The same manufacturer id on another board is another account: ids are per board.
  { uuid: 'backfill-other-board', boardType: OTHER_BOARD, setterId: SOLE_SETTER },
  // Unlisted: published, and not on the list. A NULL draft flag is not a draft
  // and a NULL listed flag is not listed, so both of these are unlisted climbs.
  { uuid: 'backfill-unlisted-sole', setterId: SOLE_SETTER, isDraft: false },
  { uuid: 'backfill-unlisted-null-flags', setterId: SOLE_SETTER, isDraft: null, isListed: null },
  { uuid: 'backfill-unlisted-shared', setterId: SHARED_SETTER, isDraft: false },
  // Public, or already owned. None of these may be written.
  { uuid: 'backfill-published', setterId: SOLE_SETTER, isDraft: false, isListed: true },
  { uuid: 'backfill-already-owned', setterId: SOLE_SETTER, userId: SHARED_ACCOUNT_A },
];

type StoredClimb = { uuid: string; user_id: string | null; sync_seq: string };

async function storedClimbs(): Promise<Map<string, StoredClimb>> {
  const rows = rowsFromResult<StoredClimb>(
    await db.execute(sql`
      SELECT uuid, user_id, sync_seq::text AS sync_seq FROM board_climbs WHERE uuid LIKE 'backfill-%' ORDER BY uuid`),
  );
  return new Map(rows.map((row) => [row.uuid, row]));
}

const ownersOf = (climbs: Map<string, StoredClimb>) =>
  Object.fromEntries([...climbs].map(([uuid, climb]) => [uuid, climb.user_id]));

const UNTOUCHED_OWNERS = {
  'backfill-sole-a': null,
  'backfill-sole-b': null,
  'backfill-unlinked': null,
  'backfill-shared': null,
  'backfill-unknown': null,
  'backfill-no-setter': null,
  'backfill-other-board': null,
  'backfill-unlisted-sole': null,
  'backfill-unlisted-null-flags': null,
  'backfill-unlisted-shared': null,
  'backfill-published': null,
  'backfill-already-owned': SHARED_ACCOUNT_A,
};

const DRAFT_ASSIGNMENTS = {
  'backfill-sole-a': SOLE_ACCOUNT,
  'backfill-sole-b': SOLE_ACCOUNT,
};
/** Only with `includeMappingOnly`. */
const MAPPING_ONLY_ASSIGNMENTS = {
  'backfill-unlinked': UNLINKED_ACCOUNT,
};
const UNLISTED_ASSIGNMENTS = {
  'backfill-unlisted-sole': SOLE_ACCOUNT,
  'backfill-unlisted-null-flags': SOLE_ACCOUNT,
};

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'backfill-%'`);
  await db.execute(sql`DELETE FROM sync_deletions WHERE record_id LIKE 'backfill-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

async function linkCredential(userId: string, boardType: string, auroraUserId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO aurora_credentials (user_id, board_type, aurora_user_id) VALUES (${userId}, ${boardType}, ${auroraUserId})
  `);
}

async function linkMapping(userId: string, boardType: string, boardUserId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_board_mappings (user_id, board_type, board_user_id) VALUES (${userId}, ${boardType}, ${boardUserId})
  `);
}

describeWithDatabase('climb owner backfill (real DB)', () => {
  beforeEach(async () => {
    await removeFixtures();
    for (const userId of USERS) {
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.test`})`,
      );
    }
    // The same account in both link tables is still one account.
    await linkCredential(SOLE_ACCOUNT, BOARD, SOLE_SETTER);
    await linkMapping(SOLE_ACCOUNT, BOARD, SOLE_SETTER);
    await linkMapping(UNLINKED_ACCOUNT, BOARD, UNLINKED_SETTER);
    // Two accounts on one manufacturer account, one in each table.
    await linkCredential(SHARED_ACCOUNT_A, BOARD, SHARED_SETTER);
    await linkMapping(SHARED_ACCOUNT_B, BOARD, SHARED_SETTER);

    for (const climb of CLIMBS) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, setter_id, user_id)
        VALUES (${climb.uuid}, ${climb.boardType ?? BOARD}, ${LAYOUT_ID}, 'Backfill fixture', 'p1r5',
                ${climb.isDraft === undefined ? true : climb.isDraft},
                ${climb.isListed === undefined ? false : climb.isListed}, ${climb.setterId}, ${climb.userId ?? null})
      `);
    }
  });
  afterAll(removeFixtures);

  it('plans each kind by board: one linked account matches, several or none do not', async () => {
    const plan = await planClimbOwnerBackfill(db);
    expect(plan.drafts.byBoardType[BOARD]).toEqual({
      ownerless: 6,
      matched: 2,
      // The setter linked through a mapping row alone: counted, on its own.
      matchedMappingOnly: 1,
      ambiguous: 1,
      noLinkedAccount: 1,
      noSetterId: 1,
    });
    // The other board's draft names a setter id nobody links on THAT board.
    expect(plan.drafts.byBoardType[OTHER_BOARD]).toEqual({
      ownerless: 1,
      matched: 0,
      matchedMappingOnly: 0,
      ambiguous: 0,
      noLinkedAccount: 1,
      noSetterId: 0,
    });
    expect(plan.unlisted.byBoardType[BOARD]).toEqual({
      ownerless: 3,
      matched: 2,
      matchedMappingOnly: 0,
      ambiguous: 1,
      noLinkedAccount: 0,
      noSetterId: 0,
    });
    for (const kind of ['drafts', 'unlisted'] as const) {
      for (const counts of [plan[kind].totals, ...Object.values(plan[kind].byBoardType)]) {
        expect(
          counts.matched + counts.matchedMappingOnly + counts.ambiguous + counts.noLinkedAccount + counts.noSetterId,
        ).toBe(counts.ownerless);
      }
    }
  });

  it('plans one kind or one board when asked', async () => {
    const draftsOnly = await planClimbOwnerBackfill(db, { kinds: ['drafts'] });
    expect(draftsOnly.unlisted.totals.ownerless).toBe(0);
    expect(draftsOnly.drafts.byBoardType[BOARD]?.matched).toBe(2);

    const otherBoard = await planClimbOwnerBackfill(db, { boardType: OTHER_BOARD });
    expect(Object.keys(otherBoard.drafts.byBoardType)).toEqual([OTHER_BOARD]);
    expect(otherBoard.unlisted.byBoardType).toEqual({});
  });

  it('writes nothing unless told to apply', async () => {
    const before = await storedClimbs();
    const result = await backfillClimbOwners(db, { apply: false });
    expect(result.updated).toBe(0);
    expect(result.plan.drafts.byBoardType[BOARD]?.matched).toBe(2);
    // Not a row, and not a cursor position either.
    expect(await storedClimbs()).toEqual(before);
    expect(ownersOf(before)).toEqual(UNTOUCHED_OWNERS);
  });

  it('assigns the matched climbs of both kinds and leaves every other row as it was', async () => {
    const before = await storedClimbs();
    const batches: number[] = [];
    // A batch smaller than the work, so the keyset paging is exercised.
    const result = await backfillClimbOwners(db, {
      apply: true,
      batchSize: 3,
      onBatch: (updatedSoFar) => batches.push(updatedSoFar),
    });
    expect(result.updated).toBe(4);
    expect(batches).toEqual([3, 4]);

    const after = await storedClimbs();
    // The mapping-only draft is not among them: nothing proves its account
    // ever signed in to its setter.
    expect(ownersOf(after)).toEqual({ ...UNTOUCHED_OWNERS, ...DRAFT_ASSIGNMENTS, ...UNLISTED_ASSIGNMENTS });
    for (const [uuid, climb] of after) {
      const wasAssigned = climb.user_id !== before.get(uuid)?.user_id;
      // An assigned row moves its cursor position, which is how it reaches its
      // owner's devices. A row left alone must not move at all.
      expect(Number(climb.sync_seq) > Number(before.get(uuid)?.sync_seq)).toBe(wasAssigned);
    }
  });

  it('assigns a mapping-only match only when the run asks for it', async () => {
    const result = await backfillClimbOwners(db, { apply: true, includeMappingOnly: true });
    expect(result.updated).toBe(5);
    expect(ownersOf(await storedClimbs())).toEqual({
      ...UNTOUCHED_OWNERS,
      ...DRAFT_ASSIGNMENTS,
      ...MAPPING_ONLY_ASSIGNMENTS,
      ...UNLISTED_ASSIGNMENTS,
    });
    // Ambiguity still wins: a mapping beside another account's link is no match.
    expect(ownersOf(await storedClimbs())['backfill-shared']).toBeNull();
  });

  it.each([
    ['drafts', DRAFT_ASSIGNMENTS],
    ['unlisted', UNLISTED_ASSIGNMENTS],
  ] as const)('assigns only %s when asked for that kind', async (kind, assignments) => {
    const result = await backfillClimbOwners(db, { apply: true, kinds: [kind] });
    expect(result.updated).toBe(Object.keys(assignments).length);
    expect(ownersOf(await storedClimbs())).toEqual({ ...UNTOUCHED_OWNERS, ...assignments });
  });

  it('assigns only one board when asked for that board', async () => {
    expect((await backfillClimbOwners(db, { apply: true, boardType: OTHER_BOARD })).updated).toBe(0);
    expect(ownersOf(await storedClimbs())).toEqual(UNTOUCHED_OWNERS);
  });

  it('writes no deletion marker: an assigned climb was not public before and is not after', async () => {
    const markersBefore = rowsFromResult<{ count: string }>(
      await db.execute(sql`SELECT count(*)::text AS count FROM sync_deletions WHERE record_id LIKE 'backfill-%'`),
    );
    await backfillClimbOwners(db, { apply: true });
    const markersAfter = rowsFromResult<{ count: string }>(
      await db.execute(sql`SELECT count(*)::text AS count FROM sync_deletions WHERE record_id LIKE 'backfill-%'`),
    );
    expect(markersAfter).toEqual(markersBefore);
  });

  it('is idempotent: a second run finds nothing to assign and moves nothing', async () => {
    await backfillClimbOwners(db, { apply: true });
    const afterFirstRun = await storedClimbs();

    const secondRun = await backfillClimbOwners(db, { apply: true });
    expect(secondRun.updated).toBe(0);
    expect(secondRun.plan.drafts.byBoardType[BOARD]).toMatchObject({
      ownerless: 4,
      matched: 0,
      matchedMappingOnly: 1,
      ambiguous: 1,
    });
    expect(secondRun.plan.unlisted.byBoardType[BOARD]).toMatchObject({ ownerless: 1, matched: 0, ambiguous: 1 });
    expect(await storedClimbs()).toEqual(afterFirstRun);
  });

  it('re-checks each row where it writes it', async () => {
    const withMappingOnly = { includeMappingOnly: true };
    const assignments = await selectClimbOwnerAssignments(db, {
      afterUuid: null,
      limit: 100,
      kinds: ['drafts'],
      ...withMappingOnly,
    });
    expect(assignments.filter((assignment) => assignment.uuid.startsWith('backfill-'))).toEqual([
      { uuid: 'backfill-sole-a', userId: SOLE_ACCOUNT },
      { uuid: 'backfill-sole-b', userId: SOLE_ACCOUNT },
      { uuid: 'backfill-unlinked', userId: UNLINKED_ACCOUNT },
    ]);

    // Between the read and the write: one draft is published and listed, one
    // gains an owner, and one account is deleted.
    await db.execute(sql`UPDATE board_climbs SET is_draft = false, is_listed = true WHERE uuid = 'backfill-sole-a'`);
    await db.execute(sql`UPDATE board_climbs SET user_id = ${SHARED_ACCOUNT_B} WHERE uuid = 'backfill-sole-b'`);
    await db.execute(sql`DELETE FROM users WHERE id = ${UNLINKED_ACCOUNT}`);

    expect(await applyClimbOwnerAssignments(db, assignments, withMappingOnly)).toBe(0);
    expect(ownersOf(await storedClimbs())).toMatchObject({
      'backfill-sole-a': null,
      'backfill-sole-b': SHARED_ACCOUNT_B,
      'backfill-unlinked': null,
    });
  });

  it('skips a climb whose only proof, the credential row, is gone by the time it is written', async () => {
    const assignments = (
      await selectClimbOwnerAssignments(db, { afterUuid: null, limit: 100, kinds: ['drafts'] })
    ).filter((assignment) => assignment.uuid.startsWith('backfill-'));
    expect(assignments.map((assignment) => assignment.uuid)).toEqual(['backfill-sole-a', 'backfill-sole-b']);

    // Between the read and the write the account's credential is removed and its
    // mapping row stays: the link is mapping-only now.
    await db.execute(sql`DELETE FROM aurora_credentials WHERE user_id = ${SOLE_ACCOUNT} AND board_type = ${BOARD}`);

    expect(await applyClimbOwnerAssignments(db, assignments)).toBe(0);
    expect(ownersOf(await storedClimbs())).toMatchObject({ 'backfill-sole-a': null, 'backfill-sole-b': null });
    // Asked for, a mapping-only link is enough.
    expect(await applyClimbOwnerAssignments(db, assignments, { includeMappingOnly: true })).toBe(2);
  });

  it('skips a climb whose setter is linked by a second account by the time it is written', async () => {
    const withMappingOnly = { includeMappingOnly: true };
    const assignments = await selectClimbOwnerAssignments(db, {
      afterUuid: null,
      limit: 100,
      kinds: ['drafts'],
      ...withMappingOnly,
    });
    const planned = assignments.filter((assignment) => assignment.uuid.startsWith('backfill-'));
    expect(planned.map((assignment) => assignment.uuid)).toEqual([
      'backfill-sole-a',
      'backfill-sole-b',
      'backfill-unlinked',
    ]);

    // Between the read and the write a second account links the same
    // manufacturer account: the match is no longer the only one.
    await linkCredential(SHARED_ACCOUNT_B, BOARD, SOLE_SETTER);

    expect(await applyClimbOwnerAssignments(db, planned, withMappingOnly)).toBe(1);
    expect(ownersOf(await storedClimbs())).toMatchObject({
      'backfill-sole-a': null,
      'backfill-sole-b': null,
      // Its setter still has one linked account.
      'backfill-unlinked': UNLINKED_ACCOUNT,
    });
  });

  it.each(['aurora_credentials', 'user_board_mappings'] as const)(
    'waits for in-flight %s edits before deciding the unique owner',
    async (linkTable) => {
      const writer = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      let assignment: Promise<number> | undefined;
      try {
        await writer.begin(async (transaction) => {
          if (linkTable === 'aurora_credentials') {
            await transaction`
              UPDATE aurora_credentials SET aurora_user_id = ${SOLE_SETTER}
              WHERE user_id = ${SHARED_ACCOUNT_A} AND board_type = ${BOARD}
            `;
          } else {
            await transaction`
              UPDATE user_board_mappings SET board_user_id = ${SOLE_SETTER}
              WHERE user_id = ${SHARED_ACCOUNT_B} AND board_type = ${BOARD}
            `;
          }
          assignment = applyClimbOwnerAssignments(db, [{ uuid: 'backfill-sole-a', userId: SOLE_ACCOUNT }]);
          // Keep errors handled while observing the blocked write transaction.
          void assignment.catch(() => {});
          await expect
            .poll(
              async () => {
                const [lock] = rowsFromResult<{ waiting: boolean }>(
                  await db.execute(sql`
              SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_locks
                WHERE relation = ${`public.${linkTable}`}::regclass
                  AND mode = 'ShareLock' AND NOT granted
              ) AS waiting
            `),
                );
                return lock.waiting;
              },
              { timeout: 5000, interval: 20 },
            )
            .toBe(true);
          // This second link becomes visible only when this transaction commits.
        });
        expect(await assignment).toBe(0);
        expect(ownersOf(await storedClimbs())['backfill-sole-a']).toBeNull();
      } finally {
        await assignment?.catch(() => {});
        await writer.end();
      }
    },
  );
});
