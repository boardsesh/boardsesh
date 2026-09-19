import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { followedAuthorCondition, sprayClimbVisibilityCondition, withSerialPlan } from '@boardsesh/db/queries';
import { boardClimbs, setterFollows, userBoardMappings, userFollows, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  buildCrewClimbCandidatesQuery,
  buildCrewGroupClimbsQuery,
  crewPublicationTime,
  type CrewClimbCandidateRow,
  type CrewGroupClimbRow,
} from '../graphql/resolvers/social/crew-feed-candidates';

const viewerId = 'candidate-viewer';
const authorId = 'candidate-author';
const secondAuthorId = 'candidate-second-author';
const emptyViewerId = 'candidate-empty-viewer';
const snapshotAt = '2026-09-17T12:00:00.000000Z';
const recent = '2026-09-16T12:00:00.123456Z';
// Either side of midnight UTC, both inside one Sydney (UTC+10) day.
const lateUtc = '2026-09-16T23:30:00.000000Z';
const earlyUtc = '2026-09-17T01:00:00.000000Z';
const SYDNEY = 'Australia/Sydney';
type Boundary = { occurredAt: string; id: string };

function candidatePage(limit = 20, before?: Boundary, viewer = viewerId, timeZone = 'UTC') {
  return db
    .execute(buildCrewClimbCandidatesQuery({ viewerId: viewer, snapshotAt, before, limit, timeZone }))
    .then(rowsFromResult<CrewClimbCandidateRow>);
}

