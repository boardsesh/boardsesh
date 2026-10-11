import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import {
  AUDIENCE_BOARD_TYPE,
  AUDIENCE_FOLLOWER,
  AUDIENCE_LAYOUT_ID,
  AUDIENCE_OTHER_SIZE_ID,
  AUDIENCE_OWNER,
  AUDIENCE_PENDING_FOLLOWER,
  AUDIENCE_SIZE_ID,
  AUDIENCE_SPRAY_LAYOUT_ID,
  AUDIENCE_STRANGER,
  AUDIENCE_VIEWERS,
  expectStreamsPartitionUnion,
  keysOf,
  pullAllDocuments,
  pullAudiencePage,
  pullAudienceStreams,
  seedSyncAudienceFixture,
} from './helpers/sync-audience-fixture';

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

  it('returns authorized catalog grades when unscoped, excluding missing climbs', async () => {
    const result = await callSyncClimbGrades({ boardType: 'kilter' });
    expect(gradeKeysOf(result)).toEqual(['g-l1-s5@40', 'g-l1-s7@40', 'g-l2-s5@40']);
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

// The audience split (#6306) for grades. Same fixture and same contract as the
// climb and stats coverage in sync-pull-board-scope.test.ts.
describe('syncClimbGrades — audience split', () => {
  const RESOLVER = 'syncClimbGrades';
  const LAYOUT = { boardType: AUDIENCE_BOARD_TYPE, layoutId: AUDIENCE_LAYOUT_ID };
  const WALL = { boardType: 'spray', layoutId: AUDIENCE_SPRAY_LAYOUT_ID, sizeId: AUDIENCE_SPRAY_LAYOUT_ID };

  // `ref-a` and `own-private` are graded at two angles, the rest at one.
  const REFERENCE_GRADES = ['ref-a@40', 'ref-a@45', 'ref-b@40', 'ref-size-7@40'];
  // Without an accepted follow: the public account's climb, the deleted
  // account's retained one, and the private account's current Public choice.
  const OPEN_TO_EVERYONE = ['deleted-public@40', 'own-public-consent@40', 'own-public@40'];
  const PROTECTED_GRADES = {
    [AUDIENCE_OWNER]: [
      'deleted-public@40',
      'own-only-me@40',
      'own-private-size-7@40',
      'own-private@40',
      'own-private@45',
      'own-public-consent@40',
      'own-public@40',
      'own-stale-consent@40',
    ],
    [AUDIENCE_FOLLOWER]: [
      'deleted-public@40',
      'own-private-size-7@40',
      'own-private@40',
      'own-private@45',
      'own-public-consent@40',
      'own-public@40',
      'own-stale-consent@40',
    ],
    [AUDIENCE_PENDING_FOLLOWER]: OPEN_TO_EVERYONE,
    [AUDIENCE_STRANGER]: OPEN_TO_EVERYONE,
  };

  beforeEach(async () => {
    await seedSyncAudienceFixture();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(AUDIENCE_VIEWERS)('for %s', (viewerId) => {
    it('splits the grades into two disjoint streams that add up to the union', async () => {
      const streams = await pullAudienceStreams({ resolver: RESOLVER, scope: LAYOUT, viewerId });
      expectStreamsPartitionUnion(RESOLVER, streams);
      expect(keysOf(RESOLVER, streams.reference)).toEqual(REFERENCE_GRADES);
      expect(keysOf(RESOLVER, streams.protectedStream)).toEqual(PROTECTED_GRADES[viewerId]);
    });

    it('scopes both streams to a size, and to the whole board type when no layout is given', async () => {
      for (const sizeId of [AUDIENCE_SIZE_ID, AUDIENCE_OTHER_SIZE_ID]) {
        const sized = await pullAudienceStreams({ resolver: RESOLVER, scope: { ...LAYOUT, sizeId }, viewerId });
        expectStreamsPartitionUnion(RESOLVER, sized);
        const inSize = (key: string) => key.includes('-size-7@') === (sizeId === AUDIENCE_OTHER_SIZE_ID);
        expect(keysOf(RESOLVER, sized.reference)).toEqual(REFERENCE_GRADES.filter(inSize));
        expect(keysOf(RESOLVER, sized.protectedStream)).toEqual(PROTECTED_GRADES[viewerId].filter(inSize));
      }

      const everyLayout = await pullAudienceStreams({
        resolver: RESOLVER,
        scope: { boardType: AUDIENCE_BOARD_TYPE },
        viewerId,
      });
      expectStreamsPartitionUnion(RESOLVER, everyLayout);
      expect(keysOf(RESOLVER, everyLayout.reference)).toContain('other-layout-ref@40');
      expect(keysOf(RESOLVER, everyLayout.protectedStream)).toContain('other-layout-own@40');
    });

    it('pages each stream to the same rows whatever the page size', async () => {
      for (const audience of ['REFERENCE', 'PROTECTED'] as const) {
        const inOnePage = await pullAllDocuments({ resolver: RESOLVER, scope: LAYOUT, viewerId, audience });
        // Every grade shares one computed_at, so only sync_seq moves the cursor.
        const twoAtATime = await pullAllDocuments({
          resolver: RESOLVER,
          scope: LAYOUT,
          viewerId,
          audience,
          pageSize: 2,
        });
        expect(twoAtATime).toEqual(inOnePage);
      }
    });
  });

  it('serves the same REFERENCE grades to every viewer', async () => {
    const [asOwner, ...asEveryoneElse] = await Promise.all(
      AUDIENCE_VIEWERS.map((viewerId) =>
        pullAllDocuments({ resolver: RESOLVER, scope: LAYOUT, viewerId, audience: 'REFERENCE' }),
      ),
    );
    expect(asEveryoneElse).toHaveLength(AUDIENCE_VIEWERS.length - 1);
    for (const asAnotherViewer of asEveryoneElse) {
      expect(asAnotherViewer).toEqual(asOwner);
    }
  });

  it('returns the same PROTECTED pages whether driven from the climbs or walked in cursor order', async () => {
    const pageThrough = () =>
      pullAllDocuments({
        resolver: RESOLVER,
        scope: { ...LAYOUT, sizeId: AUDIENCE_SIZE_ID },
        viewerId: AUDIENCE_OWNER,
        audience: 'PROTECTED',
        pageSize: 2,
      });
    const firstPage = () =>
      pullAudiencePage({
        resolver: RESOLVER,
        scope: LAYOUT,
        viewerId: AUDIENCE_OWNER,
        audience: 'PROTECTED',
        limit: 3,
      });

    const drivenDocuments = await pageThrough();
    const drivenFirstPage = await firstPage();
    // Zero candidates allowed: every page takes the cursor-order walk.
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', '0');
    const walkedDocuments = await pageThrough();
    const walkedFirstPage = await firstPage();

    expect(drivenDocuments.length).toBeGreaterThan(2);
    expect(walkedDocuments).toEqual(drivenDocuments);
    // Same rows, same order, same cursor: a cursor from one shape resumes on the other.
    expect(walkedFirstPage).toEqual(drivenFirstPage);
    expect(drivenFirstPage.hasMore).toBe(true);
  });

  it('has no REFERENCE grades for a spray wall, and PROTECTED is what the viewer may see on it', async () => {
    const cursor = { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '7' };
    for (const viewerId of [AUDIENCE_OWNER, AUDIENCE_STRANGER]) {
      const page = await pullAudiencePage({ resolver: RESOLVER, scope: WALL, viewerId, audience: 'REFERENCE', cursor });
      expect(page).toEqual({ documents: [], cursor: { updatedAt: cursor.updatedAt, syncSeq: '7' }, hasMore: false });
    }

    const asOwner = await pullAudienceStreams({ resolver: RESOLVER, scope: WALL, viewerId: AUDIENCE_OWNER });
    expectStreamsPartitionUnion(RESOLVER, asOwner);
    expect(keysOf(RESOLVER, asOwner.protectedStream)).toEqual(['spray-orphan@40', 'spray-own@40']);

    const asStranger = await pullAudienceStreams({ resolver: RESOLVER, scope: WALL, viewerId: AUDIENCE_STRANGER });
    expect(asStranger).toEqual({ union: [], reference: [], protectedStream: [] });
  });
});
