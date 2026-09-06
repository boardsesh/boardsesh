import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql, type SQL } from 'drizzle-orm';
import { applyAuroraAscents } from '@boardsesh/aurora-sync/apply-user-logbook';
import { acquireUserTickMutationLock } from '@boardsesh/db/queries';
import { applyLogs, type PowerSyncOp } from '@boardsesh/kilter-sync';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const mutationSideEffects = vi.hoisted(() => ({
  invalidateRecentBetaLinksCache: vi.fn(() => Promise.resolve()),
  publishDebouncedSessionStats: vi.fn(),
  queueBoardStatsPublish: vi.fn(),
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));

vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: mutationSideEffects.queueClimbStatsRecompute,
  recomputeClimbStatsNow: mutationSideEffects.recomputeClimbStatsNow,
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({
  queueBoardStatsPublish: mutationSideEffects.queueBoardStatsPublish,
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: mutationSideEffects.publishDebouncedSessionStats,
}));
vi.mock('../graphql/resolvers/beta-videos/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graphql/resolvers/beta-videos/queries')>()),
  invalidateRecentBetaLinksCache: mutationSideEffects.invalidateRecentBetaLinksCache,
}));
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { tickQueries } from '../graphql/resolvers/ticks/queries';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { setupWorkerDatabase } from './worker-db';

/**
 * #3535 — Aurora itself stores some ascents two-to-four times, each copy with
 * its own real upstream uuid, so the aurora_id-keyed pull imports every copy as
 * its own tick and the climber's logbook shows one send 2-4×.
 *
 * These run against the real worker Postgres because the fix IS a SQL
 * predicate: a stub that re-states the condition in JS would assert its own
 * copy of the rule and stay green through any change to the shipped SQL.
 *
 * Revert `notAuroraTwinDuplicate` out of the resolvers and the collapse,
 * survivor-stability, tombstone-promotion and second-cycle read assertions all
 * fail; loosen the rule to day granularity or drop a payload column from it and
 * the "keeps genuinely different sends" cases fail.
 */

const USER_ID = 'twin3535-user';
const BOARD = 'tension';
const CLIMB_UUID = 'twin3535-climb-uuid';
const CLIMB_NAME = 'Twin Test Climb';
const ANGLE = 40;
// Millisecond-precision instant: the twins share it exactly.
const CLIMBED_AT = '2026-05-01T18:22:37.000Z';
const LOCK_WAIT_TIMEOUT_MS = 4_000;
const LOCK_WAIT_POLL_INTERVAL_MS = 20;

type TickOverrides = Partial<typeof dbSchema.boardseshTicks.$inferInsert>;

