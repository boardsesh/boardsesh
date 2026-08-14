import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { LIST_ROW_HEIGHT } from '@/app/lib/climb-list-constants';
import StaticClimbList from '../static-climb-list';

/**
 * The headline verify for W-12: the *first* render — the one the crawler and
 * the HTML response see — already contains real climb anchors.
 *
 * `@tanstack/react-virtual` is deliberately NOT mocked here. The whole SSR
 * mechanism is the `initialRect` the list hands `useWindowVirtualizer`: without
 * it `getVirtualItems()` returns `[]` on the server and the HTML carries zero
 * links. A mocked virtualizer would make this test pass no matter what.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/playlists/some-uuid',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));
vi.mock('@/app/components/climb-card/climb-title', () => ({
  default: ({ climb }: { climb: { name?: string } }) => <span>{climb.name}</span>,
}));

function makeClimb(index: number): Climb {
  return {
    uuid: `CLIMB${index}`,
    name: `Test Boulder ${index}`,
    setter_username: 'setter',
    description: '',
    frames: `p${index}r14`,
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  } as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
  } as BoardDetails;
}

const twentyClimbs = Array.from({ length: 20 }, (_, index) => makeClimb(index));

function renderListToString() {
  return renderToString(
    <StaticClimbList
      climbs={twentyClimbs}
      boardDetails={makeBoardDetails()}
      isFetching={false}
      hasMore={false}
      onLoadMore={() => {}}
    />,
  );
}

describe('StaticClimbList server render', () => {
  it('emits real climb anchors in the server HTML', () => {
    const html = renderListToString();
    const anchors = html.match(/href="\/kilter\//g) ?? [];
    expect(anchors.length).toBeGreaterThanOrEqual(8);
  });

  it('points the first anchor at the canonical config-tuple view URL', () => {
    const html = renderListToString();
    expect(html).toContain('href="/kilter/original/12x12-square/screw_bolt/40/view/test-boulder-0-CLIMB0"');
  });

  /**
   * The negative control that makes the two assertions above non-vacuous:
   * drive the same virtualizer with the same options *minus* `initialRect` and
   * show that the server window collapses to nothing. If someone deletes that
   * option from the list, the anchors go with it.
   */
  it('produces no server-side rows at all without initialRect', () => {
    let withRect = -1;
    let withoutRect = -1;

    function Probe({ withInitialRect }: { withInitialRect: boolean }) {
      const virtualizer = useWindowVirtualizer({
        count: twentyClimbs.length,
        estimateSize: () => LIST_ROW_HEIGHT,
        overscan: 10,
        getItemKey: (index) => twentyClimbs[index]?.uuid ?? index,
        ...(withInitialRect ? { initialRect: { width: 375, height: 812 } } : {}),
      });
      const count = virtualizer.getVirtualItems().length;
      if (withInitialRect) withRect = count;
      else withoutRect = count;
      return null;
    }

    renderToString(<Probe withInitialRect />);
    renderToString(<Probe withInitialRect={false} />);

    expect(withoutRect).toBe(0);
    expect(withRect).toBeGreaterThan(0);
  });
});
