/**
 * The materialised similar-climbs index end to end, against the real test
 * Postgres: the in-memory scorer, the watermark-driven refresh job, the read
 * path the `similarClimbs` resolver serves non-admins from, and the
 * `updateClimb` invalidation. Design: docs/similar-climbs.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, or, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  CLIMB_NEIGHBOR_K,
  ClimbNeighborIndex,
  getMaterializedSimilarClimbs,
  refreshClimbNeighborsForBoard,
} from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { hasCatalogQueryAccess } from '../graphql/resolvers/social/roles';

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../events', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

const BOARD = 'kilter' as const;
const PREFIX = 'climb-neighbors-test-';
const OWNER = 'user-123';

function framesFor(holdIds: readonly number[]): string {
  return holdIds.map((holdId) => `p${holdId}r13`).join('');
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

type ClimbSeed = {
  uuid: string;
  layoutId: number;
  holds: number[];
  isDraft?: boolean;
  isHidden?: boolean;
  isListed?: boolean | null;
  userId?: string | null;
  publishedAt?: string | null;
};

async function insertClimb({
  uuid,
  layoutId,
  holds,
  isDraft = false,
  isHidden = false,
  isListed = null,
  userId = null,
  publishedAt = null,
}: ClimbSeed): Promise<void> {
  await db.insert(dbSchema.boardClimbs).values({
    uuid: PREFIX + uuid,
    boardType: BOARD,
    layoutId,
    name: uuid,
    angle: 40,
    frames: framesFor(holds),
    framesCount: 1,
    isDraft,
    isHidden,
    isListed,
    userId,
    publishedAt,
    setterUsername: 'setter',
  });
}

async function neighbourList(uuid: string): Promise<Array<{ neighbor: string; rank: number; shared: number }>> {
  const rows = await db
    .select({
      neighbor: dbSchema.boardClimbNeighbors.neighborUuid,
      rank: dbSchema.boardClimbNeighbors.rank,
      shared: dbSchema.boardClimbNeighbors.sharedHoldCount,
    })
    .from(dbSchema.boardClimbNeighbors)
    .where(
      and(eq(dbSchema.boardClimbNeighbors.boardType, BOARD), eq(dbSchema.boardClimbNeighbors.climbUuid, PREFIX + uuid)),
    )
    .orderBy(dbSchema.boardClimbNeighbors.rank);
  return rows.map((row) => ({ ...row, neighbor: row.neighbor.slice(PREFIX.length) }));
}

async function rowsNaming(uuid: string): Promise<number> {
  const rows = await db
    .select({ climb: dbSchema.boardClimbNeighbors.climbUuid })
    .from(dbSchema.boardClimbNeighbors)
    .where(
      and(
        eq(dbSchema.boardClimbNeighbors.boardType, BOARD),
        or(
          eq(dbSchema.boardClimbNeighbors.climbUuid, PREFIX + uuid),
          eq(dbSchema.boardClimbNeighbors.neighborUuid, PREFIX + uuid),
        ),
      ),
    );
  return rows.length;
}

async function watermark(): Promise<number | null> {
  const [run] = await db
    .select({ lastSyncSeq: dbSchema.boardClimbNeighborRuns.lastSyncSeq })
    .from(dbSchema.boardClimbNeighborRuns)
    .where(eq(dbSchema.boardClimbNeighborRuns.boardType, BOARD));
  return run ? Number(run.lastSyncSeq) : null;
}

async function highestSyncSeq(): Promise<number> {
  const rows = await db.execute<{ seq: string }>(
    sql`SELECT MAX(sync_seq)::text AS seq FROM board_climbs WHERE board_type = ${BOARD}`,
  );
  return Number([...rows][0]?.seq ?? 0);
}

/**
 * Age every test climb's last write past the watermark's one-hour settle
 * window. `updated_at` alone is excluded from the sync trigger's WHEN guard, so
 * this moves no sync_seq.
 */
