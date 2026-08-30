import { describe, expect, it } from 'vite-plus/test';
import { ANGLES } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { popularConfigListUrl } from '@/app/lib/url-utils';
import { boardConfigsToItems } from '../board-entries';

const kilterConfig: PopularBoardConfig = {
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

const moonboardConfig: PopularBoardConfig = {
  ...kilterConfig,
  boardType: 'moonboard',
  layoutId: 8,
  sizeId: 17,
  displayName: 'MoonBoard 2016',
};

describe('boardConfigsToItems', () => {
  it('emits one entry per angle for the board type', () => {
    const items = boardConfigsToItems([kilterConfig]);
    expect(items).toHaveLength(ANGLES.kilter.length);
    expect(ANGLES.kilter).toHaveLength(15);
  });

  it('emits the MoonBoard angle set for MoonBoard configs', () => {
    expect(boardConfigsToItems([moonboardConfig])).toHaveLength(ANGLES.moonboard.length);
    expect(ANGLES.moonboard).toHaveLength(2);
  });

  it('uses the shared popular-config list-URL builder', () => {
    const items = boardConfigsToItems([kilterConfig]);
    for (const [index, angle] of ANGLES.kilter.entries()) {
      expect(items[index].path).toBe(popularConfigListUrl(kilterConfig, angle));
    }
  });

  it('keeps the id-aware slug for a shadowed size rather than the name-based one', () => {
    // Kilter layout 1 sizes 10/27 share the `12x12-square` base slug. Slugging
    // from names alone collapses this config onto the other physical board.
    const [item] = boardConfigsToItems([kilterConfig]);
    expect(item.path).not.toContain('12-x-12-square');
  });

  it('falls back to numeric ids, never an empty path segment, when set names are missing', () => {
    // A config the static slug tables can't resolve, with no set names: the
    // name-based branch would emit `/kilter/weird-layout/weird-size//40/list`,
    // a 404 submitted straight to Google.
    const unresolvable: PopularBoardConfig = {
      ...kilterConfig,
      layoutId: 9999,
      sizeId: 8888,
      setIds: [7777],
      layoutName: 'Weird Layout',
      sizeName: 'Weird Size',
      sizeDescription: null,
      setNames: [],
    };

    const items = boardConfigsToItems([unresolvable]);
    for (const item of items) {
      expect(item.path).not.toContain('//');
    }
    expect(items[0].path).toBe(`/kilter/9999/8888/7777/${ANGLES.kilter[0]}/list`);
  });

  it('never emits a paged variant or a /b/{slug} URL', () => {
    for (const item of boardConfigsToItems([kilterConfig, moonboardConfig])) {
      expect(item.path).not.toContain('?');
      expect(item.path.startsWith('/b/')).toBe(false);
    }
  });

  it('carries no lastModified — there is no real per-config timestamp to report', () => {
    for (const item of boardConfigsToItems([kilterConfig])) {
      expect(item.lastModified).toBeUndefined();
    }
  });

  it('skips configs with no listed climbs and unknown board types', () => {
    expect(boardConfigsToItems([{ ...kilterConfig, climbCount: 0 }])).toHaveLength(0);
    expect(boardConfigsToItems([{ ...kilterConfig, boardType: 'not-a-board' }])).toHaveLength(0);
  });

  it('keeps runtime-only Quantum pages out of the legacy www sitemap', () => {
    expect(boardConfigsToItems([{ ...kilterConfig, boardType: 'quantum', layoutId: 9101, sizeId: 9201 }])).toEqual([]);
  });
});
