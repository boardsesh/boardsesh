import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import {
  AUDIENCE_BOARD_TYPE,
  AUDIENCE_FOLLOWER,
  AUDIENCE_LAYOUT_ID,
  AUDIENCE_OTHER_SIZE_ID,
  AUDIENCE_OWNER,
  AUDIENCE_PENDING_FOLLOWER,
  AUDIENCE_PUBLIC_AUTHOR,
  AUDIENCE_SIZE_ID,
  AUDIENCE_SPRAY_LAYOUT_ID,
  AUDIENCE_STRANGER,
  AUDIENCE_VIEWERS,
  EXPECTED_ON_LAYOUT,
  FIRST_ASCENT_CLIMB_UUID,
  audienceContext,
  expectStreamsPartitionUnion,
  keysOf,
  pullAllDocuments,
  pullAudiencePage,
  pullAudienceStreams,
  seedSyncAudienceFixture,
  type AudienceResolver,
  type AudienceStreams,
  type SyncDocument,
} from './helpers/sync-audience-fixture';

/**
 * The publication rule on the board sync (#6306), for `syncClimbs`,
 * `syncClimbStats` and `syncClimbGrades` in all three ways of asking.
 *
 *  - A climb that is published and listed is public: every caller gets it,
 *    whoever set it, whatever that account's privacy settings or the climb's
 *    own audience say. That is `REFERENCE`.
 *  - A draft or an unlisted climb goes to its owner alone. That is the owner's
 *    `PROTECTED`. One with no owner goes to no one.
 *  - A request with no audience gets both in one stream.
 *
 * And the split keeps its contract for every caller: the two streams are
 * disjoint and add up to the single stream.
 */

const RESOLVERS = ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'] as const;
const LAYOUT = { boardType: AUDIENCE_BOARD_TYPE, layoutId: AUDIENCE_LAYOUT_ID };
const BOARD = { boardType: AUDIENCE_BOARD_TYPE };
const WALL = { boardType: 'spray', layoutId: AUDIENCE_SPRAY_LAYOUT_ID, sizeId: AUDIENCE_SPRAY_LAYOUT_ID };

/** A document key's climb: `uuid` for a climb, `uuid@angle` for a stats or grades row. */
const climbOf = (key: string) => key.split('@')[0];
/** The distinct climbs a stream's documents belong to, sorted. */
const climbsIn = (resolver: AudienceResolver, documents: SyncDocument[]) =>
  [...new Set(keysOf(resolver, documents).map(climbOf))].sort();

beforeEach(async () => {
  await seedSyncAudienceFixture();
});

