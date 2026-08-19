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

const { SETTER_MIN_VISIBLE_CLIMBS, buildSetterSitemapSql, setterRowsToItems } = await import('../setter-query');

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
    expect(normalised).toContain(`having count(*) >= $`);
    expect(params).toContain(SETTER_MIN_VISIBLE_CLIMBS);
    expect(SETTER_MIN_VISIBLE_CLIMBS).toBe(3);
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
    expect(normalised).toContain(`to_char(max(updated_at), 'yyyy-mm-dd"t"hh24:mi:ss.ms"z"')`);
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
  });

  it('orders deterministically so a page is the same page between crawls', () => {
    expect(normalised).toContain('order by setter_username asc');
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
    climb_count: 7,
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
