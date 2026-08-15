import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import type { BoardDetails } from '@/app/lib/types';
import {
  climbRowsToItems,
  isResolvableGroup,
  resolveClimbSitemapGroups,
  type ClimbConfigGroup,
  type ClimbSitemapRow,
} from '../climb-entries';

vi.mock('server-only', () => ({}));

const KILTER_GROUP: ClimbConfigGroup = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] };

/**
 * The board identity the climb page itself resolves for the same configuration.
 * Names are deliberately identical for sizes 10 and 27 so the shadowed-size case
 * can only pass through the id-aware builder — the same trick
 * `climb-canonical-parity.test.ts` uses.
 */
function boardDetailsFor(group: ClimbConfigGroup): BoardDetails {
  return {
    board_name: group.boardType,
    layout_id: group.layoutId,
    size_id: group.sizeId,
    set_ids: group.setIds,
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
  } as unknown as BoardDetails;
}

const UPDATED_AT = new Date('2026-05-04T11:22:33.000Z');

function row(overrides: Partial<ClimbSitemapRow> = {}): ClimbSitemapRow {
  return {
    uuid: 'abcdef1234567890abcdef1234567890',
    name: 'Test Climb',
    angle: 40,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('climbRowsToItems', () => {
  it('emits the byte-identical string the climb page claims as its canonical', () => {
    // THE assertion of this PR. Not a regex, not toContain: the sitemap URL and
    // the page's own canonical are the same call, or 128k URLs get dropped as
    // "alternate page with proper canonical".
    const { items, dropped } = climbRowsToItems([row()], KILTER_GROUP);

    expect(dropped).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe(
      buildCanonicalClimbViewUrl(boardDetailsFor(KILTER_GROUP), 40, 'abcdef1234567890abcdef1234567890', 'Test Climb'),
    );
  });

  it('falls back to the display name for an unnamed climb, exactly as the page does', () => {
    // Mutation check: delete the resolveClimbDisplayName call in the builder and
    // this goes red, because the canonical below keeps the `-kilter-climb-` slug.
    const { items } = climbRowsToItems([row({ name: null })], KILTER_GROUP);

    const expectedName = resolveClimbDisplayName(null, KILTER_GROUP.boardType);
    expect(items[0].path).toContain('kilter-climb-');
    expect(items[0].path).toBe(
      buildCanonicalClimbViewUrl(boardDetailsFor(KILTER_GROUP), 40, 'abcdef1234567890abcdef1234567890', expectedName),
    );
  });

  it('emits the qualified size slug for the shadowed Kilter size (layout 1, size 27)', () => {
    const shadowed: ClimbConfigGroup = { ...KILTER_GROUP, sizeId: 27 };

    const bare = climbRowsToItems([row()], KILTER_GROUP).items[0].path;
    const qualified = climbRowsToItems([row()], shadowed).items[0].path;

    expect(qualified).not.toBe(bare);
    expect(qualified).toBe(
      buildCanonicalClimbViewUrl(boardDetailsFor(shadowed), 40, 'abcdef1234567890abcdef1234567890', 'Test Climb'),
    );
  });

  it('drops a climb whose configuration has no readable URL rather than inventing one', () => {
    // The numeric and name-based fallbacks below `tryConstructSlugViewUrl` are
    // URLs we cannot prove match the page's canonical, so they are not options.
    const unresolvable: ClimbConfigGroup = { ...KILTER_GROUP, layoutId: 999_999 };

    const { items, dropped } = climbRowsToItems([row()], unresolvable);

    expect(items).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('passes the row timestamp through and never synthesises one', () => {
    const { items } = climbRowsToItems([row()], KILTER_GROUP);

    expect(items[0].lastModified).toBe(UPDATED_AT);
    // The same 60-second window static-entries.test.ts uses: a floating
    // `new Date()` regression lands inside it, a real content timestamp does not.
    const aMinuteAgo = Date.now() - 60 * 1000;
    expect(items[0].lastModified!.getTime()).toBeLessThan(aMinuteAgo);
  });

  it('emits no changefreq or priority — the byte budget is a contract here', () => {
    const { items } = climbRowsToItems([row()], KILTER_GROUP);

    expect(items[0].changeFrequency).toBeUndefined();
    expect(items[0].priority).toBeUndefined();
  });
});

function config(overrides: Partial<PopularBoardConfig>): PopularBoardConfig {
  return {
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
    ...overrides,
  };
}

describe('resolveClimbSitemapGroups', () => {
  it('keeps exactly one configuration per (board, layout)', () => {
    const groups = resolveClimbSitemapGroups([
      config({ sizeId: 10, boardCount: 12 }),
      config({ sizeId: 27, boardCount: 3 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sizeId).toBe(10);
  });

  it('breaks ties deterministically so 128k URLs do not churn between crawls', () => {
    const tied = [
      config({ sizeId: 27, boardCount: 5, climbCount: 100 }),
      config({ sizeId: 10, boardCount: 5, climbCount: 100 }),
    ];

    expect(resolveClimbSitemapGroups(tied)[0].sizeId).toBe(10);
    expect(resolveClimbSitemapGroups([...tied].reverse())[0].sizeId).toBe(10);
  });

  it('drops a configuration with no listed climbs and one with no readable URL', () => {
    expect(resolveClimbSitemapGroups([config({ climbCount: 0 })])).toEqual([]);
    expect(resolveClimbSitemapGroups([config({ layoutId: 999_999 })])).toEqual([]);
    expect(resolveClimbSitemapGroups([config({ boardType: 'not-a-board' })])).toEqual([]);
  });

  it('orders groups deterministically by board then layout', () => {
    const groups = resolveClimbSitemapGroups([
      config({ boardType: 'tension', layoutId: 8, sizeId: 15, setIds: [12], setNames: ['Tension Sets'] }),
      config({ boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: [26, 27] }),
      config({ boardType: 'kilter', layoutId: 1 }),
    ]);

    expect(groups.map((group) => `${group.boardType}/${group.layoutId}`)).toEqual(
      [...groups].map((group) => `${group.boardType}/${group.layoutId}`).sort(),
    );
    expect(groups[0].boardType).toBe('kilter');
  });
});

describe('isResolvableGroup', () => {
  it('is a property of the configuration alone — not the angle, uuid or name', () => {
    // This is what lets the group filter stand in for a per-row check, which is
    // what keeps the count query and the item builder selecting one set.
    expect(isResolvableGroup(KILTER_GROUP)).toBe(true);
    expect(isResolvableGroup({ ...KILTER_GROUP, layoutId: 999_999 })).toBe(false);
  });
});
