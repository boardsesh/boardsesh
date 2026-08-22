import { describe, expect, it } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ANGLES } from '@boardsesh/board-config';
import { buildTier2ClimbQuery, MAX_ROWS_PER_GROUP, TIER_2_MIN_ASCENTS } from '../tier2-query';
import { tier2PredicateFingerprint } from '../tier2-fingerprint';
import type { ClimbConfigGroup } from '../tier2-groups';

// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, so this needs no database.
const db = drizzle({} as never);

// sizeId 27 / setIds [26, 31] deliberately: the Kilter angle list bound into the
// same params array is 0,5,…,70, so a fixture using size 10 and set 20 would make
// a `toContain(10)`-style assertion pass even with the size and set predicates
// deleted. These ids appear nowhere else in the rendered params.
const KILTER: ClimbConfigGroup = { boardType: 'kilter', layoutId: 1, sizeId: 27, setIds: [26, 31] };
const MOONBOARD: ClimbConfigGroup = { boardType: 'moonboard', layoutId: 8, sizeId: 17, setIds: [24] };

/**
 * The materialised sitemap is only as trustworthy as the guarantee that the
 * refresh job and the web fallback run the SAME query. This file renders what
 * drizzle actually produces instead of restating the predicate it hopes is there
 * — a rebuilt predicate is a tautology.
 */
describe('the tier-2 climb query, rendered', () => {
  it('binds the Kilter parameters in exactly this order', () => {
    // Positional `toEqual`, never `toContain`. Swapping `isListed` and `isDraft`
    // renders byte-identical SQL and matches zero climbs; a membership assertion
    // stays green through it because `true` and `false` are both still present.
    expect(buildTier2ClimbQuery(db, KILTER).toSQL().params).toEqual([
      'kilter',
      1,
      true, // is_listed
      false, // is_draft
      TIER_2_MIN_ASCENTS,
      ...ANGLES.kilter,
      27, // compatible_size_ids @> ARRAY[27]
      26,
      31, // required_set_ids <@ ARRAY[26, 31]
      MAX_ROWS_PER_GROUP,
    ]);
  });

  it('keeps the angle filter, which the issue text omitted', () => {
    // The one leg a prior review round found missing from the issue's SQL. A
    // table built from that description would submit URLs at angles the route
    // tables do not carry, and every one of them 404s.
    const { sql } = buildTier2ClimbQuery(db, KILTER).toSQL();
    expect(sql).toContain('"board_climb_stats"."angle" in (');
  });

  it('binds the MoonBoard parameters in exactly this order, with no size predicate', () => {
    // MoonBoard has one fixed size, so the `@>` size containment is absent
    // entirely and the set predicate takes its `IS NULL OR <@` form. That branch
    // is a second predicate with its own way of going wrong.
    expect(buildTier2ClimbQuery(db, MOONBOARD).toSQL().params).toEqual([
      'moonboard',
      8,
      true,
      false,
      TIER_2_MIN_ASCENTS,
      ...ANGLES.moonboard,
      24,
      MAX_ROWS_PER_GROUP,
    ]);

    const { sql } = buildTier2ClimbQuery(db, MOONBOARD).toSQL();
    expect(sql).not.toContain('compatible_size_ids');
    expect(sql).toContain('"board_climbs"."required_set_ids" IS NULL OR');
  });

  it('emits in primary-key order, which is what makes the stored table sliceable', () => {
    // The materialised table's PK is `(board_type, layout_id, climb_uuid)` and a
    // page is an `OFFSET/LIMIT` over it. That reproduces this order only while
    // this order is `climb_uuid` ascending.
    expect(buildTier2ClimbQuery(db, KILTER).toSQL().sql).toContain('order by "chosen"."climb_uuid" asc');
  });
});

describe('the tier-2 predicate fingerprint', () => {
  it('is this exact value', () => {
    // Pinned on purpose. It moves when the predicate moves — a changed ascent
    // threshold, an edited angle list, a new filter — and when it moves, every
    // stored row was selected by different SQL and the read path must fall back
    // until a refresh runs. Going red here is the reminder to dispatch one.
    //
    // Derived from BOTH probe groups. A one-probe fingerprint would stay green
    // through an edit confined to the MoonBoard branch, which is exactly the
    // half that has no size predicate and a different set predicate.
    expect(tier2PredicateFingerprint(db)).toBe('869710c0ae562a50');
  });

  it('is stable across calls', () => {
    expect(tier2PredicateFingerprint(db)).toBe(tier2PredicateFingerprint(db));
  });
});
