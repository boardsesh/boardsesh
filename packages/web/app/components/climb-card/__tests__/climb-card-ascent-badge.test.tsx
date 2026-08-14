import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { BoardName, BoardDetails, Climb } from '@/app/lib/types';
import ClimbCard from '../climb-card';

/**
 * The cover's ascent badge takes the viewer's ticks as props now — it reads no
 * BoardContext of its own, because it is a front-door survivor and the provider
 * is not. The card is what reads the provider on its behalf, in *both* of its
 * variants. Delete either prop from either one and the grid on
 * `/[board]/…/list` and `/…/liked` loses every badge for signed-in climbers
 * with nothing else going red, which is what these two cases exist to catch.
 */
let capturedCoverProps: { logbook?: readonly LogbookEntry[]; boardName?: BoardName } | null = null;
let mockBoardProvider: { logbook: LogbookEntry[]; boardName: BoardName } | null = null;

vi.mock('../climb-card-cover', () => ({
  default: (props: { logbook?: readonly LogbookEntry[]; boardName?: BoardName }) => {
    capturedCoverProps = props;
    return <div data-testid="climb-card-cover" />;
  },
}));

vi.mock('../climb-title', () => ({
  default: () => <span data-testid="climb-title" />,
}));

vi.mock('../heart-animation-overlay', () => ({
  default: () => null,
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: () => mockBoardProvider,
}));

vi.mock('../../board-page/selected-climb-store', () => ({
  useIsClimbSelected: () => false,
}));

vi.mock('../../climb-actions', () => ({
  ClimbActions: () => <div data-testid="climb-actions" />,
}));

vi.mock('../../climb-actions/use-double-tap-favorite', () => ({
  useDoubleTapFavorite: () => ({
    handleDoubleTap: vi.fn(),
    showHeart: false,
    dismissHeart: vi.fn(),
    isFavorited: false,
    toggleFavorite: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12/default/40/list',
}));

vi.mock('@/app/hooks/use-color-mode', () => ({
  useColorMode: () => ({ mode: 'light' }),
}));

vi.mock('@/app/lib/climb-action-utils', () => ({
  getExcludedClimbActions: () => [],
}));

function makeClimb(): Climb {
  return {
    uuid: 'climb-1',
    name: 'Test Boulder',
    setter_username: 'setter_joe',
    description: '',
    frames: 'p1r14',
    angle: 40,
    ascensionist_count: 10,
    difficulty: 'V4',
    quality_average: '3.5',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  } as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
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

describe('ClimbCard ascent-badge wiring', () => {
  beforeEach(() => {
    capturedCoverProps = null;
    mockBoardProvider = null;
  });

  it('hands the cover the viewer ticks and board when it builds its own actions', () => {
    const logbook = [{ climb_uuid: 'climb-1', angle: 40, is_ascent: true }] as unknown as LogbookEntry[];
    mockBoardProvider = { logbook, boardName: 'tension' };

    render(<ClimbCard climb={makeClimb()} boardDetails={makeBoardDetails()} />);

    expect(capturedCoverProps?.logbook).toBe(logbook);
    expect(capturedCoverProps?.boardName).toBe('tension');
  });

  it('hands the cover the same values when actions come from the caller', () => {
    const logbook = [{ climb_uuid: 'climb-1', angle: 40, is_ascent: true }] as unknown as LogbookEntry[];
    mockBoardProvider = { logbook, boardName: 'kilter' };

    render(<ClimbCard climb={makeClimb()} boardDetails={makeBoardDetails()} actions={[]} />);

    expect(capturedCoverProps?.logbook).toBe(logbook);
    expect(capturedCoverProps?.boardName).toBe('kilter');
  });

  it('leaves the cover tickless when nobody is signed in', () => {
    render(<ClimbCard climb={makeClimb()} boardDetails={makeBoardDetails()} />);

    expect(capturedCoverProps?.logbook).toBeUndefined();
    expect(capturedCoverProps?.boardName).toBeUndefined();
  });
});
