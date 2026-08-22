import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

/**
 * The seam that decides whether MoonBoard is in the sitemap at all, tested as a
 * composition rather than as three separate mocks agreeing with each other.
 *
 * Since #4552 the shard pages do not build anything: they read
 * `sitemap_climb_urls`, and that table is written by one refresher whose only
 * selection entry point is `buildAllTier2UrlRows()`. So a synthetic MoonBoard
 * config that reaches `/sitemaps/boards.xml` but not THIS function produces a
 * store that has never heard of MoonBoard and a shard that emits nothing new —
 * a change that looks complete in review, passes the boards-shard tests, and
 * ships a no-op.
 *
 * `climb-store.test.ts` pins the other half: the rows this returns are the rows
 * written and the rows a page serves. Together they are the end-to-end claim.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbzRead: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: never[]) => unknown) => fn }));

const KILTER_CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

/**
 * MoonBoard Masters 2017, every hold set — the tuple `board-config-source.ts`
 * synthesises for layout 4, written out as literals rather than re-derived by
 * calling `getDefaultRenderBoard` here, which would assert `f(x) === f(x)`.
 *
 * Masters 2017 on purpose: `Screw-on Feet` slugs to `screw`, which is the set
 * the old `-`-splitting parser silently dropped, so the URL this emits is also
 * the one #4576's round-trip fix is about.
 */
const MOONBOARD_MASTERS_2017: PopularBoardConfig = {
  boardType: 'moonboard',
  layoutId: 4,
  layoutName: 'MoonBoard Masters 2017',
  sizeId: 1,
  sizeName: 'MoonBoard',
  sizeDescription: '11 x 18',
  setIds: [11, 12, 13, 14, 15, 16],
  setNames: ['Hold Set A', 'Hold Set B', 'Hold Set C', 'Original School Holds', 'Screw-on Feet', 'Wooden Holds'],
  climbCount: 54_678,
  totalAscents: 0,
  boardCount: 0,
  displayName: 'MoonBoard Masters 2017',
};

const source = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock('../board-config-source', () => ({
  getSitemapClimbConfigsOrThrow: async () => source.configs,
}));

/**
 * One climb per group. The MoonBoard uuid is the dashed RFC-4122 form every
 * MoonBoard row in `board_climbs` actually carries, not a 32-hex stand-in — the
 * shape #4576's extractor had to learn, and the shape whose URL has to survive
 * being stored as text and read back.
 */
const MOONBOARD_UUID = '9fe54099-6fdd-5adb-b82f-2d7bcb10d4ad';
/**
 * The full masters-2017 set slug as `generateSetSlug` emits it — descending by
 * set-name slug, `_`-joined, with `screw` (Screw-on Feet) present. Written out
 * rather than computed from the config's `setNames`, so a builder that started
 * emitting a partial or differently-ordered list has something to disagree with.
 */
const FULL_SET_SLUG = 'wooden-holds_screw_original-school-holds_hold-set-c_hold-set-b_hold-set-a';
const KILTER_UUID = 'abcdef1234567890abcdef1234567890';

const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock('@boardsesh/db/queries', () => ({
  withSerialPlan: async () => {
    scans.count += 1;
    // Both uuids on every group; `climbRowsToItems` renders whatever the group
    // it was handed says, so the MoonBoard path can only appear if a MoonBoard
    // GROUP reached the loop.
    return [MOONBOARD_UUID, KILTER_UUID].map((uuid) => ({
      uuid,
      name: 'To Dokids Yuito',
      angle: 40,
      statsUpdatedAt: new Date('2026-05-04T11:22:33.000Z'),
      climbUpdatedAt: new Date('2026-05-05T00:00:00.000Z'),
    }));
  },
}));

const { buildAllTier2UrlRows } = await import('../climb-query');

afterEach(() => {
  scans.count = 0;
  source.configs = [];
});

describe('the refresher that fills sitemap_climb_urls', () => {
  it('emits MoonBoard URLs, so the stored rows carry them', async () => {
    source.configs = [KILTER_CONFIG, MOONBOARD_MASTERS_2017];

    const urlRows = await buildAllTier2UrlRows();
    const moonboardRows = urlRows.filter((row) => row.boardType === 'moonboard');

    // Two climbs on the MoonBoard group, and the annotation the store writes
    // into `board_type` / `layout_id` names the group they came from.
    expect(moonboardRows).toHaveLength(2);
    expect(new Set(moonboardRows.map((row) => row.layoutId))).toEqual(new Set([4]));

    // The full set slug, `_`-joined, INCLUDING `screw` — the part the old parser
    // could not produce and the reason masters-2017 canonicalised onto a URL
    // nobody asked for.
    expect(moonboardRows.map((row) => row.path)).toEqual([
      `/moonboard/masters-2017/standard-11x18-grid/${FULL_SET_SLUG}/40/view/to-dokids-yuito-${MOONBOARD_UUID}`,
      `/moonboard/masters-2017/standard-11x18-grid/${FULL_SET_SLUG}/40/view/to-dokids-yuito-${KILTER_UUID}`,
    ]);

    // Kilter is untouched and still first: the config source is additive, and a
    // MoonBoard row displacing an Aurora one would move every page boundary in
    // the store.
    expect(urlRows[0]?.boardType).toBe('kilter');
    expect(urlRows.filter((row) => row.boardType === 'kilter')).toHaveLength(2);
  });

  it('carries no MoonBoard rows when the config source has none — the state before this change', async () => {
    source.configs = [KILTER_CONFIG];

    const urlRows = await buildAllTier2UrlRows();

    // The negative arm is what makes the positive one mean something: it pins
    // that the MoonBoard paths above came from the CONFIG SOURCE and not from
    // some unconditional MoonBoard branch inside the builder.
    expect(urlRows.filter((row) => row.boardType === 'moonboard')).toHaveLength(0);
    expect(scans.count).toBe(1);
  });
});
