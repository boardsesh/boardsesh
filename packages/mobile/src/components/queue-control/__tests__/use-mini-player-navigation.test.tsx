// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource, PlaylistTrackResume } from '@boardsesh/queue';
import type { TrackPosition } from '@boardsesh/play-view';

const queue = vi.hoisted(() => ({
  items: [] as ClimbQueueItem[],
  current: null as ClimbQueueItem | null,
  historyCount: 0 as number | null,
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
  // Where each step leaves the list's place in Up next (absent: it stays put).
  nextTrackResume: undefined as PlaylistTrackResume | null | undefined,
  prevTrackResume: undefined as PlaylistTrackResume | null | undefined,
  // What the walk was asked to start from, and along which list.
  from: null as ClimbQueueItem | null,
  along: null as PlaylistSuggestionSource | null,
  // Where the climb it steps from stands on the list.
  position: { kind: 'off' } as TrackPosition,
}));
const settings = vi.hoisted(() => ({ alwaysDrive: false }));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    nextClimb: queue.nextClimb,
    previousClimb: queue.previousClimb,
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueData: () => ({
    queue: queue.items,
    currentClimbQueueItem: queue.current,
    historyCount: queue.historyCount,
  }),
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
  // Always drive the wall, for Queue Navigation only: whether a step lights reads the drive.
  useSetting: () => [settings.alwaysDrive, vi.fn()],
}));
vi.mock('../../play-drawer/use-track-paging', () => ({ useTrackPaging: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fresh-uuid' }));
vi.mock('@boardsesh/play-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/play-view')>();
  return {
    // Real: the list a look carries is what these cases check (#7227).
    resolvePreviewStepSource: actual.resolvePreviewStepSource,
    // Real: which walk a step takes, read off its place and its `trackResume`.
    resolveStepTrack: actual.resolveStepTrack,
    stepCrossesIntoList: actual.stepCrossesIntoList,
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
        nextTrackResume: targets.nextTrackResume,
        prevTrackResume: targets.prevTrackResume,
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
    resolveTrackPosition: () => targets.position,
  };
});

import {
  enterDriveMode,
  markDriveLive,
  resetDriveModeForTests,
  startAlwaysDrive,
  stopDrivingForLink,
} from '../../play-drawer/drive-mode-store';
import { useMiniPlayerNavigation } from '../use-mini-player-navigation';
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

/** Always drive the wall's drive, as `DriveModeWatcher` starts it once this phone's link is up. */
function driveAlways() {
  settings.alwaysDrive = true;
  startAlwaysDrive({ sessionId: null, boardId: 7, boardType: 'kilter' });
}

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
    queue.items = [];
    queue.historyCount = 0;
    targets.position = { kind: 'off' };
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
    targets.nextTrackResume = undefined;
    targets.prevTrackResume = undefined;
    settings.alwaysDrive = false;
    resetDriveModeForTests();
    drawer.openPlayDrawer.mockClear();
    analytics.track.mockClear();
  });

  function navigationEvents() {
    return analytics.track.mock.calls.filter(([eventName]) => eventName === 'Queue Navigation');
  }

  it("moves the queue in Always drive the wall's drive, as a swipe in the player would", () => {
    driveAlways();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    act(() => result.current.onPrevious());
    expect(queue.nextClimb).toHaveBeenCalledTimes(1);
    expect(queue.previousClimb).toHaveBeenCalledTimes(1);
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });

  // Always drive the wall on with no drive (no link yet): ⏮ and ⏭ preview.
  it('previews with Always drive the wall on and nothing driving', () => {
    settings.alwaysDrive = true;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(drawer.openPlayDrawer).toHaveBeenCalledOnce();
  });

  // #7113: a press on "You are driving the wall" stopped driving on this link;
  // ⏮ and ⏭ preview, as a swipe in the player does, until the link drops or
  // the next Put on board.
  it("previews after a press stopped Always drive the wall's drive", () => {
    driveAlways();
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
    ['solo', () => {}, 'solo'],
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
    driveAlways();
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
          alwaysDrive: true,
          driving: true,
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
      'in a crew, Always drive the wall on with no link',
      () => {
        queue.inSharedSession = true;
        settings.alwaysDrive = true;
      },
      'party',
      true,
    ],
    ['solo, outside a drive', () => {}, 'solo', false],
  ] as const)('reports a preview %s', (_label, arrange, sessionMode, alwaysDrive) => {
    arrange();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(navigationEvents()).toEqual([
      [
        'Queue Navigation',
        expect.objectContaining({ direction: 'next', outcome: 'preview', sessionMode, alwaysDrive, driving: false }),
      ],
    ]);
  });

  it.each([
    ['in a crew', () => (queue.inSharedSession = true)],
    ['solo, outside a drive', () => {}],
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

  // #7227: the look carries the list the climb on the wall is on, with the
  // step's place in Up next, so the player's swipes go on down the list after
  // Up next instead of stopping at the end of the queue.
  it.each([
    ['in a crew', () => (queue.inSharedSession = true)],
    ['solo, outside a drive', () => {}],
  ])('hands the preview the list and its place in Up next %s', (_label, arrange) => {
    arrange();
    const list: PlaylistSuggestionSource = {
      playlistUuid: 'playlist',
      activatedClimbUuid: 'climb-current',
      boardKey: 'kilter:1',
      climbs: [makeItem('current').climb, makeItem('list-next').climb],
    };
    queue.source = list;
    targets.nextTrackResume = { climbUuid: 'climb-current', queueItemUuid: 'current' };
    targets.prevTrackResume = null;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    act(() => result.current.onPrevious());
    expect(queue.nextClimb).not.toHaveBeenCalled();
    expect(queue.previousClimb).not.toHaveBeenCalled();
    const [[, nextOpen], [, previousOpen]] = drawer.openPlayDrawer.mock.calls;
    // A step off the climb on the wall starts a look, and its list says so
    // (#7227 re-review), whichever way it goes.
    expect(nextOpen).toEqual({
      previewQueueItem: targets.nextItem,
      playlistSuggestionSource: {
        ...list,
        resume: { climbUuid: 'climb-current', queueItemUuid: 'current' },
        lookOffWall: true,
      },
    });
    // A step that stays on the list leaves its place as it is.
    expect(previousOpen).toEqual({
      previewQueueItem: targets.prevItem,
      playlistSuggestionSource: { ...list, lookOffWall: true },
    });
    expect(list).not.toHaveProperty('lookOffWall');
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
    queue.items = [];
    queue.historyCount = 0;
    targets.position = { kind: 'off' };
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
    targets.nextTrackResume = undefined;
    targets.prevTrackResume = undefined;
    settings.alwaysDrive = false;
    resetDriveModeForTests();
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

  it('keeps the pick’s place in Up next for a step into it', () => {
    pickWith(track);
    targets.nextTrackResume = { climbUuid: 'climb-pick', queueItemUuid: 'pick' };
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(targets.nextItem?.climb, {
      previewQueueItem: targets.nextItem,
      playlistSuggestionSource: { ...track, resume: { climbUuid: 'climb-pick', queueItemUuid: 'pick' } },
    });
  });

  // #7227 re-review: a pick a look left in Up next steps back onto the list.
  // The detour names the pick as the Up next climb stepped off, where the
  // player's Previous retraces from.
  it('records the pick as the Up next climb a step back onto the list stepped off', () => {
    const resume = { climbUuid: 'climb-list', queueItemUuid: 'list-entry' };
    pickWith({ ...track, resume });
    targets.nextTrackResume = null;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(targets.nextItem?.climb, {
      previewQueueItem: targets.nextItem,
      playlistSuggestionSource: { ...track, detour: { ...resume, lastUpNextQueueItemUuid: pickItem.uuid } },
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

  // #7227 review: a pick a look left on the list's climb, with Up next after
  // it. The step that lights goes into Up next, so it has to store where the
  // list picks up again, or the list goes dormant at the queued climb.
  it.each([
    ['onNext', 'nextTrackResume', 'nextItem', 'next'],
    ['onPrevious', 'prevTrackResume', 'prevItem', 'previous'],
  ] as const)('%s while driving keeps the pick’s place in Up next', (button, resumeKey, target, trigger) => {
    pickWith(track);
    const resume = { climbUuid: 'climb-pick', queueItemUuid: 'pick' };
    targets[resumeKey] = resume;
    driveAlways();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current[button]());
    expect(queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      targets[target],
      expect.objectContaining({
        playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'playlist', resume }),
        keepQueue: true,
        trigger,
      }),
    );
  });

  // A trackless pick (a queue slot, a look walked along the queue): while
  // driving, its neighbour goes up keeping the walked track.
  it('puts a trackless pick’s neighbour up in Always drive the wall’s drive', () => {
    pickWith(null);
    driveAlways();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onPrevious());
    expect(queue.previousClimb).not.toHaveBeenCalled();
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(targets.prevItem, {
      keepWalkedTrack: true,
      trigger: 'previous',
      historyCopy: 'fresh',
    });
  });

  it('opens a trackless pick’s neighbour as a preview outside a drive, in a crew too', () => {
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

  // A pick opened on its own board (a logbook row) steps on that board.
  it('keeps the board a pick was opened on for a step that stays a look', () => {
    const atThirty = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 30 };
    setLastPick({
      item: pickItem,
      suggestionSource: track,
      commitOptions: undefined,
      mirrored: false,
      boardConfig: atThirty,
      currentAtPick: 'current',
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(drawer.openPlayDrawer).toHaveBeenCalledWith(
      targets.nextItem?.climb,
      expect.objectContaining({ previewQueueItem: targets.nextItem, boardConfig: atThirty }),
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

// Owner answer 2 on the then-signposts: ⏮ and ⏭ tell a screen reader which
// list they walk, and each step says which walk it took for Queue Navigation.
describe('useMiniPlayerNavigation names the walk each button takes', () => {
  const search: PlaylistSuggestionSource = {
    playlistUuid: 'search',
    activatedClimbUuid: 'climb-current',
    boardKey: 'kilter:1',
    climbs: [makeItem('current').climb, makeItem('after').climb],
    label: 'Search results',
  };
  const leftFrom: PlaylistTrackResume = { climbUuid: 'climb-current', queueItemUuid: 'current' };

  beforeEach(() => {
    resetLastPickForTests();
    resetDriveModeForTests();
    analytics.track.mockClear();
    queue.items = [];
    queue.current = makeItem('current');
    queue.source = search;
    targets.prevItem = makeItem('before');
    targets.nextItem = makeItem('after');
    targets.atTrackEnd = false;
    targets.canLoadMore = false;
    targets.nextTrackResume = null;
    targets.prevTrackResume = null;
    targets.position = { kind: 'list', trackIndex: 0 };
  });

  it('names the list a step stays on', () => {
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.nextWalk).toEqual({ kind: 'list', name: 'Search results' });
    expect(result.current.previousWalk).toEqual({ kind: 'list', name: 'Search results' });
  });

  it('says Up next for a step into it, never the list it leaves', () => {
    targets.nextTrackResume = leftFrom;
    const { result } = renderHook(() => useMiniPlayerNavigation());
    expect(result.current.nextWalk).toEqual({ kind: 'upNext' });
  });

  it('keeps the plain label with no list, a list nobody named, or nowhere to go', () => {
    targets.position = { kind: 'off' };
    expect(renderHook(() => useMiniPlayerNavigation()).result.current.nextWalk).toBeNull();
    targets.position = { kind: 'list', trackIndex: 0 };
    queue.source = { ...search, label: undefined };
    expect(renderHook(() => useMiniPlayerNavigation()).result.current.nextWalk).toBeNull();
    queue.source = search;
    targets.nextItem = null;
    targets.atTrackEnd = true;
    expect(renderHook(() => useMiniPlayerNavigation()).result.current.nextWalk).toBeNull();
  });

  it('reports the walk with the step: the track, from your own climb, Up next bucketed, the crossing', () => {
    // The climb on the wall plays the last of Up next; Next crosses onto the list.
    targets.position = { kind: 'upNext', resume: leftFrom, resumeIndex: 0 };
    queue.items = [makeItem('history'), makeItem('current'), makeItem('q1'), makeItem('q2')];
    driveAlways();
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Navigation',
      expect.objectContaining({ track: 'list', from: 'current', upNextBucket: '1-3', crossed: true }),
    );
  });

  // F3 now-slot mode: with nothing current, History stays in the array and is
  // not Up next. The bucket counts from the line, as the queue sheet does.
  it('never buckets History as Up next with nothing current', () => {
    queue.current = null;
    // 4 History climbs, so counting them (5) would land in '4-10', not '1-3'.
    queue.historyCount = 4;
    queue.items = [makeItem('h1'), makeItem('h2'), makeItem('h3'), makeItem('h4'), makeItem('u1')];
    targets.nextItem = makeItem('u1');
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(analytics.track).toHaveBeenCalledWith('Queue Navigation', expect.objectContaining({ upNextBucket: '1-3' }));
  });

  it('reports a step from the last pick as from a preview', () => {
    setLastPick({
      item: makeItem('pick'),
      suggestionSource: search,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: 'current',
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result } = renderHook(() => useMiniPlayerNavigation());
    act(() => result.current.onNext());
    expect(analytics.track).toHaveBeenCalledWith(
      'Queue Navigation',
      expect.objectContaining({ track: 'list', from: 'preview', upNextBucket: '0', crossed: false }),
    );
  });
});
