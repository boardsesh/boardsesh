import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { gzipSync } from 'node:zlib';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { toBoardImageDetails } from '@/app/lib/board-image-details';
import type { BoardImageDetails, Climb } from '@/app/lib/types';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('../front-door-breadcrumb', () => ({ default: () => null }));
vi.mock('../climb-creative-work-json-ld', () => ({ default: () => null }));
vi.mock('../climb-list-json-ld', () => ({ default: () => null }));
vi.mock('../climb-facts', () => ({ default: () => null }));
vi.mock('../angle-cross-links', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));
vi.mock('@/app/components/social/climb-social-section', () => ({ default: () => null }));
vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({ default: () => null }));
vi.mock('@/app/components/similar-climbs/similar-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-list/static-climb-list', () => ({ default: () => null }));

import ClimbFrontDoor from '../climb-front-door';
import StaticListFrontDoor from '../static-list-front-door';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';

function clientProps(node: React.ReactNode, component: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = clientProps(child, component);
      if (Object.keys(found).length) return found;
    }
  }
  if (!React.isValidElement(node)) return {};
  const element = node as React.ReactElement<Record<string, unknown>>;
  return element.type === component ? element.props : clientProps(element.props.children as React.ReactNode, component);
}

function expectSmallGeometryFreeProps(details: unknown, original: object) {
  const serialized = JSON.stringify(details);
  expect(Buffer.byteLength(serialized)).toBeLessThan(700);
  expect(gzipSync(serialized).length).toBeLessThan(gzipSync(JSON.stringify(original)).length / 3);
  expect(serialized).not.toMatch(/holdsData|images_to_holds|mirroredHoldId|"cx"|"cy"|"edge_/);
}

const climb = { uuid: 'climb', name: 'Example', frames: 'p1r42', setter_username: 'setter' } as Climb;

describe('real server component board-image boundaries', () => {
  it.each([
    { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] },
    { board_name: 'moonboard', layout_id: 6, size_id: 1, set_ids: [24, 25, 26, 27] },
    { board_name: 'woods', layout_id: 1, size_id: 2, set_ids: [1] },
  ])('strips hold arrays before similar and static-list client props: $board_name', async (params) => {
    const full = getBoardDetailsForBoard(params);
    // Extra fields are deliberate: structural typing permits them, so the actual boundary must project.
    const serverDetails = { ...full, ...toBoardImageDetails(full) } satisfies BoardImageDetails;
    const climbTree = await ClimbFrontDoor({
      climb,
      boardDetails: serverDetails,
      angle: 40,
      canonicalAngle: 40,
      angleStats: [],
      similarClimbs: { status: 'loaded', items: [] },
      betaLinks: { status: 'loaded', items: [] },
      handoffPath: '/example',
      tree: 'config-tuple',
    });
    const listTree = await StaticListFrontDoor({
      boardDetails: serverDetails,
      angle: 40,
      climbs: [climb],
      hasMore: false,
      page: 1,
      basePath: '/example/list',
      tree: 'config-tuple',
    });
    const similarDetails = clientProps(climbTree, SimilarClimbsList).viewerBoardDetails;
    const listDetails = clientProps(listTree, StaticClimbList).boardDetails;
    expect(similarDetails).toEqual(toBoardImageDetails(full));
    expect(listDetails).toEqual(toBoardImageDetails(full));
    expectSmallGeometryFreeProps(similarDetails, full);
    expectSmallGeometryFreeProps(listDetails, full);
  });
});
