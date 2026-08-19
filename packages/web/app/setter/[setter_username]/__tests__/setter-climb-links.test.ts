import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { climbRowsToItems, resolveClimbSitemapGroups } from '@/app/lib/seo/sitemap/climb-entries';
import { getBoardDetailsForPlaylist } from '@/app/lib/board-config-for-playlist';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbz: {}, dbzRead: {}, executeRows: async () => [] }));

const { resolveSetterClimbLinks } = await import('../setter-climb-links');
type SetterClimbRow = Parameters<typeof resolveSetterClimbLinks>[0][number];

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

function climb(overrides: Partial<SetterClimbRow> = {}): SetterClimbRow {
  return {
    uuid: 'abcdef1234567890abcdef1234567890',
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'marco',
    name: 'Test Climb',
    description: '',
    frames: 'p1080r15',
    framesCount: 1,
    framesPace: 0,
    angle: 40,
    ascensionist_count: 12,
    difficulty: '6B',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    created_at: null,
    compatibleSizeIds: [10, 27],
    requiredSetIds: [1, 20],
    updatedAt: new Date('2026-05-04T11:22:33.000Z'),
    ...overrides,
  } as SetterClimbRow;
}

/**
 * The href a setter row will actually render for this climb: `StaticClimbRow`
 * builds it from the per-climb `BoardDetails` with exactly this call.
 */
function renderedHref(links: ReturnType<typeof resolveSetterClimbLinks>, row: SetterClimbRow): string | null {
  const boardDetails = links.boardDetailsByClimb[row.uuid];
  if (!boardDetails || links.unlinkedClimbUuids.has(row.uuid)) return null;
  return buildCanonicalClimbViewUrl(
    boardDetails,
    row.angle,
    row.uuid,
    resolveClimbDisplayName(row.name, boardDetails.board_name),
  );
}

/**
 * The URL `/sitemaps/climbs/N.xml` submits for the same climb — COMPUTED from
 * the sitemap builder, never pinned.
 *
 * This is the whole point of the oracle. A hardcoded expectation would still
 * pass if the link builder and the sitemap builder both drifted, and it would
 * not have caught any of the four earlier wrong-board-URL bugs in this campaign.
 */
function sitemapHref(configs: PopularBoardConfig[], row: SetterClimbRow): string | null {
  const group = resolveClimbSitemapGroups(configs).find(
    (candidate) => candidate.boardType === row.boardType && candidate.layoutId === row.layoutId,
  );
  if (!group) return null;
  const { items } = climbRowsToItems(
    [{ uuid: row.uuid, name: row.name, angle: row.angle, updatedAt: row.updatedAt }],
    group,
  );
  return items[0]?.path ?? null;
}

describe('resolveSetterClimbLinks', () => {
  it('links a climb to the same URL the climbs sitemap submits for it', () => {
    // Two configs on one layout: the sitemap picks size 10 (most boards); the
    // client path this replaces picked the LARGEST size plus every set, which is
    // a different tuple and therefore a second indexable URL per climb.
    const configs = [
      config({ sizeId: 10, boardCount: 12 }),
      config({ sizeId: 27, boardCount: 3, setIds: [1, 20, 26] }),
    ];
    const row = climb();

    const links = resolveSetterClimbLinks([row], configs);
    const expected = sitemapHref(configs, row);

    expect(expected).toBeTruthy();
    expect(renderedHref(links, row)).toBe(expected);
  });

  it('does not build the link the way the old client list did', () => {
    // The mutation this file exists to catch: resolving the board with
    // `getBoardDetailsForPlaylist` (largest size + every set) instead of the
    // sitemap group. If the two ever agree the assertion below is vacuous, so
    // it asserts they differ before asserting which one we picked.
    const configs = [config({ sizeId: 10, boardCount: 12 })];
    const row = climb();

    const playlistDetails = getBoardDetailsForPlaylist(row.boardType, row.layoutId);
    expect(playlistDetails).not.toBeNull();
    const playlistHref = buildCanonicalClimbViewUrl(
      playlistDetails!,
      row.angle,
      row.uuid,
      resolveClimbDisplayName(row.name, row.boardType),
    );

    const links = resolveSetterClimbLinks([row], configs);
    expect(renderedHref(links, row)).not.toBe(playlistHref);
    expect(renderedHref(links, row)).toBe(sitemapHref(configs, row));
  });

  it('leaves a climb unlinked when no sitemap group resolves for its layout', () => {
    // MoonBoard today: `resolveClimbSitemapGroups` drops it, so its climbs get
    // no anchor rather than a URL whose canonical points somewhere else. Derived
    // from the real resolver, so this also goes red if MoonBoard is later lifted
    // into the groups without fixing the set-slug parser.
    const moonboardConfigs = [
      config({ boardType: 'moonboard', layoutId: 1, sizeId: 17, setIds: [24], layoutName: 'MoonBoard 2016' }),
    ];
    const row = climb({ boardType: 'moonboard', layoutId: 1, compatibleSizeIds: [], requiredSetIds: [] });

    expect(sitemapHref(moonboardConfigs, row)).toBeNull();

    const links = resolveSetterClimbLinks([row], moonboardConfigs);
    expect(links.unlinkedClimbUuids.has(row.uuid)).toBe(true);
    expect(renderedHref(links, row)).toBeNull();
    // Still drawn on its own board — the display board is not a URL.
    expect(links.boardDetailsByClimb[row.uuid]?.board_name).toBe('moonboard');
  });

  it('leaves a climb unlinked when it does not fit the chosen configuration', () => {
    // The group is resolvable, but this climb needs a set the config does not
    // carry — the same `required_set_ids <@ setIds` rule the sitemap query
    // applies before it will name a config in a climb's URL.
    const configs = [config({ sizeId: 10, setIds: [1, 20] })];
    const row = climb({ requiredSetIds: [1, 20, 26] });

    const links = resolveSetterClimbLinks([row], configs);
    expect(links.unlinkedClimbUuids.has(row.uuid)).toBe(true);
    expect(renderedHref(links, row)).toBeNull();
  });

  it('names the board the most linked climbs sit on', () => {
    const configs = [config({ layoutId: 1 }), config({ layoutId: 8, sizeId: 25, setIds: [26, 31] })];
    const links = resolveSetterClimbLinks([climb({ uuid: 'a'.repeat(32) }), climb({ uuid: 'b'.repeat(32) })], configs);

    expect(links.primaryGroup?.layoutId).toBe(1);
    expect(links.fallbackBoardDetails?.board_name).toBe('kilter');
  });
});
