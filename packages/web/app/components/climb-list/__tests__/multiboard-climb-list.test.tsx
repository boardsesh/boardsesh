// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Climb } from '@/app/lib/types';
import MultiboardClimbList from '../multiboard-climb-list';

/**
 * Delete-safety oracle for the W-12 repoint. This surface serves
 * `/playlists/[uuid]`, `/setter/[username]`, `/profile/{id}/climbs` and
 * `/discover/*`, and its rows are now crawlable links rather than click
 * handlers.
 *
 * There is deliberately no `vi.mock` for `climb-actions/*`, `graphql-queue` or
 * `board-page/climbs-list` here: the file no longer imports any of them, and
 * vitest throws on a mock whose path the module graph never reaches. The
 * absence of those mocks is the signal.
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

vi.mock('@/app/components/board-scroll/board-filter-strip', () => ({
  default: () => <div data-testid="board-filter-strip" />,
}));

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSessionState: () => ({ activeSession: null }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: () => ({ boards: [], isLoading: false }),
}));

// jsdom has no IntersectionObserver, and the real infinite-scroll sentinel runs
// here (unmocked, so the wiring is part of what this test covers).
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);

vi.mock('@/app/hooks/use-board-details-map', () => ({
  useBoardDetailsMap: (climbs: Climb[]) => ({
    defaultBoardDetails: {
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
    },
    boardDetailsByClimb: Object.fromEntries(
      climbs.map((climb) => [
        climb.uuid,
        {
          board_name: climb.boardType ?? 'kilter',
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
        },
      ]),
    ),
    unsupportedClimbs: new Set<string>(),
    upsizedClimbs: new Set<string>(),
  }),
}));

function makeClimb(index: number, boardType: 'kilter' | 'tension'): Climb {
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
    boardType,
  } as Climb;
}

const threeClimbs = [makeClimb(0, 'kilter'), makeClimb(1, 'tension'), makeClimb(2, 'kilter')];

function renderList(overrides: Partial<React.ComponentProps<typeof MultiboardClimbList>> = {}) {
  const props: React.ComponentProps<typeof MultiboardClimbList> = {
    climbs: threeClimbs,
    isFetching: false,
    isLoading: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    selectedBoard: null,
    onBoardSelect: vi.fn(),
    ...overrides,
  };
  return render(<MultiboardClimbList {...props} />);
}

describe('MultiboardClimbList', () => {
  it('renders every climb as a real link to its own board', () => {
    renderList();
    const hrefs = screen.getAllByRole('link').map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/(kilter|tension)\/.+\/view\//);
    }
    // The per-climb board override is what keeps a cross-board playlist honest.
    expect(hrefs.some((href) => href?.startsWith('/tension/'))).toBe(true);
  });

  it('still shows the empty state for a settled, empty list', () => {
    renderList({ climbs: [] });
    expect(screen.getByText('multiboardList.noClimbsFound')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('keeps the sort toggle working', () => {
    const onSortChange = vi.fn();
    renderList({ showSortToggle: true, sortBy: 'popular', onSortChange });
    fireEvent.click(screen.getByText('multiboardList.new'));
    expect(onSortChange).toHaveBeenCalledWith('new');
  });

  it('makes sure the board with no per-climb override falls back to the default board', () => {
    renderList({ climbs: [makeClimb(9, 'kilter')] });
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/kilter/original/12x12-square/screw_bolt/40/view/test-boulder-9-CLIMB9',
    );
  });
});
