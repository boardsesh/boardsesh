import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never), executeRows: async () => [] }));

const { buildSetterClimbsQuery, buildSetterProfileQuery, SETTER_PAGE_SIZE } = await import('../server-setter-data');

const db = drizzle({} as never);

function normalise(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ');
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
  return sql.slice(start, end.length > 0 ? Math.min(...end) : sql.length);
}

/** The bindings the WHERE clause actually references, in the order it names them. */
function whereParamsOf(rendered: { sql: string; params: unknown[] }): unknown[] {
  const placeholders = whereClauseOf(rendered).match(/\$(\d+)/g) ?? [];
  return placeholders.map((placeholder) => rendered.params[Number(placeholder.slice(1)) - 1]);
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

  it('links each climb at the angle with the most ascents, the rule the climbs sitemap uses', () => {
    const sql = normalise(climbs.sql);
    expect(sql).toContain('order by s.ascensionist_count desc nulls last');
    expect(sql).toContain('from board_climb_stats s');
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
