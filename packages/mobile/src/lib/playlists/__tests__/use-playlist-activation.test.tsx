// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { UsePlaylistClimbActivationOptions } from '@boardsesh/playlists-react';
import { usePlaylistActivation, _resetEmptyBoardFetchReportsForTests } from '../use-playlist-activation';

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
  queueState: { queue: [], currentClimbQueueItem: null } as QueueState,
  activate: vi.fn<(climb: Climb) => Promise<void>>(),
  fetchSuggestion: vi.fn(),
  captured: undefined as UsePlaylistClimbActivationOptions | undefined,
  queueItemCounter: 0,
  reportHandledError: vi.fn(),
}));

const VIEW_ONLY_BOARD = { boardName: 'tension', layoutId: 9, sizeId: 5, setIds: '1,2', angle: 35 };

vi.mock('@boardsesh/playlists-react', () => ({
  usePlaylistClimbActivation: (options: UsePlaylistClimbActivationOptions) => {
    mocks.captured = options;
    return mocks.activate;
  },
  fetchPlaylistSuggestionClimbs: (args: unknown) => mocks.fetchSuggestion(args),
  isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE: 100,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    setCurrentClimb: mocks.setCurrentClimb,
    setPlaylistSuggestionSource: mocks.setPlaylistSuggestionSource,
    refreshPlaylistSuggestionSource: mocks.refreshPlaylistSuggestionSource,
    setQueue: mocks.setQueue,
    getQueueSnapshot: () => mocks.queueState,
  }),
  useActiveClimbUuid: () => mocks.activeClimbUuid,
  usePlaylistSuggestionSource: () => mocks.suggestionSource,
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: mocks.openPlayDrawer }),
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
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
    replaceQueueOnActivate?: boolean;
  } = {},
) {
  return renderHook(() =>
    usePlaylistActivation({
      sourceId: options.sourceId ?? 'playlist:pl-1',
      allClimbs: options.allClimbs ?? [],
      fetchPage,
      viewOnlyBoard: options.viewOnlyBoard,
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
});

describe('usePlaylistActivation (mobile wrapper)', () => {
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
  });

  it('reuses the pinned item once — a second dispatch builds a fresh item', async () => {
    const { result } = renderActivation();
    const climb = makeClimb('a');
    await result.current.activate(climb);

    const first = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    const second = await captured().queueApi!.setCurrentClimb(climb, { playlistSuggestionSource: null });
    expect(second).not.toBe(first);
    expect(second?.uuid).not.toBe(first?.uuid);
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

  it('fetchClimbsForBoard pages the playlist via the injected fetchPage', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('b')], hasMore: false });
    mocks.fetchSuggestion.mockImplementation(
      async ({
        fetchPage: fp,
      }: {
        fetchPage: (a: { page: number; pageSize: number; signal: AbortSignal }) => unknown;
      }) => {
        await fp({ page: 0, pageSize: 100, signal: new AbortController().signal });
        return [makeClimb('b')];
      },
    );
    renderActivation(fetchPage);
    const target = captured().resolveTarget(makeClimb('a'))!;
    const climbs = await captured().fetchClimbsForBoard({
      target,
      activatedClimbUuid: 'a',
      signal: new AbortController().signal,
    });
    expect(fetchPage).toHaveBeenCalled();
    expect(climbs.map((climb) => climb.uuid)).toEqual(['b']);
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
    it('seeds the tapped climb, then replaces the queue with the full playlist order', async () => {
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [makeClimb('a'), tapped, makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });

      // The tapped climb is committed immediately (the drawer renders it), then
      // the queue expands to the whole ordered playlist around it.
      expect(mocks.openPlayDrawer).toHaveBeenCalledWith(tapped, { committedExternally: true });
      await waitFor(() => {
        const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
        expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['a', 'b', 'c']);
        expect(lastSetQueue?.[1].climb.uuid).toBe('b');
      });
      expect(fetchPage).toHaveBeenCalled();
      expect(result.current.queueReplaceSheet.visible).toBe(false);
    });

    it('warns instead of replacing when the queue has manual future items', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const fetchPage = vi.fn();
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(result.current.queueReplaceSheet.visible).toBe(true);
      expect(result.current.queueReplaceSheet.futureQueueCount).toBe(1);
      expect(mocks.setQueue).not.toHaveBeenCalled();
      expect(fetchPage).not.toHaveBeenCalled();
    });

    it('warns for suggested future queue items because replacement still clears them', async () => {
      const current = makeQueueItem('q-current', 'current');
      const suggestedFuture = makeQueueItem('q-suggested', 'suggested', true);
      mocks.queueState = { queue: [current, suggestedFuture], currentClimbQueueItem: current };
      const { result } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });

      expect(result.current.queueReplaceSheet.visible).toBe(true);
      expect(result.current.queueReplaceSheet.futureQueueCount).toBe(1);
      expect(mocks.setQueue).not.toHaveBeenCalled();
    });

    it('replaces the queue once the user confirms the warning', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped, makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });
      expect(result.current.queueReplaceSheet.visible).toBe(true);

      await act(async () => {
        result.current.queueReplaceSheet.onConfirm();
      });

      await waitFor(() => {
        expect(mocks.setQueue).toHaveBeenCalled();
      });
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b', 'c']);
      await waitFor(() => {
        expect(result.current.queueReplaceSheet.visible).toBe(false);
      });
    });

    it('bumps the count and requires a second confirm when the queue grows while the sheet is open', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const tapped = makeClimb('b');
      const fetchPage = vi.fn().mockResolvedValue({ climbs: [tapped, makeClimb('c')], hasMore: false });
      const { result } = renderActivation(fetchPage, { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(tapped);
      });
      expect(result.current.queueReplaceSheet.visible).toBe(true);
      expect(result.current.queueReplaceSheet.futureQueueCount).toBe(1);

      // Another future item lands before the user confirms.
      const extraFuture = makeQueueItem('q-future-2', 'future-2');
      mocks.queueState = { queue: [current, future, extraFuture], currentClimbQueueItem: current };

      await act(async () => {
        result.current.queueReplaceSheet.onConfirm();
      });

      // First confirm only bumps the warning to the new count — it does NOT clear
      // the queue, so the user re-acknowledges what they're about to lose.
      expect(result.current.queueReplaceSheet.visible).toBe(true);
      expect(result.current.queueReplaceSheet.futureQueueCount).toBe(2);
      expect(mocks.setQueue).not.toHaveBeenCalled();

      // Second confirm (count now stable) goes through.
      await act(async () => {
        result.current.queueReplaceSheet.onConfirm();
      });
      await waitFor(() => {
        expect(mocks.setQueue).toHaveBeenCalled();
      });
      expect(fetchPage).toHaveBeenCalled();
    });

    it('cancelling the warning leaves the queue untouched', async () => {
      const current = makeQueueItem('q-current', 'current');
      const future = makeQueueItem('q-future', 'future');
      mocks.queueState = { queue: [current, future], currentClimbQueueItem: current };
      const { result } = renderActivation(vi.fn(), { replaceQueueOnActivate: true });

      await act(async () => {
        await result.current.activate(makeClimb('b'));
      });
      expect(result.current.queueReplaceSheet.visible).toBe(true);

      act(() => {
        result.current.queueReplaceSheet.onCancel();
      });

      expect(result.current.queueReplaceSheet.visible).toBe(false);
      expect(mocks.setQueue).not.toHaveBeenCalled();
    });

    // #3891 canary. A board-scoped fetch that comes back empty for a playlist whose
    // detail list already has climbs degrades into a plausible one-item queue —
    // no error, no toast, just a circuit you can't swipe through. That is exactly
    // how the MoonBoard size filter hid for months, so it now reports to Sentry.
    it('reports (and does not silently one-item) an empty board-scoped fetch for a non-empty playlist', async () => {
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
      // Documents the degraded-but-not-crashed behaviour: the tapped climb is still
      // playable, it just has nowhere to swipe to. The canary is telemetry, not a fix.
      const lastSetQueue = mocks.setQueue.mock.calls.at(-1);
      expect(lastSetQueue?.[0].map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['b']);
      expect(mocks.showToast).not.toHaveBeenCalled();
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
  });
});
