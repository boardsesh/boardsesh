import { describe, expect, it } from 'vite-plus/test';
import { buildClimbLogsQuery } from '../graphql/resolvers/social/climb-logs';

/**
 * The SQL `climbLogs` sends, read without a database.
 *
 * `climb-logs.test.ts` proves the behaviour against Postgres. This file pins
 * the SHAPE that behaviour rests on, and runs anywhere: the spray-wall
 * predicate has to sit inside the window on the one-row-per-climber path, the
 * cursor outside it, and an anonymous caller's viewer id has to reach the
 * predicate as null. Each of those moved by one clause is a privacy leak or a
 * repeated climber that no type check would notice.
 */

const base = {
  boardType: 'spray',
  canonicalClimbUuid: 'climb-under-test',
  viewerUserId: null,
  filters: {},
  latestPerClimber: false,
  limit: 20,
  cursor: null,
} as const;

const cursor = { climbedAt: '2026-05-01 18:00:00', id: 9007199254740993n };

/** The wall-visibility check: no invisible spray climb behind this log. */
const VISIBILITY = /NOT EXISTS \(\s*SELECT 1\s+FROM board_climbs ref_climb/;
/** The fail-closed check: a spray log whose climb row is gone is not shown. */
const CLIMB_ROW_EXISTS = /FROM board_climbs existing_climb/;
const TWIN_FILTER = /"boardsesh_ticks" "aurora_twin"/;
/**
 * The twin lookup sits behind the full "real Aurora-pull row" test: origin,
 * a non-null aurora_id, and not a json-import surrogate. CASE, not OR, so the
 * order is guaranteed and the lookup runs per Aurora row.
 */
const twinGuard = (table: string) =>
  new RegExp(
    `CASE WHEN \\("${table}"\\."origin" = \\$\\d+ and "${table}"\\."aurora_id" is not null and "${table}"\\."aurora_id" NOT LIKE \\$\\d+\\) THEN not exists \\(select 1 from "boardsesh_ticks" "aurora_twin"[^]*?ELSE true END`,
  );

const sqlOf = (overrides: Partial<Parameters<typeof buildClimbLogsQuery>[0]> = {}) =>
  buildClimbLogsQuery({ ...base, ...overrides }).toSQL();

/** The text of the `ranked` subquery: everything the window function sees. */
function rankedSubquery(text: string): string {
  const start = text.indexOf('row_number() over');
  const end = text.indexOf(') "ranked"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('climbLogs SQL, plain path', () => {
  it('carries the wall checks and the twin filter in its WHERE', () => {
    const { sql } = sqlOf();

    expect(sql).toMatch(VISIBILITY);
    expect(sql).toMatch(CLIMB_ROW_EXISTS);
    expect(sql).toMatch(TWIN_FILTER);
    expect(sql).not.toContain('row_number()');
  });

  it('runs the twin lookup only for Aurora-pull rows', () => {
    expect(sqlOf().sql).toMatch(twinGuard('boardsesh_ticks'));
  });

  it('orders newest first with the id as tie-break and asks for one row past the page', () => {
    const { sql, params } = sqlOf({ limit: 20 });

    expect(sql).toContain('order by "boardsesh_ticks"."climbed_at" desc, "boardsesh_ticks"."id" desc limit');
    expect(params.at(-1)).toBe(21);
  });

  it('binds the cursor as text, the timestamp untouched and the id past 2^53 intact', () => {
    const { sql, params } = sqlOf({ cursor });

    expect(sql).toMatch(
      /\("boardsesh_ticks"\."climbed_at", "boardsesh_ticks"\."id"\) < \(\$\d+::timestamp, \$\d+::bigint\)/,
    );
    expect(params).toContain('2026-05-01 18:00:00');
    expect(params).toContain('9007199254740993');
  });
});

describe('climbLogs SQL, one row per climber', () => {
  it('filters INSIDE the window, so a hidden log is never ranked', () => {
    const ranked = rankedSubquery(sqlOf({ latestPerClimber: true }).sql);

    expect(ranked).toMatch(VISIBILITY);
    expect(ranked).toMatch(CLIMB_ROW_EXISTS);
    expect(ranked).toMatch(TWIN_FILTER);
    expect(ranked).toMatch(twinGuard('ranked_log'));
    // The checks read the ranked rows, not the outer table of the same name.
    expect(ranked).toContain('ref_climb.uuid = "ranked_log"."climb_uuid"');
    expect(ranked).not.toContain('"boardsesh_ticks"."climb_uuid"');
  });

  it('puts every optional filter inside the window too, so the pick is the newest log that passes', () => {
    const ranked = rankedSubquery(
      sqlOf({
        latestPerClimber: true,
        viewerUserId: 'viewer-1',
        filters: { angle: 40, withNotes: true, sendsOnly: true, excludeFollowed: true },
      }).sql,
    );

    expect(ranked).toMatch(/"ranked_log"\."angle" = \$\d+/);
    expect(ranked).toContain(String.raw`"ranked_log"."comment" ~ '\S'`);
    expect(ranked).toContain(`"ranked_log"."status" in ('flash', 'send')`);
    expect(ranked).toMatch(/"ranked_log"\."user_id" <> \$\d+/);
    expect(ranked).toContain('"user_follows"."following_id" = "ranked_log"."user_id"');
  });

  it('applies the cursor and the page size OUTSIDE the window', () => {
    const { sql, params } = sqlOf({ latestPerClimber: true, cursor, limit: 20 });
    const ranked = rankedSubquery(sql);
    const afterRanked = sql.slice(sql.indexOf(') "ranked"'));

    expect(ranked).not.toContain('::timestamp');
    expect(afterRanked).toMatch(/"climber_rank" = \$\d+ and \("ranked"\."climbed_at", "ranked"\."id"\) < /);
    expect(afterRanked).toMatch(/order by "ranked"\."climbed_at" desc, "ranked"\."id" desc limit \$\d+\) "page"/);
    expect(params).toContain(21);
  });

  it('partitions by climber and ranks newest first with the id as tie-break', () => {
    expect(sqlOf({ latestPerClimber: true }).sql).toContain(
      'row_number() over (partition by "user_id" order by "climbed_at" desc, "id" desc)',
    );
  });
});

describe.each([
  { path: 'plain', latestPerClimber: false },
  { path: 'one row per climber', latestPerClimber: true },
])('climbLogs SQL, the viewer on the $path path', ({ latestPerClimber }) => {
  it('hands the wall check a null viewer for an anonymous caller', () => {
    const { params } = sqlOf({ latestPerClimber, viewerUserId: null });

    expect(params).toContain(null);
    expect(params.filter((param) => typeof param === 'string' && param.startsWith('viewer'))).toEqual([]);
  });

  it('ignores excludeFollowed for an anonymous caller', () => {
    const { sql } = sqlOf({ latestPerClimber, viewerUserId: null, filters: { excludeFollowed: true } });

    expect(sql).not.toContain('user_follows');
  });

  it('leaves out the optional filters nobody asked for', () => {
    const { sql } = sqlOf({ latestPerClimber });

    expect(sql).not.toContain('"comment" ~');
    expect(sql).not.toContain(`in ('flash', 'send')`);
    expect(sql).not.toContain('user_follows');
    expect(sql).not.toMatch(/"angle" = \$\d+\)/);
  });
});