// The pre-optimization predicate is the independent correctness oracle. Keep
// this aligned with search's membership semantics, not the UNION implementation.
// It stays per-climb: grouping is then applied in JS below, so the SQL grouping
// is checked against a JS grouping of an independently-derived row set.
function originalClimbs() {
  return db
    .select({
      sourceId: boardClimbs.uuid,
      boardType: boardClimbs.boardType,
      authorKey: sql<string>`COALESCE(NULLIF(${boardClimbs.setterUsername}, ''), 'user:' || ${boardClimbs.userId})`,
      occurredAt: sql<string>`to_char(${crewPublicationTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        eq(boardClimbs.isHidden, false),
        followedAuthorCondition(viewerId),
        sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
        sql`${crewPublicationTime} >= ${snapshotAt}::timestamptz - interval '30 days'`,
        sql`${crewPublicationTime} <= ${snapshotAt}::timestamptz`,
      ),
    )
    .orderBy(desc(crewPublicationTime), sql`${boardClimbs.uuid} COLLATE "C" DESC`);
}

/** The groups the oracle rows imply, keyed the way the SQL keys them. */
async function originalGroups(timeZone = 'UTC') {
  const climbs = await originalClimbs();
  const byGroup = new Map<string, { groupId: string; occurredAt: string; climbCount: number }>();
  for (const climb of climbs) {
    // en-CA numeric parts are YYYY-MM-DD in that order, which is what the SQL
    // `::date` cast yields — built from parts so no locale pattern can drift.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(climb.occurredAt));
    const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    const groupId = `climbgroup:${climb.boardType}:${climb.authorKey}:${day}`;
    const existing = byGroup.get(groupId);
    if (existing) {
      existing.climbCount += 1;
      if (climb.occurredAt > existing.occurredAt) existing.occurredAt = climb.occurredAt;
    } else {
      byGroup.set(groupId, { groupId, occurredAt: climb.occurredAt, climbCount: 1 });
    }
  }
  return [...byGroup.values()].sort((left, right) =>
    left.occurredAt !== right.occurredAt
      ? left.occurredAt < right.occurredAt
        ? 1
        : -1
      : left.groupId < right.groupId
        ? 1
        : -1,
  );
}

function summarise(rows: CrewClimbCandidateRow[]) {
  return rows.map(({ groupId, occurredAt, climbCount }) => ({ groupId, occurredAt, climbCount }));
}

describe('author-first Crew candidates', () => {
  // The shared setup truncates these tables before each test file and gives
  // every parallel worker its own database (see setup.ts and worker-db.ts).
  beforeAll(async () => {
    await db
      .insert(users)
      .values([viewerId, authorId, secondAuthorId, emptyViewerId].map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(setterFollows).values(
      ['candidate-global', 'candidate-tz', 'candidate-prolific'].map((setterUsername) => ({
        followerId: viewerId,
        setterUsername,
      })),
    );
    await db
      .insert(userFollows)
      .values([authorId, secondAuthorId].map((followingId) => ({ followerId: viewerId, followingId })));
    await db.insert(userBoardMappings).values([
      { userId: authorId, boardType: 'kilter', boardUsername: 'candidate-global', boardUserId: 98701 },
      { userId: authorId, boardType: 'tension', boardUsername: 'candidate-linked', boardUserId: 98702 },
      { userId: secondAuthorId, boardType: 'tension', boardUsername: 'candidate-linked', boardUserId: 98703 },
    ]);
    await db.insert(boardClimbs).values(
      [
        { uuid: 'candidate-overlap', userId: authorId },
        { uuid: 'candidate-accountless', boardType: 'tension' },
        { uuid: 'candidate-native', userId: authorId, setterUsername: null },
        { uuid: 'candidate-linked', boardType: 'tension', setterUsername: 'candidate-linked' },
        { uuid: 'candidate-wrong-board', setterUsername: 'candidate-linked' },
        { uuid: 'candidate-published', createdAt: '2020-01-01', publishedAt: recent },
        { uuid: 'candidate-old', createdAt: '2020-01-01' },
        { uuid: 'candidate-future', createdAt: '2026-09-18' },
        { uuid: 'candidate-invalid', createdAt: '2026-02-30' },
        { uuid: 'candidate-hidden', isHidden: true },
        { uuid: 'candidate-draft', isDraft: true },
        { uuid: 'candidate-unlisted', isListed: false },
        { uuid: 'candidate-private-spray', boardType: 'spray' },
        // Straddle midnight UTC; one Sydney day.
        { uuid: 'candidate-tz-late', setterUsername: 'candidate-tz', createdAt: lateUtc },
        { uuid: 'candidate-tz-early', setterUsername: 'candidate-tz', createdAt: earlyUtc },
        // One setter, one day, more climbs than a card carries.
        ...Array.from({ length: 12 }, (_, index) => ({
          uuid: `candidate-prolific-${String(index).padStart(2, '0')}`,
          setterUsername: 'candidate-prolific',
          createdAt: `2026-09-15T${String(index).padStart(2, '0')}:00:00.000000Z`,
        })),
        ...Array.from({ length: 500 }, (_, index) => ({
          uuid: `candidate-stranger-${index}`,
          setterUsername: 'candidate-stranger',
        })),
      ].map((climb) => ({
        boardType: 'kilter',
        layoutId: 99773,
        isListed: true,
        isDraft: false,
        isHidden: false,
        createdAt: recent,
        setterUsername: 'candidate-global',
        ...climb,
      })),
    );
  });

  it('matches all three follow paths and deduplicates overlapping users, setters, and mappings', async () => {
    const candidates = await candidatePage();
    expect(summarise(candidates)).toEqual(await originalGroups());
    // Every followed climb lands in exactly one group, and nothing else does.
    const climbs = await originalClimbs();
    expect(candidates.reduce((total, group) => total + group.climbCount, 0)).toBe(climbs.length);
    expect(climbs.map((climb) => climb.sourceId).sort()).toEqual(
      [
        'candidate-accountless',
        'candidate-linked',
        'candidate-native',
        'candidate-overlap',
        'candidate-published',
        'candidate-tz-early',
        'candidate-tz-late',
        ...Array.from({ length: 12 }, (_, index) => `candidate-prolific-${String(index).padStart(2, '0')}`),
      ].sort(),
    );
  });

  it('files a climb under the viewer local day, not the UTC one', async () => {
    const utcGroups = await candidatePage(20, undefined, viewerId, 'UTC');
    const sydneyGroups = await candidatePage(20, undefined, viewerId, SYDNEY);
    expect(summarise(sydneyGroups)).toEqual(await originalGroups(SYDNEY));

    const tzGroups = (rows: CrewClimbCandidateRow[]) => rows.filter((row) => row.groupId.includes(':candidate-tz:'));
    // 23:30Z and 01:00Z the next day are two UTC days but one Sydney day.
    expect(tzGroups(utcGroups).map((row) => [row.groupId, row.climbCount])).toEqual([
      ['climbgroup:kilter:candidate-tz:2026-09-17', 1],
      ['climbgroup:kilter:candidate-tz:2026-09-16', 1],
    ]);
    expect(tzGroups(sydneyGroups).map((row) => [row.groupId, row.climbCount])).toEqual([
      ['climbgroup:kilter:candidate-tz:2026-09-17', 2],
    ]);
  });

  it('counts every climb in a group, past the per-card cap', async () => {
    const prolific = (await candidatePage()).find((row) => row.groupId.includes(':candidate-prolific:'));
    expect(prolific).toMatchObject({
      groupId: 'climbgroup:kilter:candidate-prolific:2026-09-15',
      climbCount: 12,
      // The group is stamped with its NEWEST climb, not its oldest.
      occurredAt: '2026-09-15T11:00:00.000000Z',
    });
  });

  it('hands each group to exactly one page and never splits a setter day', async () => {
    const expected = await originalGroups();
    const seen: ReturnType<typeof summarise> = [];
    let before: Boundary | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await candidatePage(2, before);
      expect(summarise(page)).toEqual(await originalGroups().then((all) => all.slice(seen.length, seen.length + 3)));
      seen.push(...summarise(page).slice(0, 2));
      if (page.length <= 2) break;
      const last = page[1];
      before = { occurredAt: last.occurredAt, id: last.groupId };
    }
    expect(seen).toEqual(expected);
    // No group is served twice, and the climb counts survive paging intact.
    expect(new Set(seen.map((group) => group.groupId)).size).toBe(seen.length);
  });

  it('returns no candidates without follows', async () => {
    expect(await candidatePage(20, undefined, emptyViewerId)).toEqual([]);
  });

  it('materializes only followed published rows before evaluating publication dates', async () => {
    type PlanNode = { 'Node Type': string; 'Subplan Name'?: string; 'Actual Rows': number; Plans?: PlanNode[] };
    const expectedFollowed = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.isListed, true),
          eq(boardClimbs.isDraft, false),
          eq(boardClimbs.isHidden, false),
          followedAuthorCondition(viewerId),
        ),
      );
    const expectedCandidates = await originalGroups();
    const explained = await withSerialPlan(db, (transaction) =>
      transaction.execute(
        sql`EXPLAIN (ANALYZE, FORMAT JSON) ${buildCrewClimbCandidatesQuery({ viewerId, snapshotAt, limit: 20, timeZone: 'UTC' })}`,
      ),
    );
    const root = rowsFromResult<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(explained)[0]['QUERY PLAN'][0].Plan;
    const flatten = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const plans = flatten(root);
    const materialized = plans.find((plan) => plan['Subplan Name'] === 'CTE crew_followed_climbs');
    // Includes old, future, invalid, and inaccessible spray rows. None of the
    // unrelated climbs reaches the date parser; overlapping paths count once.
    expect(materialized?.['Actual Rows']).toBe(expectedFollowed.length);
    expect(expectedFollowed.length).toBeGreaterThan(expectedCandidates.length);
    expect(plans.some((plan) => plan['Node Type'] === 'CTE Scan')).toBe(true);
    expect(root['Actual Rows']).toBe(expectedCandidates.length);
  });
});

describe('Crew group climbs', () => {
  function groupClimbs(groups: { boardType: string; authorKey: string; day: string }[], perGroup = 10) {
    return db
      .execute(buildCrewGroupClimbsQuery({ viewerId, snapshotAt, groups, timeZone: 'UTC', perGroup }))
      .then(rowsFromResult<CrewGroupClimbRow>);
  }

  it('returns a capped, newest-first page of one group', async () => {
    const rows = await groupClimbs([{ boardType: 'kilter', authorKey: 'candidate-prolific', day: '2026-09-15' }]);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.uuid)).toEqual([
      'candidate-prolific-11',
      'candidate-prolific-10',
      'candidate-prolific-09',
      'candidate-prolific-08',
      'candidate-prolific-07',
      'candidate-prolific-06',
      'candidate-prolific-05',
      'candidate-prolific-04',
      'candidate-prolific-03',
      'candidate-prolific-02',
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[0].occurredAt).toBe('2026-09-15T11:00:00.000000Z');
  });

  it('ranks within each group independently when several are asked for at once', async () => {
    const rows = await groupClimbs(
      [
        { boardType: 'kilter', authorKey: 'candidate-tz', day: '2026-09-16' },
        { boardType: 'kilter', authorKey: 'candidate-tz', day: '2026-09-17' },
        { boardType: 'tension', authorKey: 'candidate-linked', day: '2026-09-16' },
      ],
      10,
    );
    expect(
      rows
        .map((row) => [row.boardType, row.authorKey, row.day, row.uuid, row.rank])
        .sort((a, b) => (a[3] < b[3] ? -1 : 1)),
    ).toEqual([
      ['tension', 'candidate-linked', '2026-09-16', 'candidate-linked', 1],
      ['kilter', 'candidate-tz', '2026-09-17', 'candidate-tz-early', 1],
      ['kilter', 'candidate-tz', '2026-09-16', 'candidate-tz-late', 1],
    ]);
  });

  it('never reaches a climb the viewer does not follow', async () => {
    expect(await groupClimbs([{ boardType: 'kilter', authorKey: 'candidate-stranger', day: '2026-09-16' }])).toEqual(
      [],
    );
  });
});
