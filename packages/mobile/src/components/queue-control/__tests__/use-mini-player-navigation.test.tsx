// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

const queue = vi.hoisted(() => ({
  current: null as ClimbQueueItem | null,
  source: null as PlaylistSuggestionSource | null,
  inSharedSession: false,
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
}));
// What the shared navigation selector answers from the climb on the wall.
const targets = vi.hoisted(() => ({
  prevItem: null as ClimbQueueItem | null,
  nextItem: null as ClimbQueueItem | null,
  atTrackEnd: false,
  canLoadMore: false,
}));
const settings = vi.hoisted(() => ({ lightOnSwipe: true }));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ nextClimb: queue.nextClimb, previousClimb: queue.previousClimb }),
  useQueueData: () => ({ queue: [], currentClimbQueueItem: queue.current, historyCount: 0 }),
  usePlaylistSuggestionSource: () => queue.source,
  useIsSharedSession: () => queue.inSharedSession,
}));
vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({ useReachableBoardKeys: () => new Set() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/playlists/track-pager', () => ({ canLoadMoreOfTrack: () => targets.canLoadMore }));
vi.mock('../../../settings/hooks', () => ({ useSetting: () => [settings.lightOnSwipe, vi.fn()] }));
vi.mock('../../play-drawer/use-track-paging', () => ({ useTrackPaging: vi.fn() }));
vi.mock('@boardsesh/play-view', () => ({
  computeNavigationTargetsWithSuggestions: () => ({
    prevItem: targets.prevItem,
    nextItem: targets.nextItem,
    canPrevious: targets.prevItem !== null,
    canNext: targets.nextItem !== null,
    atTrackEnd: targets.atTrackEnd,
  }),
  resolveTrackListClimbUuid: () => null,
  resolveTrackPosition: () => null,
}));

import { useMiniPlayerNavigation } from '../use-mini-player-navigation';

function makeItem(uuid: string): ClimbQueueItem {
  const climb: Climb = {
    uuid: `climb-${uuid}`,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  };
  return { uuid, climb };
}

describe('useMiniPlayerNavigation', () => {
  beforeEach(() => {
    queue.current = makeItem('current');
    queue.source = null;
    queue.inSharedSession = false;
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    targets.prevItem = makeItem('before');
    targets.nextItem = makeItem('after');
    targets.atTrackEnd = false;
    targets.canLoadMore = false;
    settings.lightOnSwipe = true;
    drawer.openPlayDrawer.mockClear();
  });

  it('moves the queue solo with Light on swipe on, as a swipe in the player would', () => {
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    act(() => result.current.onPrevious());
    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });

  it.each([
    ['in a crew', () => (queue.inSharedSession = true)],
    ['with Light on swipe off', () => (settings.lightOnSwipe = false)],
  ])('opens the player on the next climb as a preview %s, leaving the wall alone', (_label, arrange) => {
    arrange();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      targets.nextItem?.climb,
      expect.objectContaining({ previewQueueItem: targets.nextItem }),
    );
  });

  it('reads disabled with nowhere to go, and a tap does nothing', () => {
    targets.prevItem = null;
    targets.nextItem = null;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.canPrevious).toBe(false);
    expect(result.current.canNext).toBe(false);
    act(() => result.current.onPrevious());
    expect(queue.previousClimb).not.toHaveBeenCalled();
  });

  it("waits while the list's next page is still loading", () => {
    targets.nextItem = null;
    targets.atTrackEnd = true;
    targets.canLoadMore = true;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.canNext).toBe(false);
  });

  it("opens the player at the end of a list, where Next shows the list's end card", () => {
    targets.nextItem = null;
    targets.atTrackEnd = true;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.canNext).toBe(true);
    act(() => result.current.onNext());
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(queue.current?.climb, { reopensCurrent: true });
  });
});