async function settleClimbs(): Promise<void> {
  await db.execute(
    sql`UPDATE board_climbs SET updated_at = now() - interval '2 hours' WHERE uuid LIKE ${PREFIX + '%'}`,
  );
}

async function reset(): Promise<void> {
  await db.execute(sql`DELETE FROM board_climb_neighbor_runs`);
  await db.execute(sql`DELETE FROM board_climb_neighbor_group_runs`);
  await db.execute(sql`DELETE FROM board_climb_neighbors`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM board_climb_holds WHERE climb_uuid LIKE ${PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
}

describe('ClimbNeighborIndex', () => {
  it('scores position-only Jaccard and keeps pairs at or above the floor, best first', () => {
    const index = new ClimbNeighborIndex([
      { uuid: 'a', holdIds: range(1, 10) },
      { uuid: 'b', holdIds: [...range(1, 9), 11] }, // 9 / 11
      { uuid: 'c', holdIds: [...range(1, 5), ...range(20, 24)] }, // 5 / 15, below 0.5
      { uuid: 'd', holdIds: range(1, 10) }, // identical
    ]);
    expect(index.neighborsOf('a')).toEqual([
      { neighborUuid: 'd', sharedHoldCount: 10, targetHoldCount: 10, candidateHoldCount: 10, jaccard: 1 },
      { neighborUuid: 'b', sharedHoldCount: 9, targetHoldCount: 10, candidateHoldCount: 10, jaccard: 9 / 11 },
    ]);
    expect(index.neighborsOf('c')).toEqual([]);
    expect(index.neighborsOf('missing')).toEqual([]);
  });

  it('does not lose a pair at exactly the threshold to float noise (7 of 10 at 0.7)', () => {
    const index = new ClimbNeighborIndex([
      { uuid: 'a', holdIds: range(1, 10) },
      { uuid: 'b', holdIds: [...range(1, 7), ...range(30, 32)] }, // 7 shared of 13 → below 0.7
      { uuid: 'c', holdIds: range(1, 7) }, // 7 / 10 = 0.7
    ]);
    expect(index.neighborsOf('a', 0.7).map(({ neighborUuid }) => neighborUuid)).toEqual(['c']);
  });

  function randomCatalogue(seed: number, count: number, minSize: number, maxSize: number, holdSpace: number) {
    let state = seed;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    return Array.from({ length: count }, (_, position) => {
      const holds = new Set<number>();
      const size = minSize + Math.floor(random() * (maxSize - minSize + 1));
      while (holds.size < size) holds.add(Math.floor(random() * holdSpace));
      return { uuid: `c${String(position).padStart(3, '0')}`, holdIds: [...holds].sort((left, right) => left - right) };
    });
  }

  // The live SQL only ever sees candidates sharing at least one hold (it joins
  // on board_climb_holds), so "shared >= 1" is part of the definition even at
  // threshold 0.
  function bruteForce(climbs: ReturnType<typeof randomCatalogue>, targetUuid: string, threshold: number) {
    const target = climbs.find(({ uuid }) => uuid === targetUuid);
    if (!target) return [];
    return climbs
      .filter((candidate) => candidate.uuid !== target.uuid)
      .map((candidate) => {
        const shared = candidate.holdIds.filter((holdId) => target.holdIds.includes(holdId)).length;
        return {
          neighborUuid: candidate.uuid,
          sharedHoldCount: shared,
          candidateHoldCount: candidate.holdIds.length,
          jaccard: shared / (target.holdIds.length + candidate.holdIds.length - shared),
        };
      })
      .filter(({ sharedHoldCount, jaccard }) => sharedHoldCount >= 1 && jaccard >= threshold)
      .sort(
        (left, right) =>
          right.jaccard - left.jaccard ||
          (left.neighborUuid < right.neighborUuid ? -1 : left.neighborUuid > right.neighborUuid ? 1 : 0),
      );
  }

  const THRESHOLDS = [0, 0.3, 0.5, 0.7, 1];
  const CATALOGUES = [
    // Kilter-shaped: 4–13 holds from a 40-hold wall.
    { name: '4–13-hold climbs', climbs: randomCatalogue(7, 300, 4, 13, 40) },
    // Tiny climbs, where the prefix is the whole climb (prefixLength === size)
    // and a single shared hold is enough (minShared === 1).
    { name: '1–3-hold climbs', climbs: randomCatalogue(11, 120, 1, 3, 12) },
  ];

  for (const { name, climbs } of CATALOGUES) {
    for (const threshold of THRESHOLDS) {
      it(`matches a brute-force scorer, list for list, on ${name} at ${threshold}`, () => {
        const index = new ClimbNeighborIndex(climbs);
        for (const target of climbs.slice(0, 60)) {
          const actual = index
            .neighborsOf(target.uuid, threshold)
            .map(({ neighborUuid, sharedHoldCount, candidateHoldCount, jaccard }) => ({
              neighborUuid,
              sharedHoldCount,
              candidateHoldCount,
              jaccard,
            }));
          expect(actual).toEqual(bruteForce(climbs, target.uuid, threshold));
        }
      });
    }
  }
});

describe('refreshClimbNeighborsForBoard', () => {
  beforeAll(reset);
  afterAll(reset);

  it('full rebuild writes symmetric lists and keeps drafts, hidden, other layouts and weak pairs out', async () => {
    await insertClimb({ uuid: 'a', layoutId: 1, holds: range(1, 10) });
    await insertClimb({ uuid: 'b', layoutId: 1, holds: [...range(1, 9), 11] });
    await insertClimb({ uuid: 'c', layoutId: 1, holds: [...range(1, 5), ...range(20, 24)] });
    await insertClimb({ uuid: 'hidden', layoutId: 1, holds: range(1, 10), isHidden: true });
    await insertClimb({ uuid: 'draft', layoutId: 1, holds: range(1, 10), isDraft: true });
    await insertClimb({ uuid: 'unlisted', layoutId: 1, holds: range(1, 10), isListed: false });
    await insertClimb({ uuid: 'other-layout', layoutId: 2, holds: range(1, 10) });

    // No watermark row yet: the first run on a board is a full build unasked.
    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(result.full).toBe(true);

    expect(await neighbourList('a')).toEqual([{ neighbor: 'b', rank: 1, shared: 9 }]);
    expect(await neighbourList('b')).toEqual([{ neighbor: 'a', rank: 1, shared: 9 }]);
    expect(await neighbourList('c')).toEqual([]);
    expect(await rowsNaming('hidden')).toBe(0);
    expect(await rowsNaming('draft')).toBe(0);
    expect(await rowsNaming('unlisted')).toBe(0);
    expect(await rowsNaming('other-layout')).toBe(0);
    expect(result.rowsWritten).toBe(2);
    // Every row was written seconds ago, so the watermark may not pass any of
    // them yet: an open transaction could still commit a lower sync_seq.
    expect(await watermark()).toBe(0);
  });

  it('advances the watermark only past rows that have settled', async () => {
    await settleClimbs();
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(await watermark()).toBe(await highestSyncSeq());
  });

  it('an incremental run folds a new climb in, in both directions', async () => {
    const before = await watermark();
    await insertClimb({ uuid: 'g', layoutId: 1, holds: [...range(1, 10), 12] }); // a: 10/11, b: 9/12

    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    expect(result.full).toBe(false);
    expect(result.previousSyncSeq).toBe(before);
    expect(result.workSetSize).toBe(1);
    expect(await neighbourList('g')).toEqual([
      { neighbor: 'a', rank: 1, shared: 10 },
      { neighbor: 'b', rank: 2, shared: 9 },
    ]);
    expect(await neighbourList('a')).toEqual([
      { neighbor: 'g', rank: 1, shared: 10 },
      { neighbor: 'b', rank: 2, shared: 9 },
    ]);
    expect(await neighbourList('b')).toEqual([
      { neighbor: 'a', rank: 1, shared: 9 },
      { neighbor: 'g', rank: 2, shared: 9 },
    ]);
  });

  it('holds the watermark below a recent row, so the next run scores it again', async () => {
    // 'g' was written seconds ago with the board's highest sync_seq. Advancing
    // past it is exactly what would lose a row whose transaction was still
    // open: the watermark stays put and 'g' is re-processed (idempotently).
    const [gRow] = await db
      .select({ syncSeq: dbSchema.boardClimbs.syncSeq })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.uuid, PREFIX + 'g'));
    expect(await watermark()).toBeLessThan(gRow.syncSeq);

    const again = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(again.workSetSize).toBe(1);
    expect(await neighbourList('a')).toHaveLength(2);

    await settleClimbs();
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(await watermark()).toBe(gRow.syncSeq);
  });

  it('a run with nothing changed and everything settled writes nothing', async () => {
    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(result.workSetSize).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(await neighbourList('a')).toHaveLength(2);
  });

  it('an edited climb loses its stale rows everywhere and the lists it left are refilled', async () => {
    await db
      .update(dbSchema.boardClimbs)
      .set({ frames: framesFor(range(30, 40)) })
      .where(eq(dbSchema.boardClimbs.uuid, PREFIX + 'g'));

    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    expect(await rowsNaming('g')).toBe(0);
    expect(await neighbourList('a')).toEqual([{ neighbor: 'b', rank: 1, shared: 9 }]);
    expect(await neighbourList('b')).toEqual([{ neighbor: 'a', rank: 1, shared: 9 }]);
  });

  it('a dry run computes but writes nothing, watermark included', async () => {
    const before = await watermark();
    await insertClimb({ uuid: 'dry', layoutId: 1, holds: range(1, 10) });
    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD, dryRun: true });
    expect(result.rowsWritten).toBeGreaterThan(0);
    expect(await rowsNaming('dry')).toBe(0);
    expect(await watermark()).toBe(before);
    await db.delete(dbSchema.boardClimbs).where(eq(dbSchema.boardClimbs.uuid, PREFIX + 'dry'));
  });

  it(`trims every list to K = ${CLIMB_NEIGHBOR_K}`, async () => {
    await insertClimb({ uuid: 'k-target', layoutId: 3, holds: range(1, 10) });
    for (let variant = 0; variant < 30; variant += 1) {
      await insertClimb({ uuid: `k-${variant}`, layoutId: 3, holds: [...range(1, 10), 100 + variant] });
    }
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    const targetList = await neighbourList('k-target');
    expect(targetList).toHaveLength(CLIMB_NEIGHBOR_K);
    expect(targetList.map(({ rank }) => rank)).toEqual(range(1, CLIMB_NEIGHBOR_K));
    // Each variant scores 10/11 with the target and 10/12 with its siblings,
    // so the target ranks first and the siblings fill the rest.
    const variantList = await neighbourList('k-0');
    expect(variantList).toHaveLength(CLIMB_NEIGHBOR_K);
    expect(variantList[0].neighbor).toBe('k-target');
  });

  it('refills a list that lost a row to a deleted climb (FK cascade), last-ranked row included', async () => {
    // Settle and catch up first, so the refill below can only come from the
    // list_size check: the work set is empty.
    await settleClimbs();
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    const targetList = await neighbourList('k-target');
    const middle = targetList[4].neighbor;
    const last = targetList[CLIMB_NEIGHBOR_K - 1].neighbor;
    await db.delete(dbSchema.boardClimbs).where(eq(dbSchema.boardClimbs.uuid, PREFIX + middle));
    await db.delete(dbSchema.boardClimbs).where(eq(dbSchema.boardClimbs.uuid, PREFIX + last));
    expect(await neighbourList('k-target')).toHaveLength(CLIMB_NEIGHBOR_K - 2);

    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    expect(result.workSetSize).toBe(0);
    const refilled = await neighbourList('k-target');
    expect(refilled.map(({ rank }) => rank)).toEqual(range(1, CLIMB_NEIGHBOR_K));
    expect(refilled.map(({ neighbor }) => neighbor)).not.toContain(middle);
    expect(refilled.map(({ neighbor }) => neighbor)).not.toContain(last);
  });

  it('refills a list that lost only its last-ranked row', async () => {
    await settleClimbs();
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    const last = (await neighbourList('k-target'))[CLIMB_NEIGHBOR_K - 1].neighbor;
    await db.delete(dbSchema.boardClimbs).where(eq(dbSchema.boardClimbs.uuid, PREFIX + last));

    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    expect(result.workSetSize).toBe(0);
    expect(await neighbourList('k-target')).toHaveLength(CLIMB_NEIGHBOR_K);
  });

  it('skips spray walls outright', async () => {
    const result = await refreshClimbNeighborsForBoard(db, { boardType: 'spray', full: true });
    expect(result.skipped).toBe(true);
  });
});

