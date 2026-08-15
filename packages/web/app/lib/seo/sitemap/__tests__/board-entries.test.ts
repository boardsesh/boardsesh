import { describe, expect, it } from 'vite-plus/test';
import { ANGLES } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
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

  it('uses the same canonical builder the list pages canonicalise to', () => {
    const items = boardConfigsToItems([kilterConfig]);
    for (const [index, angle] of ANGLES.kilter.entries()) {
      expect(items[index].path).toBe(
        buildCanonicalClimbListUrl(
          {
            board_name: 'kilter',
            layout_id: kilterConfig.layoutId,
            size_id: kilterConfig.sizeId,
            set_ids: kilterConfig.setIds,
            layout_name: kilterConfig.layoutName ?? undefined,
            size_name: kilterConfig.sizeName ?? undefined,
            size_description: kilterConfig.sizeDescription ?? undefined,
            set_names: kilterConfig.setNames,
          },
          angle,
        ),
      );
    }
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
});
