// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionId } from '../use-climb-actions';

// Keep the real useCreateClimbNavigation in this test so fork/edit exercise the
// one-action and injected-dismiss handoff end to end.
const ctrl = vi.hoisted(() => ({ canUpdate: false, sessionId: null as string | null }));
const openers = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  addToQueue: vi.fn(),
  toggleFavoriteMutate: vi.fn(),
  push: vi.fn(),
  shareClimb: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: openers.push }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('@boardsesh/create-climb-react', () => ({ computeCanUpdate: () => ctrl.canUpdate }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openPlayDrawer: openers.openPlayDrawer,
    // Still surfaced by the real provider (the climb-list row / board sheet open
    // it directly), but the hook no longer consumes it — the playlist action is
    // structurally inline-only. Kept here so the "never opens the sheet" assertion
    // has something to prove.
    openAddToPlaylist: openers.openAddToPlaylist,
    openLogAscent: openers.openLogAscent,
    openAddBetaVideo: openers.openAddBetaVideo,
    boardConfig: null,
  }),
  boardConfigsMatch: () => false,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ addToQueue: openers.addToQueue }),
  useQueueSessionId: () => ({ sessionId: ctrl.sessionId }),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: (climb: unknown) => ({ uuid: 'qi', climb }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f', neutral: '#fff', pin: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: openers.toggleFavoriteMutate }),
  useFavoriteStatus: () => ({ data: false }),
}));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => openers.shareClimb }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

import { useClimbActions } from '../use-climb-actions';

const climb = {
  uuid: 'climb-1',
  name: 'Test Climb',
  frames: 'p1r12',
  difficulty: 'V4',
  quality_average: '3.0',
} as unknown as Climb;

const ownerClimb = { ...climb, userId: 'user-1', is_draft: true } as unknown as Climb;

const kilterBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const tensionBoard = { ...kilterBoard, boardName: 'tension' };
const woodsBoard = { ...kilterBoard, boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1' };

// `onSelectPlaylist` is required on the hook — it MUST host the playlist picker
// inline (no root AddToPlaylistSheet, no flash-close over a modal route; see
// use-climb-actions.ts). Default it here so every call site is valid; the playlist
// dispatch test overrides it with a spy.
type ActionArgs = Omit<Parameters<typeof useClimbActions>[0], 'onSelectPlaylist'> & {
  onSelectPlaylist?: () => void;
};
const noopSelectPlaylist = () => {};
function renderActions(args: ActionArgs) {
  return renderHook(() => useClimbActions({ onSelectPlaylist: noopSelectPlaylist, ...args }));
}

function ids(args: ActionArgs): ClimbActionId[] {
  const { result } = renderActions(args);
  return result.current.map((action) => action.id);
}

beforeEach(() => {
  ctrl.canUpdate = false;
  ctrl.sessionId = null;
  Object.values(openers).forEach((fn) => fn.mockClear?.());
});

describe('useClimbActions gating', () => {
  it('returns the universal actions for a plain Kilter climb (no edit/beta/openInApp/editEntry)', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).toEqual([
      'preview',
      'queue',
      'playlist',
      'favorite',
      'tick',
      'fork',
      'share',
    ]);
  });

  it('adds "Edit entry" only when onEditEntry is provided', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false, onEditEntry: () => {} })).toContain(
      'editEntry',
    );
  });

  it('adds "Add beta video" only when authenticated', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: true })).toContain('betaVideo');
  });

  it('adds "Open in app" for Tension but not Kilter', () => {
    expect(ids({ climb, boardConfig: tensionBoard, isAuthenticated: false })).toContain('openInApp');
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).not.toContain('openInApp');
  });

  // Only the Aurora boards have a `<board>boardapp.com` site — a code-driven board
  // would otherwise get a row pointing at a domain that does not exist.
  it('never offers "Open in app" for a code-driven board', () => {
    expect(ids({ climb, boardConfig: woodsBoard, isAuthenticated: false })).not.toContain('openInApp');
  });

  it('adds owner-only "Edit" only when the climb is editable by the current user', () => {
    ctrl.canUpdate = true;
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'user-1' }),
    ).toContain('edit');
    // Not the owner → no edit row.
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'someone-else' }),
    ).not.toContain('edit');
  });

  it('offers Fork and Edit on Woods with the usual ownership rules', () => {
    ctrl.canUpdate = true;
    const woodsIds = ids({
      climb: ownerClimb,
      boardConfig: woodsBoard,
      isAuthenticated: false,
      currentUserId: 'user-1',
    });

    expect(woodsIds).toContain('fork');
    expect(woodsIds).toContain('edit');
    expect(woodsIds).toEqual(expect.arrayContaining(['preview', 'queue', 'playlist', 'favorite', 'tick', 'share']));
  });

  it('returns nothing without a climb or board config', () => {
    expect(ids({ climb: null, boardConfig: kilterBoard, isAuthenticated: true })).toEqual([]);
    expect(ids({ climb, boardConfig: null, isAuthenticated: true })).toEqual([]);
  });
});

