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

// Use size/set ids above the routable 0–90° range so their bindings cannot be
// mistaken for angle bindings if the size/set predicates are deleted.
const KILTER: ClimbConfigGroup = { boardType: 'kilter', layoutId: 1, sizeId: 127, setIds: [126, 131] };
const MOONBOARD: ClimbConfigGroup = { boardType: 'moonboard', layoutId: 8, sizeId: 17, setIds: [24] };
const GRASSHOPPER: ClimbConfigGroup = { boardType: 'grasshopper', layoutId: 101, sizeId: 127, setIds: [126, 131] };

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

  it('breaks the angle tie with COALESCE (defensive, not load-bearing)', () => {
    // Correction to an earlier claim: this cannot currently change a result.
    // `board_climbs.uuid` is the primary key and the join is on
    // `(uuid, board_type)`, so every row in one DISTINCT ON group joins the SAME
    // `board_climbs` row — a NULL `climbs.angle` makes the comparison NULL for
    // the whole group, NULLs sort equal, and the tie-break falls through to
    // `asc(stats.angle)` either way (measured: zero differing rows over kilter
    // layout 1's 16,233 NULL-angle tier-2 climbs). Kept because it is free.
    expect(normalised).toContain('coalesce(');
    expect(normalised).toMatch(/coalesce\("board_climb_stats"\."angle" = "board_climbs"\."angle", false\) desc/);
  });

  it('constrains the angle to the canonical routable range', () => {
    expect(normalised).toMatch(/"board_climb_stats"\."angle" in \(/);
    expect(params).toContain(40);
    expect(params).toContain(41);
    expect(params).toContain(90);
    expect(params).not.toContain(91);
    expect(params).not.toContain(-5);
    expect(render(GRASSHOPPER).params).toContain(-5);
  });

  it('applies the same size and set predicates the /list front door filters on', () => {
    expect(normalised).toContain('"board_climbs"."compatible_size_ids" @> array[');
    expect(normalised).toContain('"board_climbs"."required_set_ids" <@ array[');
    expect(params).toContain(127);
    expect(params).toContain(126);
    expect(params).toContain(131);
  });

  it('excludes GENUINE alias uuids only, never the self-aliases every Kilter climb has', () => {
    // `board_climb_aliases` is mostly self-aliases: migration 0160 gave every
    // synced Kilter climb a row mapping its uuid to itself so deletion
    // reconciliation can resolve upstream removals. Production measured the
    // broken predicate excluding 106,550 of 127,131 tier-2 climbs (84%), while
    // no genuine alias currently reaches tier 2.
    expect(normalised).toContain('not exists');
    expect(normalised).toContain('"board_climb_aliases"');
    expect(normalised).toMatch(/"board_climb_aliases"\."alias_uuid" = "board_climbs"\."uuid"/);
    expect(normalised).toMatch(/"board_climb_aliases"\."alias_uuid" <> "board_climb_aliases"\."canonical_uuid"/);
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

/** Everything between the subquery's `where (` and its `order by` — the selection. */
function selectionOf(rendered: { sql: string; params: unknown[] }) {
  const normalisedSql = rendered.sql.replace(/\s+/g, ' ');
  const start = normalisedSql.indexOf('where (');
  const end = normalisedSql.indexOf('order by "board_climb_stats"."climb_uuid"');
  expect(start, 'no where clause in the rendered SQL').toBeGreaterThan(-1);
  expect(end, 'no distinct-on order by in the rendered SQL').toBeGreaterThan(start);
  return normalisedSql.slice(start, end);
}

describe('the summary query', () => {
  const rendered = buildTier2ClimbSummaryQuery(db, KILTER).toSQL();
  const sql = rendered.sql.toLowerCase().replace(/\s+/g, ' ');

  it('counts what the item query returns and dates content or stats changes in explicit UTC', () => {
    expect(sql).toContain('count(*)::int');
    // Both independent clocks feed the value: content edits advance
    // board_climbs, while ascents and grades advance board_climb_stats.
    expect(sql).toContain('greatest("stats_updated_at", "climb_updated_at")');
    // NOT a bare timestamp aggregate: raw SQL bypasses drizzle's
    // timestamp mapper, so the driver returns pg text like
    // `2026-08-10 20:39:19.492499`, which `new Date()` reads in the PROCESS
    // timezone. On any non-UTC runtime the index `<lastmod>` would then disagree
    // with the per-URL `<lastmod>` built from the same clocks.
    expect(sql).toContain(
      'to_char(max(greatest("stats_updated_at", "climb_updated_at")), \'yyyy-mm-dd"t"hh24:mi:ss.ms"z"\')',
    );
    expect(sql).toContain('distinct on ("board_climb_stats"."climb_uuid")');
    expect(sql).toContain('"board_climbs"."is_listed"');
  });

  it('selects the IDENTICAL set the item query selects, predicate for predicate', () => {
    // The page count the index publishes and the items the pages serve must not
    // describe two different sets. A byte-comparison of the recorded WHERE
    // clauses is what reds when a predicate is added to one and not the other —
    // grepping each for a keyword it already contains never will.
    const items = buildTier2ClimbQuery(db, KILTER).toSQL();
    const summary = buildTier2ClimbSummaryQuery(db, KILTER).toSQL();

    expect(selectionOf(summary)).toBe(selectionOf(items));
    // ...and the same bindings, so the two cannot differ by a parameter either.
    // The item query carries one extra trailing param: its LIMIT.
    expect(summary.params).toEqual(items.params.slice(0, summary.params.length));
  });
});
