import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { usePlaylistClimbActivation } from '../use-playlist-climb-activation';
import { PLAY_DRAWER_EVENT } from '../play-drawer-event';
import type { ClimbQueueItem, PlaylistSuggestionSource, QueueActionsType } from '../types';
import type { QueueBridgeBoardInfo } from '../queue-bridge-board-info-context';

const boardDetails: BoardDetails = {
  images_to_holds: {},
  holdsData: [],
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  led_protocol: 'kilter',
} as unknown as BoardDetails;

function makeClimb(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    setter_username: 's',
    name: uuid,
    description: '',
    frames: '',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '7',
    quality_average: '3',
    stars: 3,
    difficulty_error: '',
    mirrored: false,
    benchmark_difficulty: null,
    boardType: 'kilter',
    layoutId: 1,
    ...overrides,
  } as Climb;
}

function makeQueueActions(
  setCurrentClimbImpl: (
    climb: Climb,
    opts: { playlistSuggestionSource: PlaylistSuggestionSource | null },
  ) => Promise<ClimbQueueItem | null>,
): Pick<QueueActionsType, 'setCurrentClimb' | 'refreshPlaylistSuggestionSource'> {
  return {
    setCurrentClimb: vi.fn(setCurrentClimbImpl),
    refreshPlaylistSuggestionSource: vi.fn(),
  };
}

function makeBoardInfo(): QueueBridgeBoardInfo {
  return { boardDetails, angle: 40, hasResolvedAngle: true, hasActiveQueue: true, isHydrated: true };
}

describe('usePlaylistClimbActivation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches the play-drawer-open event after a successful activation', async () => {
    const climb = makeClimb('activated');
    const drawerOpenListener = vi.fn();
    window.addEventListener(PLAY_DRAWER_EVENT, drawerOpenListener);

    const queueActions = makeQueueActions(async () => ({ uuid: 'q-1', climb }) as ClimbQueueItem);

    const { result } = renderHook(() =>
      usePlaylistClimbActivation({
        queueActions,
        activeQueueBoardInfo: makeBoardInfo(),
        selectedBoardDetails: boardDetails,
        selectedBoard: { boardType: 'kilter', layoutId: 1, angle: 40 },
        sourceId: 'playlist-1',
        allClimbs: [climb],
        fetchClimbsForBoard: async () => [climb],
        refreshErrorMessage: 'refresh failed',
      }),
    );

    await act(async () => {
      await result.current(climb);
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(drawerOpenListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(PLAY_DRAWER_EVENT, drawerOpenListener);
  });

  it('does not dispatch the play-drawer-open event when activation is rejected', async () => {
    const climb = makeClimb('activated');
    const drawerOpenListener = vi.fn();
    window.addEventListener(PLAY_DRAWER_EVENT, drawerOpenListener);

    // setCurrentClimb returns null (e.g. board-compat validation failed)
    const queueActions = makeQueueActions(async () => null);

    const { result } = renderHook(() =>
      usePlaylistClimbActivation({
        queueActions,
        activeQueueBoardInfo: makeBoardInfo(),
        selectedBoardDetails: boardDetails,
        selectedBoard: { boardType: 'kilter', layoutId: 1, angle: 40 },
        sourceId: 'playlist-1',
        allClimbs: [climb],
        fetchClimbsForBoard: async () => [climb],
        refreshErrorMessage: 'refresh failed',
      }),
    );

    await act(async () => {
      await result.current(climb);
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(drawerOpenListener).not.toHaveBeenCalled();
    window.removeEventListener(PLAY_DRAWER_EVENT, drawerOpenListener);
  });
});