describe('the publication rule on the board sync', () => {
  describe.each(AUDIENCE_VIEWERS)('for %s', (viewerId) => {
    it.each(RESOLVERS)(
      '%s: REFERENCE is the published, listed climbs, and PROTECTED the caller’s own others',
      async (resolver) => {
        const streams = await pullAudienceStreams({ resolver, scope: LAYOUT, viewerId });
        const ownNonPublic = EXPECTED_ON_LAYOUT.protectedFor(viewerId);

        expect(climbsIn(resolver, streams.reference)).toEqual(EXPECTED_ON_LAYOUT.reference);
        expect(climbsIn(resolver, streams.protectedStream)).toEqual(ownNonPublic);
        expect(climbsIn(resolver, streams.union)).toEqual([...EXPECTED_ON_LAYOUT.reference, ...ownNonPublic].sort());
      },
    );

    it.each(RESOLVERS)('%s: no draft or unlisted climb of anyone else, in any stream', async (resolver) => {
      const streams = await pullAudienceStreams({ resolver, scope: BOARD, viewerId });
      const notTheirs = EXPECTED_ON_LAYOUT.notPublic.filter(
        (uuid) => !EXPECTED_ON_LAYOUT.protectedFor(viewerId).includes(uuid),
      );
      for (const documents of [streams.union, streams.reference, streams.protectedStream]) {
        const delivered = climbsIn(resolver, documents);
        expect(delivered.filter((uuid) => notTheirs.includes(uuid))).toEqual([]);
      }
    });

    it.each(RESOLVERS)('%s: the two streams are disjoint and add up to the single stream', async (resolver) => {
      const scopes = [
        LAYOUT,
        { ...LAYOUT, sizeId: AUDIENCE_SIZE_ID },
        { ...LAYOUT, sizeId: AUDIENCE_OTHER_SIZE_ID },
        BOARD,
      ];
      for (const scope of scopes) {
        for (const pageSize of [500, 2]) {
          expectStreamsPartitionUnion(resolver, await pullAudienceStreams({ resolver, scope, viewerId, pageSize }));
        }
      }
    });

    it.each(RESOLVERS)('%s: each stream pages to the same rows whatever the page size', async (resolver) => {
      for (const audience of ['REFERENCE', 'PROTECTED', undefined] as const) {
        const inOnePage = await pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience });
        // Every row shares one timestamp, so only sync_seq moves the cursor.
        const twoAtATime = await pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience, pageSize: 2 });
        expect(twoAtATime).toEqual(inOnePage);
      }
    });
  });

  it.each(RESOLVERS)('%s: REFERENCE is the same documents for every caller', async (resolver) => {
    const [first, ...others] = await Promise.all(
      AUDIENCE_VIEWERS.map((viewerId) =>
        pullAllDocuments({ resolver, scope: LAYOUT, viewerId, audience: 'REFERENCE' }),
      ),
    );
    expect(first.length).toBeGreaterThan(0);
    for (const other of others) expect(other).toEqual(first);
  });

  it('gives a private account’s published climbs to everyone: no account setting, item audience or follow decides', async () => {
    const publishedUnderARestriction = [
      'pub-only-me',
      'pub-private-account',
      'pub-public-consent',
      'pub-stale-consent',
      // A deleted account's restricted climb, and a policy row nobody owns.
      'pub-deleted-account-restricted',
      'pub-orphan-policy',
    ];
    for (const viewerId of [AUDIENCE_STRANGER, AUDIENCE_PENDING_FOLLOWER, AUDIENCE_FOLLOWER]) {
      for (const audience of ['REFERENCE', undefined] as const) {
        const delivered = keysOf(
          'syncClimbs',
          await pullAllDocuments({ resolver: 'syncClimbs', scope: LAYOUT, viewerId, audience }),
        );
        expect(delivered).toEqual(expect.arrayContaining(publishedUnderARestriction));
      }
    }
  });

  it('moves no climb between streams when an account turns private or public, or a follow ends', async () => {
    const pullEveryViewer = () =>
      Promise.all(
        AUDIENCE_VIEWERS.map((viewerId) => pullAudienceStreams({ resolver: 'syncClimbs', scope: LAYOUT, viewerId })),
      );
    const before = await pullEveryViewer();
    await db.execute(sql`UPDATE user_profiles SET is_private = false WHERE user_id = ${AUDIENCE_OWNER}`);
    await db.execute(sql`
      INSERT INTO user_profiles (user_id, is_private) VALUES (${AUDIENCE_PUBLIC_AUTHOR}, true)
      ON CONFLICT (user_id) DO UPDATE SET is_private = true
    `);
    await db.execute(sql`DELETE FROM user_follows WHERE following_id = ${AUDIENCE_OWNER}`);
    expect(await pullEveryViewer()).toEqual(before);
  });

  it('keeps the flags on the row: a caller’s own draft arrives as a draft, an unlisted climb as unlisted', async () => {
    const protectedStream = await pullAllDocuments({
      resolver: 'syncClimbs',
      scope: LAYOUT,
      viewerId: AUDIENCE_OWNER,
      audience: 'PROTECTED',
    });
    const flagsOf = (uuid: string) => {
      const document = protectedStream.find((candidate) => candidate.uuid === uuid);
      return { is_draft: document?.is_draft, is_listed: document?.is_listed, user_id: document?.user_id };
    };
    expect(flagsOf('draft-private-account')).toEqual({ is_draft: true, is_listed: false, user_id: AUDIENCE_OWNER });
    expect(flagsOf('unlisted-private-account')).toEqual({ is_draft: false, is_listed: false, user_id: AUDIENCE_OWNER });
  });

  it('scopes every stream to a layout, and the board-wide pull takes the other layouts in', async () => {
    for (const viewerId of AUDIENCE_VIEWERS) {
      const layoutOnly = await pullAudienceStreams({ resolver: 'syncClimbs', scope: LAYOUT, viewerId });
      expect(keysOf('syncClimbs', layoutOnly.union).filter((uuid) => uuid.startsWith('other-layout-'))).toEqual([]);

      const boardWide = await pullAudienceStreams({ resolver: 'syncClimbs', scope: BOARD, viewerId });
      expect(keysOf('syncClimbs', boardWide.reference)).toEqual(
        expect.arrayContaining(['other-layout-pub', 'other-layout-ref']),
      );
      expect(keysOf('syncClimbs', boardWide.protectedStream).includes('other-layout-draft')).toBe(
        viewerId === AUDIENCE_PUBLIC_AUTHOR,
      );
    }
  });

  describe('first-ascent credit on a stats row', () => {
    const creditOf = (documents: SyncDocument[], climbUuid: string) => {
      const row = documents.find((document) => document.climb_uuid === climbUuid && document.angle === 40);
      return { fa_username: row?.fa_username, fa_at: row?.fa_at };
    };
    const NO_CREDIT = { fa_username: null, fa_at: null };

    it('is the stored credit for a manufacturer climb and NULL for a Boardsesh one, the same for every caller', async () => {
      for (const viewerId of AUDIENCE_VIEWERS) {
        for (const audience of ['REFERENCE', undefined] as const) {
          const stats = await pullAllDocuments({ resolver: 'syncClimbStats', scope: LAYOUT, viewerId, audience });
          expect(creditOf(stats, 'ref-a')).toEqual({ fa_username: 'Stored FA ref-a', fa_at: '2020-01-02T03:04:05Z' });
          // Has an owner: the name would come from a Boardsesh tick, which stays
          // under its author's privacy settings. Not even its author's own pull
          // carries it, so no page depends on who is asking.
          expect(creditOf(stats, FIRST_ASCENT_CLIMB_UUID)).toEqual(NO_CREDIT);
          expect(creditOf(stats, 'pub-private-account')).toEqual(NO_CREDIT);
          // Had an owner: the author flag outlives the account.
          expect(creditOf(stats, 'pub-deleted-account')).toEqual(NO_CREDIT);
        }
      }
    });

    it('is NULL on every PROTECTED row', async () => {
      const stats = await pullAllDocuments({
        resolver: 'syncClimbStats',
        scope: LAYOUT,
        viewerId: AUDIENCE_OWNER,
        audience: 'PROTECTED',
      });
      expect(stats.length).toBeGreaterThan(0);
      for (const document of stats) {
        expect({ fa_username: document.fa_username, fa_at: document.fa_at }).toEqual(NO_CREDIT);
      }
    });
  });

  describe('a spray wall has no reference set', () => {
    it.each(RESOLVERS)('%s: REFERENCE is empty for the wall’s owner too, and echoes the cursor', async (resolver) => {
      const cursor = { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '7' };
      const page = await pullAudiencePage({
        resolver,
        scope: WALL,
        viewerId: AUDIENCE_OWNER,
        audience: 'REFERENCE',
        cursor,
      });
      expect(page).toEqual({ documents: [], cursor, hasMore: false });
    });

    it.each(RESOLVERS)(
      '%s: PROTECTED is everything the owner may read there: the published climbs and their own draft',
      async (resolver) => {
        const streams = await pullAudienceStreams({ resolver, scope: WALL, viewerId: AUDIENCE_OWNER });
        expectStreamsPartitionUnion(resolver, streams);
        expect(streams.reference).toEqual([]);
        // Not the draft somebody else set on the wall: a draft is its owner's alone.
        expect(climbsIn(resolver, streams.protectedStream)).toEqual([
          'spray-draft-own',
          'spray-pub-own',
          'spray-pub-ownerless',
        ]);
      },
    );

    it.each(RESOLVERS)(
      '%s: a caller who cannot read the wall gets nothing, their own draft on it included',
      async (resolver) => {
        for (const viewerId of [AUDIENCE_FOLLOWER, AUDIENCE_STRANGER, AUDIENCE_PUBLIC_AUTHOR]) {
          const streams: AudienceStreams = await pullAudienceStreams({ resolver, scope: WALL, viewerId });
          expect(streams.union).toEqual([]);
          expect(streams.reference).toEqual([]);
          expect(streams.protectedStream).toEqual([]);
        }
      },
    );
  });

  it('rejects an audience the schema does not define', async () => {
    await expect(
      syncQueries.syncClimbs(
        undefined,
        { ...LAYOUT, cursor: null, limit: 10, audience: 'EVERYONE' as unknown as 'REFERENCE' },
        audienceContext(AUDIENCE_STRANGER),
      ),
    ).rejects.toThrow();
  });
});
