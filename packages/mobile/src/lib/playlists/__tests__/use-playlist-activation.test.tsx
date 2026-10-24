// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { ReadyBoardArtSnapshot } from '../../board-render/ready-board-art';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import { computeNavigationStateWithSuggestions } from '@boardsesh/play-view';
import type { UsePlaylistClimbActivationOptions } from '@boardsesh/playlists-react';
import { MAX_PLAYLIST_QUEUE_REPLACE_PAGES } from '@boardsesh/playlists-react/fetch-playlist-suggestion-climbs';
import {
  usePlaylistActivation,
  TRACK_COUNT_GRACE_MS,
  _resetEmptyBoardFetchReportsForTests,
  type UsePlaylistActivationOptions,
} from '../use-playlist-activation';
import { canLoadMoreOfTrack, loadNextTrackPage, _resetTrackPagerForTests } from '../track-pager';
import { invalidatePrivacySnapshots } from '../../privacy/privacy-cache';
import { useInfiniteSearchClimbs } from '../../graphql/hooks/use-infinite-search-climbs';
import { toQueueClimbs, toSchemaClimb } from '../../climb-types';
import type { SearchClimbsQueryResponse } from '../../graphql/operations';

// The shared `usePlaylistClimbActivation` is exercised by @boardsesh/playlists-react's
// own tests. Here we mock it to capture the options the mobile wrapper builds —
// the queue API, board-target resolution, drawer side-effect, and page fetcher —
// which is the wrapper's whole job. (Rendering the real package hook would pull a
// second React copy and trip the dispatcher.)
type ActiveBoard = { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number } | null;

type SuggestionSource = { playlistUuid: string; activatedClimbUuid: string; boardKey: string } | null;

type QueueState = { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null };

const mocks = vi.hoisted(() => ({
  setCurrentClimb: vi.fn(),
  setPlaylistSuggestionSource: vi.fn(),
  refreshPlaylistSuggestionSource: vi.fn(),
  setQueue: vi.fn(),
  showToast: vi.fn(),
  openPlayDrawer: vi.fn(),
  activeBoard: { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 } as ActiveBoard,
  activeClimbUuid: null as string | null,
  suggestionSource: null as SuggestionSource,
  activeClimbSubscription: vi.fn(),
  sourceSubscription: vi.fn(),
  queueState: { queue: [], currentClimbQueueItem: null } as QueueState,
  activate: vi.fn<(climb: Climb) => Promise<void>>(),
  fetchSuggestion: vi.fn(),
  captured: undefined as UsePlaylistClimbActivationOptions | undefined,
  queueItemCounter: 0,
  reportHandledError: vi.fn(),
  appendQueueItems: vi.fn<(items: ClimbQueueItem[], options?: { activateFirstWhenIdle?: boolean }) => number>(),
  choose: vi.fn<(options: { options: ReadonlyArray<{ value: string }> }) => Promise<string>>(),
  showQueueAddedSnackbar: vi.fn(),
  track: vi.fn(),
  searchRequest:
    vi.fn<(query: unknown, variables: { input: ClimbSearchInput }) => Promise<SearchClimbsQueryResponse>>(),
}));

const VIEW_ONLY_BOARD = { boardName: 'tension', layoutId: 9, sizeId: 5, setIds: '1,2', angle: 35 };

// Only the React hook is stubbed. The paged drain is the pure-TS half of the
// package, and stubbing it would make every assertion below about page fetching
// vacuous — so it comes from the real module via its subpath export.
vi.mock('@boardsesh/playlists-react', async () => {
  const drain = await vi.importActual<typeof import('@boardsesh/playlists-react/fetch-playlist-suggestion-climbs')>(
    '@boardsesh/playlists-react/fetch-playlist-suggestion-climbs',
  );
  return {
    usePlaylistClimbActivation: (options: UsePlaylistClimbActivationOptions) => {
      mocks.captured = options;
      return mocks.activate;
    },
    fetchPlaylistSuggestionClimbs: (args: unknown) => mocks.fetchSuggestion(args),
    fetchPlaylistTrackPage: drain.fetchPlaylistTrackPage,
    isAbortError: drain.isAbortError,
    drainPlaylistPages: drain.drainPlaylistPages,
    MAX_PLAYLIST_QUEUE_REPLACE_PAGES: drain.MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
    PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE: drain.PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  };
});
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    setCurrentClimb: mocks.setCurrentClimb,
    setPlaylistSuggestionSource: mocks.setPlaylistSuggestionSource,
    refreshPlaylistSuggestionSource: mocks.refreshPlaylistSuggestionSource,
    setQueue: mocks.setQueue,
    getQueueSnapshot: () => ({
      ...mocks.queueState,
      currentClimbQueueItem:
        mocks.queueState.currentClimbQueueItem ??
        (mocks.activeClimbUuid ? makeQueueItem('active-item', mocks.activeClimbUuid) : null),
      playlistSuggestionSource: mocks.suggestionSource,
    }),
    appendQueueItems: mocks.appendQueueItems,
  }),
  useActiveClimbUuid: () => {
    mocks.activeClimbSubscription();
    return mocks.activeClimbUuid;
  },
  usePlaylistSuggestionSource: () => {
    mocks.sourceSubscription();
    return mocks.suggestionSource;
  },
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: mocks.openPlayDrawer }),
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock('../../../providers/queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: mocks.showQueueAddedSnackbar }),
}));
vi.mock('../../../providers/dialog-provider', () => ({
  useChoose: () => mocks.choose,
}));
vi.mock('../../analytics', () => ({ track: mocks.track }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: mocks.activeBoard }),
}));
vi.mock('../../error-reporting', () => ({ reportHandledError: mocks.reportHandledError }));
// Unique uuid per call (mirrors the real randomUUID wrapper) — the "same item"
// assertions below would be vacuous if every call minted the same uuid.
vi.mock('../../climb-to-queue-item', () => ({
  climbToQueueItem: (climb: { uuid: string }, options?: { suggested?: boolean }) => ({
    uuid: `qi-${climb.uuid}-${++mocks.queueItemCounter}`,
    suggested: options?.suggested,
    climb,
  }),
}));
vi.mock('../../graphql/offline-request', () => ({
  offlineAwareRequest: (query: unknown, variables: { input: ClimbSearchInput }) =>
    mocks.searchRequest(query, variables),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => false }));
vi.mock('../../../hooks/use-current-user-id', () => ({ useStoredUserId: () => ({ userId: null }) }));
vi.mock('../../graphql/hooks/search-grade-source', () => ({
  useGradeSourceSearchInput: (input: ClimbSearchInput) => input,
}));

