import { describe, expect, it } from 'vitest';

import {
  classifyKilterDeletions,
  isAnomalousDeletionBacklog,
  planDeletionBatch,
  reconcileDeletions,
  type AliasClassificationRow,
} from './deletions';

const noop = () => {};

function aliasRow(
  overrides: Partial<AliasClassificationRow> & Pick<AliasClassificationRow, 'aliasUuid'>,
): AliasClassificationRow {
  return {
    canonicalUuid: overrides.aliasUuid,
    source: 'kilter',
    canonicalSetInBoardsesh: false,
    canonicalIsListed: true,
    ...overrides,
  };
}

describe('classifyKilterDeletions', () => {
  const noCounts = new Map<string, number>();

  it('drops a pure kilter alias but never a foreign-source one', () => {
    const result = classifyKilterDeletions({
      loweredUuids: ['dup', 'foreign'],
      aliasRows: [
        aliasRow({ aliasUuid: 'dup', canonicalUuid: 'canon' }),
        aliasRow({ aliasUuid: 'foreign', canonicalUuid: 'canon2', source: 'backfill' }),
      ],
      aliasCounts: noCounts,
    });
    expect(result.aliasUuidsToDelete).toEqual(['dup']);
    expect(result.skippedForeignSource).toBe(1);
  });

  it('protects a user-authored self-canonical', () => {
    const result = classifyKilterDeletions({
      loweredUuids: ['mine'],
      aliasRows: [aliasRow({ aliasUuid: 'mine', canonicalSetInBoardsesh: true })],
      aliasCounts: noCounts,
    });
    expect(result.canonicalsToSoftDelete).toEqual([]);
    expect(result.protectedUserAuthored).toBe(1);
  });

  it('soft-deletes a lone synced self-canonical, skips one already unlisted', () => {
    const result = classifyKilterDeletions({
      loweredUuids: ['a', 'b'],
      aliasRows: [aliasRow({ aliasUuid: 'a' }), aliasRow({ aliasUuid: 'b', canonicalIsListed: false })],
      aliasCounts: new Map([
        ['a', 1],
        ['b', 1],
      ]),
    });
    expect(result.canonicalsToSoftDelete).toEqual(['a']);
    expect(result.alreadyUnlisted).toBe(1);
  });

  it('skips a canonical that still backs live aliases (no orphaning)', () => {
    const result = classifyKilterDeletions({
      loweredUuids: ['a'],
      aliasRows: [aliasRow({ aliasUuid: 'a' })],
      aliasCounts: new Map([['a', 3]]),
    });
    expect(result.canonicalsToSoftDelete).toEqual([]);
    expect(result.skippedCanonicalWithAliases).toBe(1);
  });

  it('counts uuids not present in board_climb_aliases as unknown and returns them for the direct fallback', () => {
    const result = classifyKilterDeletions({
      loweredUuids: ['ghost', 'dup'],
      aliasRows: [aliasRow({ aliasUuid: 'dup', canonicalUuid: 'canon' })],
      aliasCounts: noCounts,
    });
    // 'dup' is a known alias; 'ghost' is not in the graph → unknown + surfaced.
    expect(result.unknown).toBe(1);
    expect(result.unknownLoweredUuids).toEqual(['ghost']);
  });
});

describe('planDeletionBatch', () => {
  it('caps applied changes at the batch limit, alias drops first', () => {
    const plan = planDeletionBatch({ aliasUuidsToDelete: ['a1', 'a2', 'a3'], canonicalsToSoftDelete: ['s1', 's2'] }, 3);
    expect(plan.aliasBatch).toEqual(['a1', 'a2', 'a3']);
    expect(plan.softBatch).toEqual([]);
    expect(plan.appliedThisRun).toBe(3);
    expect(plan.remaining).toBe(2);
  });

  it('spills the remaining budget into soft-deletes', () => {
    const plan = planDeletionBatch({ aliasUuidsToDelete: ['a1'], canonicalsToSoftDelete: ['s1', 's2', 's3'] }, 3);
    expect(plan.aliasBatch).toEqual(['a1']);
    expect(plan.softBatch).toEqual(['s1', 's2']);
    expect(plan.appliedThisRun).toBe(3);
    expect(plan.remaining).toBe(1);
  });
});

describe('isAnomalousDeletionBacklog', () => {
  it('trips when the backlog exceeds the fraction of live climbs', () => {
    expect(isAnomalousDeletionBacklog(30, 100)).toBe(true);
    expect(isAnomalousDeletionBacklog(20, 100)).toBe(false);
  });

  it('never trips on an empty catalog', () => {
    expect(isAnomalousDeletionBacklog(5, 0)).toBe(false);
  });
});

