// A sitemap is a list of URLs we ask Google to crawl, and a crawled URL is a
// public one. A spray wall is one climber's own wall, so neither shard may name
// it — however many listed climbs it has.

import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { isIndexableBoardType } from '../indexable-boards';
import { resolveClimbSitemapGroups } from '../climb-entries';
import { boardConfigsToItems } from '../board-entries';

vi.mock('server-only', () => ({}));

function configFor(boardType: string, layoutId: number): PopularBoardConfig {
  return {
    boardType,
    layoutId,
    layoutName: 'Original Layout',
    sizeId: layoutId,
    sizeName: '12 x 12',
    sizeDescription: 'Square',
    setIds: [1],
    setNames: ['Holds'],
    climbCount: 500,
    totalAscents: 5_000,
    boardCount: 3,
    displayName: 'A wall',
  };
}

/** Kilter layout 1 / size 10 / sets 1,20 — a configuration that really exists. */
const KILTER_CONFIG: PopularBoardConfig = {
  ...configFor('kilter', 1),
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
};

describe('isIndexableBoardType', () => {
  it('withholds spray and nothing else', () => {
    expect(isIndexableBoardType('spray')).toBe(false);
    for (const boardType of [
      'kilter',
      'tension',
      'moonboard',
      'woods',
      'decoy',
      'grasshopper',
      'soill',
      'touchstone',
    ]) {
      expect(isIndexableBoardType(boardType), boardType).toBe(true);
    }
  });
});

describe('the climbs shard', () => {
  it('drops every spray group, however many climbs it has', () => {
    const groups = resolveClimbSitemapGroups([configFor('spray', 900), configFor('spray', 901)]);
    expect(groups).toEqual([]);
  });

  it('keeps the other boards alongside it', () => {
    // A real Kilter configuration — `resolveClimbSitemapGroups` also drops any
    // group whose segments have no readable URL, so an invented one would pass
    // this test for the wrong reason.
    const groups = resolveClimbSitemapGroups([KILTER_CONFIG, configFor('spray', 900)]);
    expect(groups.map((group) => group.boardType)).toEqual(['kilter']);
  });
});

describe('the boards shard', () => {
  it('emits no list URL for a spray wall', () => {
    expect(boardConfigsToItems([configFor('spray', 900)])).toEqual([]);
  });

  it('still emits one per angle for a real board', () => {
    const items = boardConfigsToItems([KILTER_CONFIG]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => !item.path.includes('/spray/'))).toBe(true);
  });
});
