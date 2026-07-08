import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

/**
 * Covers syncClimbGrades — the offline pull for board_climb_grades. Mirrors the
 * syncClimbStats coverage (sync-pull-board-scope.test.ts): composite-cursor
 * paging on (computed_at, sync_seq), layout/size scoping via a correlated
 * board_climbs EXISTS (grades has no layout_id column), the auth requirement,
 * and an empty tail that echoes the supplied cursor. See docs/sync-table-manifest.md.
 */

const USER_ID = 'sync-grades-user';

function ctx(authenticated = true): ConnectionContext {
  return {
    connectionId: 'sync-grades-conn',
    isAuthenticated: authenticated,
    userId: authenticated ? USER_ID : null,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

type GradesArgs = {
  boardType: string;
  layoutId?: number | null;
  sizeId?: number | null;
  cursor?: SyncCursorInput | null;
  limit?: number;
};

const callSyncClimbGrades = (args: GradesArgs, connection: ConnectionContext = ctx()) =>
  syncQueries.syncClimbGrades(undefined, { cursor: null, limit: 500, ...args }, connection) as Promise<SyncResult>;

const gradeKeysOf = (result: SyncResult) =>
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

async function insertGrade(opts: {
  boardType: string;
  climbUuid: string;
  angle: number;
  localGrade?: number | null;
  universalGrade?: number | null;
  confidence?: string;
  computedAt?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high,
       confidence, ascensionist_count, model_version, coeff_version, computed_at)
    VALUES
      (${opts.boardType}, ${opts.climbUuid}, ${opts.angle}, ${opts.localGrade ?? 20.0},
       ${opts.universalGrade ?? 21.5}, 20.0, 23.0, ${opts.confidence ?? 'confirmed'}, 42,
       'test-model', 'test-coeff', ${opts.computedAt ?? sql`now()`})
  `);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_grades RESTART IDENTITY CASCADE`);
});

describe('syncClimbGrades — document shape', () => {
  beforeEach(async () => {
    await insertClimb({ uuid: 'g-shape', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [5] });
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-shape', angle: 40, universalGrade: 22.5 });
  });

  it('emits the surfaced grade + band + sync columns, dropping model/coeff/content_prior', async () => {
    const result = await callSyncClimbGrades({ boardType: 'kilter' });
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0] as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'angle',
        'ascensionist_count',
        'board_type',
        'climb_uuid',
        'computed_at',
        'confidence',
        'grade_high',
        'grade_low',
        'local_grade',
        'sync_seq',
        'universal_grade',
      ].sort(),
    );
    expect(doc.climb_uuid).toBe('g-shape');
    expect(doc.confidence).toBe('confirmed');
    expect(doc.universal_grade).toBe(22.5);
    expect(typeof doc.computed_at).toBe('string');
    // Device never needs the model bookkeeping.
    expect(doc).not.toHaveProperty('model_version');
    expect(doc).not.toHaveProperty('coeff_version');
    expect(doc).not.toHaveProperty('content_prior');
    // Cursor scaffolding is stripped.
    expect(doc).not.toHaveProperty('__seq');
    expect(doc).not.toHaveProperty('__updated_at');
    expect(result.hasMore).toBe(false);
  });
});

describe('syncClimbGrades — composite-cursor pagination', () => {
  beforeEach(async () => {
    await insertClimb({ uuid: 'g-collide', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [5] });
  });

  it('pages through a computed_at collision without skipping or duplicating rows', async () => {
    // 7 grades on the same climb across 7 angles that ALL share computed_at — the
    // batch-recompute collision. Only sync_seq differentiates them.
    const sharedTs = '2026-05-02T12:00:00Z';
    const total = 7;
    for (let i = 0; i < total; i++) {
      await insertGrade({ boardType: 'kilter', climbUuid: 'g-collide', angle: 20 + i, computedAt: sharedTs });
    }

    const pageSize = 3;
    const seen = new Set<string>();
    let cursor: SyncCursorInput | null = null;
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
      const page: SyncResult = await callSyncClimbGrades({ boardType: 'kilter', cursor, limit: pageSize });
      pages++;
      for (const doc of page.documents as Array<Record<string, unknown>>) {
        seen.add(String(doc.angle));
      }
      cursor = page.cursor;
      hasMore = page.hasMore;
      expect(pages).toBeLessThan(10);
    }

    expect(seen.size).toBe(total);
    for (let i = 0; i < total; i++) {
      expect(seen.has(String(20 + i))).toBe(true);
    }
    // ceil(7 / 3) = 3 pages; the cursor advanced by sync_seq within the shared timestamp.
    expect(pages).toBe(3);
  });

  it('returns the supplied cursor unchanged when there are no new rows (empty tail)', async () => {
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-collide', angle: 40 });
    const cursor: SyncCursorInput = { updatedAt: '2030-01-01T00:00:00Z', syncSeq: '999999' };
    const result = await callSyncClimbGrades({ boardType: 'kilter', cursor });
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor.updatedAt).toBe('2030-01-01T00:00:00Z');
    expect(result.cursor.syncSeq).toBe('999999');
  });
});

describe('syncClimbGrades — scoping via correlated board_climbs EXISTS', () => {
  beforeEach(async () => {
    await insertClimb({ uuid: 'g-l1-s5', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'g-l1-s7', boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] });
    await insertClimb({ uuid: 'g-l2-s5', boardType: 'kilter', layoutId: 2, compatibleSizeIds: [5] });
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-l1-s5', angle: 40 });
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-l1-s7', angle: 40 });
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-l2-s5', angle: 40 });
    // an orphan grade with no matching climb row — excluded once scoped
    await insertGrade({ boardType: 'kilter', climbUuid: 'g-orphan', angle: 40 });
    // a different board type entirely — never leaks
    await insertClimb({ uuid: 't-l1-s5', boardType: 'tension', layoutId: 1, compatibleSizeIds: [5] });
    await insertGrade({ boardType: 'tension', climbUuid: 't-l1-s5', angle: 40 });
  });

  it('returns all grades for the board type when unscoped (back-compat)', async () => {
    const result = await callSyncClimbGrades({ boardType: 'kilter' });
    expect(gradeKeysOf(result)).toEqual(['g-l1-s5@40', 'g-l1-s7@40', 'g-l2-s5@40', 'g-orphan@40']);
  });

  it('scopes grades to the climbs of the given layout', async () => {
    const result = await callSyncClimbGrades({ boardType: 'kilter', layoutId: 1 });
    expect(gradeKeysOf(result)).toEqual(['g-l1-s5@40', 'g-l1-s7@40']);
  });

  it('scopes grades to the climbs of the given layout AND size', async () => {
    const result = await callSyncClimbGrades({ boardType: 'kilter', layoutId: 1, sizeId: 5 });
    expect(gradeKeysOf(result)).toEqual(['g-l1-s5@40']);
  });
});

describe('syncClimbGrades — auth requirement', () => {
  it('throws when the connection is unauthenticated', async () => {
    await expect(callSyncClimbGrades({ boardType: 'kilter' }, ctx(false))).rejects.toThrow(/Authentication required/);
  });
});
