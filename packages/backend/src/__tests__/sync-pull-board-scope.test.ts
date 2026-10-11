import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { withdrawDeletedAccountContent } from '../graphql/resolvers/users/delete-account-privacy';
import {
  AUDIENCE_BOARD_TYPE,
  AUDIENCE_FOLLOWER,
  AUDIENCE_LAYOUT_ID,
  AUDIENCE_OTHER_SIZE_ID,
  AUDIENCE_OWNER,
  AUDIENCE_PUBLIC_AUTHOR,
  AUDIENCE_SIZE_ID,
  AUDIENCE_SPRAY_LAYOUT_ID,
  AUDIENCE_STRANGER,
  AUDIENCE_VIEWERS,
  FIRST_ASCENT_CLIMB_UUID,
  audienceContext,
  expectStreamsPartitionUnion,
  keysOf,
  pullAllDocuments,
  pullAudiencePage,
  pullAudienceStreams,
  seedSyncAudienceFixture,
} from './helpers/sync-audience-fixture';

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

  it('returns authorized catalog stats when unscoped, excluding missing climbs', async () => {
    const result = await callSyncClimbStats({ boardType: 'kilter' });
    expect(statKeysOf(result)).toEqual(['k-l1-s5@40', 'k-l1-s7@40', 'k-l2-s5@40']);
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

// The audience split (#6306): `syncClimbs` and `syncClimbStats` with
// `audience: REFERENCE | PROTECTED`. Grades have the same coverage in
// sync-pull-grades.test.ts; the fixture is shared.
describe('audience split — REFERENCE and PROTECTED partition the single-stream pull', () => {
  const LAYOUT = { boardType: AUDIENCE_BOARD_TYPE, layoutId: AUDIENCE_LAYOUT_ID };
  const WALL = { boardType: 'spray', layoutId: AUDIENCE_SPRAY_LAYOUT_ID, sizeId: AUDIENCE_SPRAY_LAYOUT_ID };

  const REFERENCE_CLIMBS = ['ref-a', 'ref-b', 'ref-size-7'];
  const PROTECTED_CLIMBS = {
    [AUDIENCE_OWNER]: ['deleted-public', 'own-only-me', 'own-private', 'own-private-size-7', 'own-public'],
    [AUDIENCE_FOLLOWER]: ['deleted-public', 'own-private', 'own-private-size-7', 'own-public'],
    [AUDIENCE_STRANGER]: ['deleted-public', 'own-public'],
  };
  // Nobody may see these, so they are in neither stream and not in the union:
  // a deleted account's restricted climb, and a policy row on an unowned climb.
  const WITHHELD_CLIMBS = ['deleted-private', 'orphan-policy'];

  beforeEach(async () => {
    await seedSyncAudienceFixture();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(AUDIENCE_VIEWERS)('for %s', (viewerId) => {
    it.each(['syncClimbs', 'syncClimbStats'] as const)(
      '%s: the two streams are disjoint and add up to the union',
      async (resolver) => {
        const streams = await pullAudienceStreams({ resolver, scope: LAYOUT, viewerId });
        expectStreamsPartitionUnion(resolver, streams);
        expect(streams.union.length).toBeGreaterThan(streams.reference.length);
      },
    );

    it('puts each climb in the stream its ownership says, and the withheld ones in neither', async () => {
      const streams = await pullAudienceStreams({ resolver: 'syncClimbs', scope: LAYOUT, viewerId });
      expect(keysOf('syncClimbs', streams.reference)).toEqual(REFERENCE_CLIMBS);
      expect(keysOf('syncClimbs', streams.protectedStream)).toEqual(PROTECTED_CLIMBS[viewerId]);
      for (const uuid of WITHHELD_CLIMBS) {
        expect(keysOf('syncClimbs', streams.union)).not.toContain(uuid);
      }
    });

    it('scopes both streams to a size, and to the whole board type when no layout is given', async () => {
      for (const sizeId of [AUDIENCE_SIZE_ID, AUDIENCE_OTHER_SIZE_ID]) {
        const sized = await pullAudienceStreams({ resolver: 'syncClimbs', scope: { ...LAYOUT, sizeId }, viewerId });
        expectStreamsPartitionUnion('syncClimbs', sized);
        const inSize = (uuid: string) => uuid.endsWith('-size-7') === (sizeId === AUDIENCE_OTHER_SIZE_ID);
        expect(keysOf('syncClimbs', sized.reference)).toEqual(REFERENCE_CLIMBS.filter(inSize));
        expect(keysOf('syncClimbs', sized.protectedStream)).toEqual(PROTECTED_CLIMBS[viewerId].filter(inSize));

        const sizedStats = await pullAudienceStreams({
          resolver: 'syncClimbStats',
          scope: { ...LAYOUT, sizeId },
          viewerId,
        });
        expectStreamsPartitionUnion('syncClimbStats', sizedStats);
      }

      const boardWide = { boardType: AUDIENCE_BOARD_TYPE };
      const everyLayout = await pullAudienceStreams({ resolver: 'syncClimbs', scope: boardWide, viewerId });
      expectStreamsPartitionUnion('syncClimbs', everyLayout);
      expect(keysOf('syncClimbs', everyLayout.reference)).toContain('other-layout-ref');
      expect(keysOf('syncClimbs', everyLayout.protectedStream)).toContain('other-layout-own');
      expectStreamsPartitionUnion(
        'syncClimbStats',
        await pullAudienceStreams({ resolver: 'syncClimbStats', scope: boardWide, viewerId }),
      );
    });

    it.each(['syncClimbs', 'syncClimbStats'] as const)(
      '%s: each stream pages to the same rows whatever the page size',
      async (resolver) => {
        for (const audience of ['REFERENCE', 'PROTECTED'] as const) {
          const inOnePage = await pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience });
          // Every row shares one timestamp, so only sync_seq moves the cursor.
          const twoAtATime = await pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience, pageSize: 2 });
          expect(twoAtATime).toEqual(inOnePage);
        }
      },
    );
  });

  it('serves the same REFERENCE rows to every viewer', async () => {
    for (const resolver of ['syncClimbs', 'syncClimbStats'] as const) {
      const [asOwner, asFollower, asStranger] = await Promise.all(
        AUDIENCE_VIEWERS.map((viewerId) =>
          pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience: 'REFERENCE' }),
        ),
      );
      expect(asFollower).toEqual(asOwner);
      expect(asStranger).toEqual(asOwner);
    }
  });

  it('ships the stored manufacturer credit on REFERENCE stats and no name at all on PROTECTED stats', async () => {
    const streams = await pullAudienceStreams({
      resolver: 'syncClimbStats',
      scope: LAYOUT,
      viewerId: AUDIENCE_STRANGER,
    });
    const statsFor = (documents: typeof streams.union, climbUuid: string) =>
      documents.find((document) => document.climb_uuid === climbUuid && document.angle === 40);

    expect(statsFor(streams.reference, 'ref-a')).toMatchObject({
      fa_username: 'Stored FA ref-a',
      fa_at: '2020-01-02T03:04:05Z',
    });
    // The single stream projects the name from a tick this viewer may see...
    expect(statsFor(streams.union, FIRST_ASCENT_CLIMB_UUID)).toMatchObject({
      fa_username: AUDIENCE_PUBLIC_AUTHOR,
      fa_at: '2020-01-02T03:04:05Z',
    });
    // ...and PROTECTED withholds it anyway, with every other column intact.
    expect(statsFor(streams.protectedStream, FIRST_ASCENT_CLIMB_UUID)).toMatchObject({
      fa_username: null,
      fa_at: null,
      display_difficulty: 20,
      ascensionist_count: '3',
    });
    for (const document of streams.protectedStream) {
      expect(document.fa_username).toBeNull();
      expect(document.fa_at).toBeNull();
    }
  });

  it('returns the same PROTECTED stats pages whether driven from the climbs or walked in cursor order', async () => {
    const pageThrough = () =>
      pullAllDocuments({
        resolver: 'syncClimbStats',
        scope: { ...LAYOUT, sizeId: AUDIENCE_SIZE_ID },
        viewerId: AUDIENCE_OWNER,
        audience: 'PROTECTED',
        pageSize: 2,
      });
    const firstPage = () =>
      pullAudiencePage({
        resolver: 'syncClimbStats',
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

  describe('spray walls have no reference set', () => {
    it.each(['syncClimbs', 'syncClimbStats'] as const)(
      '%s: REFERENCE is empty for the wall owner too, and echoes the cursor',
      async (resolver) => {
        const cursor = { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '7' };
        for (const viewerId of [AUDIENCE_OWNER, AUDIENCE_STRANGER]) {
          const page = await pullAudiencePage({ resolver, scope: WALL, viewerId, audience: 'REFERENCE', cursor });
          expect(page).toEqual({
            documents: [],
            cursor: { updatedAt: cursor.updatedAt, syncSeq: '7' },
            hasMore: false,
          });
        }
      },
    );

    it.each(['syncClimbs', 'syncClimbStats'] as const)(
      '%s: PROTECTED is everything the viewer may see on the wall',
      async (resolver) => {
        const asOwner = await pullAudienceStreams({ resolver, scope: WALL, viewerId: AUDIENCE_OWNER });
        expectStreamsPartitionUnion(resolver, asOwner);
        expect(asOwner.reference).toEqual([]);
        // The ownerless legacy climb included: with no reference stream to carry
        // it, PROTECTED is the only way it reaches the wall's owner.
        expect(keysOf('syncClimbs', await pullWallClimbs(AUDIENCE_OWNER))).toEqual(['spray-orphan', 'spray-own']);

        const asStranger = await pullAudienceStreams({ resolver, scope: WALL, viewerId: AUDIENCE_STRANGER });
        expect(asStranger).toEqual({ union: [], reference: [], protectedStream: [] });
      },
    );

    function pullWallClimbs(viewerId: string) {
      return pullAllDocuments({ resolver: 'syncClimbs', scope: WALL, viewerId, audience: 'PROTECTED' });
    }
  });

  it('keeps a deleted account’s public climb in PROTECTED and delivers it again past the old cursor', async () => {
    const stranger = { resolver: 'syncClimbs' as const, scope: LAYOUT, viewerId: AUDIENCE_STRANGER };
    const tail = await pullAudiencePage({ ...stranger, audience: 'PROTECTED' });
    expect(tail.hasMore).toBe(false);
    expect(keysOf('syncClimbs', tail.documents as Record<string, unknown>[])).toContain('own-public');

    await db.transaction(async (transaction) => {
      await withdrawDeletedAccountContent(transaction, AUDIENCE_PUBLIC_AUTHOR);
      await transaction.execute(sql`DELETE FROM users WHERE id = ${AUDIENCE_PUBLIC_AUTHOR}`);
    });

    // The author flag and the cleared owner both bumped the row, so a phone at
    // the old tail gets the ownerless copy without replaying from epoch.
    const afterDeletion = await pullAudiencePage({ ...stranger, audience: 'PROTECTED', cursor: tail.cursor });
    const redelivered = (afterDeletion.documents as Record<string, unknown>[]).find(
      (document) => document.uuid === 'own-public',
    );
    expect(redelivered).toMatchObject({ uuid: 'own-public', user_id: null });

    const streams = await pullAudienceStreams(stranger);
    expectStreamsPartitionUnion('syncClimbs', streams);
    expect(keysOf('syncClimbs', streams.reference)).toEqual(REFERENCE_CLIMBS);
    expect(keysOf('syncClimbs', streams.protectedStream)).toContain('own-public');
  });

  it('cannot move a catalogue climb out of REFERENCE: a policy row needs an owner', async () => {
    // A policy row arriving on, or leaving, an unowned climb would change its
    // stream without bumping the climb, and a phone resuming REFERENCE from a
    // watermark would never hear of it. The API has no way to write one.
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    await expect(
      privacyMutations.setContentAudience(
        null,
        { input: { entityType: 'climb', entityId: 'ref-a', audience: 'only_me', privacyRevision: 0 } },
        audienceContext(AUDIENCE_OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    const policyRows = await db.execute(
      sql`SELECT 1 FROM content_privacy WHERE entity_type = 'climb' AND entity_id = 'ref-a'`,
    );
    expect(policyRows).toHaveLength(0);
    const reference = await pullAllDocuments({
      resolver: 'syncClimbs',
      scope: LAYOUT,
      viewerId: AUDIENCE_STRANGER,
      audience: 'REFERENCE',
    });
    expect(keysOf('syncClimbs', reference)).toContain('ref-a');
  });

  it('rejects an audience the schema does not define', async () => {
    await expect(
      syncQueries.syncClimbs(
        undefined,
        { ...LAYOUT, cursor: null, limit: 500, audience: 'EVERYONE' as unknown as 'REFERENCE' },
        audienceContext(AUDIENCE_OWNER),
      ),
    ).rejects.toThrow(/audience/);
  });
});
