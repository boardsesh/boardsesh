import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';

/**
 * Reposition invariant (Phase A0).
 *
 * The climb-view page SSR-emits `ClimbViewSeoFragment` — the sr-only <h1> +
 * description that carries the crawlable SEO payload. Phase A2 swaps the
 * interactive `BoardPageClimbsList` drawer for a static render, but the SEO
 * fragment must remain in the server output. This test asserts the fragment is
 * present by element identity, so a refactor can't drop it unnoticed.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
    slug: 'my-board',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
  })),
  boardToRouteParams: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    angle: 40,
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: [],
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({ uuid: 'test-climb', name: 'Test Climb', difficulty: 'V5', frames: 'p1r12' })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render?variant=overlay'),
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
}));

// The interactive list is a client component; stub it so importing the page in a
// node test doesn't pull client-only code. It is NOT what this test asserts —
// `ClimbViewSeoFragment` is deliberately left real for the identity check.
vi.mock('@/app/components/board-page/board-page-climbs-list', () => ({ default: () => null }));

const pageModule = await import('../page');

/**
 * Search the whole server-rendered element tree (not just the root's direct
 * children) for an element of `type`, so the assertion survives A2 wrapping the
 * fragment in a layout/fragment/conditional.
 */
function treeContainsElementOfType(node: React.ReactNode, type: React.ElementType): boolean {
  return React.Children.toArray(node).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (child.type === type) return true;
    const { children } = child.props as { children?: React.ReactNode };
    return treeContainsElementOfType(children, type);
  });
}

describe('board slug climb view SEO fragment', () => {
  it('SSR-emits ClimbViewSeoFragment in the server output', async () => {
    const element = (await pageModule.default({
      params: Promise.resolve({ board_slug: 'my-board', angle: '40', climb_uuid: 'test-climb' }),
    })) as React.ReactElement;

    expect(treeContainsElementOfType(element, ClimbViewSeoFragment)).toBe(true);
  });
});