describe('a full build survives being cut off', () => {
  beforeAll(reset);
  afterAll(reset);

  async function runRow() {
    const [row] = await db
      .select()
      .from(dbSchema.boardClimbNeighborRuns)
      .where(eq(dbSchema.boardClimbNeighborRuns.boardType, BOARD));
    return row;
  }

  async function completedGroups(): Promise<number[]> {
    const rows = await db
      .select({ layoutId: dbSchema.boardClimbNeighborGroupRuns.layoutId })
      .from(dbSchema.boardClimbNeighborGroupRuns)
      .where(eq(dbSchema.boardClimbNeighborGroupRuns.boardType, BOARD));
    return rows.map(({ layoutId }) => layoutId).sort((left, right) => left - right);
  }

  it('records finished groups, smallest first, and resumes without redoing them', async () => {
    // Layout 5: 2 climbs (the smaller group, so it goes first). Layout 6: 4.
    await insertClimb({ uuid: 'r5-a', layoutId: 5, holds: range(1, 10) });
    await insertClimb({ uuid: 'r5-b', layoutId: 5, holds: [...range(1, 9), 11] });
    for (let variant = 0; variant < 4; variant += 1) {
      await insertClimb({ uuid: `r6-${variant}`, layoutId: 6, holds: [...range(1, 10), 20 + variant] });
    }
    await settleClimbs();
    const pinned = await highestSyncSeq();

    // Let exactly one chunk through: layout 5's only chunk.
    let chunksAllowed = 1;
    const first = await refreshClimbNeighborsForBoard(db, {
      boardType: BOARD,
      shouldContinue: () => chunksAllowed-- > 0,
    });

    expect(first.interrupted).toBe(true);
    expect(first.full).toBe(true);
    expect(first.groups.map(({ layoutId }) => layoutId)).toEqual([5, 6]);
    expect(await completedGroups()).toEqual([5]);
    expect(await neighbourList('r5-a')).toEqual([{ neighbor: 'r5-b', rank: 1, shared: 9 }]);
    expect(await neighbourList('r6-0')).toEqual([]);
    const midBuild = await runRow();
    expect(midBuild.lastSyncSeq).toBe(0);
    expect(midBuild.fullBuildSyncSeq).toBe(pinned);
    expect(midBuild.fullBuildStartedAt).not.toBeNull();

    // A climb that lands between the two runs sits above the pinned target.
    await insertClimb({ uuid: 'r6-late', layoutId: 6, holds: [...range(1, 10), 40] });

    // The next run is a plain nightly run: it resumes the build on its own.
    const second = await refreshClimbNeighborsForBoard(db, { boardType: BOARD });

    expect(second.resumed).toBe(true);
    expect(second.interrupted).toBe(false);
    const layoutFive = second.groups.find(({ layoutId }) => layoutId === 5);
    expect(layoutFive?.alreadyComplete).toBe(true);
    expect(await neighbourList('r6-0')).toHaveLength(4);
    const finished = await runRow();
    // The watermark lands on the target pinned when the build started, not on
    // the late climb, so the next incremental run still folds it in.
    expect(finished.lastSyncSeq).toBe(pinned);
    expect(finished.fullBuildStartedAt).toBeNull();
    expect(finished.fullBuildSyncSeq).toBeNull();
  });

  it('skips lists a cut-off run already wrote inside an unfinished group', async () => {
    await reset();
    for (let variant = 0; variant < 6; variant += 1) {
      await insertClimb({ uuid: `r7-${variant}`, layoutId: 7, holds: [...range(1, 10), 50 + variant] });
    }

    let chunksAllowed = 1;
    const first = await refreshClimbNeighborsForBoard(db, {
      boardType: BOARD,
      chunkSize: 2,
      shouldContinue: () => chunksAllowed-- > 0,
    });
    expect(first.interrupted).toBe(true);
    expect(first.rowsWritten).toBe(2 * 5);
    expect(await completedGroups()).toEqual([]);

    const second = await refreshClimbNeighborsForBoard(db, { boardType: BOARD, chunkSize: 2 });

    expect(second.resumed).toBe(true);
    expect(second.groups[0]).toMatchObject({ layoutId: 7, climbsSkipped: 2, climbsProcessed: 4 });
    for (let variant = 0; variant < 6; variant += 1) {
      expect(await neighbourList(`r7-${variant}`)).toHaveLength(5);
    }
    expect(await completedGroups()).toEqual([7]);
  });

  it('an explicit --full on a finished board starts a new build, rewriting every list', async () => {
    const result = await refreshClimbNeighborsForBoard(db, { boardType: BOARD, full: true, chunkSize: 2 });
    expect(result.resumed).toBe(false);
    expect(result.groups[0]).toMatchObject({ climbsSkipped: 0, climbsProcessed: 6 });
  });
});