describe('useClimbActions colours and dispatch', () => {
  it('colours queue/favorite by role and the rest with the accent', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    const byId = Object.fromEntries(result.current.map((action) => [action.id, action.color]));
    expect(byId.queue).toBe('#0a0');
    expect(byId.favorite).toBe('#f00');
    expect(byId.playlist).toBe('#00f');
  });

  it('queue.run enqueues the climb and fires onAfterAction', () => {
    const onAfterAction = vi.fn();
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false, onAfterAction });
    result.current.find((action) => action.id === 'queue')?.run();
    expect(openers.addToQueue).toHaveBeenCalledWith({ uuid: 'queue-uuid', climb });
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('playlist.run always hosts the picker inline (onSelectPlaylist), never the root sheet, and does not dismiss', () => {
    const onSelectPlaylist = vi.fn();
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      onSelectPlaylist,
      onAfterAction,
    });
    result.current.find((action) => action.id === 'playlist')?.run();
    expect(onSelectPlaylist).toHaveBeenCalledTimes(1);
    // Structural guarantee: the action can never open the root AddToPlaylistSheet
    // (which would flash closed over a modal route — the #3335 / #3294 class), and
    // it keeps the reaction overlay up (no dismiss).
    expect(openers.openAddToPlaylist).not.toHaveBeenCalled();
    expect(onAfterAction).not.toHaveBeenCalled();
  });

  it('betaVideo.run opens the root beta sheet and fires onAfterAction by default', () => {
    const onAfterAction = vi.fn();
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: true, onAfterAction });
    result.current.find((action) => action.id === 'betaVideo')?.run();
    expect(openers.openAddBetaVideo).toHaveBeenCalledWith(climb, kilterBoard);
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('betaVideo.run calls onAddBetaVideo (in-tree) instead of the root sheet when provided', () => {
    const onAddBetaVideo = vi.fn();
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: true,
      onAddBetaVideo,
      onAfterAction,
    });
    result.current.find((action) => action.id === 'betaVideo')?.run();
    // Same climb/board snapshot the root path uses, so a live queue change can't retarget it.
    expect(onAddBetaVideo).toHaveBeenCalledWith(climb, kilterBoard);
    // The play drawer's own sheet takes over — the root opener is skipped, but the
    // reaction menu still dismisses (unlike the inline playlist path).
    expect(openers.openAddBetaVideo).not.toHaveBeenCalled();
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'null', ascensionistCount: null },
    { label: 'undefined', ascensionistCount: undefined },
  ])('tick.run normalizes a runtime $label ascensionist count before opening LogAscent', ({ ascensionistCount }) => {
    const climbWithNullishCount = { ...climb, ascensionist_count: ascensionistCount } as unknown as Climb;
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb: climbWithNullishCount,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      onAfterAction,
    });
    result.current.find((action) => action.id === 'tick')?.run();
    expect(openers.openLogAscent).toHaveBeenCalledWith(
      expect.objectContaining({
        climbUuid: 'climb-1',
        boardName: 'kilter',
        angle: 40,
        baseAscensionistCount: 0,
      }),
    );
    const payload = openers.openLogAscent.mock.calls[0]?.[0] as { baseAscensionistCount: number };
    expect(Number.isFinite(payload.baseAscensionistCount)).toBe(true);
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  // #4975: every other tick entry point (play drawer, queue bar, queue sheet)
  // already forwards the active session. This one didn't, so ticking from the
  // climbs list / board sheet / logbook / a playlist — or the in-session screen's
  // own climb rows — wrote `session_id = NULL` mid-session and the climb vanished
  // from the session it belonged to.
  it('tick.run forwards the active session so the tick lands on it', () => {
    ctrl.sessionId = 'session-abc';
    const { result } = renderActions({ climb, boardConfig: woodsBoard, isAuthenticated: true });
    result.current.find((action) => action.id === 'tick')?.run();
    expect(openers.openLogAscent).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'climb-1', sessionId: 'session-abc' }),
    );
  });

  it('tick.run passes a null session when no session is running', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: true });
    result.current.find((action) => action.id === 'tick')?.run();
    expect(openers.openLogAscent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it('tick.run calls onTick (in-tree) instead of the root sheet when provided', () => {
    const onTick = vi.fn();
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      onTick,
      onAfterAction,
    });
    result.current.find((action) => action.id === 'tick')?.run();
    // Same climb/board snapshot the root path uses, so a live queue change can't retarget it.
    expect(onTick).toHaveBeenCalledWith(climb, kilterBoard);
    // The play drawer's own in-tree sheet takes over — the root opener (which would
    // pop the /play modal) is skipped, but the reaction menu still dismisses.
    expect(openers.openLogAscent).not.toHaveBeenCalled();
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('share.run opens the native share sheet', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    result.current.find((action) => action.id === 'share')?.run();
    expect(openers.shareClimb).toHaveBeenCalledTimes(1);
  });

  it('preview.run opens the climb view-only in the play drawer', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    result.current.find((action) => action.id === 'preview')?.run();
    expect(openers.openPlayDrawer).toHaveBeenCalledTimes(1);
    expect(openers.openPlayDrawer).toHaveBeenCalledWith(climb, expect.any(Object));
  });
});

