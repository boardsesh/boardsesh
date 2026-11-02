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
  setCurrentClimb: vi.fn(),
}));
// What the shared navigation selector answers from the climb on the wall.
const targets = vi.hoisted(() => ({
  prevItem: null as ClimbQueueItem | null,
  nextItem: null as ClimbQueueItem | null,
  atTrackEnd: false,
  canLoadMore: false,
  // What the walk was asked to start from, and along which list.
  from: null as ClimbQueueItem | null,
  along: null as PlaylistSuggestionSource | null,
}));
const settings = vi.hoisted(() => ({ lightOnSwipe: true }));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    nextClimb: queue.nextClimb,
    previousClimb: queue.previousClimb,
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueData: () => ({ queue: [], currentClimbQueueItem: queue.current, historyCount: 0 }),
  usePlaylistSuggestionSource: () => queue.source,
  useIsSharedSession: () => queue.inSharedSession,
}));
vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({ useReachableBoardKeys: () => new Set() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer, boardConfig: null }),
}));
vi.mock('../../../lib/boards/climb-render-board', () => ({ resolveClimbRenderBoard: () => null }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../lib/playlists/track-pager', () => ({ canLoadMoreOfTrack: () => targets.canLoadMore }));
vi.mock('../../../settings/hooks', () => ({
  useSetting: () => [settings.lightOnSwipe, vi.fn()],
  // The at-press read (`readClimbChangeLights`), for a window that lapsed under a paused timer.
  getSetting: () => settings.lightOnSwipe,
}));
vi.mock('../../play-drawer/use-track-paging', () => ({ useTrackPaging: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fresh-uuid' }));
vi.mock('@boardsesh/play-view', () => ({
  computeNavigationTargetsWithSuggestions: (
    _queue: unknown,
    from: ClimbQueueItem | null,
    along: PlaylistSuggestionSource | null,
  ) => {
    targets.from = from;
    targets.along = along;
    return {
      prevItem: targets.prevItem,
      nextItem: targets.nextItem,
      canPrevious: targets.prevItem !== null,
      canNext: targets.nextItem !== null,
      atTrackEnd: targets.atTrackEnd,
    };
  },
  // The preview's own list when it has one, as the player resolves it.
  resolveNavigationSuggestionSource: ({
    previewSource,
    committedSource,
  }: {
    previewSource: PlaylistSuggestionSource | null;
    committedSource: PlaylistSuggestionSource | null;
  }) => previewSource ?? committedSource,
  resolveTrackListClimbUuid: () => null,
  resolveTrackPosition: () => null,
}));

import {
  enterDriveMode,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../../play-drawer/drive-mode-store';
import { useMiniPlayerNavigation } from '../use-mini-player-navigation';
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

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
    queue.setCurrentClimb.mockClear();
    resetLastPickForTests();
    targets.prevItem = makeItem('before');
    targets.nextItem = makeItem('after');
    targets.atTrackEnd = false;
    targets.canLoadMore = false;
    settings.lightOnSwipe = true;
    drawer.openPlayDrawer.mockClear();
    analytics.track.mockClear();
  });

  function navigationEvents() {
    return analytics.track.mock.calls.filter(([eventName]) => eventName === 'Queue Navigation');
  }

  it('moves the queue solo with Light on swipe on, as a swipe in the player would', () => {
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    act(() => result.current.onPrevious());
    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });

  // #7113: a press on "You are driving the wall" stopped driving on this link;
  // ⏮ and ⏭ preview, as a swipe in the player does, until the link drops.
  it('previews after a press stopped driving, solo with Light on swipe on', () => {
    stopDrivingForLink();
    try {
      const { result } = renderHook(() => useMiniPlayerNavigation());
      act(() => result.current.onNext());
      expect(queue.nextClimb).not.toHaveBeenCalled();
      expect(drawer.openPlayDrawer).toHaveBeenCalledOnce();
    } finally {
      resetDriveModeForTests();
    }
  });

  // #7113: driving the wall, ⏮ and ⏭ move the wall in a crew too.
  it.each([
    [
      'in a crew',
      () => {
        queue.inSharedSession = true;
      },
      'party',
    ],
    [
      'with Light on swipe off',
      () => {
        settings.lightOnSwipe = false;
      },
      'solo',
    ],
  ] as const)('moves the wall %s while driving, and says so', (_label, arrange, sessionMode) => {
    arrange();
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 });
    markDriveLive();
    try {
      const { result } = renderHook(() => useMiniPlayerNavigation());
      act(() => result.current.onNext());
      expect(queue.nextClimb).toHaveBeenCalledOnce();
      expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
      expect(navigationEvents()).toEqual([
        ['Queue Navigation', expect.objectContaining({ outcome: 'moved', sessionMode, driving: true })],
      ]);
    } finally {
      resetDriveModeForTests();
    }
  });

  // 2.7: Put on board's keep-lighting window is a live drive with an end. Its
  // end is read off the clock at the press: Android pauses JS timers with the
  // activity (#7038), so the watcher may not have ended it. The timers here
  // never advance.
  it('previews once a keep-lighting window is past its end, before the watcher has tidied it', () => {
    settings.lightOnSwipe = false;
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 });
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: 7,
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      now: 1_000,
    });
    markDriveLive({ now: 1_000 });
    try {
      const { result } = renderHook(() => useMiniPlayerNavigation());
      vi.setSystemTime(46_000);
      act(() => result.current.onNext());
      expect(queue.nextClimb).not.toHaveBeenCalled();
      expect(drawer.openPlayDrawer).toHaveBeenCalledOnce();
      expect(navigationEvents()).toEqual([
        ['Queue Navigation', expect.objectContaining({ outcome: 'preview', driving: false })],
      ]);
    } finally {
      vi.useRealTimers();
      resetDriveModeForTests();
    }
  });

  it('reports each move once, as a MiniPlayer button press', () => {
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    act(() => result.current.onPrevious());
    expect(navigationEvents()).toEqual([
      [
        'Queue Navigation',
        expect.objectContaining({
          direction: 'next',
          method: 'button',
          surface: 'mini_player',
          outcome: 'moved',
          sessionMode: 'solo',
          lightOnSwipe: true,
        }),
      ],
      [
        'Queue Navigation',
        expect.objectContaining({ direction: 'previous', method: 'button', surface: 'mini_player', outcome: 'moved' }),
      ],
    ]);
  });

  it.each([
    [
      'in a crew',
      () => {
        queue.inSharedSession = true;
      },
      'party',
      true,
    ],
    [
      'with Light on swipe off',
      () => {
        settings.lightOnSwipe = false;
      },
      'solo',
      false,
    ],
  ] as const)('reports a preview %s', (_label, arrange, sessionMode, lightOnSwipe) => {
    arrange();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(navigationEvents()).toEqual([
      [
        'Queue Navigation',
        expect.objectContaining({ direction: 'next', outcome: 'preview', sessionMode, lightOnSwipe }),
      ],
    ]);
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
    expect(navigationEvents()).toHaveLength(0);
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
    // Opening the end card changes no climb.
    expect(navigationEvents()).toHaveLength(0);
  });
});