/** The shape graphql-request 7.4.0 actually throws for a rate-limited operation. */
function makeRateLimitClientError(retryAfterSeconds: number): Error {
  return Object.assign(new Error(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`), {
    response: {
      errors: [
        {
          message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
          extensions: { code: 'RATE_LIMITED', operation: 'smartPlaylist', retryAfterSeconds },
        },
      ],
    },
  });
}

function makeClimb(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'test',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeQueueItem(uuid: string, climbUuid: string, suggested = false): ClimbQueueItem {
  return { uuid, suggested, climb: makeClimb(climbUuid) } as unknown as ClimbQueueItem;
}

function renderActivation(
  fetchPage = vi.fn(),
  options: {
    allClimbs?: Climb[];
    sourceId?: string;
    viewOnlyBoard?: typeof VIEW_ONLY_BOARD | ((climb: Climb) => typeof VIEW_ONLY_BOARD | null) | null;
    previewOnly?: boolean;
    replaceQueueOnActivate?: boolean;
    label?: string;
    fetchTotal?: UsePlaylistActivationOptions['fetchTotal'];
    snapshotFetchPage?: UsePlaylistActivationOptions['snapshotFetchPage'];
    loadedRowsArePages?: boolean;
  } = {},
) {
  return renderHook(() =>
    usePlaylistActivation({
      sourceId: options.sourceId ?? 'playlist:pl-1',
      allClimbs: options.allClimbs ?? [],
      fetchPage,
      fetchTotal: options.fetchTotal,
      snapshotFetchPage: options.snapshotFetchPage,
      loadedRowsArePages: options.loadedRowsArePages,
      label: options.label,
      viewOnlyBoard: options.viewOnlyBoard,
      previewOnly: options.previewOnly,
      refreshErrorMessage: 'refresh failed:',
      replaceQueueOnActivate: options.replaceQueueOnActivate,
    }),
  );
}

function captured(): UsePlaylistClimbActivationOptions {
  if (!mocks.captured) throw new Error('usePlaylistClimbActivation was not called');
  return mocks.captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The canary's once-per-session Set is module state; clear it so a reused
  // sourceId can't make a case pass by reporting nothing.
  _resetEmptyBoardFetchReportsForTests();
  _resetTrackPagerForTests();
  mocks.activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 };
  mocks.activeClimbUuid = null;
  mocks.suggestionSource = null;
  mocks.queueState = { queue: [], currentClimbQueueItem: null };
  mocks.captured = undefined;
  mocks.activate.mockResolvedValue(undefined);
  mocks.queueItemCounter = 0;
  // Mirror real setQueue: it commits the new queue, so a later getQueueSnapshot
  // reflects it (the replacement path re-checks the queue after seeding it).
  mocks.setQueue.mockImplementation((queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => {
    mocks.queueState = { queue, currentClimbQueueItem: currentClimbQueueItem ?? null };
  });
  // Default fork answer is "back out" so a case that forgets to choose can never
  // pass by silently destroying the queue.
  mocks.choose.mockResolvedValue('cancel');
  // Mirror the provider: everything handed over lands, and the count comes back.
  mocks.appendQueueItems.mockImplementation((items: ClimbQueueItem[]) => items.length);
});

/** The values the three-way fork offered, in display order. */
function chooseValues(callIndex = 0): string[] {
  const call = mocks.choose.mock.calls[callIndex];
  if (!call) throw new Error('choose() was not called');
  return call[0].options.map((option) => option.value);
}

describe('usePlaylistActivation (mobile wrapper)', () => {
  it('carries row art into a preview only for the loaded climb projection', async () => {
    const loadedClimb = makeClimb('art-climb', { frames: 'p123r12' });
    const readyBoardArt: ReadyBoardArtSnapshot = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: '3',
      frames: loadedClimb.frames,
      climbUuid: loadedClimb.uuid,
      mirrored: false,
      renderSignature: 'stroke',
      colorScheme: 'dark',
      quality: 'full',
      overlayCacheKey: 'full-key',
      overlayUri: 'file:///overlay.png',
      overlayGeneration: 1,
      overlayLoadKey: 'generation:full-key',
      backgroundPaths: ['board.png'],
      privacyGeneration: 0,
      credentialGeneration: 0,
      sprayGeneration: '',
      sprayVersion: '',
    };
    const { result } = renderActivation(vi.fn(), { allClimbs: [loadedClimb], previewOnly: true });
    await act(() => result.current.activate({ ...loadedClimb }, readyBoardArt));
    expect(mocks.openPlayDrawer.mock.calls[0][1].readyBoardArt).toBe(readyBoardArt);
    expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    await act(() =>
      result.current.activate({ ...loadedClimb, frames: 'stale' }, { ...readyBoardArt, frames: 'stale' }),
    );
    expect(mocks.openPlayDrawer.mock.calls[1][0].frames).toBe(loadedClimb.frames);
    expect(mocks.openPlayDrawer.mock.calls[1][1]).not.toHaveProperty('readyBoardArt');
  });

  it('prepares one compatible track before taps and reuses it across rerenders', async () => {
    const first = makeClimb('a');
    const duplicate = { ...first, name: 'stale duplicate' };
    const climbs = [first, duplicate, makeClimb('b'), makeClimb('wrong-board', { boardType: 'tension', layoutId: 1 })];
    const { result, rerender } = renderActivation(vi.fn(), { allClimbs: climbs });
    const prepared = captured().preparedClimbs;
    expect(prepared?.climbs).toEqual([first, climbs[2]]);
    await result.current.activate({ ...first, name: 'retained stale details' });
    expect(mocks.activate).toHaveBeenLastCalledWith(first);
    rerender();
    expect(captured().preparedClimbs).toBe(prepared);
    expect(captured().resolveTarget(first)?.isClimbable).toBe(prepared?.isClimbable);
  });

  it('builds a queueApi that creates the queue item, dispatches it, and returns it', async () => {
    renderActivation();
    const climb = makeClimb('a');
    const item = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    expect(mocks.setCurrentClimb).toHaveBeenCalledWith(expect.objectContaining({ climb }), {
      playlistSuggestionSource: null,
    });
    // Returning the item (non-null) tells the shared hook the synchronous
    // activation phase succeeded.
    expect(item).toEqual(mocks.setCurrentClimb.mock.calls[0][0]);
  });

  it('resolves the active board into a board target, or null when no board', () => {
    const { rerender } = renderActivation();
    const target = captured().resolveTarget(makeClimb('a'));
    expect(target).toMatchObject({ boardName: 'kilter', angle: 40 });
    expect(target?.boardKey).toContain('kilter');

    mocks.activeBoard = null;
    rerender();
    expect(captured().resolveTarget(makeClimb('a'))).toBeNull();
  });

  // The playlist-detail screens run the resolver in ALL-BOARDS mode on purpose,
  // so `allClimbs` — which seeds the synchronous suggestion source before the
  // board-scoped refresh lands — carries climbs this board cannot draw. Without
  // this predicate a swipe serves one of them and the board goes blank, with no
  // board switch involved at all (issue #5099, second route).
  describe('isClimbable keeps un-drawable climbs out of the swipe order', () => {
    it('keeps a climb set for this exact board', () => {
      renderActivation();
      const target = captured().resolveTarget(makeClimb('a'));
      expect(target?.isClimbable(makeClimb('same-board', { boardType: 'kilter', layoutId: 1 }))).toBe(true);
    });

    it('drops another board type and another layout', () => {
      renderActivation();
      const target = captured().resolveTarget(makeClimb('a'));
      expect(target?.isClimbable(makeClimb('other-board', { boardType: 'tension', layoutId: 1 }))).toBe(false);
      expect(target?.isClimbable(makeClimb('other-layout', { boardType: 'kilter', layoutId: 8 }))).toBe(false);
    });

    it('drops a same-layout climb that does not fit this wall size', () => {
      // Identity matching cannot see this one: Woods numbers each size's holds
      // from its own origin, so the ids all exist on the other size as different
      // holds. `canAddClimbToBoard` rule 5 is what catches it.
      renderActivation();
      const target = captured().resolveTarget(makeClimb('a'));
      expect(
        target?.isClimbable(makeClimb('wrong-size', { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [999] })),
      ).toBe(false);
      expect(
        target?.isClimbable(makeClimb('right-size', { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [2] })),
      ).toBe(true);
    });

    it('keeps a climb with no board metadata at all (fails open)', () => {
      renderActivation();
      const target = captured().resolveTarget(makeClimb('a'));
      expect(target?.isClimbable(makeClimb('unknown'))).toBe(true);
    });
  });

  it('opens the play drawer immediately on activate, before the queue state updates', async () => {
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);
    // The drawer opens FIRST — before the shared activation's setCurrentClimb +
    // suggestion-source work — so BottomSheetModal.present() fires on the same
    // frame as the tap. `committedExternally` tells the drawer the caller already
    // dispatches the climb, so it renders from currentClimbQueueItem (no preview)
    // and doesn't re-dispatch.
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
    // The shared activation still runs (suggestion source + the synchronous queue
    // dispatch).
    expect(mocks.activate).toHaveBeenCalledWith(climb);
  });

  it('dispatches the exact item the activation pinned', async () => {
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    // The first dispatch reuses the item pinned during activate (same climb uuid),
    // so the drawer's nav anchor and the queue entry share one uuid.
    const item = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    expect(mocks.setCurrentClimb.mock.calls[0][0]).toBe(item);
    expect(item?.climb).toEqual(climb);
    // Browse-origin: a list tap is flagged suggested so the reducer's
    // suggested-after-current prune drops leftovers from an earlier list/board.
    expect(item?.suggested).toBe(true);
  });

  it('reuses the pinned item once — a second dispatch builds a fresh item', async () => {
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    const first = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    const second = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    expect(second).not.toBe(first);
    expect(second?.uuid).not.toBe(first?.uuid);
    // The fallback-built second item is browse-origin too.
    expect(second?.suggested).toBe(true);
  });

  it('ignores the pinned item when the dispatched climb differs', async () => {
    const { result } = renderActivation();
    await result.current.activate(makeClimb('a'));

    const climbB = makeClimb('b');
    const item = await captured().queueApi!.setCurrentClimb(climbB, { playlistSuggestionSource: null });
    expect(item?.climb).toEqual(climbB);
  });

  it('activates through the shared queue on every tap (always-live, no preview gate)', async () => {
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    // Every tap drives the shared activation — there is no non-driver preview
    // branch that skips it anymore.
    expect(mocks.activate).toHaveBeenCalledWith(climb);
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
  });

  it('re-tapping the active climb whose suggestions already follow this list just reopens', async () => {
    mocks.activeClimbUuid = 'a';
    // Suggestions already anchored on 'a' from this very list (sourceId 'playlist:pl-1').
    mocks.suggestionSource = { playlistUuid: 'playlist:pl-1', activatedClimbUuid: 'a', boardKey: 'kilter:1:2:3' };
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    // Pure reopen — the shared activation does NOT run (re-activating would
    // duplicate it in the queue / pointlessly rebuild the same source).
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('reads current climb and source at tap time without a render or queue subscriptions', async () => {
    const { result } = renderActivation();
    const originalActivate = result.current.activate;
    const climb = makeClimb('a');
    mocks.activeClimbUuid = climb.uuid;
    mocks.suggestionSource = {
      playlistUuid: 'playlist:pl-1',
      activatedClimbUuid: climb.uuid,
      boardKey: 'kilter:1:2:3',
    };
    await originalActivate(climb);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });

    mocks.suggestionSource = { ...mocks.suggestionSource, playlistUuid: 'different-list' };
    await originalActivate(climb);
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(climb);
    expect(result.current.activate).toBe(originalActivate);
    expect(mocks.activeClimbSubscription).not.toHaveBeenCalled();
    expect(mocks.sourceSubscription).not.toHaveBeenCalled();
  });

  it('checks the live active climb again at commit without rerendering', async () => {
    renderActivation();
    const queueApi = captured().queueApi!;
    const climb = makeClimb('a');
    const source = { playlistUuid: 'pl-1', activatedClimbUuid: 'a', boardKey: 'kilter:1:2:3', climbs: [] };
    mocks.activeClimbUuid = climb.uuid;
    await queueApi.setCurrentClimb(climb, { playlistSuggestionSource: source });
    expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    expect(mocks.setPlaylistSuggestionSource).toHaveBeenCalledExactlyOnceWith(source);

    mocks.activeClimbUuid = 'another-climb';
    await queueApi.setCurrentClimb(climb, { playlistSuggestionSource: source });
    expect(mocks.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ climb }), {
      playlistSuggestionSource: source,
    });
  });

  it('re-tapping the active climb from a DIFFERENT list re-activates to follow it', async () => {
    mocks.activeClimbUuid = 'a';
    // 'a' is active, but its suggestions follow another list ('climblist'), not
    // this one ('playlist:pl-1'). The drawer's next/previous must switch to follow it.
    mocks.suggestionSource = { playlistUuid: 'climblist', activatedClimbUuid: 'a', boardKey: 'kilter:1:2:3' };
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    expect(mocks.activate).toHaveBeenCalledWith(climb);
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
  });

  it('queueApi refreshes the source in place for the active climb (no duplicate append)', async () => {
    mocks.activeClimbUuid = 'a';
    renderActivation();
    const climb = makeClimb('a');
    const source = { playlistUuid: 'pl-1', activatedClimbUuid: 'a', boardKey: 'kilter:1:2:3', climbs: [] };

    const item = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: source });

    // The active climb is not re-dispatched (would append a duplicate); only the
    // suggestion source is updated, and a non-null item is still returned so the
    // shared hook proceeds to its async refresh.
    expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    expect(mocks.setPlaylistSuggestionSource).toHaveBeenCalledWith(source);
    expect(item?.climb).toEqual(climb);
  });

  it('activates a non-active climb even when a different climb is active', async () => {
    mocks.activeClimbUuid = 'b';
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    // 'a' is not the active climb ('b' is), so this still starts a fresh pass.
    expect(mocks.activate).toHaveBeenCalledWith(climb);
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
  });

  it('opens wrong-board playlist climbs view-only without mutating the queue', async () => {
    const climbA = { ...makeClimb('a'), angle: 20 };
    const climbB = makeClimb('b');
    const fetchPage = vi.fn();
    const { result } = renderActivation(fetchPage, { allClimbs: [climbA, climbB], viewOnlyBoard: VIEW_ONLY_BOARD });

    await result.current.activate(climbA);

    const viewOnlyOptions = mocks.openPlayDrawer.mock.calls[0][1];
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climbA, {
      boardConfig: { ...VIEW_ONLY_BOARD, angle: 20 },
      previewQueueItem: expect.objectContaining({ climb: climbA, suggested: true }),
      playlistSuggestionSource: expect.objectContaining({
        playlistUuid: 'playlist:pl-1',
        activatedClimbUuid: 'a',
        boardKey: 'tension:9:5:1,2',
        climbs: [climbA, climbB],
      }),
    });
    expect(viewOnlyOptions.boardConfig).not.toBe(VIEW_ONLY_BOARD);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    expect(mocks.refreshPlaylistSuggestionSource).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('resolves the view-only board from the tapped climb', async () => {
    const climb = { ...makeClimb('tension-a'), angle: 20 };
    const viewOnlyResolver = vi.fn((tapped: Climb) =>
      tapped.uuid === climb.uuid ? { boardName: 'tension', layoutId: 9, sizeId: 8, setIds: '4,5', angle: 0 } : null,
    );
    const { result } = renderActivation(vi.fn(), { allClimbs: [climb], viewOnlyBoard: viewOnlyResolver });

    await result.current.activate(climb);

    expect(viewOnlyResolver).toHaveBeenCalledWith(climb);
    expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, {
      boardConfig: { boardName: 'tension', layoutId: 9, sizeId: 8, setIds: '4,5', angle: 20 },
      previewQueueItem: expect.objectContaining({ climb, suggested: true }),
      playlistSuggestionSource: expect.objectContaining({
        boardKey: 'tension:9:8:4,5',
      }),
    });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  // `previewOnly` is how a shared session turns a climb-list row tap into
  // browsing: same view-only landing as the wrong-board branch, but on the board
  // the climber is standing at, and seeded with the list they tapped from so the
  // drawer's swipes walk it.
  describe('previewOnly (shared session)', () => {
    it('opens the tapped climb view-only on the ACTIVE board, seeded with this list', async () => {
      const climbA = makeClimb('a');
      const climbB = makeClimb('b');
      const fetchPage = vi.fn();
      const { result } = renderActivation(fetchPage, {
        allClimbs: [climbA, climbB],
        sourceId: 'climblist',
        previewOnly: true,
      });

      await result.current.activate(climbA);

      expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climbA, {
        previewQueueItem: expect.objectContaining({ climb: climbA }),
        playlistSuggestionSource: expect.objectContaining({
          playlistUuid: 'climblist',
          activatedClimbUuid: 'a',
          // The ACTIVE board's key — no board override, unlike the wrong-board
          // branch. A source keyed to another board would never match.
          boardKey: 'kilter:1:2:3',
          climbs: [climbA, climbB],
        }),
      });
      // The whole point: a row tap in a crew writes nothing.
      expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(mocks.activate).not.toHaveBeenCalled();
      expect(fetchPage).not.toHaveBeenCalled();
    });

    // A preview opened at row 250 of a 500-row list must not fetch pages 0, 1
    // and 2 back to back just to find out it already has them (#6664 review).
    it.each([
      [false, 0],
      [true, 2],
    ] as const)(
      'pages the preview on from where the rows end only when they are its pages (aligned: %s)',
      async (loadedRowsArePages, firstPage) => {
        const rows = Array.from({ length: 250 }, (_, index) => makeClimb(`row-${index}`));
        const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
          climbs: [makeClimb(`page-${page}`)],
          hasMore: true,
        }));
        const { result } = renderActivation(fetchPage, { allClimbs: rows, previewOnly: true, loadedRowsArePages });

        await result.current.activate(rows[240]);

        const previewTrack = mocks.openPlayDrawer.mock.calls[0][1].playlistSuggestionSource;
        expect(previewTrack.continuation).toMatchObject({ nextPage: firstPage });
        await loadNextTrackPage(previewTrack);
        expect(fetchPage.mock.calls[0][0]).toMatchObject({ page: firstPage });
      },
    );

    // Search reads a frozen basis that every row tap re-captures, crew and
    // preview taps included. A track's later pages must keep the search it was
    // built from, or they walk another search's climbs (#6664 second review).
    it('pages a track with the list as it was when the track was built', async () => {
      const rows = Array.from({ length: 250 }, (_, index) => makeClimb(`row-${index}`));
      let liveSearch = 'search-a';
      const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
        climbs: [makeClimb(`${liveSearch}-${page}`)],
        hasMore: true,
      }));
      const snapshotFetchPage = vi.fn(() => {
        const search = liveSearch;
        return async ({ page }: { page: number }) => ({ climbs: [makeClimb(`${search}-${page}`)], hasMore: true });
      });
      const { result } = renderActivation(fetchPage, { allClimbs: rows, previewOnly: true, snapshotFetchPage });

      await result.current.activate(rows[240]);
      // A later tap on the same screen re-captures a different search.
      liveSearch = 'search-b';

      const previewTrack = mocks.openPlayDrawer.mock.calls[0][1].playlistSuggestionSource;
      const page = await loadNextTrackPage(previewTrack);
      expect(page?.climbs.map(({ uuid }) => uuid)).toEqual(['search-a-0']);
      expect(fetchPage).not.toHaveBeenCalled();
    });

    it('passes no board override, so the drawer stays on the board the climber is at', async () => {
      const climb = makeClimb('a');
      const { result } = renderActivation(vi.fn(), { allClimbs: [climb], previewOnly: true });

      await result.current.activate(climb);

      expect(mocks.openPlayDrawer.mock.calls[0][1]).not.toHaveProperty('boardConfig');
    });

    it('still previews when no active board has resolved yet', async () => {
      // No board means no suggestion source to key — but a dead tap would be its
      // own regression, so the climb still opens.
      mocks.activeBoard = null;
      const climb = makeClimb('a');
      const { result } = renderActivation(vi.fn(), { allClimbs: [climb], previewOnly: true });

      await result.current.activate(climb);

      expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, {
        previewQueueItem: expect.objectContaining({ climb }),
        playlistSuggestionSource: null,
      });
      expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    });

    it('re-tapping the already-active climb previews it too, instead of reopening live', async () => {
      // Solo this is a pure reopen (`committedExternally`). In a crew the tap has
      // to leave the drawer browsing, or the climber's next swipe would drive the
      // crew's wall from a state they thought was view-only.
      mocks.activeClimbUuid = 'a';
      mocks.suggestionSource = { playlistUuid: 'climblist', activatedClimbUuid: 'a', boardKey: 'kilter:1:2:3' };
      const climb = makeClimb('a');
      const { result } = renderActivation(vi.fn(), { allClimbs: [climb], sourceId: 'climblist', previewOnly: true });

      await result.current.activate(climb);

      expect(mocks.openPlayDrawer.mock.calls[0][1]).toEqual(
        expect.objectContaining({ previewQueueItem: expect.objectContaining({ climb }) }),
      );
      expect(mocks.openPlayDrawer.mock.calls[0][1]).not.toHaveProperty('committedExternally');
    });

    it('beats replace-on-activate — a row tap never replaces a crew queue', async () => {
      // Replacing the whole queue is the loudest write in the app. Ordering
      // matters here, not just the flag: with the branches the other way round a
      // playlist tap in a crew would wipe everyone's upcoming climbs.
      const climb = makeClimb('a');
      const { result } = renderActivation(vi.fn(), {
        allClimbs: [climb],
        previewOnly: true,
        replaceQueueOnActivate: true,
      });

      await result.current.activate(climb);

      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(mocks.openPlayDrawer.mock.calls[0][1]).toHaveProperty('previewQueueItem');
    });

    it('yields to a wrong-board tap, which needs its own board override', async () => {
      const climb = { ...makeClimb('a'), angle: 20 };
      const { result } = renderActivation(vi.fn(), {
        allClimbs: [climb],
        previewOnly: true,
        viewOnlyBoard: VIEW_ONLY_BOARD,
      });

      await result.current.activate(climb);

      expect(mocks.openPlayDrawer.mock.calls[0][1]).toHaveProperty('boardConfig', { ...VIEW_ONLY_BOARD, angle: 20 });
    });

    it('leaves the solo tap committing, exactly as before', async () => {
      const climb = makeClimb('a');
      const { result } = renderActivation(vi.fn(), { allClimbs: [climb], previewOnly: false });

      await result.current.activate(climb);

      expect(mocks.activate).toHaveBeenCalledWith(climb);
      expect(mocks.openPlayDrawer).toHaveBeenCalledWith(climb, { committedExternally: true });
    });
  });

  it('fetchClimbsForBoard pages the playlist via the injected fetchPage', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('b')], hasMore: false });
    mocks.fetchSuggestion.mockImplementation(
      async ({
        fetchPage: fp,
      }: {
        fetchPage: (a: { page: number; pageSize: number; signal: AbortSignal }) => unknown;
      }) => {
        await fp({ page: 0, pageSize: 100, signal: new AbortController().signal });
        return { climbs: [makeClimb('b')], nextPage: null };
      },
    );
    renderActivation(fetchPage);
    const target = captured().resolveTarget(makeClimb('a'))!;
    const load = await captured().fetchClimbsForBoard({
      target,
      activatedClimbUuid: 'a',
      signal: new AbortController().signal,
    });
    expect(fetchPage).toHaveBeenCalled();
    expect(load.climbs.map((climb) => climb.uuid)).toEqual(['b']);
    // The list ended inside the first load: nothing to page past.
    expect(load).not.toHaveProperty('continuation');
  });

  // Issue #6664: a track used to stop for good about 250 climbs in.
  it('hands the first load a way to keep paging the same list past where it stopped', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      climbs: [makeClimb(`page-${page}`)],
      hasMore: true,
      totalCount: 40,
    }));
    mocks.fetchSuggestion.mockResolvedValue({ climbs: [makeClimb('a')], nextPage: 3, total: 40 });
    renderActivation(fetchPage);
    const target = captured().resolveTarget(makeClimb('a'))!;
    const load = await captured().fetchClimbsForBoard({
      target,
      activatedClimbUuid: 'a',
      signal: new AbortController().signal,
    });

    expect(load.total).toBe(40);
    expect(load.continuation).toMatchObject({ nextPage: 3 });
    const source = { playlistUuid: 'p', activatedClimbUuid: 'a', boardKey: 'k', ...load };
    const page = await loadNextTrackPage(source);

    // One page, the next one, for the active board, and nothing else.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toMatchObject({
      page: 3,
      board: { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 },
    });
    expect(page).toMatchObject({ page: 3, nextPage: 4, total: 40, filteredOut: false });
    expect(page?.climbs.map(({ uuid }) => uuid)).toEqual(['page-3']);
  });

  it('marks the first track of a list tap as still loading until the refresh lands (#6664)', async () => {
    renderActivation();
    const continuation = captured().pendingContinuation?.(Promise.resolve(true));
    if (!continuation) throw new Error('the first track says nothing about the load still out');
    const seed = { playlistUuid: 'p', activatedClimbUuid: 'a', boardKey: 'k', climbs: [makeClimb('a')], continuation };

    expect(canLoadMoreOfTrack(seed)).toBe(true);
    // The refresh put the fuller track in place: nothing lands on the seed.
    await expect(loadNextTrackPage(seed)).resolves.toBeNull();
  });

  // The count only feeds the header's "4 of 23". A slow one must not hold up
  // the swipe track (#6664 review): it gets a moment past the climbs, no more.
  describe("the list's count, from its own query", () => {
    async function firstLoad(fetchTotal: UsePlaylistActivationOptions['fetchTotal']) {
      mocks.fetchSuggestion.mockResolvedValue({ climbs: [makeClimb('a')], nextPage: null });
      renderActivation(vi.fn(), { fetchTotal });
      const target = captured().resolveTarget(makeClimb('a'))!;
      return captured().fetchClimbsForBoard({ target, activatedClimbUuid: 'a', signal: new AbortController().signal });
    }

    it('names the count when it answers with the climbs', async () => {
      await expect(firstLoad(async () => 23)).resolves.toMatchObject({ total: 23 });
    });

    it('lands the climbs without a count that is still out after the grace', async () => {
      vi.useFakeTimers();
      try {
        const load = firstLoad(() => new Promise<number>(() => {}));
        await vi.advanceTimersByTimeAsync(TRACK_COUNT_GRACE_MS);
        const landed = await load;
        expect(landed.climbs.map(({ uuid }) => uuid)).toEqual(['a']);
        expect(landed).not.toHaveProperty('total');
      } finally {
        vi.useRealTimers();
      }
    });

    it('lands the climbs without a count that failed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        firstLoad(async () => {
          throw new Error('count failed');
        }),
      ).resolves.not.toHaveProperty('total');
    });
  });

  it('swallows rejections from the underlying activation (no unhandled void promise)', async () => {
    mocks.activate.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderActivation();
    await expect(result.current.activate(makeClimb('a'))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('queue replacement (replaceQueueOnActivate)', () => {
    it('seeds loaded adjacent climbs as a swipe track, then refreshes the full playlist order', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a'), tapped, makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      // The tapped climb is committed and its loaded neighbours become the
      // swipe track before the drawer opens, so arrows never wait for refresh.
      const firstSetQueue = mocks.setQueue.mock.calls[0];
      expect(firstSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
      expect(firstSetQueue?.[1].climb.uuid).toBe('b');
      expect(mocks.setPlaylistSuggestionSource.mock.calls[0][0]).toMatchObject({
        playlistUuid: 'playlist:pl-1',
        activatedClimbUuid: 'b',
        climbs: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }],
      });
      expect(mocks.openPlayDrawer).toHaveBeenCalledWith(tapped, { committedExternally: true });
      await waitFor(() => {
        const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
        expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'b', 'c']);
        expect(lastSetQueue?.[1].climb.uuid).toBe('b');
      });
      expect(fetchPage).toHaveBeenCalled();
      // Nothing queued after the current climb, so no destructive decision is needed.
      expect(mocks.choose).not.toHaveBeenCalled();
      // The circuit is the queue now, and the player still plays from the
      // playlist (#6664): the track that replaces any earlier list's is this
      // playlist, in the queue's order, so list-first swipes (#4829) walk the
      // circuit and the header can still name it.
      const finalTrack = mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0];
      expect(finalTrack).toMatchObject({ playlistUuid: 'playlist:pl-1', activatedClimbUuid: 'b' });
      expect(finalTrack.climbs.map((climb: Climb) => climb.uuid)).toEqual(['a', 'b', 'c']);
    });

    it('names the loaded playlist after "Start playlist", with its count', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({
        climbs: [makeClimb('a'), tapped, makeClimb('c')],
        hasMore: false,
        totalCount: 3,
      });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
        label: 'Tuesday circuit',
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      // The first frame already names the list, before its count is known.
      expect(mocks.setPlaylistSuggestionSource.mock.calls[0][0]).toMatchObject({ label: 'Tuesday circuit' });
      expect(mocks.setPlaylistSuggestionSource.mock.calls[0][0]).not.toHaveProperty('total');
      await waitFor(() =>
        expect(mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0]).toMatchObject({
          label: 'Tuesday circuit',
          total: 3,
        }),
      );
    });

    it('queues and walks only what this board can draw from a list that mixes layouts', async () => {
      // A smart list is fetched by board name, so climbs from another layout and
      // from a bigger wall come back with it. Queued between the list's climbs,
      // they sat where the provider's board filter left them off the track, and
      // every swipe past one queued a copy of the next climb (#6664).
      const tapped = makeClimb('a', { boardType: 'kilter', layoutId: 1 });
      const otherLayout = makeClimb('homewall', { boardType: 'kilter', layoutId: 8 });
      const biggerWall = makeClimb('bigger-wall', { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [999] });
      const second = makeClimb('b', { boardType: 'kilter', layoutId: 1 });
      const fetchPage = vi.fn().mockResolvedValue({
        climbs: [tapped, otherLayout, biggerWall, second],
        hasMore: false,
        totalCount: 4,
      });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [tapped, otherLayout, biggerWall, second],
        label: 'Projects',
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() =>
        expect(mocks.setQueue.mock.calls.at(-1)?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual([
          'a',
          'b',
        ]),
      );
      const finalTrack = mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0];
      expect(finalTrack.climbs.map((climb: Climb) => climb.uuid)).toEqual(['a', 'b']);
      // "2 of 4" would be wrong: positions moved when two climbs dropped out.
      expect(finalTrack).toMatchObject({ label: 'Projects' });
      expect(finalTrack).not.toHaveProperty('total');
    });

    it('keeps the climb the climber is on in place, even one this board cannot draw', async () => {
      const tapped = makeClimb('homewall', { boardType: 'kilter', layoutId: 8 });
      const listClimbs = [makeClimb('a', { boardType: 'kilter', layoutId: 1 }), tapped, makeClimb('b')];
      const fetchPage = vi.fn().mockResolvedValue({ climbs: listClimbs, hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: listClimbs });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
        expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'homewall', 'b']);
        expect(lastSetQueue?.[1].climb.uuid).toBe('homewall');
      });
    });

    // Issue #6670: the seeded tap commits the climb, the whole playlist loads in
    // the background, and a climber who swipes meanwhile must not be snapped
    // back to the climb they tapped when it lands.
    describe('when the climber moves while the playlist loads (#6670)', () => {
      const listClimbs = ['a', 'b', 'c', 'd'].map((uuid) => makeClimb(uuid));

      function startLoad() {
        let releaseFetch: (page: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
        const fetchPage = vi.fn(
          () =>
            new Promise<{ climbs: Climb[]; hasMore: boolean }>((resolve) => {
              releaseFetch = resolve;
            }),
        );
        const { result } = renderActivation(fetchPage, {
          replaceQueueOnActivate: true,
          allClimbs: listClimbs.slice(0, 3),
        });
        let activation: Promise<void> = Promise.resolve();
        act(() => {
          activation = result.current.activate(listClimbs[1]);
        });
        const tappedItem = mocks.queueState.currentClimbQueueItem;
        if (!tappedItem) throw new Error('the tap did not seed the queue');
        return {
          tappedItem,
          finishLoad: () =>
            act(async () => {
              releaseFetch({ climbs: listClimbs, hasMore: false });
              await activation;
            }),
        };
      }

      it('loads the playlist around the climb they swiped to, instead of snapping back', async () => {
        const { tappedItem, finishLoad } = startLoad();
        // A committed swipe along the seeded track: the next climb goes in after
        // the tapped one and becomes current.
        const swipedTo = makeQueueItem('swiped-to-c', 'c', true);
        mocks.queueState = { queue: [tappedItem, swipedTo], currentClimbQueueItem: swipedTo };

        await finishLoad();

        expect(mocks.setQueue).toHaveBeenCalledTimes(2);
        const [queue, current] = mocks.setQueue.mock.calls[1];
        expect(queue.map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'b', 'c', 'd']);
        // The same entry they are on, so nothing on screen or on the wall moves.
        expect(current).toBe(swipedTo);
        // The track is the playlist, walking on from where they are.
        expect(mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0]).toMatchObject({
          playlistUuid: 'playlist:pl-1',
          activatedClimbUuid: 'c',
        });
      });

      it('replaces around the tapped climb when they swiped back to it', async () => {
        const { tappedItem, finishLoad } = startLoad();
        // Forward and back again: the climb they visited is queued after the
        // tapped one, so the load asks before clearing it.
        mocks.queueState = {
          queue: [tappedItem, makeQueueItem('visited-c', 'c', true)],
          currentClimbQueueItem: tappedItem,
        };
        mocks.choose.mockResolvedValueOnce('replace');

        await finishLoad();

        expect(mocks.setQueue).toHaveBeenCalledTimes(2);
        expect(mocks.setQueue.mock.calls[1][1]).toBe(tappedItem);
      });

      it('leaves the queue alone when they moved to a climb that is not on this playlist', async () => {
        const { tappedItem, finishLoad } = startLoad();
        const elsewhere = makeQueueItem('elsewhere-slot', 'elsewhere');
        mocks.queueState = { queue: [tappedItem, elsewhere], currentClimbQueueItem: elsewhere };

        await finishLoad();

        // Only the seed: the replace would undo what they picked after the tap.
        expect(mocks.setQueue).toHaveBeenCalledTimes(1);
        expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1);
      });

      it('leaves the queue alone when they are walking another list, even through a shared climb', async () => {
        const { tappedItem, finishLoad } = startLoad();
        const fromSearch = makeQueueItem('search-slot', 'c');
        mocks.queueState = { queue: [tappedItem, fromSearch], currentClimbQueueItem: fromSearch };
        mocks.suggestionSource = { playlistUuid: 'climblist', activatedClimbUuid: 'c', boardKey: 'kilter:1:2:3' };

        await finishLoad();

        expect(mocks.setQueue).toHaveBeenCalledTimes(1);
      });

      // The seed is the rows on screen. Their last row is not the playlist's
      // last climb, so the player must not show the end card there (#6664).
      it('says the seed is still loading, and answers nothing once the playlist replaced it', async () => {
        const { finishLoad } = startLoad();
        const seed = mocks.setPlaylistSuggestionSource.mock.calls[0]?.[0];
        expect(canLoadMoreOfTrack(seed)).toBe(true);
        const answer = loadNextTrackPage(seed);

        await finishLoad();

        await expect(answer).resolves.toBeNull();
      });

      it('ends the seed where it is when the replace is skipped', async () => {
        const { tappedItem, finishLoad } = startLoad();
        const elsewhere = makeQueueItem('elsewhere-slot', 'elsewhere');
        mocks.queueState = { queue: [tappedItem, elsewhere], currentClimbQueueItem: elsewhere };
        const seed = mocks.setPlaylistSuggestionSource.mock.calls[0]?.[0];

        await finishLoad();

        await expect(loadNextTrackPage(seed)).resolves.toMatchObject({ climbs: [], nextPage: null });
      });
    });

    it('ends the seed where it is when the playlist fails to load', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchPage = vi.fn().mockRejectedValue(new Error('network'));
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [makeClimb('a'), makeClimb('b')],
      });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      const seed = mocks.setPlaylistSuggestionSource.mock.calls[0]?.[0];
      await expect(loadNextTrackPage(seed)).resolves.toMatchObject({ climbs: [], nextPage: null });
    });

    it('keeps loaded navigation live while the board refresh is still pending', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn(() => new Promise<{ climbs: Climb[]; hasMore: boolean }>(() => {}));
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
      });

      act(() => {
        void result.current.activate(tapped);
      });

      await waitFor(() => expect(mocks.openPlayDrawer).toHaveBeenCalled());
      expect(mocks.setQueue).toHaveBeenCalledTimes(1);
      expect(mocks.setQueue.mock.calls[0][0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
      expect(mocks.setQueue.mock.calls[0][1].climb.uuid).toBe('b');
      const seededSource = mocks.setPlaylistSuggestionSource.mock.calls[0][0];
      expect(seededSource).toMatchObject({ activatedClimbUuid: 'b' });
      expect(seededSource.climbs.map((climb: Climb) => climb.uuid)).toEqual(['a', 'b', 'c']);
      const navigation = computeNavigationStateWithSuggestions(
        mocks.queueState.queue,
        mocks.queueState.currentClimbQueueItem,
        seededSource,
      );
      expect(navigation.canPrevious).toBe(true);
      expect(navigation.canNext).toBe(true);
    });

    it('forks instead of replacing when the queue has manual future items', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const fetchPage = vi.fn();
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      // Destructive first (the climber tapped play), the non-destructive exit
      // second, cancel last — and the count they're warned about is the real one.
      expect(chooseValues()).toEqual(['replace', 'append', 'cancel']);
      expect(mocks.choose.mock.calls[0][0]).toMatchObject({ cancelValue: 'cancel' });
      expect(mocks.setQueue).not.toHaveBeenCalled();
      // Asked before the fetch, so nobody waits on the network to be told what
      // they're about to lose.
      expect(fetchPage).not.toHaveBeenCalled();
    });

    it('forks for suggested future queue items because replacement still clears them', async () => {
      const current = makeQueueItem('q-current', 'current');
      const suggestedFuture = makeQueueItem('q-suggested', 'suggested', true);
      mocks.queueState = { queue: [current, suggestedFuture], currentClimbQueueItem: current };
      const { result } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(mocks.choose).toHaveBeenCalledTimes(1);
      expect(mocks.setQueue).not.toHaveBeenCalled();
    });

    it('replaces the queue when the climber picks "Start playlist"', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped, makeClimb('c')], hasMore: false });
      mocks.choose.mockResolvedValue('replace');
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.setQueue).toHaveBeenCalled();
      });
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b', 'c']);
      expect(mocks.appendQueueItems).not.toHaveBeenCalled();
    });

    it('appends instead of clearing when the climber picks "Add to queue"', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped, makeClimb('c')], hasMore: false });
      mocks.choose.mockResolvedValue('append');
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1);
      });
      expect(mocks.appendQueueItems.mock.calls[0][0].map((item) => item.climb.uuid)).toEqual(['b', 'c']);
      // Nothing was cleared, and the current climb was never handed over.
      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(mocks.appendQueueItems.mock.calls[0][1]).toBeUndefined();
      // The entryPoint split is the whole point of the property — it answers
      // whether people find the additive path on its own or only once the
      // destructive prompt offers it.
      expect(mocks.track.mock.calls[0][1]).toMatchObject({
        entryPoint: 'replacePrompt',
        sourceKind: 'playlist',
        outcome: 'added',
      });
    });

    it('says so instead of silently dropping the pick when an append is already in flight', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      let releaseRowFetch: (value: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
      const fetchPage = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseRowFetch = resolve;
          }),
      );
      mocks.choose.mockResolvedValue('append');
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      // Row append starts and is still paging...
      act(() => {
        result.current.addToQueue.append?.();
      });
      // ...then a row tap raises the fork and the climber deliberately picks
      // "Add to queue". The re-entrancy guard swallows it, so it has to say so —
      // an explicit pick that does nothing at all is the bug.
      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.alreadyAdding', 'info');
      await act(async () => {
        releaseRowFetch({ climbs: [makeClimb('a')], hasMore: false });
      });
      // And the append that WAS in flight still lands, exactly once.
      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1));
    });

    it('re-asks with the bigger count when the queue grows while the prompt is open', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      const extraFuture = makeQueueItem('q-future-2', 'future-2');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped, makeClimb('c')], hasMore: false });
      // First "Start playlist" lands after another climb was queued behind the
      // prompt; the climber must re-acknowledge the bigger number.
      mocks.choose.mockImplementationOnce(async () => {
        mocks.queueState = { queue: [current, future, extraFuture], currentClimbQueueItem: current };
        return 'replace';
      });
      mocks.choose.mockResolvedValue('replace');
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.choose).toHaveBeenCalledTimes(2);
      });
      expect(mocks.choose.mock.calls[1][0]).toMatchObject({ message: 'detail.queueReplace.message' });
      await waitFor(() => {
        expect(mocks.setQueue).toHaveBeenCalled();
      });
    });

    it('cancelling the fork leaves the queue untouched', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const { result } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(mocks.appendQueueItems).not.toHaveBeenCalled();
    });

    // #3891 canary. A board-scoped fetch that comes back empty for a playlist whose
    // detail list already has climbs used to degrade into a plausible one-item
    // queue: no error, no toast, just a circuit you couldn't swipe through. The
    // loaded swipe track covers the pending window; the completed refresh remains
    // authoritative because the playlist may really have changed on the server.
    it('reports an empty board-scoped fetch for a non-empty playlist', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-1',
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
          tags: { source: 'playlist', op: 'replace-queue-empty' },
          extra: { sourceId: 'playlist:empty-fetch-1', renderableCount: 3, loadedCount: 3 },
        });
      });
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
      expect(lastSetQueue?.[1].climb.uuid).toBe('b');
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('accepts a shorter completed refresh instead of restoring removed climbs', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
      expect(lastSetQueue?.[1].climb.uuid).toBe('b');
      expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('reports an empty board-scoped fetch at most once per playlist per session', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-2',
        allClimbs: [makeClimb('a'), tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });
      await waitFor(() => expect(mocks.reportHandledError).toHaveBeenCalledTimes(1));

      // A climber poking at a broken playlist re-taps rows freely, and
      // reportHandledError has no dedup of its own — one bad playlist must not
      // become hundreds of identical Sentry events.
      await act(async () => {
        await result.current.activate(tapped);
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
      expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    });

    it('does not report an empty board-scoped fetch for a playlist with no loaded climbs', async () => {
      // Nothing loaded means nothing to disagree with — an empty playlist legitimately
      // fetches nothing, and a false positive here would be permanent noise.
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-3',
        allClimbs: [],
      });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => expect(fetchPage).toHaveBeenCalled());
      expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('stays silent when the loaded climbs are all on a board this one cannot render', async () => {
      // The detail list runs the resolver in ALL-BOARDS mode on purpose, so
      // `allClimbs` carries climbs from other board types and layouts. A playlist
      // declared on kilter layout 1 whose climbs were all added from a Tension
      // board legitimately fetches nothing here — reporting it would drown the
      // signal this canary exists to give.
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-4',
        allClimbs: [
          makeClimb('a', { boardType: 'tension', layoutId: 9 }),
          makeClimb('b', { boardType: 'tension', layoutId: 9 }),
        ],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => expect(fetchPage).toHaveBeenCalled());
      expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('still reports when only some of the loaded climbs belong to the active board', async () => {
      // The mixed case is the one that matters: one climbable row plus a pile of
      // off-board ones still means the board-scoped fetch owed us that row.
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-5',
        allClimbs: [makeClimb('a', { boardType: 'tension', layoutId: 9 }), tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
          tags: { source: 'playlist', op: 'replace-queue-empty' },
          extra: { sourceId: 'playlist:empty-fetch-5', renderableCount: 1, loadedCount: 2 },
        });
      });
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
    });

    it('stays silent when a MoonBoard wall lacks the sets its playlist climbs need', async () => {
      // MoonBoard's renderable holds are the whole grid whatever add-on sets are
      // bolted on, so the canary's compatibility check has to look at hold sets
      // too. A base-only 2024 wall opening a wooden-holds playlist legitimately
      // fetches nothing (the backend's `required_set_ids <@ selected sets`
      // containment drops every row) — reporting that would poison the signal.
      mocks.activeBoard = {
        boardType: 'moonboard',
        layoutId: 3,
        sizeId: 21,
        setIds: '5,6,7',
        angle: 40,
      } as ActiveBoard;
      const tapped = makeClimb('b', { boardType: 'moonboard', layoutId: 3, frames: 'p1r42p2r43' });
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-6',
        allClimbs: [makeClimb('a', { boardType: 'moonboard', layoutId: 3, frames: 'p2r42p17r43' }), tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => expect(fetchPage).toHaveBeenCalled());
      expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('still reports for a MoonBoard wall that does have the sets its playlist climbs need', async () => {
      // Same wall with the wooden sets installed: now the backend owed us those
      // rows, so an empty fetch is a real defect and must page us.
      mocks.activeBoard = {
        boardType: 'moonboard',
        layoutId: 3,
        sizeId: 21,
        setIds: '5,6,7,8,9,10',
        angle: 40,
      } as ActiveBoard;
      const tapped = makeClimb('b', { boardType: 'moonboard', layoutId: 3, frames: 'p1r42p2r43' });
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-7',
        allClimbs: [tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
          tags: { source: 'playlist', op: 'replace-queue-empty' },
          extra: { sourceId: 'playlist:empty-fetch-7', renderableCount: 1, loadedCount: 1 },
        });
      });
    });

    it('stays silent when a Woods 12x12 wall opens a playlist of 8x10-only climbs', async () => {
      // Woods' two boards number their holds from their own origins, so an 8x10
      // climb's hold ids all exist on the 12x12 as different holds. The backend's
      // `compatible_size_ids @> ARRAY[sizeId]` correctly returns nothing here, and
      // before the climbs carried `compatibleSizeIds` the canary's hold-id check
      // waved every row through and reported a defect that wasn't one.
      mocks.activeBoard = { boardType: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 } as ActiveBoard;
      const eightByTen = { boardType: 'woods', layoutId: 1, frames: 'p12r4p207r2', compatibleSizeIds: [1] };
      const tapped = makeClimb('b', eightByTen);
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-woods-1',
        allClimbs: [makeClimb('a', eightByTen), tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => expect(fetchPage).toHaveBeenCalled());
      expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('still reports when the Woods wall is the size those climbs fit', async () => {
      // Same climbs on the 8x10 they were set on: the backend owed us those rows,
      // so an empty fetch is a real defect and must page us.
      mocks.activeBoard = { boardType: 'woods', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } as ActiveBoard;
      const tapped = makeClimb('b', { boardType: 'woods', layoutId: 1, frames: 'p12r4p207r2', compatibleSizeIds: [1] });
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:empty-fetch-woods-2',
        allClimbs: [tapped],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
          tags: { source: 'playlist', op: 'replace-queue-empty' },
          extra: { sourceId: 'playlist:empty-fetch-woods-2', renderableCount: 1, loadedCount: 1 },
        });
      });
    });

    it('keeps the queue unchanged and shows a toast when the full playlist fetch fails', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('network'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.loadFailed', 'error');
      });
      errorSpy.mockRestore();
    });

    // A plain Error is a server verdict, not a blip. Retrying it would only make
    // the climber wait longer for the same toast, so the page is issued once.
    it('does not retry a non-transport failure', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('User not found'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.loadFailed', 'error');
      });
      expect(fetchPage).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    // The half of #4622 still firing in Sentry: one dropped fetch used to kill
    // the whole replacement. Pins that the hook injects a retry predicate that
    // actually recognises `TypeError: Network request failed`.
    it('retries a dropped page and still fills the queue', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValue({ climbs: [makeClimb('a'), tapped, makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => {
        expect(fetchPage).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
        expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'b', 'c']);
      });
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    // The runaway bound. Truncation is silent for the climber and loud for us.
    it('stops at the page cap, still replaces the queue, and reports it', async () => {
      let pageCounter = 0;
      const fetchPage = vi.fn(async () => ({ climbs: [makeClimb(`cap-${pageCounter++}`)], hasMore: true }));
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:capped-1',
      });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ tags: { source: 'playlist', op: 'replace-queue-page-cap' } }),
        );
      });
      // Exactly one call per page: the mock never rejects, so no retry inflates this.
      expect(fetchPage).toHaveBeenCalledTimes(MAX_PLAYLIST_QUEUE_REPLACE_PAGES);
      // Truncated, not failed: the climber still gets a circuit and no toast.
      expect(mocks.setQueue).toHaveBeenCalled();
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    // #6673: `Mutation.setQueue` throws on a payload over 500 climbs.
    describe('a playlist longer than the queue holds', () => {
      /** Page `page` of a `size`-climb list, 100 climbs a page, named row-<index>. */
      function pagedList(size: number, { reportsTotal = true }: { reportsTotal?: boolean } = {}) {
        return vi.fn(async ({ page, pageSize }: { page: number; pageSize: number }) => {
          const firstRow = page * pageSize;
          const lastRow = Math.min(firstRow + pageSize, size);
          return {
            climbs: Array.from({ length: Math.max(lastRow - firstRow, 0) }, (_unused, offset) =>
              makeClimb(`row-${firstRow + offset}`),
            ),
            hasMore: lastRow < size,
            ...(reportsTotal ? { totalCount: size } : {}),
          };
        });
      }

      it('starts a 600-climb playlist with 500 queued, the tapped row 550 among them, and says so', async () => {
        const tapped = makeClimb('row-550');
        const fetchPage = pagedList(600);
        const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: [tapped] });

        await act(async () => {
          await result.current.activate(tapped);
        });

        await waitFor(() => expect(mocks.setQueue).toHaveBeenCalledTimes(2));
        const [queue, current] = mocks.setQueue.mock.calls[1];
        const queuedUuids = queue.map((item: ClimbQueueItem) => item.climb.uuid);
        expect(queuedUuids).toHaveLength(500);
        // The tapped climb stays current, with every climb after it, and the
        // window fills from before it: rows 100 to 599, in list order.
        expect(current.climb.uuid).toBe('row-550');
        expect(queue).toContain(current);
        expect(queuedUuids[0]).toBe('row-100');
        expect(queuedUuids.at(-1)).toBe('row-599');
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.trimmed', 'info');
        // The track is still the whole list, so "551 of 600" stays right.
        const finalTrack = mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0];
        expect(finalTrack.climbs).toHaveLength(600);
        expect(finalTrack).toMatchObject({ activatedClimbUuid: 'row-550', total: 600 });
        expect(finalTrack).not.toHaveProperty('continuation');
      });

      it('queues 500 from the tapped climb and keeps the whole drained list as the track', async () => {
        const tapped = makeClimb('row-10');
        const fetchPage = pagedList(2000);
        const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: [tapped] });

        await act(async () => {
          await result.current.activate(tapped);
        });

        await waitFor(() => expect(mocks.setQueue).toHaveBeenCalledTimes(2));
        const [queue, current] = mocks.setQueue.mock.calls[1];
        const queuedUuids = queue.map((item: ClimbQueueItem) => item.climb.uuid);
        expect(queuedUuids).toHaveLength(500);
        expect(queuedUuids[0]).toBe('row-10');
        expect(queuedUuids.at(-1)).toBe('row-509');
        expect(current.climb.uuid).toBe('row-10');
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.trimmed', 'info');

        // Only the queue is windowed: the track holds all 2,000, as before the cap.
        const finalTrack = mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0];
        expect(finalTrack.climbs).toHaveLength(2000);
        expect(finalTrack.total).toBe(2000);
        expect(finalTrack).not.toHaveProperty('continuation');
      });

      // Past the track pager's 10-page bound, a continuation would only fetch
      // nothing and strip the count. The track must run to the list's end.
      it('keeps the track and its count to the list end when tapped deep in a long list', async () => {
        const tapped = makeClimb('row-950');
        const fetchPage = pagedList(2000);
        const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: [tapped] });

        await act(async () => {
          await result.current.activate(tapped);
        });

        await waitFor(() => expect(mocks.setQueue).toHaveBeenCalledTimes(2));
        const [queue, current] = mocks.setQueue.mock.calls[1];
        const queuedUuids = queue.map((item: ClimbQueueItem) => item.climb.uuid);
        expect(queuedUuids).toHaveLength(500);
        expect(queuedUuids[0]).toBe('row-950');
        expect(queuedUuids.at(-1)).toBe('row-1449');
        expect(current.climb.uuid).toBe('row-950');

        const finalTrack = mocks.setPlaylistSuggestionSource.mock.calls.at(-1)?.[0];
        expect(finalTrack).toMatchObject({ activatedClimbUuid: 'row-950', total: 2000 });
        expect(finalTrack.climbs).toHaveLength(2000);
        expect(finalTrack.climbs.at(-1).uuid).toBe('row-1999');
        expect(finalTrack).not.toHaveProperty('continuation');
      });

      it('says what fit without a count when the list never reports one', async () => {
        const tapped = makeClimb('row-0');
        // Longer than the 20-page drain, so the drain cannot count it either.
        const fetchPage = pagedList(2500, { reportsTotal: false });
        const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: [tapped] });

        await act(async () => {
          await result.current.activate(tapped);
        });

        await waitFor(() => expect(mocks.setQueue).toHaveBeenCalledTimes(2));
        expect(mocks.setQueue.mock.calls[1][0]).toHaveLength(500);
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.trimmedUnknownTotal', 'info');
      });

      it('leaves a playlist that fits whole and quiet', async () => {
        const tapped = makeClimb('row-450');
        const fetchPage = pagedList(500);
        const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true, allClimbs: [tapped] });

        await act(async () => {
          await result.current.activate(tapped);
        });

        await waitFor(() => expect(mocks.setQueue).toHaveBeenCalledTimes(2));
        expect(mocks.setQueue.mock.calls[1][0]).toHaveLength(500);
        expect(mocks.showToast).not.toHaveBeenCalled();
      });
    });

    // A server that repeats a page is a paging defect, not the #3891 empty-fetch
    // defect. Firing that canary here would poison the signal it exists to give.
    it('does not fire the #3891 empty-fetch canary when the drain stopped on no-progress', async () => {
      const tapped = makeClimb('b');
      // Empty page that still claims there is more — the shape `52d9a631f` fixed.
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: true });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:no-progress-1',
        allClimbs: [makeClimb('a'), tapped, makeClimb('c')],
      });

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => expect(fetchPage).toHaveBeenCalled());
      expect(mocks.reportHandledError).not.toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { source: 'playlist', op: 'replace-queue-empty' } }),
      );
      // And it does not spin: one page is enough to know the server is stuck.
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    // The reachable half of the guard, and the one that used to be silent: a
    // logbook playlist whose refs all fail to hydrate returns `climbs: []` with
    // `hasMore: true`. The climber still gets a one-item queue either way, so
    // this Sentry report is the only signal anyone gets.
    it('reports a no-progress stop under its own op so triage can tell it from the page cap', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: true });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:no-progress-2',
        allClimbs: [makeClimb('a'), makeClimb('b')],
      });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: { source: 'playlist', op: 'replace-queue-no-progress' },
            extra: { sourceId: 'playlist:no-progress-2', pagesFetched: 1, climbCount: 0 },
          }),
        );
      });
      // Still silent for the climber.
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    // The rate-limit path runs through the REAL parseRateLimitError from
    // @boardsesh/graphql-client (this file does not mock it). Without these two,
    // renaming `retryAfterSeconds` or breaking the ClientError shape match would
    // leave every suite green while every rate limit became a hard failure.
    it('waits out a short rate limit read by the real parser and still fills the queue', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi
        .fn()
        .mockRejectedValueOnce(makeRateLimitClientError(1))
        .mockResolvedValue({ climbs: [makeClimb('a'), tapped], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(mocks.showToast).not.toHaveBeenCalled();
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'b']);
    }, 10_000);

    it('fails fast on a long rate limit and hands the original error to Sentry', async () => {
      const fetchPage = vi.fn().mockRejectedValue(makeRateLimitClientError(46));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.loadFailed', 'error');
      });
      // No spinner held for 46 seconds, and no retry spent on it.
      expect(fetchPage).toHaveBeenCalledTimes(1);
      // The ORIGINAL error is what reaches reportHandledError, so
      // isGraphqlRateLimitedError can still read extensions.code and downgrade
      // the event to warning + rate_limited instead of paging someone.
      const reported = mocks.reportHandledError.mock.calls.at(-1);
      expect(reported?.[0]).toMatchObject({
        response: { errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 46 } }] },
      });
      errorSpy.mockRestore();
    });

    it('reports replacement failure after the climber chooses to replace', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      mocks.choose.mockResolvedValue('replace');
      const fetchPage = vi.fn().mockRejectedValue(new Error('boom'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(mocks.choose).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.queueReplace.loadFailed', 'error');
      });
      errorSpy.mockRestore();
    });
  });
  describe('addToQueue (additive bulk queueing)', () => {
    it('pages the board-scoped list and appends it without touching setQueue', async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce({ climbs: [makeClimb('a'), makeClimb('b')], hasMore: true })
        .mockResolvedValueOnce({ climbs: [makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1));
      expect(mocks.appendQueueItems.mock.calls[0][0].map((item) => item.climb.uuid)).toEqual(['a', 'b', 'c']);
      // Nothing is replaced, so the destructive write never happens — and no
      // confirmation is raised, because nothing is being destroyed.
      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(mocks.choose).not.toHaveBeenCalled();
    });

    it('never asks the provider to move the current climb', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalled());
      // No options bag at all: `activateFirstWhenIdle` defaults off, so an add
      // can never take the crew's wall.
      expect(mocks.appendQueueItems.mock.calls[0][1]).toBeUndefined();
    });

    it('dedupes the batch by climb uuid across pages', async () => {
      // Paging an ordered list that is being edited underneath can hand the same
      // climb back twice.
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce({ climbs: [makeClimb('a'), makeClimb('b')], hasMore: true })
        .mockResolvedValueOnce({ climbs: [makeClimb('b'), makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalled());
      expect(mocks.appendQueueItems.mock.calls[0][0].map((item) => item.climb.uuid)).toEqual(['a', 'b', 'c']);
    });

    it('confirms through the queue-added snackbar exactly once for the whole batch', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a'), makeClimb('b')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      // The bulk append bypasses `commitQueueAdd`, which is what fires this for a
      // single add — so it fires here, once, not once per climb, and it carries
      // the count so the confirmation reads "2 climbs added to queue".
      await waitFor(() => expect(mocks.showQueueAddedSnackbar).toHaveBeenCalledTimes(1));
      expect(mocks.showQueueAddedSnackbar).toHaveBeenCalledWith({ kind: 'added', count: 2 });
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('reports the fetched-vs-appended split to analytics', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a'), makeClimb('b')], hasMore: false });
      // The provider clamped the batch at the wire cap.
      mocks.appendQueueItems.mockReturnValue(1);
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.track).toHaveBeenCalled());
      expect(mocks.track.mock.calls[0][1]).toMatchObject({
        sourceKind: 'playlist',
        entryPoint: 'listHeader',
        outcome: 'addedPartial',
        fetchedCount: 2,
        appendedCount: 1,
        boardName: 'kilter',
        layoutId: 1,
        angle: 40,
      });
      // Climbs still landed, so it is still the snackbar — not an error toast —
      // and the count is what LANDED (1), not what was fetched (2), so a batch
      // clamped at the wire cap confirms the honest number.
      expect(mocks.showQueueAddedSnackbar).toHaveBeenCalledTimes(1);
      expect(mocks.showQueueAddedSnackbar).toHaveBeenCalledWith({ kind: 'added', count: 1 });
    });

    it('shows the queue-full error and adds nothing when the provider takes none of the batch', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a')], hasMore: false });
      mocks.appendQueueItems.mockReturnValue(0);
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.queueFull', 'error');
      });
      // Nothing landed, so there is nothing to open — no snackbar.
      expect(mocks.showQueueAddedSnackbar).not.toHaveBeenCalled();
    });

    it('reports every outcome, including the two that return before an append is attempted', async () => {
      // `queueFull` (pre-fetch) and `nothingToAdd` both end 0/0, so the counts
      // alone cannot tell them apart — `outcome` is what makes them measurable.
      mocks.queueState = {
        queue: Array.from({ length: 500 }, (_unused, index) => makeQueueItem(`q-${index}`, `c-${index}`)),
        currentClimbQueueItem: null,
      };
      const { result: full } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });
      await act(async () => {
        full.current.addToQueue.append?.();
      });
      await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
      expect(mocks.track.mock.calls[0][1]).toMatchObject({ outcome: 'queueFull', fetchedCount: 0, appendedCount: 0 });

      mocks.track.mockClear();
      mocks.queueState = { queue: [], currentClimbQueueItem: null };
      const emptyFetch = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result: empty } = renderActivation(emptyFetch, { replaceQueueOnActivate: true });
      await act(async () => {
        empty.current.addToQueue.append?.();
      });
      await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
      expect(mocks.track.mock.calls[0][1]).toMatchObject({
        outcome: 'nothingToAdd',
        fetchedCount: 0,
        appendedCount: 0,
      });
    });

    it('reports the failed outcome on a non-abort throw', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('network'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.track).toHaveBeenCalled());
      expect(mocks.track.mock.calls[0][1]).toMatchObject({ outcome: 'failed' });
      errorSpy.mockRestore();
    });

    it('shows the queue-full error without fetching when the queue is already at the cap', async () => {
      mocks.queueState = {
        queue: Array.from({ length: 500 }, (_unused, index) => makeQueueItem(`q-${index}`, `c-${index}`)),
        currentClimbQueueItem: null,
      };
      const fetchPage = vi.fn();
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.queueFull', 'error');
      });
      expect(fetchPage).not.toHaveBeenCalled();
      expect(mocks.appendQueueItems).not.toHaveBeenCalled();
    });

    it('stops paging once the queue has room for no more climbs', async () => {
      mocks.queueState = {
        queue: Array.from({ length: 499 }, (_unused, index) => makeQueueItem(`q-${index}`, `c-${index}`)),
        currentClimbQueueItem: null,
      };
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a'), makeClimb('b')], hasMore: true });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalled());
      // One page covered the single remaining slot, so `hasMore` never buys a
      // second round trip, and only what fits is handed over.
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(mocks.appendQueueItems.mock.calls[0][0].map((item) => item.climb.uuid)).toEqual(['a']);
    });

    it('toasts nothingToAdd and fires its own canary on an empty board-scoped fetch', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:append-empty-1',
        allClimbs: [makeClimb('a'), makeClimb('b')],
      });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.nothingToAdd', 'info');
      });
      expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { source: 'playlist', op: 'append-queue-empty' },
        extra: { sourceId: 'playlist:append-empty-1', renderableCount: 2, loadedCount: 2 },
      });
      expect(mocks.appendQueueItems).not.toHaveBeenCalled();
    });

    it('keeps an append no-progress report separate from the empty-board canary', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: true });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:append-no-progress-1',
        allClimbs: [makeClimb('a'), makeClimb('b')],
      });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(mocks.reportHandledError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { source: 'playlist', op: 'append-queue-no-progress' } }),
      );
      expect(mocks.reportHandledError).not.toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { source: 'playlist', op: 'append-queue-empty' } }),
      );
      expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.nothingToAdd', 'info');
    });

    it('reports a page-cap append under its own op while appending the bounded result', async () => {
      let pageCounter = 0;
      const fetchPage = vi.fn(async () => ({ climbs: [makeClimb(`append-cap-${pageCounter++}`)], hasMore: true }));
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => {
        expect(mocks.reportHandledError).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ tags: { source: 'playlist', op: 'append-queue-page-cap' } }),
        );
      });
      expect(fetchPage).toHaveBeenCalledTimes(MAX_PLAYLIST_QUEUE_REPLACE_PAGES);
      expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1);
      expect(mocks.appendQueueItems.mock.calls[0][0]).toHaveLength(MAX_PLAYLIST_QUEUE_REPLACE_PAGES);
    });

    it('an append canary does not suppress the replace canary for the same playlist', async () => {
      // The once-per-session Set is keyed on `<op>|<sourceId>`. Keyed on the
      // sourceId alone this passes vacuously, which is why BOTH reports are
      // asserted.
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'playlist:shared-canary-1',
        allClimbs: [makeClimb('a'), tapped],
      });

      await act(async () => {
        result.current.addToQueue.append?.();
      });
      await waitFor(() => expect(mocks.reportHandledError).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.activate(tapped);
      });

      await waitFor(() => expect(mocks.reportHandledError).toHaveBeenCalledTimes(2));
      const reportedOps = mocks.reportHandledError.mock.calls.map((call) => call[1].tags.op);
      expect(reportedOps).toEqual(['append-queue-empty', 'replace-queue-empty']);
    });

    it('blocks a second append while one is in flight', async () => {
      let releaseFetch: (value: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
      const fetchPage = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseFetch = resolve;
          }),
      );
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      act(() => {
        result.current.addToQueue.append?.();
        result.current.addToQueue.append?.();
      });

      expect(fetchPage).toHaveBeenCalledTimes(1);
      await act(async () => {
        releaseFetch({ climbs: [makeClimb('a')], hasMore: false });
      });
      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1));
    });

    it('surfaces an error toast and reports on a non-abort failure', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('network'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => {
        expect(mocks.showToast).toHaveBeenCalledWith('detail.addToQueue.failed', 'error');
      });
      expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { source: 'playlist', op: 'append-queue' },
      });
      errorSpy.mockRestore();
    });

    it('tags a smart playlist as sourceKind "smart" without shipping its user id', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a')], hasMore: false });
      const { result } = renderActivation(fetchPage, {
        replaceQueueOnActivate: true,
        sourceId: 'smart:LIKED_CLIMBS:u-1',
      });

      await act(async () => {
        result.current.addToQueue.append?.();
      });

      await waitFor(() => expect(mocks.track).toHaveBeenCalled());
      expect(mocks.track.mock.calls[0][1]).toMatchObject({ sourceKind: 'smart' });
      expect(JSON.stringify(mocks.track.mock.calls[0][1])).not.toContain('u-1');
    });

    it('withholds append entirely when there is no active board', async () => {
      // The board-scoped fetch is built from the active board, so with none it
      // returns nothing and the row would say "nothing here for your board yet"
      // to someone who simply hasn't picked one. Absent instead, so the detail
      // view's render gate hides the row.
      mocks.activeBoard = null;
      const { result } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });
      expect(result.current.addToQueue.append).toBeUndefined();
      expect(result.current.addToQueue.isAppending).toBe(false);
    });

    it('a row tap mid-append does not abort the append', async () => {
      let releaseAppendFetch: (value: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
      const fetchPage = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseAppendFetch = resolve;
            }),
        )
        .mockResolvedValue({ climbs: [makeClimb('z')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      act(() => {
        result.current.addToQueue.append?.();
      });
      // Separate AbortController refs, so the tap's replacement can't cancel the
      // append that is already paging.
      await act(async () => {
        await result.current.activate(makeClimb('z'));
      });
      await act(async () => {
        releaseAppendFetch({ climbs: [makeClimb('a')], hasMore: false });
      });

      await waitFor(() => expect(mocks.appendQueueItems).toHaveBeenCalledTimes(1));
      expect(mocks.appendQueueItems.mock.calls[0][0].map((item) => item.climb.uuid)).toEqual(['a']);
    });
  });
});

describe('account change during playlist activation', () => {
  it('keeps large loaded-list taps usable as pages append', async () => {
    const previousRows = Array.from({ length: 5000 }, (_, index) => makeClimb(`loaded-${index}`));
    const options = { allClimbs: previousRows, viewOnlyBoard: VIEW_ONLY_BOARD };
    const { result, rerender } = renderActivation(vi.fn(), options);
    await act(() => result.current.activate(previousRows[4999]));
    const nextRows = Array.from({ length: 5000 }, (_, index) => makeClimb(`appended-${index}`));
    options.allClimbs = [...previousRows, ...nextRows];
    rerender();
    await act(() => result.current.activate(nextRows[4999]));
    await act(() => result.current.activate({ ...previousRows[0] }));
    expect(mocks.openPlayDrawer.mock.calls.map(([climb]) => climb.uuid)).toEqual([
      'loaded-4999',
      'appended-4999',
      'loaded-0',
    ]);
  });

  it('rejects captured activation and shared refresh callbacks before React rerenders', async () => {
    const climb = makeClimb('withdrawn');
    const { result } = renderActivation();
    const oldActivate = result.current.activate;
    const oldQueueApi = captured().queueApi!;
    const source = {
      playlistUuid: 'playlist:pl-1',
      activatedClimbUuid: climb.uuid,
      boardKey: 'kilter:1:2:3',
      climbs: [climb],
    };

    await act(async () => {
      invalidatePrivacySnapshots('credential');
      expect(await oldQueueApi.setCurrentClimb(climb, { playlistSuggestionSource: source })).toBeNull();
      oldQueueApi.refreshPlaylistSuggestionSource(source);
      await oldActivate(climb);
    });

    expect(mocks.setCurrentClimb).not.toHaveBeenCalled();
    expect(mocks.refreshPlaylistSuggestionSource).not.toHaveBeenCalled();
    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
    // The callback built after the change still activates.
    await act(async () => {
      await captured().queueApi!.setCurrentClimb(makeClimb('allowed'), { playlistSuggestionSource: null });
    });
    expect(mocks.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('discards a delayed append page after the account changes', async () => {
    let releaseFetch: (page: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<{ climbs: Climb[]; hasMore: boolean }>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const { result } = renderActivation(fetchPage);
    act(() => result.current.addToQueue.append?.());
    expect(fetchPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      invalidatePrivacySnapshots('credential');
      releaseFetch({ climbs: [makeClimb('withdrawn')], hasMore: false });
    });

    await waitFor(() => expect(result.current.addToQueue.isAppending).toBe(false));
    expect(mocks.appendQueueItems).not.toHaveBeenCalled();
    expect(mocks.showQueueAddedSnackbar).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('discards a delayed replacement page without restoring the seeded content', async () => {
    let releaseFetch: (page: { climbs: Climb[]; hasMore: boolean }) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<{ climbs: Climb[]; hasMore: boolean }>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });
    let activation: Promise<void> = Promise.resolve();
    act(() => {
      activation = result.current.activate(makeClimb('withdrawn'));
    });
    expect(mocks.setQueue).toHaveBeenCalledTimes(1);

    await act(async () => {
      invalidatePrivacySnapshots('credential');
      mocks.setQueue.mockClear();
      mocks.setPlaylistSuggestionSource.mockClear();
      releaseFetch({ climbs: [makeClimb('withdrawn')], hasMore: false });
      await activation;
    });

    expect(mocks.setQueue).not.toHaveBeenCalled();
    expect(mocks.setPlaylistSuggestionSource).not.toHaveBeenCalled();
  });

  it('cancels an already-open replacement prompt when the account changes', async () => {
    const current = makeQueueItem('current-slot', 'current');
    mocks.queueState = { queue: [current, makeQueueItem('future-slot', 'future')], currentClimbQueueItem: current };
    let answerPrompt: (answer: string) => void = () => {};
    mocks.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answerPrompt = resolve;
        }),
    );
    const fetchPage = vi.fn();
    const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });
    let activation: Promise<void> = Promise.resolve();
    act(() => {
      activation = result.current.activate(makeClimb('withdrawn'));
    });
    expect(mocks.choose).toHaveBeenCalledTimes(1);

    await act(async () => {
      invalidatePrivacySnapshots('credential');
      answerPrompt('replace');
      await activation;
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(mocks.setQueue).not.toHaveBeenCalled();
    expect(mocks.appendQueueItems).not.toHaveBeenCalled();
  });
});

describe('climb-list rows from the search hook', () => {
  const input: ClimbSearchInput = {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 2,
    setIds: '3',
    angle: 40,
    pageSize: 100,
  };

  function response(climbs: Climb[]): SearchClimbsQueryResponse {
    return { searchClimbs: { climbs: climbs.map(toSchemaClimb), hasMore: true } };
  }

  function renderLoadedSearch(rows: Climb[], boardName = input.boardName) {
    const searchInput = { ...input, boardName };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const pages = Array.from({ length: 50 }, (_, page) => response(rows.slice(page * 100, (page + 1) * 100)));
    client.setQueryData(['infiniteSearchClimbs', { ...searchInput, crossAngleStats: false }], {
      pages,
      pageParams: pages.map((_page, index) => index),
    });
    const hook = renderHook(
      () => {
        const query = useInfiniteSearchClimbs(searchInput, true, { staleTime: Infinity });
        const visibleClimbs = useMemo(
          () => query.data?.pages.flatMap((page) => page.climbs) ?? [],
          [query.data?.pages],
        );
        const allClimbs = useMemo(() => toQueueClimbs(visibleClimbs), [visibleClimbs]);
        const activation = usePlaylistActivation({
          sourceId: 'climblist',
          allClimbs,
          fetchPage: vi.fn(),
          viewOnlyBoard: VIEW_ONLY_BOARD,
          refreshErrorMessage: 'query lifecycle test',
        });
        return { query, allClimbs, activation, isFetchingNextPage: query.isFetchingNextPage };
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    return { ...hook, client };
  }

  it('opens a loaded row on the first tap after a refetch', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => makeClimb(`query-${index}`));
    mocks.searchRequest.mockImplementation(async (_query, { input: request }) => {
      const page = request.page ?? 0;
      return response(rows.slice(page * 100, (page + 1) * 100).map((climb) => ({ ...climb })));
    });
    const { result, client, unmount } = renderLoadedSearch(rows);
    try {
      const previousRows = result.current.allClimbs;
      await act(async () => {
        await result.current.query.refetch();
      });
      expect(mocks.searchRequest).toHaveBeenCalledTimes(50);
      expect(result.current.allClimbs).toBe(previousRows);
      await act(() => result.current.activation.activate(result.current.allClimbs[0]));
      expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      client.clear();
    }
  });

  it('opens the rows already on screen after an account change, through the new callback only', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => makeClimb(`query-${index}`));
    const { result, client, unmount } = renderLoadedSearch(rows);
    try {
      const shownRow = result.current.allClimbs[0];
      const previousActivation = result.current.activation.activate;
      act(() => invalidatePrivacySnapshots('credential'));
      await act(() => previousActivation(shownRow));
      expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
      // No refetch: the same row objects stay tappable.
      expect(result.current.allClimbs[0]).toBe(shownRow);
      await act(() => result.current.activation.activate(shownRow));
      expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1);
      expect(mocks.openPlayDrawer.mock.calls[0][0].uuid).toBe(shownRow.uuid);
      expect(mocks.searchRequest).not.toHaveBeenCalled();
    } finally {
      unmount();
      client.clear();
    }
  });
});