describe('useClimbActions create-climb navigation (fork / edit)', () => {
  it('fork.run dismisses the overlay, then pushes create with the fork params', () => {
    const onAfterAction = vi.fn();
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false, onAfterAction });
    result.current.find((action) => action.id === 'fork')?.run();

    expect(onAfterAction).toHaveBeenCalledTimes(1);
    expect(openers.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: 'p1r12',
        forkName: 'Test Climb',
        forkDescription: '',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  it('edit.run pushes create with the climb uuid, not the fork frames', () => {
    ctrl.canUpdate = true;
    const { result } = renderActions({
      climb: ownerClimb,
      boardConfig: kilterBoard,
      isAuthenticated: true,
      currentUserId: 'user-1',
    });
    result.current.find((action) => action.id === 'edit')?.run();

    expect(openers.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        editClimbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  it('awaits the injected player close before pushing create', async () => {
    let finishPlayerDismiss: (result: { status: 'dismissed' }) => void = () => {};
    const dismissPlayerAndWait = vi.fn(
      () =>
        new Promise<{ status: 'dismissed' }>((resolve) => {
          finishPlayerDismiss = resolve;
        }),
    );
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      dismissPlayerAndWait,
    });
    result.current.find((action) => action.id === 'fork')?.run();

    expect(dismissPlayerAndWait).toHaveBeenCalledTimes(1);
    expect(openers.push).not.toHaveBeenCalled();

    await act(async () => finishPlayerDismiss({ status: 'dismissed' }));
    expect(openers.push).toHaveBeenCalledTimes(1);
  });

  it('pushes directly when no source or player dismiss callback is present', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    result.current.find((action) => action.id === 'fork')?.run();

    expect(openers.push).toHaveBeenCalledTimes(1);
  });
});
