import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { ClimbConfigGroup } from '../climb-entries';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never) }));
vi.mock('@/app/lib/server-popular-configs', () => ({ getAllBoardConfigsOrThrow: async () => [] }));

const { buildTier2ClimbQuery, buildTier2ClimbSummaryQuery, TIER_2_MIN_ASCENTS } = await import('../climb-query');

const db = drizzle({} as never);

const KILTER: ClimbConfigGroup = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] };
const MOONBOARD: ClimbConfigGroup = { boardType: 'moonboard', layoutId: 8, sizeId: 17, setIds: [24] };

function render(group: ClimbConfigGroup) {
  const { sql, params } = buildTier2ClimbQuery(db, group).toSQL();
  return { normalised: sql.toLowerCase().replace(/\s+/g, ' '), params };
}

// Renders the SQL drizzle actually produces rather than restating the predicate
// the test hopes is there — a rebuilt predicate is a tautology.
describe('the tier-2 climbs query', () => {
  const { normalised, params } = render(KILTER);

  it('publishes only listed, non-draft climbs', () => {
    expect(normalised).toMatch(/"board_climbs"\."is_listed" = \$\d+/);
    expect(normalised).toMatch(/"board_climbs"\."is_draft" = \$\d+/);
    expect(params).toContain(true);
    expect(params).toContain(false);
  });

  it('is tier 2, not tier 3: at least ten ascents', () => {
    expect(normalised).toMatch(/"board_climb_stats"\."ascensionist_count" >= \$\d+/);
    expect(params).toContain(TIER_2_MIN_ASCENTS);
    expect(TIER_2_MIN_ASCENTS).toBe(10);
  });

  it('keeps exactly one angle per climb', () => {
    expect(normalised).toContain('distinct on ("board_climb_stats"."climb_uuid")');
    expect(normalised).toMatch(/order by "board_climb_stats"\."climb_uuid",/);
    expect(normalised).toMatch(/"board_climb_stats"\."ascensionist_count" desc/);
  });

  it('breaks the angle tie with COALESCE, because board_climbs.angle is nullable', () => {
    // Postgres orders DESC with NULLS FIRST, so a bare `stats.angle = climbs.angle`
    // would let a null-angle climb outrank the angle that actually matches.
    expect(normalised).toContain('coalesce(');
    expect(normalised).toMatch(/coalesce\("board_climb_stats"\."angle" = "board_climbs"\."angle", false\) desc/);
  });

  it('constrains the angle to the ones the route tables carry', () => {
    expect(normalised).toMatch(/"board_climb_stats"\."angle" in \(/);
    expect(params).toContain(40);
    expect(params).not.toContain(41);
  });

  it('applies the same size and set predicates the /list front door filters on', () => {
    expect(normalised).toContain('"board_climbs"."compatible_size_ids" @> array[');
    expect(normalised).toContain('"board_climbs"."required_set_ids" <@ array[');
    expect(params).toContain(10);
    expect(params).toContain(20);
  });

  it('excludes alias uuids, which self-canonicalise to themselves', () => {
    expect(normalised).toContain('not exists');
    expect(normalised).toContain('"board_climb_aliases"');
    expect(normalised).toMatch(/"board_climb_aliases"\."alias_uuid" = "board_climbs"\."uuid"/);
  });

  it('orders the page deterministically and caps the rows it will hold', () => {
    expect(normalised).toMatch(/\) "chosen" order by "chosen"\."climb_uuid" asc/);
    expect(normalised).toMatch(/limit \$\d+/);
  });
});

describe('the MoonBoard variant', () => {
  const { normalised } = render(MOONBOARD);

  it('emits no size predicate — MoonBoard has one fixed size', () => {
    expect(normalised).not.toContain('compatible_size_ids');
  });

  it('allows a NULL required_set_ids, the same allowance the /list filter makes', () => {
    expect(normalised).toContain('"board_climbs"."required_set_ids" is null or');
  });

  it('still excludes aliases and still requires ten ascents', () => {
    expect(normalised).toContain('not exists');
    expect(normalised).toMatch(/"ascensionist_count" >= \$\d+/);
  });
});

describe('the summary query', () => {
  const rendered = buildTier2ClimbSummaryQuery(db, KILTER).toSQL();
  const sql = rendered.sql.toLowerCase().replace(/\s+/g, ' ');

  it('counts and dates exactly what the item query would return', () => {
    // Same DISTINCT ON subquery, so the page count the index publishes and the
    // items the pages serve cannot describe two different sets.
    expect(sql).toContain('count(*)::int');
    expect(sql).toContain('max("updated_at")');
    expect(sql).toContain('distinct on ("board_climb_stats"."climb_uuid")');
    expect(sql).toContain('"board_climbs"."is_listed"');
  });
});