describe('getMaterializedSimilarClimbs', () => {
  beforeAll(async () => {
    await reset();
    await db.execute(sql`
      INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed)
      VALUES (${BOARD}, 20, '6c/V5', true)
      ON CONFLICT (board_type, difficulty) DO UPDATE SET boulder_name = excluded.boulder_name
    `);
    await insertClimb({ uuid: 'target', layoutId: 1, holds: range(1, 10) });
    await insertClimb({ uuid: 'close', layoutId: 1, holds: [...range(1, 10), 12] }); // 10/11
    await insertClimb({ uuid: 'near', layoutId: 1, holds: [...range(1, 9), 11] }); // 9/11
    await insertClimb({ uuid: 'far', layoutId: 1, holds: [...range(1, 7), 13, 14] }); // 7/12
    await db.insert(dbSchema.boardClimbStats).values({
      boardType: BOARD,
      climbUuid: PREFIX + 'near',
      angle: 40,
      displayDifficulty: 20.2,
      ascensionistCount: 7,
      qualityAverage: 2.5,
    });
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD, full: true });
  });
  afterAll(reset);

  const read = (overrides: Partial<Parameters<typeof getMaterializedSimilarClimbs>[1]> = {}) =>
    getMaterializedSimilarClimbs(db, {
      boardType: BOARD,
      layoutId: 1,
      climbUuid: PREFIX + 'target',
      threshold: 0.5,
      limit: 25,
      statsAngle: 40,
      ...overrides,
    });

  it('returns the SimilarClimb shape, ordered by similarity, with stats and grade at the angle', async () => {
    const results = await read();
    expect(results.map(({ uuid }) => uuid.slice(PREFIX.length))).toEqual(['close', 'near', 'far']);
    expect(results[1]).toEqual({
      uuid: PREFIX + 'near',
      name: 'near',
      setterUsername: 'setter',
      angle: 40,
      layoutId: 1,
      frames: framesFor([...range(1, 9), 11]),
      difficultyName: '6c/V5',
      qualityAverage: 2.5,
      ascensionistCount: 7,
      compatibleSizeIds: [],
      characteristics: null,
      similarity: 9 / 11,
      sharedHoldCount: 9,
      candidateHoldCount: 10,
      targetHoldCount: 10,
    });
  });

  it('honours threshold and limit', async () => {
    expect((await read({ threshold: 0.85 })).map(({ uuid }) => uuid)).toEqual([PREFIX + 'close']);
    expect(await read({ limit: 2 })).toHaveLength(2);
    expect(await read({ layoutId: 2 })).toEqual([]);
  });

  it('drops a neighbour the moment it is hidden or unlisted, before the next nightly run', async () => {
    await db
      .update(dbSchema.boardClimbs)
      .set({ isHidden: true })
      .where(eq(dbSchema.boardClimbs.uuid, PREFIX + 'close'));
    await db
      .update(dbSchema.boardClimbs)
      .set({ isListed: false })
      .where(eq(dbSchema.boardClimbs.uuid, PREFIX + 'far'));
    expect((await read()).map(({ uuid }) => uuid)).toEqual([PREFIX + 'near']);
  });
});

