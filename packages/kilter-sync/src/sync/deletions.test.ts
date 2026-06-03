import { describe, expect, it } from 'vitest';

import { reconcileDeletions } from './deletions';

type Row = Record<string, unknown>;

// Drizzle shim. reconcileDeletions issues two reads against board_climb_aliases:
// the 1st is select().from().where() (alias rows), the 2nd adds .groupBy()
// (alias counts) and only runs when there are canonicals. A select-call counter
// returns the right shape for each, and delete/update calls are recorded.
function mockDb(seed: { aliasRows: Row[]; counts: Row[] }) {
  const deletes: unknown[] = [];
  const updates: Array<{ set: unknown }> = [];
  let selectCall = 0;
  const db = {
    select() {
      const isFirst = selectCall++ === 0;
      return {
        from: () => ({
          where: () => (isFirst ? Promise.resolve(seed.aliasRows) : { groupBy: () => Promise.resolve(seed.counts) }),
        }),
      };
    },
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
  return { db: db as unknown as Parameters<typeof reconcileDeletions>[0], deletes, updates };
}

const noop = () => {};

void describe('reconcileDeletions', () => {
  it('drops a pure alias and leaves the canonical intact', async () => {
    const { db, deletes, updates } = mockDb({
      aliasRows: [{ aliasUuid: 'dup', canonicalUuid: 'canon' }],
      counts: [{ canonicalUuid: 'canon', count: 2 }],
    });
    const report = await reconcileDeletions(db, ['dup'], true, noop);
    expect(report.aliasDeletes).toBe(1);
    expect(report.softDeletes).toBe(0);
    expect(report.applied).toBe(true);
    expect(deletes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('soft-deletes a lone self-canonical (is_listed=false), never hard-deletes', async () => {
    const { db, deletes, updates } = mockDb({
      aliasRows: [{ aliasUuid: 'solo', canonicalUuid: 'solo' }],
      counts: [{ canonicalUuid: 'solo', count: 1 }],
    });
    const report = await reconcileDeletions(db, ['solo'], true, noop);
    expect(report.softDeletes).toBe(1);
    expect(report.aliasDeletes).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ isListed: false });
    expect(deletes).toHaveLength(0); // canonical climb is never deleted
  });

  it('skips a canonical that still backs live aliases (no orphaning)', async () => {
    const { db, deletes, updates } = mockDb({
      aliasRows: [{ aliasUuid: 'canon', canonicalUuid: 'canon' }],
      counts: [{ canonicalUuid: 'canon', count: 3 }],
    });
    const report = await reconcileDeletions(db, ['canon'], true, noop);
    expect(report.skippedCanonicalWithAliases).toBe(1);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('reports only when applyDeletions is false', async () => {
    const { db, deletes, updates } = mockDb({
      aliasRows: [{ aliasUuid: 'dup', canonicalUuid: 'canon' }],
      counts: [{ canonicalUuid: 'canon', count: 2 }],
    });
    const report = await reconcileDeletions(db, ['dup'], false, noop);
    expect(report.aliasDeletes).toBe(1);
    expect(report.applied).toBe(false);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('counts unknown uuids not present in board_*', async () => {
    const { db } = mockDb({ aliasRows: [], counts: [] });
    const report = await reconcileDeletions(db, ['ghost-1', 'ghost-2'], true, noop);
    expect(report.unknown).toBe(2);
    expect(report.aliasDeletes).toBe(0);
  });

  it('is a no-op on an empty delete set', async () => {
    const { db, deletes } = mockDb({ aliasRows: [], counts: [] });
    const report = await reconcileDeletions(db, [], true, noop);
    expect(report.reported).toBe(0);
    expect(deletes).toHaveLength(0);
  });
});