// Owner decision A: while the bar shows the climber's last pick, ⏮ ⏭ step
// from the pick along its own list, by the player's swipe rules for a preview.
describe('useMiniPlayerNavigation from the last pick', () => {
  const pickItem = makeItem('pick');
  const track: PlaylistSuggestionSource = {
    playlistUuid: 'playlist',
    activatedClimbUuid: 'climb-pick',
    boardKey: 'kilter:1',
    climbs: [pickItem.climb, makeItem('after').climb],
  };

  function pickWith(suggestionSource: PlaylistSuggestionSource | null) {
    setLastPick({
      item: pickItem,
      suggestionSource,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: 'current',
      wallAtPick: null,
      pickedAt: 0,
    });
  }

  beforeEach(() => {
    queue.current = makeItem('current');
    queue.source = null;
    queue.inSharedSession = false;
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    queue.setCurrentClimb.mockClear();
    targets.prevItem = makeItem('before');
    targets.nextItem = makeItem('after');
    targets.atTrackEnd = false;
    targets.canLoadMore = false;
    settings.lightOnSwipe = true;
    drawer.openPlayDrawer.mockClear();
    analytics.track.mockClear();
    resetLastPickForTests();
  });

  it('walks from the pick along its own list', () => {
    pickWith(track);
    renderHook(() => useMiniPlayerNavigation());
    expect(targets.from).toBe(pickItem);
    expect(targets.along).toBe(track);
  });

  it('walks from the queue’s current once it changed after the pick', () => {
    pickWith(track);
    queue.current = makeItem('crewmate');
    renderHook(() => useMiniPlayerNavigation());
    expect(targets.from).toBe(queue.current);
  });

  // A list preview's swipes stay looks unless the wall is driven: the player
  // opens on the neighbour as a preview, with the pick's list.
  it('opens the next climb on the pick’s list as a preview, leaving the wall alone', () => {
    pickWith(track);
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(targets.nextItem?.climb, {
      previewQueueItem: targets.nextItem,
      playlistSuggestionSource: track,
    });
  });

  it('puts the next climb on the pick’s list up while driving, with the list as its track', () => {
    pickWith(track);
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 });
    markDriveLive();
    try {
      const { result } = renderHook(() => useMiniPlayerNavigation());
      act(() => result.current.onNext());
      expect(queue.nextClimb).not.toHaveBeenCalled();
      expect(queue.setCurrentClimb).toHaveBeenCalledWith(
        targets.nextItem,
        expect.objectContaining({
          playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'playlist' }),
          trigger: 'next',
          historyCopy: 'fresh',
        }),
      );
    } finally {
      resetDriveModeForTests();
    }
  });

  // A trackless pick (a queue slot, a look walked along the queue): solo with
  // Light on swipe on, its neighbour goes up keeping the walked track.
  it('puts a trackless pick’s neighbour up, solo with Light on swipe on', () => {
    pickWith(null);
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onPrevious());
    expect(queue.previousClimb).not.toHaveBeenCalled();
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(targets.prevItem, {
      keepWalkedTrack: true,
      trigger: 'previous',
      historyCopy: 'fresh',
    });
  });

  it('opens a trackless pick’s neighbour as a preview in a crew', () => {
    pickWith(null);
    queue.inSharedSession = true;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      targets.nextItem?.climb,
      expect.objectContaining({ previewQueueItem: targets.nextItem }),
    );
  });

  it('opens the pick in the player at the end of its loaded list, as the same preview', () => {
    pickWith(track);
    targets.nextItem = null;
    targets.atTrackEnd = true;
    targets.canLoadMore = true;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.canNext).toBe(true);
    act(() => result.current.onNext());
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      pickItem.climb,
      expect.objectContaining({ previewQueueItem: pickItem, playlistSuggestionSource: track }),
    );
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
  });
});
