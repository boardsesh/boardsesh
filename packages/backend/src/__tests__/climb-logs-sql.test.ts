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
/**
 * The twin filter: the hidden rows are worked out once, from the climb's own
 * Aurora-pull rows, and dropped by id. `MATERIALIZED` is what keeps Postgres
 * from turning the self-join back into an index probe per row (#5986).
 */
const twinFilter = (table: string) =>
  new RegExp(
    `"${table}"\\."id" <> ALL\\(ARRAY\\(\\s*WITH twin_candidates AS MATERIALIZED \\([^]*?FROM twin_candidates "aurora_twin"\\s+INNER JOIN twin_candidates "aurora_twin_hidden" ON`,
  );
/** The slice the twin filter reads: this board type, this climb and its aliases. */
const TWIN_SCOPE =
  /FROM "boardsesh_ticks" "twin_scope"\s+WHERE \(\("twin_scope"\."board_type" = \$\d+ and "twin_scope"\."climb_uuid" = [^]*?\) and \("twin_scope"\."origin" = \$\d+ and "twin_scope"\."aurora_id" is not null and "twin_scope"\."aurora_id" NOT LIKE \$\d+\)\)/;
/**
 * Only rows sharing user, board, climb, angle and instant with another reach
 * the pair join. Without this the join is a nested loop over every Aurora row
 * of the climb.
 */
const TWIN_COLLISIONS_ONLY =
  /count\(\*\) OVER \(\s*PARTITION BY "twin_scope"\."user_id", "twin_scope"\."board_type", "twin_scope"\."climb_uuid", "twin_scope"\."angle", "twin_scope"\."climbed_at"\s*\) AS same_instant[^]*?WHERE same_instant > 1/;

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
    expect(sql).toMatch(twinFilter('boardsesh_ticks'));
    expect(sql).not.toContain('row_number()');
  });

  it("works the twins out from the climb's own Aurora-pull rows, with no lookup per row", () => {
    const { sql } = sqlOf();

    expect(sql).toMatch(TWIN_SCOPE);
    expect(sql).toMatch(TWIN_COLLISIONS_ONLY);
    // The per-row form: a correlated subquery over the whole table.
    expect(sql).not.toContain('from "boardsesh_ticks" "aurora_twin"');
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
    expect(ranked).toMatch(twinFilter('ranked_log'));
    expect(ranked).toMatch(TWIN_SCOPE);
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
