import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ANGLES } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never), executeRows: async () => [] }));
vi.mock('@/app/lib/server-popular-configs', () => ({ getAllBoardConfigsOrThrow: async () => [] }));

const { buildSetterClimbsQuery, buildSetterProfileQuery, SETTER_PAGE_SIZE } = await import('../server-setter-data');
const { buildTier2ClimbQuery } = await import('@/app/lib/seo/sitemap/climb-query');

const db = drizzle({} as never);

function normalise(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * `$1`, `$17`, `$101` … all become `$?`.
 *
 * The two builders below bind different numbers of parameters BEFORE their
 * WHERE clause — the climbs query carries the ninety-nine angle bindings of the
 * `CASE` guard — so comparing the raw text would compare placeholder numbering
 * rather than the predicate. `whereParamsOf` compares the values those
 * placeholders resolve to, which is the half that has to agree.
 */
function anonymisePlaceholders(sql: string): string {
  return sql.replace(/\$\d+/g, '$?');
}

/**
 * The OUTER where clause — `lastIndexOf`, because the climbs query carries a
 * correlated `where` inside the most-ascended-angle subquery it joins on, and
 * that one is not the visibility predicate.
 */
function whereClauseOf(rendered: { sql: string }): string {
  const sql = normalise(rendered.sql);
  const start = sql.lastIndexOf('where ');
  expect(start, 'no where clause in the rendered SQL').toBeGreaterThan(-1);
  const endMarkers = [' group by ', ' order by ', ' limit ', ' offset '];
  const end = endMarkers.map((marker) => sql.indexOf(marker, start)).filter((index) => index > -1);
  return anonymisePlaceholders(sql.slice(start, end.length > 0 ? Math.min(...end) : sql.length));
}

/** The bindings the WHERE clause actually references, in the order it names them. */
function whereParamsOf(rendered: { sql: string; params: unknown[] }): unknown[] {
  const sql = normalise(rendered.sql);
  const start = sql.lastIndexOf('where ');
  const endMarkers = [' group by ', ' order by ', ' limit ', ' offset '];
  const ends = endMarkers.map((marker) => sql.indexOf(marker, start)).filter((index) => index > -1);
  const clause = sql.slice(start, ends.length > 0 ? Math.min(...ends) : sql.length);
  const placeholders = clause.match(/\$(\d+)/g) ?? [];
  return placeholders.map((placeholder) => rendered.params[Number(placeholder.slice(1)) - 1]);
}

/**
 * The three ordered terms that decide WHICH ANGLE a climb's URL is built at,
 * with the only legitimate difference between the two builders — the table
 * alias the setter query's correlated subquery uses — erased.
 *
 * Extracted from the SQL each builder really renders, so a hand-written
 * `ORDER BY` on either side either fails to match this shape or matches with
 * different text. Nothing about the expected ordering is written down here.
 */
const ANGLE_ORDER_BY =
  /"[a-z_]+"\."ascensionist_count" desc nulls last, coalesce\("[a-z_]+"\."angle" = "board_climbs"\."angle", false\) desc, "[a-z_]+"\."angle" asc/;

function angleOrderByOf(rendered: { sql: string }): string {
  const match = ANGLE_ORDER_BY.exec(normalise(rendered.sql));
  expect(match, 'no shared angle-selection ORDER BY in the rendered SQL').not.toBeNull();
  return match![0].replaceAll('"angle_candidate"', '"board_climb_stats"');
}

// The rendered SQL of the real builders, never a rebuilt lookalike: a rebuilt
// predicate asserts only that the test can restate itself.
describe('the setter page queries', () => {
  const climbs = buildSetterClimbsQuery(db, 'marco', 0, SETTER_PAGE_SIZE).toSQL();
  const profile = buildSetterProfileQuery(db, 'marco').toSQL();

  it('publishes only listed, non-draft climbs', () => {
    for (const rendered of [climbs, profile]) {
      const sql = normalise(rendered.sql);
      expect(sql).toMatch(/"board_climbs"\."is_listed" = \$\d+/);
      expect(sql).toMatch(/"board_climbs"\."is_draft" = \$\d+/);
      expect(rendered.params).toContain(true);
      expect(rendered.params).toContain(false);
    }
  });

  it('decides "does this page exist" from the IDENTICAL predicate that decides what it shows', () => {
    // Byte-comparing the two recorded WHERE clauses is what goes red when a
    // predicate is added to one and not the other. Filtering the list but not
    // the existence check renders a 200 with an empty list; filtering the
    // existence check but not the list publishes drafts on an indexable page.
    expect(whereClauseOf(climbs)).toBe(whereClauseOf(profile));
    // ...and the same bindings, so the two cannot differ by a parameter either.
    // Resolved through the `$n` placeholders the WHERE clause itself names,
    // rather than by slicing the head of `params`: the head only happens to be
    // the visibility bindings today, and a drizzle bump that emitted LIMIT or
    // OFFSET first would leave the slice comparing the wrong values and passing.
    expect(whereParamsOf(climbs)).toEqual(whereParamsOf(profile));
  });

  it('picks the linked angle with the IDENTICAL rule the climbs sitemap publishes it under', () => {
    // The angle is a path segment, so two rules are two indexable URLs for one
    // page. This shipped as two hand-written ORDER BYs — the sitemap carried a
    // `COALESCE(stats.angle = climbs.angle, false)` tie-break and the setter
    // query did not — and they disagreed on 28 tier-2 climbs on the dev image.
    //
    // Both sides are read out of the SQL the real builders render. The oracle
    // in `setter-climb-links.test.ts` structurally CANNOT catch this: it feeds
    // the same fixture `angle` to both hrefs, so the angle is an input to both
    // sides there and can never disagree. This is where that gap is closed.
    const sitemap = buildTier2ClimbQuery(db, {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 27,
      setIds: [26, 31],
    }).toSQL();

    expect(angleOrderByOf(climbs)).toBe(angleOrderByOf(sitemap));
  });

  it('never picks an angle the route tables do not carry', () => {
    // `-5` is a real `board_climb_stats` angle on the dev image (28 grasshopper
    // rows) and it was the argmax for one visible climb, so the setter row
    // linked `/grasshopper/…/-5/view/…` — a URL the climbs sitemap refuses to
    // publish because it 404s. The guard is a CASE because one setter's climbs
    // span boards with different angle tables.
    const sql = normalise(climbs.sql);
    expect(sql).toContain('= any(case "board_climbs"."board_type"');

    for (const boardName of Object.keys(ANGLES) as BoardName[]) {
      const branch = climbs.params.indexOf(boardName);
      expect(branch, `no CASE branch for ${boardName}`).toBeGreaterThan(-1);
      expect(climbs.params.slice(branch + 1, branch + 1 + ANGLES[boardName].length)).toEqual([...ANGLES[boardName]]);
    }
  });

  it('selects the two array columns the canonical-config resolver needs', () => {
    const sql = normalise(climbs.sql);
    expect(sql).toContain('"compatible_size_ids"');
    expect(sql).toContain('"required_set_ids"');
  });

  it('asks for one row past the page so `hasMore` needs no second count', () => {
    expect(climbs.params).toContain(SETTER_PAGE_SIZE + 1);
  });
});
