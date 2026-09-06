import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { resolveClimbSitemapGroups } from '../climb-entries';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never) }));
vi.mock('@/app/lib/server-popular-configs', () => ({ getAllBoardConfigsOrThrow: async () => [] }));

// Straight from the module that owns them: `setter-query` used to re-export
// these, which gave the same constant two import chains to drift along.
const { SETTER_MIN_VISIBLE_CLIMBS, SETTER_PAGE_SIZE } = await import('../setter-page-contract');
const { buildSetterSitemapSql, setterRowsToItems } = await import('../setter-query');

const dialect = new PgDialect();

function config(overrides: Partial<PopularBoardConfig> = {}): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    layoutName: 'Kilter Board Original',
    // sizeId 8 deliberately: it is not the layout id (1), not the climb floor
    // (3) and not any other binding in this query, so `params).toContain(8)`
    // cannot be satisfied by something else once the size predicate is deleted.
    sizeId: 8,
    sizeName: '12 x 12 with kickboard',
    sizeDescription: '12 x 12 Square',
    setIds: [1, 20],
    setNames: ['Bolt Ons', 'Screw Ons'],
    climbCount: 4200,
    totalAscents: 99,
    boardCount: 12,
    displayName: 'Kilter Original 12x12',
    ...overrides,
  };
}

function render(configs: PopularBoardConfig[]) {
  const { sql, params } = dialect.sqlToQuery(buildSetterSitemapSql(resolveClimbSitemapGroups(configs)));
  // `raw` as well as `normalised`: lowercasing turns `\S` into `\s`, so a
  // case-sensitive regex predicate is unassertable against the normalised form —
  // the correct non-whitespace class and its exact inverse look identical.
  return { raw: sql.replace(/\s+/g, ' '), normalised: sql.toLowerCase().replace(/\s+/g, ' '), params };
}

