import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardseshTicks, setterFollows, userFollows, users } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { crewFeedQueries } from '../graphql/resolvers/social/crew-feed';
import { crewPublicationTime } from '../graphql/resolvers/social/crew-feed-candidates';
import {
  decodeCrewCursor,
  encodeCrewCursor,
  selectCrewCandidates,
  type CrewCandidate,
} from '../graphql/resolvers/social/crew-feed-pagination';

const viewerId = 'crew-feed-viewer';
const creatorId = 'crew-feed-creator';
const ctx = { userId: viewerId, isAuthenticated: true, connectionId: 'crew-test' } as ConnectionContext;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
// Captured once so the fixture rows and the ids asserted against them cannot
// land on different sides of midnight when a run straddles it.
const importedAt = daysAgo(1);
const nativeAt = daysAgo(3);
const draftPublishedAt = daysAgo(4);
const woodsAt = daysAgo(1);
/** A card's id: the (board, author, UTC day) the group was filed under. */
const groupId = (boardType: string, authorKey: string, at: string) =>
  `climbgroup:${boardType}:${authorKey}:${at.slice(0, 10)}`;

describe('Crew feed', () => {
  beforeAll(async () => {
    await db.insert(users).values([viewerId, creatorId].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'crew-accountless' });
    await db.insert(userFollows).values({ followerId: viewerId, followingId: creatorId });
    await db.insert(boardClimbs).values(
      [
        { uuid: 'crew-imported', setterUsername: 'crew-accountless', createdAt: importedAt },
        {
          uuid: 'crew-native',
          userId: creatorId,
          setterUsername: 'crew-native-setter',
          createdAt: nativeAt,
          publishedAt: nativeAt,
        },
        {
          uuid: 'crew-published-draft',
          setterUsername: 'crew-accountless',
          createdAt: daysAgo(100),
          publishedAt: draftPublishedAt,
        },
        { uuid: 'crew-old', setterUsername: 'crew-accountless', createdAt: daysAgo(31) },
        { uuid: 'crew-draft', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isDraft: true },
        { uuid: 'crew-hidden', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isHidden: true },
        { uuid: 'crew-unlisted', setterUsername: 'crew-accountless', createdAt: daysAgo(1), isListed: false },
        { uuid: 'crew-unfollowed', setterUsername: 'crew-stranger', createdAt: daysAgo(1) },
        { uuid: 'crew-invalid-date', setterUsername: 'crew-accountless', createdAt: 'not a timestamp' },
        {
          uuid: 'crew-spray-inaccessible',
          setterUsername: 'crew-accountless',
          createdAt: daysAgo(1),
          boardType: 'spray',
        },
      ].map((climb) => ({
        boardType: 'kilter',
        layoutId: 99772,
        isListed: true,
        isDraft: false,
        isHidden: false,
        frames: 'p1r1',
        name: climb.uuid,
        ...climb,
      })),
    );
    // Stats for the drawer's send count and stars. `crew-native` carries no
    // angle of its own, so this row's angle is the one the join resolves to.
    await db.insert(boardClimbStats).values({
      boardType: 'kilter',
      climbUuid: 'crew-native',
      angle: 40,
      ascensionistCount: 7,
      qualityAverage: 4.5,
      benchmarkDifficulty: 21,
    });
    await db.insert(boardseshTicks).values({
      uuid: 'crew-tick',
      userId: creatorId,
      boardType: 'kilter',
      climbUuid: 'crew-native',
      angle: 40,
      status: 'send',
      climbedAt: daysAgo(2),
      attemptCount: 1,
    });
  });

  it('mixes sessions and published climbs, including accountless imports and recent draft publication', async () => {
    const first = await crewFeedQueries.crewFeed(null, { input: { limit: 2, groupClimbs: true } }, ctx);
    expect(first.items.map((item) => item.__typename)).toEqual(['CrewClimbItem', 'CrewSessionItem']);
    expect(first.items[0].id).toBe(groupId('kilter', 'crew-accountless', importedAt));
    expect(first.hasMore).toBe(true);
    const second = await crewFeedQueries.crewFeed(
      null,
      { input: { limit: 2, cursor: first.cursor, groupClimbs: true } },
      ctx,
    );
    expect(second.items.map((item) => item.id)).toEqual([
      groupId('kilter', 'crew-native-setter', nativeAt),
      groupId('kilter', 'crew-accountless', draftPublishedAt),
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.cursor).toBeNull();
    expect(first.items[0]).toMatchObject({ climb: { actorId: null, actorDisplayName: 'crew-accountless' } });
  });

  it('reevaluates visibility and follow membership on refresh', async () => {
    await db.update(boardClimbs).set({ isHidden: true }).where(eq(boardClimbs.uuid, 'crew-imported'));
    const hidden = await crewFeedQueries.crewFeed(null, { input: { groupClimbs: true } }, ctx);
    expect(hidden.items.map((item) => item.id)).not.toContain(groupId('kilter', 'crew-accountless', importedAt));
    await db.update(boardClimbs).set({ isHidden: false }).where(eq(boardClimbs.uuid, 'crew-imported'));
    await db.delete(setterFollows).where(eq(setterFollows.followerId, viewerId));
    const unfollowed = await crewFeedQueries.crewFeed(null, { input: { groupClimbs: true } }, ctx);
    expect(unfollowed.items.filter((item) => item.__typename === 'CrewClimbItem').map((item) => item.id)).toEqual([
      groupId('kilter', 'crew-native-setter', nativeAt),
    ]);
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'crew-accountless' });
  });

  it('rejects anonymous requests and invalid or cross-account cursors', async () => {
    await expect(crewFeedQueries.crewFeed(null, {}, { ...ctx, isAuthenticated: false })).rejects.toThrow();
    await expect(crewFeedQueries.crewFeed(null, { input: { cursor: 'broken' } }, ctx)).rejects.toThrow('Invalid Crew');
    const first = await crewFeedQueries.crewFeed(null, { input: { limit: 1 } }, ctx);
    await expect(
      crewFeedQueries.crewFeed(null, { input: { cursor: first.cursor } }, { ...ctx, userId: creatorId }),
    ).rejects.toThrow('Invalid Crew');
  });

  it('preserves microsecond cursor precision and deterministic ties', () => {
    const occurredAt = daysAgo(1).replace(/\.[0-9]{3}Z$/, '.123456Z');
    const cursor = { version: 1 as const, viewerId, snapshotAt: daysAgo(0), occurredAt, id: 'session:xyz' };
    expect(decodeCrewCursor(encodeCrewCursor(cursor), viewerId)).toEqual(cursor);
    const selected = selectCrewCandidates(
      [
        { id: 'climb:abc', kind: 'climb', sourceId: 'abc', occurredAt },
        { id: 'session:xyz', kind: 'session', sourceId: 'xyz', occurredAt },
      ],
      1,
    );
    expect(selected.selected[0].id).toBe('session:xyz');
    expect(selected.hasMore).toBe(true);
  });

  // A group id carries the setter's username, so it can hold any character a
  // climber put in one. The JS merge and the SQL cursor have to break a tie the
  // same way or a card falls through the page boundary.
  it('breaks id ties on UTF-8 bytes, the way COLLATE "C" does', async () => {
    const occurredAt = '2026-09-01T12:00:00.000000Z';
    // U+1F600 sorts BELOW U+FF21 in UTF-16 code units and ABOVE it in UTF-8
    // bytes; a plain `<` would order these the opposite way from Postgres.
    const emoji = 'climbgroup:kilter:\u{1F600}:2026-09-01';
    const bmp = 'climbgroup:kilter:\uFF21:2026-09-01';
    const selected = selectCrewCandidates(
      [
        { id: emoji, kind: 'climb', sourceId: 'a', occurredAt },
        { id: bmp, kind: 'climb', sourceId: 'b', occurredAt },
      ],
      1,
    );
    // Descending by byte order, so the emoji group leads.
    expect(selected.selected[0].id).toBe(emoji);

    const [ordered] = await db
      .select({
        first: sql<string>`(SELECT id FROM (VALUES (${emoji}), (${bmp})) AS ids(id) ORDER BY id COLLATE "C" DESC LIMIT 1)`,
      })
      .from(boardClimbs)
      .limit(1);
    expect(selected.selected[0].id).toBe(ordered.first);
  });

  it('terminates pagination when both sources initially supply limit plus one candidates', () => {
    const limit = 2;
    const candidates: CrewCandidate[] = ['climb', 'session'].flatMap((kind) =>
      Array.from({ length: limit + 1 }, (_, index) => ({
        id: `${kind}:${index}`,
        sourceId: `${index}`,
        kind: kind as CrewCandidate['kind'],
        occurredAt: `2026-09-01T12:00:0${index}.000000Z`,
      })),
    );
    const first = selectCrewCandidates(candidates, limit);
    expect(first.selected).toHaveLength(limit);
    expect(first.hasMore).toBe(true);
    const remainingAfter = (page: typeof first) => {
      const last = page.selected.at(-1)!;
      return candidates.filter(
        (candidate) =>
          candidate.occurredAt < last.occurredAt ||
          (candidate.occurredAt === last.occurredAt && candidate.id < last.id),
      );
    };
    const second = selectCrewCandidates(remainingAfter(first), limit);
    expect(second.selected).toHaveLength(limit);
    expect(second.hasMore).toBe(true);
    const third = selectCrewCandidates(remainingAfter(second), limit);
    expect(third.selected).toHaveLength(limit);
    expect(third.hasMore).toBe(false);
    expect(
      new Set([...first.selected, ...second.selected, ...third.selected].map((candidate) => candidate.id)).size,
    ).toBe(6);
  });

  it.each([
    ['2024-02-29T12:00:00Z', '2024-02-29T12:00:00'],
    ['2025-02-29T12:00:00Z', null],
    ['2026-04-31T12:00:00Z', null],
    ['2026-09-01T24:00:00Z', null],
    ['2026-09-01T12:00:00+14:00', '2026-08-31T22:00:00'],
    ['2026-09-01T12:00:00-04:30', '2026-09-01T16:30:00'],
    ['2026-09-01 12:00:00', '2026-09-01T12:00:00'],
    ['2026-09-01T12:00:00+99:00', null],
  ])('validates imported timestamp %s before casting', async (timestamp, expected) => {
    await db.update(boardClimbs).set({ createdAt: timestamp }).where(eq(boardClimbs.uuid, 'crew-invalid-date'));
    const [parsed] = await db
      .select({
        timestamp: sql<string | null>`to_char(${crewPublicationTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')`,
      })
      .from(boardClimbs)
      .where(eq(boardClimbs.uuid, 'crew-invalid-date'));
    expect(parsed.timestamp).toBe(expected);
  });

  it('carries the climb-specific board geometry instead of the largest default', async () => {
    await db.insert(boardClimbs).values({
      uuid: 'crew-woods',
      boardType: 'woods',
      layoutId: 1,
      userId: creatorId,
      setterUsername: 'crew-native-setter',
      name: 'Small Woods climb',
      isListed: true,
      isDraft: false,
      isHidden: false,
      frames: 'p1r1',
      compatibleSizeIds: [1],
      requiredSetIds: [1],
      createdAt: woodsAt,
    });
    const feed = await crewFeedQueries.crewFeed(null, { input: { groupClimbs: true } }, ctx);
    const woods = feed.items.find((item) => item.id === groupId('woods', 'crew-native-setter', woodsAt));
    expect(woods).toMatchObject({ climb: { renderBoard: { layoutId: 1, sizeId: 1 } } });
  });

  // Declared last: these insert rows the exact-list assertions above would see.
  describe('setter day groups', () => {
    const groupedAt = daysAgo(6);
    const cappedAt = daysAgo(7);
    const hour = (at: string, index: number) => `${at.slice(0, 11)}${String(index).padStart(2, '0')}:00:00.000000Z`;

    beforeAll(async () => {
      await db
        .insert(setterFollows)
        .values(['crew-pair', 'crew-prolific'].map((setterUsername) => ({ followerId: viewerId, setterUsername })));
      await db.insert(boardClimbs).values(
        [
          ...[0, 1].map((index) => ({
            uuid: `crew-pair-${index}`,
            setterUsername: 'crew-pair',
            createdAt: hour(groupedAt, index),
          })),
          ...Array.from({ length: 12 }, (_, index) => ({
            uuid: `crew-prolific-${String(index).padStart(2, '0')}`,
            setterUsername: 'crew-prolific',
            createdAt: hour(cappedAt, index),
          })),
        ].map((climb) => ({
          boardType: 'kilter',
          layoutId: 99772,
          isListed: true,
          isDraft: false,
          isHidden: false,
          frames: 'p1r1',
          name: climb.uuid,
          ...climb,
        })),
      );
    });

    it('folds one setter day into a single card, newest climb first', async () => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      const pair = feed.items.find((item) => item.id === groupId('kilter', 'crew-pair', groupedAt));
      expect(pair?.__typename).toBe('CrewClimbGroupItem');
      expect(pair).toMatchObject({ totalCount: 2, occurredAt: hour(groupedAt, 1) });
      expect(pair?.__typename === 'CrewClimbGroupItem' && pair.climbs.map((climb) => climb.climbUuid)).toEqual([
        'crew-pair-1',
        'crew-pair-0',
      ]);
    });

    it('caps a card at ten climbs but still counts the rest', async () => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      const prolific = feed.items.find((item) => item.id === groupId('kilter', 'crew-prolific', cappedAt));
      expect(prolific?.__typename).toBe('CrewClimbGroupItem');
      expect(prolific).toMatchObject({ totalCount: 12 });
      // Ten newest, so "See all 12" is the only way to the other two.
      expect(prolific?.__typename === 'CrewClimbGroupItem' && prolific.climbs.map((climb) => climb.climbUuid)).toEqual(
        Array.from({ length: 10 }, (_, index) => `crew-prolific-${String(11 - index).padStart(2, '0')}`),
      );
    });

    it('leaves a lone climb as a CrewClimbItem for clients that predate the group', async () => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      const lone = feed.items.find((item) => item.id === groupId('kilter', 'crew-native-setter', nativeAt));
      expect(lone?.__typename).toBe('CrewClimbItem');
      expect(lone).toMatchObject({ climb: { climbUuid: 'crew-native' } });
    });

    it('splits a setter day on the viewer zone, not on UTC', async () => {
      // 00:00 and 01:00 UTC on `cappedAt` are the previous evening in Denver,
      // so a US viewer sees the day break where their clock puts it.
      const utc = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      const denver = await crewFeedQueries.crewFeed(
        null,
        { input: { limit: 50, timeZone: 'America/Denver', groupClimbs: true } },
        ctx,
      );
      const countsFor = (feed: Awaited<ReturnType<typeof crewFeedQueries.crewFeed>>, setter: string) =>
        feed.items
          .filter((item) => item.id.startsWith(`climbgroup:kilter:${setter}:`))
          .map((item) => (item.__typename === 'CrewClimbGroupItem' ? item.totalCount : 1));
      expect(countsFor(utc, 'crew-prolific')).toEqual([12]);
      // 00:00-05:59 UTC fall on the previous Denver day (UTC-6): 6 and 6.
      expect(countsFor(denver, 'crew-prolific')).toEqual([6, 6]);
    });

    it('never hands an unasked client a CrewClimbGroupItem', async () => {
      // A build that predates the member has no fragment for it, so it would
      // arrive as a bare __typename and take the Home tab down. Unasked clients
      // get the shape they already render: one card per climb.
      const legacy = await crewFeedQueries.crewFeed(null, { input: { limit: 50 } }, ctx);
      expect(legacy.items.every((item) => item.__typename !== 'CrewClimbGroupItem')).toBe(true);
      const pairCards = legacy.items.filter((item) => item.id.startsWith('climb:crew-pair-'));
      expect(pairCards.map((item) => item.id).sort()).toEqual(['climb:crew-pair-0', 'climb:crew-pair-1']);
      expect(pairCards.every((item) => item.__typename === 'CrewClimbItem' && item.climb != null)).toBe(true);
      // Still capped, so one setter cannot flood an old client either.
      expect(legacy.items.filter((item) => item.id.startsWith('climb:crew-prolific-'))).toHaveLength(10);
    });

    it('carries real ascents and stars so the drawer does not show zeros', async () => {
      const feed = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      const lone = feed.items.find((item) => item.id === groupId('kilter', 'crew-native-setter', nativeAt));
      expect(lone?.__typename === 'CrewClimbItem' && lone.climb).toMatchObject({
        ascensionistCount: 7,
        qualityAverage: 4.5,
        isBenchmark: true,
      });
    });

    it.each([
      // Intl accepts every IANA backward link; Debian's Postgres dropped them to
      // tzdata-legacy, and Android still reports Asia/Calcutta on many devices.
      ['Asia/Calcutta'],
      ['Europe/Kiev'],
      ['US/Eastern'],
      ['America/Buenos_Aires'],
    ])('serves the feed on %s, a zone Intl accepts but Postgres does not', async (zone) => {
      const feed = await crewFeedQueries.crewFeed(
        null,
        { input: { limit: 50, timeZone: zone, groupClimbs: true } },
        ctx,
      );
      expect(feed.items.length).toBeGreaterThan(0);
    });

    it('falls back to UTC for a zone Postgres would reject', async () => {
      const bogus = await crewFeedQueries.crewFeed(
        null,
        { input: { limit: 50, timeZone: 'Mars/Olympus', groupClimbs: true } },
        ctx,
      );
      const utc = await crewFeedQueries.crewFeed(null, { input: { limit: 50, groupClimbs: true } }, ctx);
      expect(bogus.items.map((item) => item.id)).toEqual(utc.items.map((item) => item.id));
    });
  });
});
