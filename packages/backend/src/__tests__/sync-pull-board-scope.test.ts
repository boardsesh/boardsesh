import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

/**
 * Covers the layout/size scoping added to syncClimbs / syncClimbStats so a
 * downloaded board is a fixed (boardType, layout, size) superset — all sets.
 * See docs/sync-table-manifest.md.
 */

const USER_ID = 'sync-scope-user';

function ctx(): ConnectionContext {
  return {
    connectionId: 'sync-scope-conn',
    isAuthenticated: true,
    userId: USER_ID,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

type ScopeArgs = {
  boardType: string;
  layoutId?: number | null;
  sizeId?: number | null;
  cursor?: SyncCursorInput | null;
  limit?: number;
};

const callSyncClimbs = (args: ScopeArgs) =>
  syncQueries.syncClimbs(undefined, { cursor: null, limit: 500, ...args }, ctx()) as Promise<SyncResult>;

const callSyncClimbStats = (args: ScopeArgs) =>
  syncQueries.syncClimbStats(undefined, { cursor: null, limit: 500, ...args }, ctx()) as Promise<SyncResult>;

const uuidsOf = (result: SyncResult) =>
  (result.documents as Array<Record<string, unknown>>).map((d) => String(d.uuid)).sort();

const statKeysOf = (result: SyncResult) =>
  (result.documents as Array<Record<string, unknown>>).map((d) => `${String(d.climb_uuid)}@${String(d.angle)}`).sort();

async function insertClimb(opts: {
  uuid: string;
  boardType: string;
  layoutId: number;
  compatibleSizeIds: number[] | null;
}): Promise<void> {
  const sizes = opts.compatibleSizeIds === null ? null : `{${opts.compatibleSizeIds.join(',')}}`;
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    VALUES
      (${opts.uuid}, ${opts.boardType}, ${opts.layoutId}, ${'Climb ' + opts.uuid}, true, false,
       ${sizes}::int[], now())
  `);
}

async function insertStat(opts: { boardType: string; climbUuid: string; angle: number }): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    VALUES (${opts.boardType}, ${opts.climbUuid}, ${opts.angle}, 10, now())
  `);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats RESTART IDENTITY CASCADE`);
});

describe('syncClimbs — layout/size scoping', () => {
  beforeEach(async () => {
    // layout 1: two climbs, one compatible with size 5, one only with size 7
    await insertClimb({ uuid: 'k-l1-s5', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [5, 6] });
    await insertClimb({ uuid: 'k-l1-s7', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] });
    // layout 2: compatible with size 5 but wrong layout
    await insertClimb({ uuid: 'k-l2-s5', boardType: 'kilter', layoutId: 2, compatibleSizeIds: [5] });
    // a different board type entirely
    await insertClimb({ uuid: 't-l1-s5', boardType: 'tension', layoutId: 1, compatibleSizeIds: [5] });
  });

  it('returns the whole board type when no layout/size given (back-compat)', async () => {
    const result = await callSyncClimbs({ boardType: 'kilter' });
    expect(uuidsOf(result)).toEqual(['k-l1-s5', 'k-l1-s7', 'k-l2-s5']);
  });

  it('scopes to a single layout when layoutId given', async () => {
    const result = await callSyncClimbs({ boardType: 'kilter', layoutId: 1 });
    expect(uuidsOf(result)).toEqual(['k-l1-s5', 'k-l1-s7']);
  });

  it('scopes to layout AND size (compatible_size_ids contains sizeId)', async () => {
    const result = await callSyncClimbs({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
    expect(uuidsOf(result)).toEqual(['k-l1-s5']);
  });

  it('emits the characteristics column in the document', async () => {
    const result = await callSyncClimbs({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
    const doc = result.documents[0] as Record<string, unknown>;
    expect(doc).toHaveProperty('characteristics');
  });
});

describe('syncClimbs — moonboard skips the size filter', () => {
  beforeEach(async () => {
    // MoonBoard climbs aren't size-scoped; compatible_size_ids may be null.
    await insertClimb({ uuid: 'm-l1-a', boardType: 'moonboard', layoutId: 1, compatibleSizeIds: null });
    await insertClimb({ uuid: 'm-l1-b', boardType: 'moonboard', layoutId: 1, compatibleSizeIds: [9] });
    await insertClimb({ uuid: 'm-l2-a', boardType: 'moonboard', layoutId: 2, compatibleSizeIds: null });
  });

  it('ignores sizeId for moonboard but still honours layoutId', async () => {
    const result = await callSyncClimbs({ boardType: 'moonboard', layoutId: 1, sizeId: 5 });
    expect(uuidsOf(result)).toEqual(['m-l1-a', 'm-l1-b']);
  });
});

describe('syncClimbStats — scoping via correlated board_climbs EXISTS', () => {
  beforeEach(async () => {
    await insertClimb({ uuid: 'k-l1-s5', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'k-l1-s7', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] });
    await insertClimb({ uuid: 'k-l2-s5', boardType: 'kilter', layoutId: 2, compatibleSizeIds: [5] });
    await insertStat({ boardType: 'kilter', climbUuid: 'k-l1-s5', angle: 40 });
    await insertStat({ boardType: 'kilter', climbUuid: 'k-l1-s7', angle: 40 });
    await insertStat({ boardType: 'kilter', climbUuid: 'k-l2-s5', angle: 40 });
    // an orphan stat with no matching climb row — excluded once scoped
    await insertStat({ boardType: 'kilter', climbUuid: 'k-orphan', angle: 40 });
  });

  it('returns all stats for the board type when unscoped (back-compat)', async () => {
    const result = await callSyncClimbStats({ boardType: 'kilter' });
    expect(statKeysOf(result)).toEqual(['k-l1-s5@40', 'k-l1-s7@40', 'k-l2-s5@40', 'k-orphan@40']);
  });

  it('scopes stats to the climbs of the given layout', async () => {
    const result = await callSyncClimbStats({ boardType: 'kilter', layoutId: 1 });
    expect(statKeysOf(result)).toEqual(['k-l1-s5@40', 'k-l1-s7@40']);
  });

  it('scopes stats to the climbs of the given layout AND size', async () => {
    const result = await callSyncClimbStats({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
    expect(statKeysOf(result)).toEqual(['k-l1-s5@40']);
  });
});

describe('syncClimbs — cursor pagination holds under a scope filter', () => {
  beforeEach(async () => {
    // 5 climbs in the scoped set that share an updated_at (collision), plus noise
    // outside the scope that must never appear or advance the cursor.
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO board_climbs
          (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
        VALUES (${'in-' + i}, 'kilter', 1, 'in', true, false, '{5}'::int[], '2026-05-02T12:00:00Z')
      `);
    }
    await insertClimb({ uuid: 'out-layout', boardType: 'kilter', layoutId: 2, compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'out-size', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [9] });
  });

  it('pages the scoped set without skipping, duplicating, or leaking out-of-scope rows', async () => {
    const seen = new Set<string>();
    let cursor: SyncCursorInput | null = null;
    let hasMore = true;
    let pages = 0;

    while (hasMore) {
      const page: SyncResult = await callSyncClimbs({ boardType: 'kilter', layoutId: 1, sizeId: 5, cursor, limit: 2 });
      pages++;
      for (const doc of page.documents as Array<Record<string, unknown>>) {
        seen.add(String(doc.uuid));
      }
      cursor = page.cursor;
      hasMore = page.hasMore;
      expect(pages).toBeLessThan(10);
    }

    expect([...seen].sort()).toEqual(['in-0', 'in-1', 'in-2', 'in-3', 'in-4']);
    expect(seen.has('out-layout')).toBe(false);
    expect(seen.has('out-size')).toBe(false);
  });
});