// The rendered SQL of the real builder, not a restatement of the predicate the
// test hopes is there.
describe('the setters shard query', () => {
  const { raw, normalised, params } = render([config()]);

  it('submits only setters with publicly visible climbs', () => {
    expect(normalised).toContain('is_listed = true');
    expect(normalised).toContain('is_draft = false');
  });

  it('applies a climb floor rather than submitting every setter with one climb', () => {
    // Counted over LINKABLE rows only — the CTE now carries every visible climb,
    // so a bare `count(*)` here would floor on the wrong population.
    expect(normalised).toContain(`having count(*) filter (where is_linkable) >= $`);
    expect(params).toContain(SETTER_MIN_VISIBLE_CLIMBS);
    expect(SETTER_MIN_VISIBLE_CLIMBS).toBe(3);
  });

  it('never submits a setter whose page one carries no crawlable link', () => {
    // The defect this replaced: the floor above counts a setter's WHOLE
    // catalogue, while the page's `noindex` fires on PAGE ONE — the top
    // SETTER_PAGE_SIZE by ascents, with no linkable filter. A setter with fifty
    // high-ascent climbs on unresolvable configurations and three low-ascent
    // linkable ones passed the floor and then self-noindexed, so the shard
    // advertised a URL that refuses indexing.
    expect(normalised).toContain('count(*) filter (where is_linkable and page_position <= $');
    expect(params).toContain(SETTER_PAGE_SIZE);
    expect(SETTER_PAGE_SIZE).toBe(50);

    // Ranked the way the PAGE ranks, or the check is about a different fifty.
    expect(normalised).toContain(
      'row_number() over ( partition by setter_username order by page_rank_ascents desc, uuid )',
    );
  });

  it('counts only climbs that sit on a configuration the climbs sitemap resolves', () => {
    // The "linkable" half of the gate. Without the size/set containment a setter
    // whose climbs need a set the chosen config does not carry would be
    // submitted with an <h1> over rows that carry no crawlable link at all.
    expect(normalised).toContain('board_type = $');
    expect(normalised).toContain('layout_id = $');
    expect(normalised).toContain('compatible_size_ids @> array[');
    expect(normalised).toContain('required_set_ids <@ array[');
    expect(params).toContain(8);
    expect(params).toContain(20);
  });

  it('dates each setter from real climb content, never a job clock or `new Date()`', () => {
    // NOT `board_setter_stats.updated_at`, which is `now()` at nightly refresh —
    // publishing that as <lastmod> claims every setter changed every night.
    expect(normalised).not.toContain('board_setter_stats');
    expect(normalised).toContain(`'yyyy-mm-dd"t"hh24:mi:ss.ms"z"'`);
    expect(normalised).toContain('max(content_clock) as content_clock');
  });

  it('moves <lastmod> when anything the page renders moves, not just linkable climbs', () => {
    // The page renders ascent counts, grades and quality out of
    // `board_climb_stats`, orders on them, and renders visible climbs that are
    // NOT linkable. A clock reading `board_climbs.updated_at` over linkable rows
    // alone stays put while the rendered page changes.
    expect(normalised).toContain(
      'greatest( board_climbs.updated_at, coalesce(stats.newest_stats_at, board_climbs.updated_at) )',
    );
    expect(normalised).toContain('max(candidate.updated_at) as newest_stats_at');

    // The CTE is over every visible climb; linkability is an eligibility
    // condition applied later, not a filter on the clock.
    expect(normalised).toContain('as is_linkable');

    // The page's <h1>, summary, avatar and ProfilePage JSON-LD are
    // `users.name` / `user_profiles.display_name` / `avatar_url`. Rename a
    // mapped setter and all four change while every climb row sits still, so
    // the identity clock has to be in the aggregate or <lastmod> goes stale on
    // exactly the edit a reader would notice first.
    expect(normalised).toContain('left join lateral');
    expect(normalised).toContain('from user_board_mappings ubm');
    expect(normalised).toContain('join users u on u.id = ubm.user_id');
    expect(normalised).toContain('left join user_profiles p on p.user_id = ubm.user_id');
    expect(normalised).toContain(
      'greatest(eligible.content_clock, coalesce(identity.updated_at, eligible.content_clock))',
    );

    // Once per ELIGIBLE setter, not once per visible climb: the join sits
    // outside the GROUP BY, on a query already close to SHARD_DEADLINE_MS.
    expect(normalised).toContain('from eligible');
    expect(normalised).toContain('where ubm.board_username = eligible.setter_username');
    expect(normalised).not.toContain('and (board_type = $1 and layout_id = $2');
  });

  it('excludes usernames whose URL a crawler can normalise into a 404', () => {
    // Leading/trailing whitespace encodes to a %20 crawlers strip; `/ ? #`
    // break the path outright. Both rules live in SQL so the summary and the
    // item list select the identical set.
    // Asserted against the RAW sql: `\S` (non-whitespace, what we want) and `\s`
    // (whitespace, its exact inverse — which would submit only the ~0 usernames
    // that carry edge whitespace) are the same string once lowercased.
    expect(raw).toContain(`setter_username ~ '^\\S(.*\\S)?$'`);
    expect(raw).not.toContain(`setter_username ~ '^\\s(`);
    expect(normalised).toContain(`setter_username !~ '[/?#]'`);

    // `.` and `..` clear every rule above and survive `encodeURIComponent`
    // unchanged, but URL normalisation eats them: `/setter/.` collapses to
    // `/setter/` and `/setter/..` to `/`, so the entry never reaches the route.
    expect(normalised).toContain(`setter_username !~ '^[.]{1,2}$'`);

    // C1 controls (U+0080-U+009F) are the ones the JS guard cannot catch:
    // `encodeURIComponent` encodes them and `decodeURIComponent` round-trips
    // them cleanly, so `setterRowsToItems` sees a valid username. Postgres
    // `text` in UTF-8 holds them happily, unlike a lone surrogate. Only this
    // predicate stands between one and a sitemap entry HTTP intermediaries
    // handle inconsistently.
    expect(raw).toContain(`\\x7F\\x80-\\x9F]`);

    // Rule 1's `\S` does NOT catch these. Measured against the shipped Postgres
    // (UTF8 / en_US.utf8): `chr(160) ~ '\s'` is false, so a non-breaking space
    // is `\S` to that engine and a name like `chr(160) || 'marco'` clears the
    // whitespace rule, then ships as `%C2%A0marco`.
    expect(raw).toContain(`\\u00A0`);
    expect(raw).toContain(`\\u2000-\\u200B`);
    expect(raw).toContain(`\\uFEFF`);
  });

  it('orders deterministically so a page is the same page between crawls', () => {
    expect(normalised).toContain('order by eligible.setter_username asc');
  });

  it('refuses to render at all when no board configuration resolves', () => {
    // A bare `()` in the OR list is a syntax error at the database, which is a
    // far worse way to learn the catalogue came back empty. The seam and the
    // production path both fail here, identically.
    expect(() => buildSetterSitemapSql([])).toThrow('no resolvable board configuration');
  });

  it('holds MoonBoard out through the shared group resolver, not a local check', () => {
    // Derived, not hardcoded: `resolveClimbSitemapGroups` drops MoonBoard today
    // because its set slugs do not round-trip. When #4493 fixes that parser this
    // builder starts emitting a MoonBoard branch with no edit here — and this
    // assertion is what tells us it happened.
    const moonboardGroups = resolveClimbSitemapGroups([
      config({ boardType: 'moonboard', layoutId: 1, sizeId: 17, setIds: [24], layoutName: 'MoonBoard 2016' }),
    ]);
    expect(moonboardGroups).toHaveLength(0);
  });
});

describe('setterRowsToItems', () => {
  const row = (setter_username: string, last_modified: string | null) => ({
    setter_username,
    last_modified,
  });

  it('emits the byte-identical path the setter page canonicalises to', () => {
    const { items, dropped } = setterRowsToItems([row('Marco & Co', '2026-05-04T11:22:33.000Z')]);

    expect(dropped).toBe(0);
    expect(items).toEqual([{ path: '/setter/Marco%20%26%20Co', lastModified: new Date('2026-05-04T11:22:33.000Z') }]);
  });

  it('passes the row clock through rather than stamping the crawl time', () => {
    // Exact equality against a fixed past date, so a `new Date()` here reds
    // without needing a frozen clock.
    const { items } = setterRowsToItems([row('marco', '2026-05-04T11:22:33.000Z')]);
    expect(items[0].lastModified?.toISOString()).toBe('2026-05-04T11:22:33.000Z');
  });

  it('carries a null clock through instead of inventing one', () => {
    const { items } = setterRowsToItems([row('marco', null)]);
    expect(items[0].lastModified).toBeNull();
  });
});