function rowsOf<Row>(result: unknown): Row[] {
  return Array.from(result as Iterable<Row>);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Proves that a second connection is actually waiting for the transaction
 * holding a user lock. A fixed delay only proves that the scheduler happened
 * not to run the contender yet, which made these serialization tests flaky.
 */
async function waitForContenderToBlockOn(holderBackendPid: number, contender: Promise<unknown>): Promise<void> {
  let stopPolling = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const contenderSettledEarly = contender.then(
    () => {
      throw new Error('The lock contender settled before PostgreSQL reported its wait');
    },
    (error: unknown) => {
      throw new Error('The lock contender rejected before PostgreSQL reported its wait', { cause: error });
    },
  );
  const observedWait = (async () => {
    while (!stopPolling) {
      const result = await db.execute(sql`
        SELECT waiting.pid
        FROM pg_locks AS waiting
        JOIN pg_locks AS held
          ON held.pid = ${holderBackendPid}
         AND held.locktype = 'advisory'
         AND held.granted = true
         AND held.database IS NOT DISTINCT FROM waiting.database
         AND held.classid IS NOT DISTINCT FROM waiting.classid
         AND held.objid IS NOT DISTINCT FROM waiting.objid
         AND held.objsubid IS NOT DISTINCT FROM waiting.objsubid
        JOIN pg_stat_activity AS activity ON activity.pid = waiting.pid
        WHERE waiting.locktype = 'advisory'
          AND waiting.granted = false
          AND activity.datname = current_database()
          AND activity.wait_event_type = 'Lock'
          AND activity.wait_event = 'advisory'
          AND ${holderBackendPid} = ANY(pg_blocking_pids(activity.pid))
      `);
      if (rowsOf<{ pid: number }>(result).length > 0) return;
      await delay(LOCK_WAIT_POLL_INTERVAL_MS);
    }
  })();
  const hangGuard = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${LOCK_WAIT_TIMEOUT_MS}ms waiting for a contender blocked by PostgreSQL backend ${holderBackendPid}`,
        ),
      );
    }, LOCK_WAIT_TIMEOUT_MS);
  });

  try {
    await Promise.race([observedWait, contenderSettledEarly, hangGuard]);
  } finally {
    stopPolling = true;
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function verifyContentionAndRelease(params: {
  holderBackendPid: number;
  holder: Promise<unknown>;
  contender: Promise<unknown>;
  releaseHolder: () => void;
}): Promise<void> {
  const { holderBackendPid, holder, contender, releaseHolder } = params;
  let observationFailure: { error: unknown } | undefined;
  try {
    await waitForContenderToBlockOn(holderBackendPid, contender);
  } catch (error: unknown) {
    observationFailure = { error };
  } finally {
    releaseHolder();
  }

  const operationResults = await Promise.allSettled([holder, contender]);
  if (observationFailure) throw observationFailure.error;

  const operationFailures = operationResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (operationFailures.length === 1) throw operationFailures[0];
  if (operationFailures.length > 1) {
    throw new AggregateError(operationFailures, 'The lock holder and contender both rejected');
  }
}

/** Stable ordering for assertions; a native tick's NULL aurora_id sorts last. */
function byAuroraId(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

let tickSeq = 0;

async function insertTick(overrides: TickOverrides = {}): Promise<string> {
  tickSeq += 1;
  const uuid = overrides.uuid ?? `twin3535-tick-${tickSeq}`;
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId: USER_ID,
    boardType: BOARD,
    climbUuid: CLIMB_UUID,
    angle: ANGLE,
    isMirror: false,
    origin: 'aurora_pull',
    status: 'send',
    attemptCount: 2,
    quality: 3,
    difficulty: 21,
    isBenchmark: false,
    comment: 'crimpy',
    climbedAt: CLIMBED_AT,
    auroraType: 'ascents',
    // The pull writes updated_at and aurora_synced_at from one `now()`, so a
    // freshly pulled row is never "locally edited". Leaving updated_at on its
    // defaultNow() would make every seeded row look edited and silently switch
    // off the payload comparison these tests exercise.
    updatedAt: CLIMBED_AT,
    auroraSyncedAt: CLIMBED_AT,
    ...overrides,
  });
  return uuid;
}

const authenticatedContext: ConnectionContext = {
  connectionId: 'aurora-twin-mutation-test',
  transport: 'ws',
  isAuthenticated: true,
  userId: USER_ID,
};

/** aurora_ids the public per-user tick list (the You page's source) shows. */
async function visibleAuroraIds(): Promise<Array<string | null>> {
  const rows = (await tickQueries.userTicks(null, { userId: USER_ID, boardType: BOARD })) as Array<{
    auroraId: string | null;
  }>;
  return rows.map((row) => row.auroraId).sort(byAuroraId);
}

/** Rows actually stored, regardless of what the read paths show. */
async function storedAuroraIds(): Promise<string[]> {
  const rows = await db
    .select({ auroraId: dbSchema.boardseshTicks.auroraId })
    .from(dbSchema.boardseshTicks)
    .where(sql`user_id = ${USER_ID}`);
  return rows.map((row) => row.auroraId ?? '').sort(byAuroraId);
}

async function feedTotalCount(): Promise<number> {
  const feed = await tickQueries.userAscentsFeed(null, { userId: USER_ID, input: { boardType: BOARD } });
  return feed.totalCount;
}

beforeAll(async () => {
  await setupWorkerDatabase();
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Twin Tester', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${CLIMB_UUID}, ${BOARD}, 1, 'test-setter', ${CLIMB_NAME}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
});

afterEach(async () => {
  await db.execute(sql`
    DELETE FROM notifications
    WHERE entity_id LIKE 'twin3535-tick-%'
       OR comment_id IN (SELECT id FROM comments WHERE entity_id LIKE 'twin3535-tick-%')
  `);
  await db.execute(sql`DELETE FROM feed_items WHERE entity_id LIKE 'twin3535-tick-%'`);
  await db.execute(sql`DELETE FROM votes WHERE entity_id LIKE 'twin3535-tick-%'`);
  await db.execute(sql`DELETE FROM vote_counts WHERE entity_id LIKE 'twin3535-tick-%'`);
  await db.execute(sql`DELETE FROM comments WHERE entity_id LIKE 'twin3535-tick-%'`);
  await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id IN (${USER_ID}, ${USER_ID + '-foreign'})`);
  await db.execute(sql`DELETE FROM board_sessions WHERE id LIKE 'twin3535-session-%'`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE 'twin3535-board-%'`);
  await db.execute(sql`DELETE FROM sync_deletions WHERE user_id IN (${USER_ID}, ${USER_ID + '-foreign'})`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID + '-foreign'}`);
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The predicate is a SQL restatement of `payloadDiffersFromStored`'s column
 * list, and nothing in the type system pins the two together. Add a
 * user-visible column to the pull's comparison — the natural place to add one —
 * and the predicate would keep collapsing rows that now differ in it, hiding a
 * real ascent with no other test going red. This is the guard for that.
 */
describe('#3535 payload column list stays in step with the pull', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  function sourceOf(relativePath: string): string {
    return readFileSync(repoRoot + relativePath, 'utf8');
  }

  function bodyBetween(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `missing marker ${startMarker}`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start);
    expect(end, `missing marker ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('compares every column payloadDiffersFromStored compares', () => {
    const pullBody = bodyBetween(
      sourceOf('packages/aurora-sync/src/sync/apply-user-logbook.ts'),
      'function payloadDiffersFromStored',
      '\n}',
    );
    const predicateBody = bodyBetween(
      sourceOf('packages/db/src/queries/ticks/aurora-twin-dedup.ts'),
      'export function isDirectAuroraTwin',
      '\n}',
    );

    const pullColumns = new Set(Array.from(pullBody.matchAll(/\bstored\.(\w+)/g), (match) => match[1]));
    const predicateColumns = new Set(
      Array.from(predicateBody.matchAll(/\b(?:smaller|larger)\.(\w+)/g), (match) => match[1]),
    );

    // Sanity-check the extraction itself before trusting the comparison.
    expect(pullColumns.size).toBeGreaterThanOrEqual(10);

    const missing = [...pullColumns].filter((column) => !predicateColumns.has(column)).sort();
    expect(missing, 'columns the pull compares but the twin predicate ignores').toEqual([]);
  });
});

describe('#3535 Aurora-side duplicate ascents', () => {
  it('shows one tick per twin group and keeps the lowest aurora_id', async () => {
    await insertTick({ auroraId: 'aur-3' });
    await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });

    expect(await storedAuroraIds()).toEqual(['aur-1', 'aur-2', 'aur-3']);
    expect(await visibleAuroraIds()).toEqual(['aur-1']);
    expect(await feedTotalCount()).toBe(1);

    const counts = await tickQueries.userTickCountsByBoard(null, { userId: USER_ID });
    expect(counts).toEqual([{ boardType: BOARD, count: 1 }]);
  });

  it('collapses the authenticated `ticks` query too', async () => {
    await insertTick({ auroraId: 'aur-2' });
    await insertTick({ auroraId: 'aur-1' });

    // The mobile/web client read, keyed on the connection's own user.
    const authenticatedContext = { userId: USER_ID, isAuthenticated: true } as unknown as Parameters<
      typeof tickQueries.ticks
    >[2];
    const rows = (await tickQueries.ticks(null, { input: { boardType: BOARD } }, authenticatedContext)) as Array<{
      auroraId: string | null;
    }>;

    expect(rows.map((row) => row.auroraId)).toEqual(['aur-1']);
  });

  it('picks the same survivor whatever order the payload arrived in', async () => {
    await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });
    await insertTick({ auroraId: 'aur-3' });

    // created_at is not the tiebreak: here the smallest aurora_id is also the
    // OLDEST row, in the previous test it was the newest, and both give aur-1.
    expect(await visibleAuroraIds()).toEqual(['aur-1']);
  });

  it('collapses the grouped (per-day) feed to one entry too', async () => {
    await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });

    const grouped = (await tickQueries.userGroupedAscentsFeed(null, {
      userId: USER_ID,
      input: { boardType: BOARD },
    })) as { groups: Array<{ items: unknown[]; sendCount: number }>; totalCount: number };

    expect(grouped.totalCount).toBe(1);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0].items).toHaveLength(1);
    // The per-group tally is built from the same fetch, so it counts once too.
    expect(grouped.groups[0].sendCount).toBe(1);
  });

  const differingPayloads: Array<[string, TickOverrides]> = [
    ['comment', { comment: 'different beta' }],
    ['quality', { quality: 5 }],
    ['difficulty', { difficulty: 22 }],
    ['is_mirror', { isMirror: true }],
    ['attempt_count', { attemptCount: 7 }],
    ['status', { status: 'flash' }],
    ['is_benchmark', { isBenchmark: true }],
  ];

  for (const [field, overrides] of differingPayloads) {
    it(`keeps both sends when they differ in ${field}`, async () => {
      await insertTick({ auroraId: 'aur-1' });
      await insertTick({ auroraId: 'aur-2', ...overrides });

      expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
      expect(await feedTotalCount()).toBe(2);
    });
  }

  it('keeps two sends logged one millisecond apart (no tolerance window)', async () => {
    await insertTick({ auroraId: 'aur-1', climbedAt: '2026-05-01T18:22:37.000Z' });
    await insertTick({ auroraId: 'aur-2', climbedAt: '2026-05-01T18:22:37.001Z' });

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
  });

  it('keeps two sends of the same climb on the same day', async () => {
    await insertTick({ auroraId: 'aur-1', climbedAt: '2026-05-01T09:00:00.000Z' });
    await insertTick({ auroraId: 'aur-2', climbedAt: '2026-05-01T19:30:00.000Z' });

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
  });

  it('never hides a native tick, and is never hidden by one', async () => {
    await insertTick({ auroraId: null, origin: 'native', auroraType: null, auroraSyncedAt: null });
    await insertTick({ auroraId: 'aur-2' });

    // byAuroraId puts the native row's NULL aurora_id last.
    expect(await visibleAuroraIds()).toEqual(['aur-2', null]);
  });

  it('never treats a json-import surrogate id as a real Aurora twin', async () => {
    await insertTick({ auroraId: 'json-import-aaa', origin: 'json_import' });
    await insertTick({ auroraId: 'zzz-real-aurora-id' });

    expect(await visibleAuroraIds()).toEqual(['json-import-aaa', 'zzz-real-aurora-id']);
  });

  it('never hides a second real Kilter link', async () => {
    await insertTick({ auroraId: 'aur-1', kilterId: 'kil-1' });
    await insertTick({ auroraId: 'aur-2', kilterId: 'kil-2' });

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
  });

  it('promotes the next id when Aurora tombstones the survivor', async () => {
    await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });
    await insertTick({ auroraId: 'aur-3' });
    expect(await visibleAuroraIds()).toEqual(['aur-1']);

    // The tombstone path deletes the pull-owned row for that aurora_id.
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE aurora_id = 'aur-1'`);

    expect(await visibleAuroraIds()).toEqual(['aur-2']);
    expect(await feedTotalCount()).toBe(1);
  });

  /**
   * Editing the one visible tick drifts its payload away from the twins it is
   * hiding. `isLocallyEdited` then makes every later pull skip that row, so
   * payload parity is never restored and a strict payload rule would resurrect
   * the duplicates permanently — making it look like rating a send created
   * them. `updateTick` fans visible direct twins out as one logical ascent, so
   * the predicate must continue to absorb the local edit on its survivor.
   */
  const localEdits: Array<[string, SQL]> = [
    ['rated', sql`quality = 5`],
    ['commented on', sql`comment = 'new beta'`],
    ['re-graded', sql`difficulty = 24`],
  ];

  for (const [action, assignment] of localEdits) {
    it(`stays collapsed after the visible tick is ${action}`, async () => {
      await insertTick({ auroraId: 'aur-1' });
      await insertTick({ auroraId: 'aur-2' });
      await insertTick({ auroraId: 'aur-3' });
      expect(await visibleAuroraIds()).toEqual(['aur-1']);

      // What updateTick does: writes the column and bumps updated_at past
      // aurora_synced_at.
      await db.execute(sql`UPDATE boardsesh_ticks SET ${assignment}, updated_at = now() WHERE aurora_id = ${'aur-1'}`);

      expect(await visibleAuroraIds()).toEqual(['aur-1']);
      expect(await feedTotalCount()).toBe(1);
    });
  }

  it('surfaces a hidden twin that itself diverges, rather than swallowing the change', async () => {
    await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });
    expect(await visibleAuroraIds()).toEqual(['aur-1']);

    // Only the SURVIVOR's local edits relax the payload rule. A hidden row that
    // diverges is a deliberate difference and must not be silently absorbed.
    await db.execute(
      sql`UPDATE boardsesh_ticks SET comment = 'other beta', updated_at = now() WHERE aurora_id = 'aur-2'`,
    );

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
  });

  it('keeps a logged attempt beside a send at the same instant, even once the attempt is edited', async () => {
    // Aurora's bids land in the same table as its ascents. `status` and
    // `aurora_type` sit outside the locally-edited relaxation precisely so an
    // edit on the smaller-id row can never let a send absorb a real attempt.
    await insertTick({ auroraId: 'aur-1', status: 'attempt', auroraType: 'bids', difficulty: null });
    await insertTick({ auroraId: 'aur-2' });
    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);

    await db.execute(sql`UPDATE boardsesh_ticks SET quality = 5, updated_at = now() WHERE aurora_id = 'aur-1'`);

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
    expect(await feedTotalCount()).toBe(2);
  });

  it('keeps a bids row beside an ascents row that matches it in every other column', async () => {
    await insertTick({ auroraId: 'aur-1', auroraType: 'bids' });
    await insertTick({ auroraId: 'aur-2', auroraType: 'ascents' });

    expect(await visibleAuroraIds()).toEqual(['aur-1', 'aur-2']);
  });

  it('fans angle and date edits across direct twins so the logical ascent stays one visible row', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });
    expect(await visibleAuroraIds()).toEqual(['aur-1']);

    await tickMutations.updateTick(
      null,
      { uuid: survivorUuid, input: { angle: ANGLE + 5, climbedAt: '2026-05-02T01:02:03-07:00' } },
      authenticatedContext,
    );

    const rows = await db.execute(sql`
      SELECT angle, climbed_at::text AS climbed_at
      FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      expect.objectContaining({ angle: ANGLE + 5, climbed_at: '2026-05-02 08:02:03' }),
      expect.objectContaining({ angle: ANGLE + 5, climbed_at: '2026-05-02 08:02:03' }),
    ]);
    expect(await visibleAuroraIds()).toEqual(['aur-1']);
  });

  it('preserves six climbedAt fractional digits while normalizing its offset across direct twins', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1' });
    await insertTick({ auroraId: 'aur-2' });

    await tickMutations.updateTick(
      null,
      { uuid: survivorUuid, input: { climbedAt: '2026-05-02T01:02:03.123456-07:00' } },
      authenticatedContext,
    );

    const rows = await db.execute(sql`
      SELECT climbed_at::text AS climbed_at
      FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([{ climbed_at: '2026-05-02 08:02:03.123456' }, { climbed_at: '2026-05-02 08:02:03.123456' }]);
  });

  it('moves beta links for every edited member, invalidates once, and recomputes distinct old/new keys', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1' });
    const twinUuid = await insertTick({ auroraId: 'aur-2' });
    await db.insert(dbSchema.boardBetaLinks).values(
      [survivorUuid, twinUuid].map((tickUuid) => ({
        boardType: BOARD,
        climbUuid: CLIMB_UUID,
        link: `https://example.com/angle-${tickUuid}`,
        tickUuid,
        angle: ANGLE,
      })),
    );

    await tickMutations.updateTick(null, { uuid: survivorUuid, input: { angle: 45 } }, authenticatedContext);

    const betaRows = await db.execute(sql`
      SELECT angle FROM board_beta_links WHERE climb_uuid = ${CLIMB_UUID} ORDER BY link
    `);
    expect(betaRows).toEqual([{ angle: 45 }, { angle: 45 }]);
    expect(mutationSideEffects.invalidateRecentBetaLinksCache).toHaveBeenCalledTimes(1);
    expect(mutationSideEffects.queueClimbStatsRecompute.mock.calls).toEqual([
      [BOARD, CLIMB_UUID, ANGLE],
      [BOARD, CLIMB_UUID, 45],
    ]);
  });

  it('deletes every direct twin when the visible survivor is deleted', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1' });
    const twinUuid = await insertTick({ auroraId: 'aur-2' });
    expect(await visibleAuroraIds()).toEqual(['aur-1']);

    await tickMutations.deleteTick(null, { uuid: survivorUuid }, authenticatedContext);

    expect(await storedAuroraIds()).toEqual([]);
    const tombstones = await db.execute(sql`
      SELECT record_id FROM sync_deletions
      WHERE table_name = 'boardsesh_ticks' AND user_id = ${USER_ID}
        AND record_id IN (${survivorUuid}, ${twinUuid})
      ORDER BY record_id
    `);
    expect(tombstones).toEqual([{ record_id: survivorUuid }, { record_id: twinUuid }]);
  });

  it('cleans every twin dependent, preserves beta rows, and fans session/board side effects out once each', async () => {
    const boardRows = await db
      .insert(dbSchema.userBoards)
      .values([
        {
          uuid: 'twin3535-board-a',
          slug: 'twin3535-board-a',
          ownerId: USER_ID,
          boardType: BOARD,
          layoutId: 1,
          sizeId: 1,
          setIds: '1',
          name: 'Twin board A',
          angle: ANGLE,
        },
        {
          uuid: 'twin3535-board-b',
          slug: 'twin3535-board-b',
          ownerId: USER_ID,
          boardType: BOARD,
          layoutId: 2,
          sizeId: 1,
          setIds: '1',
          name: 'Twin board B',
          angle: ANGLE,
        },
      ])
      .returning({ id: dbSchema.userBoards.id });
    await db.insert(dbSchema.boardSessions).values([
      { id: 'twin3535-session-a', boardPath: '/tension/1/1/1/40', lastActivity: new Date('2020-01-01') },
      { id: 'twin3535-session-b', boardPath: '/tension/2/1/1/40', lastActivity: new Date('2020-01-01') },
    ]);

    const survivorUuid = await insertTick({
      auroraId: 'aur-1',
      boardId: boardRows[0].id,
      sessionId: 'twin3535-session-a',
    });
    const twinUuid = await insertTick({
      auroraId: 'aur-2',
      boardId: boardRows[1].id,
      sessionId: 'twin3535-session-b',
    });
    const tickUuids = [survivorUuid, twinUuid];

    await db.insert(dbSchema.boardBetaLinks).values(
      tickUuids.map((tickUuid) => ({
        boardType: BOARD,
        climbUuid: CLIMB_UUID,
        link: `https://example.com/${tickUuid}`,
        tickUuid,
        angle: ANGLE,
      })),
    );
    const commentRows = await db
      .insert(dbSchema.comments)
      .values(
        tickUuids.map((tickUuid) => ({
          uuid: `comment-${tickUuid}`,
          userId: USER_ID,
          entityType: 'tick' as const,
          entityId: tickUuid,
          body: 'beta',
        })),
      )
      .returning({ id: dbSchema.comments.id });
    await db
      .insert(dbSchema.votes)
      .values(
        tickUuids.map((tickUuid) => ({ userId: USER_ID, entityType: 'tick' as const, entityId: tickUuid, value: 1 })),
      );
    await db.insert(dbSchema.voteCounts).values(
      tickUuids.map((tickUuid) => ({
        entityType: 'tick' as const,
        entityId: tickUuid,
        upvotes: 1,
        downvotes: 0,
        score: 1,
        hotScore: 1,
        createdAt: new Date(),
      })),
    );
    await db.insert(dbSchema.feedItems).values(
      tickUuids.map((tickUuid) => ({
        recipientId: USER_ID,
        actorId: USER_ID,
        type: 'ascent' as const,
        entityType: 'tick' as const,
        entityId: tickUuid,
      })),
    );
    await db.insert(dbSchema.notifications).values([
      ...tickUuids.map((tickUuid) => ({
        uuid: `notification-${tickUuid}`,
        recipientId: USER_ID,
        actorId: USER_ID,
        type: 'vote_on_tick' as const,
        entityType: 'tick' as const,
        entityId: tickUuid,
      })),
      ...commentRows.map((comment, index) => ({
        uuid: `notification-comment-${index}`,
        recipientId: USER_ID,
        actorId: USER_ID,
        type: 'comment_on_tick' as const,
        entityType: 'tick' as const,
        entityId: tickUuids[index],
        commentId: comment.id,
      })),
    ]);

    await tickMutations.deleteTick(null, { uuid: survivorUuid }, authenticatedContext);

    const tickUuidList = sql.join(
      tickUuids.map((tickUuid) => sql`${tickUuid}`),
      sql`, `,
    );
    const dependentCounts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM comments WHERE entity_id IN (${tickUuidList})) AS comments,
        (SELECT count(*)::int FROM votes WHERE entity_id IN (${tickUuidList})) AS votes,
        (SELECT count(*)::int FROM vote_counts WHERE entity_id IN (${tickUuidList})) AS vote_counts,
        (SELECT count(*)::int FROM feed_items WHERE entity_id IN (${tickUuidList})) AS feed_items,
        (SELECT count(*)::int FROM notifications WHERE entity_id IN (${tickUuidList})) AS notifications
    `);
    expect(dependentCounts).toEqual([{ comments: 0, votes: 0, vote_counts: 0, feed_items: 0, notifications: 0 }]);
    const betaRows = await db.execute(sql`
      SELECT tick_uuid, angle FROM board_beta_links WHERE climb_uuid = ${CLIMB_UUID} ORDER BY link
    `);
    expect(betaRows).toEqual([
      { tick_uuid: null, angle: ANGLE },
      { tick_uuid: null, angle: ANGLE },
    ]);
    const sessions = await db.execute(sql`
      SELECT id, last_activity > '2020-01-01'::timestamp AS touched
      FROM board_sessions WHERE id LIKE 'twin3535-session-%' ORDER BY id
    `);
    expect(sessions).toEqual([
      { id: 'twin3535-session-a', touched: true },
      { id: 'twin3535-session-b', touched: true },
    ]);
    expect(
      mutationSideEffects.publishDebouncedSessionStats.mock.calls
        .map(([sessionId]) => sessionId)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['twin3535-session-a', 'twin3535-session-b']);
    expect(
      mutationSideEffects.queueBoardStatsPublish.mock.calls
        .map(([boardId]) => boardId)
        .sort((left, right) => left - right),
    ).toEqual(boardRows.map((board) => board.id).sort((left, right) => left - right));
    const tombstones = await db.execute(sql`
      SELECT record_id FROM sync_deletions
      WHERE table_name = 'boardsesh_ticks' AND record_id IN (${tickUuidList})
      ORDER BY record_id
    `);
    expect(tombstones).toEqual(tickUuids.sort().map((recordId) => ({ record_id: recordId })));
    expect(mutationSideEffects.invalidateRecentBetaLinksCache).toHaveBeenCalledTimes(1);
  });

  it('fans only supplied fields across the group and enforces flash attempts', async () => {
    const survivorUuid = await insertTick({
      auroraId: 'aur-1',
      attemptCount: 1,
      quality: 4,
      difficulty: 22,
      // The survivor's local edit relaxes editable-payload parity, so it can
      // directly hide the otherwise identical twin with a different count.
      updatedAt: '2026-05-01T18:22:38.000Z',
    });
    await insertTick({ auroraId: 'aur-2', attemptCount: 2, quality: 4, difficulty: 22 });

    await tickMutations.updateTick(
      null,
      { uuid: survivorUuid, input: { comment: 'one logical send' } },
      authenticatedContext,
    );
    await tickMutations.updateTick(null, { uuid: survivorUuid, input: { status: 'flash' } }, authenticatedContext);

    const rows = await db.execute(sql`
      SELECT status, attempt_count, quality, difficulty, comment
      FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      { status: 'flash', attempt_count: 1, quality: 4, difficulty: 22, comment: 'one logical send' },
      { status: 'flash', attempt_count: 1, quality: 4, difficulty: 22, comment: 'one logical send' },
    ]);
    expect(await visibleAuroraIds()).toEqual(['aur-1']);
  });

  it('groups equal stored microseconds in SQL without absorbing the next microsecond', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1', climbedAt: '2026-05-01T18:22:37.000001Z' });
    await insertTick({ auroraId: 'aur-2', climbedAt: '2026-05-01T18:22:37.000001Z' });
    await insertTick({ auroraId: 'aur-3', climbedAt: '2026-05-01T18:22:37.000002Z' });

    await tickMutations.updateTick(null, { uuid: survivorUuid, input: { angle: 45 } }, authenticatedContext);

    const rows = await db.execute(sql`
      SELECT aurora_id, angle, climbed_at::text AS climbed_at
      FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      { aurora_id: 'aur-1', angle: 45, climbed_at: '2026-05-01 18:22:37.000001' },
      { aurora_id: 'aur-2', angle: 45, climbed_at: '2026-05-01 18:22:37.000001' },
      { aurora_id: 'aur-3', angle: ANGLE, climbed_at: '2026-05-01 18:22:37.000002' },
    ]);
  });

  it('keeps an Aurora local edit one microsecond newer than the sync watermark', async () => {
    const tickUuid = await insertTick({
      auroraId: 'aur-microsecond-stale',
      comment: 'local microsecond edit',
      climbedAt: '2026-05-05T18:22:37.000Z',
    });
    // Both timestamps collapse to the same millisecond in Date.parse, so the
    // pre-write JS check intentionally admits the incoming update. The SQL
    // predicate must make the final decision with Postgres precision.
    await db.execute(sql`
      UPDATE boardsesh_ticks
      SET updated_at = '2026-05-05 19:00:00.000001'::timestamp,
          aurora_synced_at = '2026-05-05 19:00:00.000000'::timestamp
      WHERE uuid = ${tickUuid}
    `);
    const payload = [
      {
        uuid: 'aur-microsecond-stale',
        climb_uuid: CLIMB_UUID,
        angle: ANGLE,
        is_mirror: false,
        attempt_id: 2,
        bid_count: 2,
        quality: null,
        difficulty: 21,
        is_benchmark: false,
        comment: 'stale upstream edit',
        climbed_at: '2026-05-05 18:22:37',
        created_at: '2026-05-05 18:25:00',
        is_listed: true,
      },
    ];
    const applyDb = db as unknown as Parameters<typeof applyAuroraAscents>[0];

    await db.transaction((tx) => applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload));

    const rows = await db.execute(sql`
      SELECT comment, updated_at::text AS updated_at, aurora_synced_at::text AS aurora_synced_at
      FROM boardsesh_ticks WHERE uuid = ${tickUuid}
    `);
    expect(rows).toEqual([
      {
        comment: 'local microsecond edit',
        updated_at: '2026-05-05 19:00:00.000001',
        aurora_synced_at: '2026-05-05 19:00:00',
      },
    ]);
  });

  it('keeps a Kilter local edit one microsecond newer than the sync watermark', async () => {
    const kilterId = 'kilter-microsecond-stale';
    const tickUuid = await insertTick({
      auroraId: null,
      auroraType: null,
      auroraSyncedAt: null,
      boardType: 'kilter',
      origin: 'kilter_pull',
      kilterId,
      kilterType: 'logs',
      kilterSyncedAt: '2026-05-06T19:00:00.000Z',
      climbedAt: '2026-05-06T18:22:37.000Z',
      attemptCount: 9,
    });
    await db.execute(sql`
      UPDATE boardsesh_ticks
      SET updated_at = '2026-05-06 19:00:00.000001'::timestamp,
          kilter_synced_at = '2026-05-06 19:00:00.000000'::timestamp
      WHERE uuid = ${tickUuid}
    `);
    const op: PowerSyncOp = {
      op_id: '1',
      op: 'PUT',
      object_type: 'logs',
      object_id: kilterId,
      data: {
        id: '1',
        log_uuid: kilterId,
        climb_uuid: CLIMB_UUID,
        user_uuid: USER_ID,
        gym_uuid: null,
        wall_uuid: null,
        product_layout_uuid: null,
        angle: ANGLE,
        flashed: 0,
        topped: 1,
        attempts: 2,
        created_at: '2026-05-06T18:22:37.000Z',
      },
    };

    await db.transaction((tx) =>
      applyLogs(
        tx as unknown as Parameters<typeof applyLogs>[0],
        USER_ID,
        [op],
        new Map([[`kilter:${CLIMB_UUID}`, CLIMB_UUID]]),
        () => {},
      ),
    );

    const rows = await db.execute(sql`
      SELECT attempt_count, updated_at::text AS updated_at, kilter_synced_at::text AS kilter_synced_at
      FROM boardsesh_ticks WHERE uuid = ${tickUuid}
    `);
    expect(rows).toEqual([
      {
        attempt_count: 9,
        updated_at: '2026-05-06 19:00:00.000001',
        kilter_synced_at: '2026-05-06 19:00:00',
      },
    ]);
  });

  it('keeps native, JSON, bid/ascent, foreign-user and two-Kilter-link rows outside the group', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-1', kilterId: 'kil-1' });
    await insertTick({ auroraId: 'aur-2' }); // one Kilter link: direct twin
    await insertTick({ auroraId: null, origin: 'native', auroraType: null, auroraSyncedAt: null });
    await insertTick({ auroraId: 'json-import-a', origin: 'json_import' });
    await insertTick({ auroraId: 'aur-3', auroraType: 'bids' });
    await insertTick({ auroraId: 'aur-4', kilterId: 'kil-4' });

    const foreignUser = `${USER_ID}-foreign`;
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${foreignUser}, ${foreignUser + '@test.com'}, 'Foreign Twin', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await insertTick({ auroraId: 'aur-foreign', userId: foreignUser });

    await tickMutations.updateTick(
      null,
      { uuid: survivorUuid, input: { comment: 'group edit' } },
      authenticatedContext,
    );

    const rows = await db.execute(sql`
      SELECT aurora_id, origin::text AS origin, comment
      FROM boardsesh_ticks WHERE user_id = ${USER_ID}
      ORDER BY aurora_id NULLS LAST
    `);
    expect(rows).toEqual([
      { aurora_id: 'aur-1', origin: 'aurora_pull', comment: 'group edit' },
      { aurora_id: 'aur-2', origin: 'aurora_pull', comment: 'group edit' },
      { aurora_id: 'aur-3', origin: 'aurora_pull', comment: 'crimpy' },
      { aurora_id: 'aur-4', origin: 'aurora_pull', comment: 'crimpy' },
      { aurora_id: 'json-import-a', origin: 'json_import', comment: 'crimpy' },
      { aurora_id: null, origin: 'native', comment: 'crimpy' },
    ]);
    const foreign = await db.execute(sql`
      SELECT comment FROM boardsesh_ticks WHERE user_id = ${foreignUser}
    `);
    expect(foreign).toEqual([{ comment: 'crimpy' }]);
    await db.execute(sql`DELETE FROM users WHERE id = ${foreignUser}`);
  });

  it('uses only direct pairs: A(kilter)/B(no kilter)/C(kilter) never closes transitively', async () => {
    const survivorUuid = await insertTick({ auroraId: 'aur-a', kilterId: 'kil-a' });
    await insertTick({ auroraId: 'aur-b' });
    await insertTick({ auroraId: 'aur-c', kilterId: 'kil-c' });
    expect(await visibleAuroraIds()).toEqual(['aur-a']);

    await tickMutations.updateTick(null, { uuid: survivorUuid, input: { angle: 45 } }, authenticatedContext);

    const rows = await db.execute(sql`
      SELECT aurora_id, angle FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      { aurora_id: 'aur-a', angle: 45 },
      { aurora_id: 'aur-b', angle: 45 },
      { aurora_id: 'aur-c', angle: ANGLE },
    ]);
    expect(await visibleAuroraIds()).toEqual(['aur-a', 'aur-c']);
  });

  it('keeps inverse NULL-kilter witnesses single-row for updates', async () => {
    const nullKilterTargetUuid = await insertTick({ auroraId: 'aur-a' });
    await insertTick({ auroraId: 'aur-b', kilterId: 'kil-b' });
    await insertTick({ auroraId: 'aur-c', kilterId: 'kil-c' });
    expect(await visibleAuroraIds()).toEqual(['aur-a']);

    await tickMutations.updateTick(null, { uuid: nullKilterTargetUuid, input: { angle: 45 } }, authenticatedContext);

    const rows = await db.execute(sql`
      SELECT aurora_id, angle FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      { aurora_id: 'aur-a', angle: 45 },
      { aurora_id: 'aur-b', angle: ANGLE },
      { aurora_id: 'aur-c', angle: ANGLE },
    ]);
  });

  it('keeps inverse NULL-kilter witnesses single-row for deletes', async () => {
    const nullKilterTargetUuid = await insertTick({ auroraId: 'aur-a' });
    await insertTick({ auroraId: 'aur-b', kilterId: 'kil-b' });
    await insertTick({ auroraId: 'aur-c', kilterId: 'kil-c' });

    await tickMutations.deleteTick(null, { uuid: nullKilterTargetUuid }, authenticatedContext);

    expect(await storedAuroraIds()).toEqual(['aur-b', 'aur-c']);
  });

  it('keeps single-row semantics when a hidden UUID is addressed directly', async () => {
    await insertTick({ auroraId: 'aur-a' });
    const hiddenUuid = await insertTick({ auroraId: 'aur-b' });
    await insertTick({ auroraId: 'aur-c' });

    await tickMutations.updateTick(null, { uuid: hiddenUuid, input: { angle: 45 } }, authenticatedContext);

    const rows = await db.execute(sql`
      SELECT aurora_id, angle FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY aurora_id
    `);
    expect(rows).toEqual([
      { aurora_id: 'aur-a', angle: ANGLE },
      { aurora_id: 'aur-b', angle: 45 },
      { aurora_id: 'aur-c', angle: ANGLE },
    ]);
  });

  it('applies the same duplicate payload twice with no second-cycle churn', async () => {
    const auroraIds = ['aur-b', 'aur-a', 'aur-c'];
    const payload = auroraIds.map((auroraId) => ({
      uuid: auroraId,
      climb_uuid: CLIMB_UUID,
      angle: ANGLE,
      is_mirror: false,
      attempt_id: 2,
      bid_count: 2,
      quality: null,
      difficulty: 21,
      is_benchmark: false,
      comment: 'crimpy',
      climbed_at: '2026-05-01 18:22:37',
      created_at: '2026-05-01 18:25:00',
      is_listed: true,
    }));

    const applyDb = db as unknown as Parameters<typeof applyAuroraAscents>[0];

    await db.transaction((tx) => applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload));
    const afterFirst = await db
      .select({ uuid: dbSchema.boardseshTicks.uuid, auroraId: dbSchema.boardseshTicks.auroraId })
      .from(dbSchema.boardseshTicks)
      .where(sql`user_id = ${USER_ID}`);

    // Every real aurora_id is stored — the fix hides a twin, it never drops one.
    expect(afterFirst.map((row) => row.auroraId).sort(byAuroraId)).toEqual(['aur-a', 'aur-b', 'aur-c']);
    expect(await visibleAuroraIds()).toEqual(['aur-a']);

    // Second cycle: identical payload, as an incremental re-pull would deliver.
    await db.transaction((tx) => applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload));
    const afterSecond = await db
      .select({ uuid: dbSchema.boardseshTicks.uuid, auroraId: dbSchema.boardseshTicks.auroraId })
      .from(dbSchema.boardseshTicks)
      .where(sql`user_id = ${USER_ID}`);

    // No re-insert, no resurrection, same row identities: the second cycle is a
    // no-op. A delete-the-loser fix would fail here — the deleted row's real
    // aurora_id is a miss on every later pull and comes straight back.
    expect(afterSecond.map((row) => row.auroraId).sort(byAuroraId)).toEqual(['aur-a', 'aur-b', 'aur-c']);
    expect(new Set(afterSecond.map((row) => row.uuid))).toEqual(new Set(afterFirst.map((row) => row.uuid)));
    expect(await visibleAuroraIds()).toEqual(['aur-a']);
    expect(await feedTotalCount()).toBe(1);
  });

  it('documents resurrection only when Aurora genuinely redelivers the deleted upstream payload', async () => {
    const payload = ['aur-a', 'aur-b'].map((auroraId) => ({
      uuid: auroraId,
      climb_uuid: CLIMB_UUID,
      angle: ANGLE,
      is_mirror: false,
      attempt_id: 2,
      bid_count: 2,
      quality: null,
      difficulty: 21,
      is_benchmark: false,
      comment: 'redelivered',
      climbed_at: '2026-05-01 18:22:37',
      created_at: '2026-05-01 18:25:00',
      is_listed: true,
    }));
    const applyDb = db as unknown as Parameters<typeof applyAuroraAscents>[0];
    await db.transaction((tx) => applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload));
    const [survivor] = await db
      .select({ uuid: dbSchema.boardseshTicks.uuid })
      .from(dbSchema.boardseshTicks)
      .where(sql`aurora_id = 'aur-a'`);

    await tickMutations.deleteTick(null, { uuid: survivor.uuid }, authenticatedContext);
    expect(await storedAuroraIds()).toEqual([]);

    // No suppression ledger is intended: a later payload carrying the real,
    // still-live Aurora ids is authoritative and resurrects the logical ascent.
    await db.transaction((tx) => applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload));
    expect(await storedAuroraIds()).toEqual(['aur-a', 'aur-b']);
    expect(await visibleAuroraIds()).toEqual(['aur-a']);
  });

  it('blocks a second holder of the same user key while letting another user through', async () => {
    let releaseHolder!: () => void;
    const holderRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let signalHolderReady!: (backendPid: number) => void;
    const holderReady = new Promise<number>((resolve) => {
      signalHolderReady = resolve;
    });
    const holderTransaction = db.transaction(async (tx) => {
      await acquireUserTickMutationLock(tx as unknown as Parameters<typeof acquireUserTickMutationLock>[0], USER_ID);
      const [{ backendPid }] = rowsOf<{ backendPid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS "backendPid"`),
      );
      signalHolderReady(backendPid);
      await holderRelease;
      return backendPid;
    });
    const holderBackendPid = await holderReady;

    // The key is per user, not a global logbook gate: a second climber's
    // mutation must not queue behind this one. If the seed/hash ever stopped
    // depending on the user id, this acquisition would hang here instead.
    await db.transaction(async (tx) => {
      await acquireUserTickMutationLock(
        tx as unknown as Parameters<typeof acquireUserTickMutationLock>[0],
        `${USER_ID}-other`,
      );
    });

    const contender = db.transaction(async (tx) => {
      await acquireUserTickMutationLock(tx as unknown as Parameters<typeof acquireUserTickMutationLock>[0], USER_ID);
    });
    await verifyContentionAndRelease({
      holderBackendPid,
      holder: holderTransaction,
      contender,
      releaseHolder,
    });
  });

  it('Aurora apply and updateTick serialize over two connections', async () => {
    const payload = [
      {
        uuid: 'aur-concurrent',
        climb_uuid: CLIMB_UUID,
        angle: ANGLE,
        is_mirror: false,
        attempt_id: 2,
        bid_count: 2,
        quality: null,
        difficulty: 21,
        is_benchmark: false,
        comment: 'upstream',
        climbed_at: '2026-05-03 18:22:37',
        created_at: '2026-05-03 18:25:00',
        is_listed: true,
      },
    ];
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let signalImportReady!: (result: { tickUuid: string; backendPid: number }) => void;
    const importedTick = new Promise<{ tickUuid: string; backendPid: number }>((resolve) => {
      signalImportReady = resolve;
    });
    const applyDb = db as unknown as Parameters<typeof applyAuroraAscents>[0];
    const importTransaction = db.transaction(async (tx) => {
      await applyAuroraAscents(tx as unknown as typeof applyDb, BOARD, USER_ID, payload);
      const [row] = await tx
        .select({ uuid: dbSchema.boardseshTicks.uuid })
        .from(dbSchema.boardseshTicks)
        .where(sql`aurora_id = 'aur-concurrent'`);
      const [{ backendPid }] = rowsOf<{ backendPid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS "backendPid"`),
      );
      signalImportReady({ tickUuid: row.uuid, backendPid });
      await importRelease;
    });
    const { tickUuid, backendPid } = await importedTick;

    const mutation = tickMutations.updateTick(
      null,
      { uuid: tickUuid, input: { comment: 'local wins' } },
      authenticatedContext,
    );
    await verifyContentionAndRelease({
      holderBackendPid: backendPid,
      holder: importTransaction,
      contender: mutation,
      releaseHolder: releaseImport,
    });
    const [stored] = await db
      .select({ comment: dbSchema.boardseshTicks.comment })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));
    expect(stored.comment).toBe('local wins');
  });

  it('Kilter log apply and updateTick serialize over two connections', async () => {
    const logUuid = 'kilter-concurrent';
    const op: PowerSyncOp = {
      op_id: '1',
      op: 'PUT',
      object_type: 'logs',
      object_id: logUuid,
      data: {
        id: '1',
        log_uuid: logUuid,
        climb_uuid: CLIMB_UUID,
        user_uuid: USER_ID,
        gym_uuid: null,
        wall_uuid: null,
        product_layout_uuid: null,
        angle: ANGLE,
        flashed: 0,
        topped: 1,
        attempts: 2,
        created_at: '2026-05-04T18:22:37.000Z',
      },
    };
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let signalImportReady!: (result: { tickUuid: string; backendPid: number }) => void;
    const importedTick = new Promise<{ tickUuid: string; backendPid: number }>((resolve) => {
      signalImportReady = resolve;
    });
    const importTransaction = db.transaction(async (tx) => {
      await applyLogs(
        tx as unknown as Parameters<typeof applyLogs>[0],
        USER_ID,
        [op],
        new Map([[`kilter:${CLIMB_UUID}`, CLIMB_UUID]]),
        () => {},
      );
      const [row] = await tx
        .select({ uuid: dbSchema.boardseshTicks.uuid })
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.kilterId, logUuid));
      const [{ backendPid }] = rowsOf<{ backendPid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS "backendPid"`),
      );
      signalImportReady({ tickUuid: row.uuid, backendPid });
      await importRelease;
    });
    const { tickUuid, backendPid } = await importedTick;

    const mutation = tickMutations.updateTick(
      null,
      { uuid: tickUuid, input: { comment: 'local after Kilter' } },
      authenticatedContext,
    );
    await verifyContentionAndRelease({
      holderBackendPid: backendPid,
      holder: importTransaction,
      contender: mutation,
      releaseHolder: releaseImport,
    });
    const [stored] = await db
      .select({ comment: dbSchema.boardseshTicks.comment })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));
    expect(stored.comment).toBe('local after Kilter');
  });
});