describe('updateClimb invalidates the materialised neighbours', () => {
  beforeAll(reset);
  afterAll(reset);
  beforeEach(async () => {
    await reset();
  });

  it('deletes the edited climb’s rows in both directions and leaves the rest', async () => {
    await insertClimb({
      uuid: 'mine',
      layoutId: 4,
      holds: range(1, 10),
      userId: OWNER,
      publishedAt: new Date().toISOString(),
    });
    await insertClimb({ uuid: 'peer-1', layoutId: 4, holds: [...range(1, 9), 11] });
    await insertClimb({ uuid: 'peer-2', layoutId: 4, holds: [...range(1, 9), 12] });
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD, full: true });
    expect(await rowsNaming('mine')).toBe(4);
    expect(await neighbourList('peer-1')).toHaveLength(2);

    await climbMutations.updateClimb(
      null,
      { input: { uuid: PREFIX + 'mine', boardType: BOARD, frames: framesFor(range(50, 60)) } },
      { connectionId: 'conn', isAuthenticated: true, userId: OWNER } as unknown as ConnectionContext,
    );

    expect(await rowsNaming('mine')).toBe(0);
    // The survivors keep their old rank (a gap where 'mine' sat) until the
    // nightly run rewrites the list; the read path orders by similarity, not rank.
    expect(await neighbourList('peer-1')).toEqual([{ neighbor: 'peer-2', rank: 2, shared: 9 }]);
    expect(await neighbourList('peer-2')).toEqual([{ neighbor: 'peer-1', rank: 2, shared: 9 }]);

    // The edit bumped sync_seq, so the next run re-scores the climb on its new holds.
    await refreshClimbNeighborsForBoard(db, { boardType: BOARD });
    expect(await rowsNaming('mine')).toBe(0);
    expect(await neighbourList('peer-1')).toEqual([{ neighbor: 'peer-2', rank: 1, shared: 9 }]);
  });
});

describe('hasCatalogQueryAccess', () => {
  it('never grants an anonymous caller', async () => {
    expect(await hasCatalogQueryAccess({ connectionId: 'c', isAuthenticated: false } as ConnectionContext)).toBe(false);
  });

  it('grants a global admin and refuses a plain user', async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES ('neighbors-admin', 'neighbors-admin@test.com', 'Admin', now(), now()), ('neighbors-user', 'neighbors-user@test.com', 'User', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`DELETE FROM community_roles WHERE user_id IN ('neighbors-admin', 'neighbors-user')`);
    await db.insert(dbSchema.communityRoles).values({ userId: 'neighbors-admin', role: 'admin', boardType: null });
    const ctxFor = (userId: string) => ({ connectionId: 'c', isAuthenticated: true, userId }) as ConnectionContext;
    expect(await hasCatalogQueryAccess(ctxFor('neighbors-admin'), 'kilter')).toBe(true);
    expect(await hasCatalogQueryAccess(ctxFor('neighbors-user'), 'kilter')).toBe(false);
    await db.execute(sql`DELETE FROM community_roles WHERE user_id IN ('neighbors-admin', 'neighbors-user')`);
  });
});
