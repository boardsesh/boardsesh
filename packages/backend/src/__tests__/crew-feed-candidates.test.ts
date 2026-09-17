import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { followedAuthorCondition, sprayClimbVisibilityCondition, withSerialPlan } from '@boardsesh/db/queries';
import { boardClimbs, setterFollows, userBoardMappings, userFollows, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  buildCrewClimbCandidatesQuery,
  crewPublicationTime,
  type CrewClimbCandidateRow,
} from '../graphql/resolvers/social/crew-feed-candidates';

const viewerId = 'candidate-viewer';
const authorId = 'candidate-author';
const secondAuthorId = 'candidate-second-author';
const emptyViewerId = 'candidate-empty-viewer';
const snapshotAt = '2026-09-17T12:00:00.000000Z';
const recent = '2026-09-16T12:00:00.123456Z';
type Boundary = { occurredAt: string; id: string };

function candidatePage(limit = 20, before?: Boundary, viewer = viewerId) {
  return db
    .execute(buildCrewClimbCandidatesQuery({ viewerId: viewer, snapshotAt, before, limit }))
    .then(rowsFromResult<CrewClimbCandidateRow>);
}

// The pre-optimization predicate is the independent correctness oracle. Keep
// this aligned with search's membership semantics, not the UNION implementation.
function originalPage(limit = 20, before?: Boundary) {
  return db
    .select({
      sourceId: boardClimbs.uuid,
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
        ...(before
          ? [
              sql`(${crewPublicationTime}, ('climb:' || ${boardClimbs.uuid}) COLLATE "C") < (${before.occurredAt}::timestamptz, ${before.id} COLLATE "C")`,
            ]
          : []),
      ),
    )
    .orderBy(desc(crewPublicationTime), sql`${boardClimbs.uuid} COLLATE "C" DESC`)
    .limit(limit + 1);
}

describe('author-first Crew candidates', () => {
  beforeAll(async () => {
    await db
      .insert(users)
      .values([viewerId, authorId, secondAuthorId, emptyViewerId].map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'candidate-global' });
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
    expect(candidates).toEqual(await originalPage());
    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([
      'candidate-published',
      'candidate-overlap',
      'candidate-native',
      'candidate-linked',
      'candidate-accountless',
    ]);
    expect(candidates.every((candidate) => candidate.occurredAt === recent)).toBe(true);
  });

  it('keeps microsecond ordering and limit-plus-one pagination without duplicate cards', async () => {
    const expected = await originalPage();
    const seen: CrewClimbCandidateRow[] = [];
    let before: Boundary | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = await candidatePage(2, before);
      expect(page).toEqual(await originalPage(2, before));
      seen.push(...page.slice(0, 2));
      if (page.length <= 2) break;
      const last = page[1];
      before = { occurredAt: last.occurredAt, id: `climb:${last.sourceId}` };
    }
    expect(seen).toEqual(expected);
    expect(await candidatePage(2, { occurredAt: recent, id: 'session:tie' })).toEqual(expected.slice(0, 3));
  });

  it('returns no candidates without follows', async () => {
    expect(await candidatePage(20, undefined, emptyViewerId)).toEqual([]);
  });

  it('materializes only followed published rows before evaluating publication dates', async () => {
    type PlanNode = { 'Node Type': string; 'Subplan Name'?: string; 'Actual Rows': number; Plans?: PlanNode[] };
    const explained = await withSerialPlan(db, (transaction) =>
      transaction.execute(
        sql`EXPLAIN (ANALYZE, FORMAT JSON) ${buildCrewClimbCandidatesQuery({ viewerId, snapshotAt, limit: 20 })}`,
      ),
    );
    const root = rowsFromResult<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(explained)[0]['QUERY PLAN'][0].Plan;
    const flatten = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const plans = flatten(root);
    const materialized = plans.find((plan) => plan['Subplan Name'] === 'CTE crew_followed_climbs');
    // Five recent + old + future + invalid + inaccessible spray. None of the
    // 500 unrelated climbs reaches the date parser; overlapping paths count once.
    expect(materialized?.['Actual Rows']).toBe(9);
    expect(plans.some((plan) => plan['Node Type'] === 'CTE Scan')).toBe(true);
    expect(root['Actual Rows']).toBe(5);
  });
});