// Drizzle shim. Each select() call consumes the next canned result in order:
// (1) alias rows (leftJoin), (2) alias counts (groupBy) when canonicals exist,
// (3) the live-catalog count (only when applying with candidates). Each stub is a
// real resolved Promise with chain methods attached, so `await db.select()...`
// resolves to the canned rows regardless of which leftJoin/where/groupBy shape
// the query uses.
type Rows = Array<Record<string, unknown>>;
type QueryStub = Promise<Rows> & {
  leftJoin: () => QueryStub;
  where: () => QueryStub;
  groupBy: () => QueryStub;
};
function mockDb(selectResults: Rows[]) {
  const deletes: unknown[] = [];
  const updates: Array<{ set: unknown }> = [];
  let selectCall = 0;
  const stub = (rows: Rows): QueryStub => {
    const query = Promise.resolve(rows) as QueryStub;
    query.leftJoin = () => query;
    query.where = () => query;
    query.groupBy = () => query;
    return query;
  };
  const writer = {
    delete: () => ({
      where: (cond: unknown) => {
        deletes.push(cond);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (value: unknown) => {
        updates.push({ set: value });
        return { where: () => Promise.resolve() };
      },
    }),
  };
  const db = {
    select: () => ({ from: () => stub(selectResults[selectCall++] ?? []) }),
    // The apply path runs inside db.transaction(cb); hand the callback a tx that
    // records deletes/updates the same way.
    transaction: (cb: (tx: typeof writer) => Promise<unknown>) => cb(writer),
    ...writer,
  };
  return { db: db as unknown as Parameters<typeof reconcileDeletions>[0], deletes, updates };
}

describe('reconcileDeletions', () => {
  it('reports only when applyDeletions is false', async () => {
    const { db, deletes, updates } = mockDb([
      [
        {
          aliasUuid: 'dup',
          canonicalUuid: 'canon',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
      ],
      [{ canonicalUuid: 'canon', count: 2 }],
    ]);
    const report = await reconcileDeletions(db, ['dup'], false, noop);
    expect(report.aliasDeletes).toBe(1);
    expect(report.applied).toBe(false);
    expect(report.remaining).toBe(1);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('applies a pure alias drop and a lone soft-delete', async () => {
    const { db, deletes, updates } = mockDb([
      [
        {
          aliasUuid: 'dup',
          canonicalUuid: 'canon',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
        {
          aliasUuid: 'solo',
          canonicalUuid: 'solo',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
      ],
      [
        { canonicalUuid: 'canon', count: 2 },
        { canonicalUuid: 'solo', count: 1 },
      ],
      [{ count: 1000 }],
    ]);
    const report = await reconcileDeletions(db, ['dup', 'solo'], true, noop);
    expect(report.aliasDeletes).toBe(1);
    expect(report.softDeletes).toBe(1);
    expect(report.applied).toBe(true);
    expect(report.appliedThisRun).toBe(2);
    expect(deletes).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ isListed: false });
  });

  it('never soft-deletes a user-authored climb', async () => {
    const { db, deletes, updates } = mockDb([
      [
        {
          aliasUuid: 'mine',
          canonicalUuid: 'mine',
          source: 'kilter',
          canonicalSetInBoardsesh: true,
          canonicalIsListed: true,
        },
      ],
      [{ canonicalUuid: 'mine', count: 1 }],
    ]);
    const report = await reconcileDeletions(db, ['mine'], true, noop);
    expect(report.protectedUserAuthored).toBe(1);
    expect(report.softDeletes).toBe(0);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('refuses an anomalous backlog and applies nothing', async () => {
    const { db, deletes, updates } = mockDb([
      [
        {
          aliasUuid: 'solo',
          canonicalUuid: 'solo',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
      ],
      [{ canonicalUuid: 'solo', count: 1 }],
      [{ count: 1 }], // 1 candidate vs 1 live climb → over the 25% guard.
    ]);
    const report = await reconcileDeletions(db, ['solo'], true, noop);
    expect(report.refused).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.remaining).toBe(1);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('does not refuse a pure alias-drop backlog (only soft-deletes gate the guard)', async () => {
    // Two pure kilter aliases → alias drops, zero soft-deletes. No live-count
    // query is issued (softDeletes === 0 short-circuits the guard).
    const { db, deletes, updates } = mockDb([
      [
        {
          aliasUuid: 'd1',
          canonicalUuid: 'c1',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
        {
          aliasUuid: 'd2',
          canonicalUuid: 'c2',
          source: 'kilter',
          canonicalSetInBoardsesh: false,
          canonicalIsListed: true,
        },
      ],
      [
        { canonicalUuid: 'c1', count: 2 },
        { canonicalUuid: 'c2', count: 2 },
      ],
    ]);
    const report = await reconcileDeletions(db, ['d1', 'd2'], true, noop);
    expect(report.softDeletes).toBe(0);
    expect(report.aliasDeletes).toBe(2);
    expect(report.refused).toBe(false);
    expect(report.applied).toBe(true);
    expect(deletes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op on an empty delete set', async () => {
    const { db, deletes } = mockDb([]);
    const report = await reconcileDeletions(db, [], true, noop);
    expect(report.reported).toBe(0);
    expect(deletes).toHaveLength(0);
  });

  it('direct-uuid fallback: soft-deletes a live climb whose uuid the alias graph never knew', async () => {
    // 'ghost' is absent from board_climb_aliases (the self-alias gap) but matches
    // a live synced board_climbs row directly. Selects in order: (1) alias rows
    // (empty), (2) direct-uuid match, (3) live-listed count.
    const { db, deletes, updates } = mockDb([
      [], // no alias rows for 'ghost'
      [{ uuid: 'ghost', isListed: true, setInBoardsesh: false }], // direct board_climbs match
      [{ count: 1000 }], // live listed count (guard)
    ]);
    const report = await reconcileDeletions(db, ['ghost'], true, noop);
    expect(report.directUuidSoftDeletes).toBe(1);
    expect(report.softDeletes).toBe(0); // none via the alias graph
    expect(report.unknown).toBe(0); // resolved directly → no longer unknown
    expect(report.applied).toBe(true);
    expect(report.appliedThisRun).toBe(1);
    expect(deletes).toHaveLength(0); // no alias rows dropped
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ isListed: false });
  });

  it('direct-uuid fallback: an already-unlisted match counts as drained, not unknown forever', async () => {
    // 'ghost' was soft-deleted on a previous cycle (is_listed=false) and still has
    // no alias row. It must land in alreadyUnlisted — NOT stay in unknown, which
    // would misreport it as "never imported" in the log on every subsequent run.
    const { db, updates } = mockDb([
      [], // no alias rows
      [{ uuid: 'ghost', isListed: false, setInBoardsesh: false }], // direct match, drained
    ]);
    const report = await reconcileDeletions(db, ['ghost'], true, noop);
    expect(report.directUuidSoftDeletes).toBe(0);
    expect(report.alreadyUnlisted).toBe(1);
    expect(report.unknown).toBe(0);
    expect(report.applied).toBe(true); // nothing left to apply
    expect(updates).toHaveLength(0);
  });

  it('direct-uuid fallback: a user-authored match is protected, never soft-deleted', async () => {
    const { db, updates } = mockDb([
      [], // no alias rows
      [{ uuid: 'mine', isListed: true, setInBoardsesh: true }], // direct match, user-owned
    ]);
    const report = await reconcileDeletions(db, ['mine'], true, noop);
    expect(report.directUuidSoftDeletes).toBe(0);
    expect(report.protectedUserAuthored).toBe(1);
    expect(report.unknown).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('direct-uuid fallback: a NULL is_listed match is soft-deleted, not counted as drained', async () => {
    // is_listed NULL is invisible in search but has never been written
    // explicitly — a deletion Kilter reports must still write is_listed=false
    // so the sync trigger fires and offline clients receive the removal.
    const { db, updates } = mockDb([
      [], // no alias rows
      [{ uuid: 'ghost', isListed: null, setInBoardsesh: false }], // direct match, never-written flag
      [{ count: 1000 }], // live listed count (guard)
    ]);
    const report = await reconcileDeletions(db, ['ghost'], true, noop);
    expect(report.directUuidSoftDeletes).toBe(1);
    expect(report.alreadyUnlisted).toBe(0);
    expect(report.unknown).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ isListed: false });
  });

  it('direct-uuid fallback: still counts a genuinely never-imported uuid as unknown', async () => {
    // 'ghost' is in neither the alias graph nor board_climbs → stays unknown.
    const { db, updates } = mockDb([
      [], // no alias rows
      [], // no direct board_climbs match
    ]);
    const report = await reconcileDeletions(db, ['ghost'], false, noop);
    expect(report.directUuidSoftDeletes).toBe(0);
    expect(report.unknown).toBe(1);
    expect(report.applied).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
