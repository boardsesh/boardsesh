// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import type { BoardDetails, Climb } from '@/app/lib/types';
import StaticClimbRow from '../static-climb-row';

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// The rendered board is irrelevant here — only the href the row wraps is.
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — that both *name*-slug to `12x12-square`. Rows
 * must address the exact wall, so the href has to come from #4417's id-aware
 * generators via `buildCanonicalClimbViewUrl`. Slugging from names would point
 * a size-27 climber's row at size 10's board.
 *
 * The row also always emits the canonical config-tuple URL, never the `/b`
 * form: `getContextAwareClimbViewUrl` would keep a visitor on
 * `/b/{slug}/{angle}/playlists/{uuid}` inside the `/b` tree, and the front
 * door's whole point is that these links are the canonical, indexable ones.
 */
function makeBoardDetails(sizeId: number): BoardDetails {
  return {
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    board_name: 'kilter',
    layout_id: 1,
    size_id: sizeId,
    set_ids: [1, 20],
  };
}

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'ABC123',
    setter_username: 'setter',
    name: 'Test Climb',
    description: '',
    frames: 'p1080r15',
    angle: 40,
    ascensionist_count: 3,
    difficulty: '6a',
    quality_average: '3',
    stars: 3,
    mirrored: false,
    ...overrides,
  } as Climb;
}

function rowHref(boardDetails: BoardDetails, climb: Climb = makeClimb()) {
  render(<StaticClimbRow climb={climb} boardDetails={boardDetails} pathname="/playlists/some-uuid" />);
  return screen.getByRole('link').getAttribute('href');
}

describe('StaticClimbRow climb-view href', () => {
  it('emits the qualified size slug for the shadowed Kilter size', () => {
    expect(rowHref(makeBoardDetails(27))).toBe(
      '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/test-climb-ABC123',
    );
  });

  it('leaves the size that owns the bare slug on it', () => {
    expect(rowHref(makeBoardDetails(10))).toBe('/kilter/original/12x12-square/screw_bolt/40/view/test-climb-ABC123');
  });

  it("uses the climb's own angle, not a page-level one", () => {
    expect(rowHref(makeBoardDetails(10), makeClimb({ angle: 25 }))).toBe(
      '/kilter/original/12x12-square/screw_bolt/25/view/test-climb-ABC123',
    );
  });

  it('renders no anchor at all when the climb has no resolvable URL', () => {
    // A session tick the catalog lookup missed carries no name, no layout and
    // no frames, so every part of a climb URL for it would be invented. The
    // row still shows what the tick knows, minus the link.
    render(
      <StaticClimbRow climb={makeClimb()} boardDetails={makeBoardDetails(10)} pathname="/session/session-1" unlinked />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('climb-thumbnail')).toBeTruthy();
  });

  it('renders exactly one interactive element, so the anchor stays valid and keyboard-navigable', () => {
    render(<StaticClimbRow climb={makeClimb()} boardDetails={makeBoardDetails(10)} pathname="/playlists/some-uuid" />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
