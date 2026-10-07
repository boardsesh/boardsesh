// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionId } from '../use-climb-actions';

// Keep the real useCreateClimbNavigation in this test so fork/edit exercise the
// one-action and injected-dismiss handoff end to end.
const ctrl = vi.hoisted(() => ({
  wallArchived: false,
  sessionId: null as string | null,
  moderationEnabled: true,
  activeClimbUuid: null as string | null,
}));
const openers = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  openReportClimb: vi.fn(),
  addToQueue: vi.fn(),
  playNext: vi.fn(),
  toggleFavoriteMutate: vi.fn(),
  push: vi.fn(),
  shareClimb: vi.fn(async () => {}),
  requestDelete: vi.fn(async (_climb: unknown, _boardName: string, _onDeleted?: () => void) => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: openers.push }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
// The REAL edit rule (`canEditClimb`): the gate is the thing under test. Only
// the wall's viewer flags are stubbed, since the registry behind them has its
// own tests.
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({
  useSprayWallIsArchived: (boardName: string | null | undefined) => boardName === 'spray' && ctrl.wallArchived,
}));
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
    openReportClimb: openers.openReportClimb,
    boardConfig: null,
  }),
  boardConfigsMatch: () => false,
}));
// The kill switch reads as ENABLED when unresolved, so the default here is true.
vi.mock('../../../providers/feature-flags-provider', () => ({
  useClimbModerationEnabled: () => ctrl.moderationEnabled,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ addToQueue: openers.addToQueue, playNext: openers.playNext }),
  useQueueSessionId: () => ({ sessionId: ctrl.sessionId }),
  useActiveClimbUuid: () => ctrl.activeClimbUuid,
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
// The delete flow (confirm, mutation, toasts) has its own tests.
vi.mock('../use-delete-climb-action', () => ({ useDeleteClimbAction: () => openers.requestDelete }));

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
const sprayBoard = { ...kilterBoard, boardName: 'spray', layoutId: 4200, sizeId: 4200, setIds: '1' };
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
  ctrl.wallArchived = false;
  ctrl.sessionId = null;
  ctrl.moderationEnabled = true;
  ctrl.activeClimbUuid = null;
  Object.values(openers).forEach((fn) => fn.mockClear?.());
});

describe('useClimbActions gating', () => {
  it('returns the universal actions for a plain Kilter climb (no edit/beta/openInApp/editEntry)', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).toEqual([
      'preview',
      'queue',
      'playNext',
      'playlist',
      'favorite',
      'tick',
      'fork',
      'share',
    ]);
  });

  // #5654: the play drawer passes this while the connect-step pill has the
  // queue button's place; everywhere else the queue has its own button.
  it('adds "Open the queue" right after "Add to queue" only when onOpenQueue is provided', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).not.toContain('openQueue');

    const withQueue = ids({ climb, boardConfig: kilterBoard, isAuthenticated: false, onOpenQueue: () => {} });
    expect(withQueue.indexOf('openQueue')).toBe(withQueue.indexOf('queue') + 1);
  });

  it('closes the menu before it opens the queue', () => {
    const order: string[] = [];
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      onAfterAction: () => order.push('closed'),
      onOpenQueue: () => order.push('queue opened'),
    });

    act(() => result.current.find((action) => action.id === 'openQueue')?.run());

    expect(order).toEqual(['closed', 'queue opened']);
  });

  it('adds "Edit entry" only when onEditEntry is provided', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false, onEditEntry: () => {} })).toContain(
      'editEntry',
    );
  });

  it('adds "Add beta video" only when authenticated', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: true })).toContain('betaVideo');
  });

  it('adds "Report climb" only when authenticated, and always last', () => {
    const signedOut = ids({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    expect(signedOut).not.toContain('report');

    const signedIn = ids({ climb, boardConfig: tensionBoard, isAuthenticated: true });
    expect(signedIn).toContain('report');
    // Below every action a climber came here to do — including "Open in app",
    // the last of them on an Aurora board.
    expect(signedIn[signedIn.length - 1]).toBe('report');
  });

  // #5960: a draft is visible to its setter alone, and nobody reports themselves.
  it("offers neither Share nor Report on the viewer's own draft", () => {
    const own = ids({ climb: ownerClimb, boardConfig: sprayBoard, isAuthenticated: true, currentUserId: 'user-1' });
    expect(own).not.toContain('share');
    expect(own).not.toContain('report');
  });

  it("drops Report but keeps Share on the viewer's own published climb", () => {
    const published = { ...ownerClimb, is_draft: false } as unknown as Climb;
    const own = ids({ climb: published, boardConfig: kilterBoard, isAuthenticated: true, currentUserId: 'user-1' });
    expect(own).toContain('share');
    expect(own).not.toContain('report');
  });

  it("keeps Report on somebody else's published climb", () => {
    const theirs = { ...climb, userId: 'setter-2', is_draft: false } as unknown as Climb;
    const viewed = ids({ climb: theirs, boardConfig: kilterBoard, isAuthenticated: true, currentUserId: 'user-1' });
    expect(viewed).toContain('share');
    expect(viewed).toContain('report');
  });

  it('drops "Report climb" when the moderation kill switch is flipped', () => {
    ctrl.moderationEnabled = false;
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: true })).not.toContain('report');
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
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'user-1' }),
    ).toContain('edit');
    // Not the owner → no edit row.
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'someone-else' }),
    ).not.toContain('edit');
  });

  it('stops offering Edit on a catalogue board 24 hours after publishing', () => {
    const publishedLongAgo = { ...climb, userId: 'user-1', is_draft: false, published_at: '2020-01-01T00:00:00.000Z' };
    expect(
      ids({
        climb: publishedLongAgo as unknown as Climb,
        boardConfig: kilterBoard,
        isAuthenticated: true,
        currentUserId: 'user-1',
      }),
    ).not.toContain('edit');
  });

  // A spray climb follows the catalogue rule: the setter, a draft for good, a
  // published climb for 24 hours after first publish. Nobody else, the wall's
  // owner included.
  describe('spray walls', () => {
    const publishedHoursAgo = (hoursAgo: number) =>
      ({
        ...climb,
        userId: 'setter-1',
        is_draft: false,
        published_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
      }) as unknown as Climb;
    const draftClimb = { ...publishedHoursAgo(30), is_draft: true, published_at: null } as unknown as Climb;
    const asViewer = (viewedClimb: Climb, currentUserId: string) =>
      ids({ climb: viewedClimb, boardConfig: sprayBoard, isAuthenticated: true, currentUserId });

    it('offers the setter Edit within 24 hours of publishing', () => {
      expect(asViewer(publishedHoursAgo(2), 'setter-1')).toContain('edit');
    });

    it('stops offering the setter Edit 24 hours after publishing', () => {
      expect(asViewer(publishedHoursAgo(30), 'setter-1')).not.toContain('edit');
    });

    it('keeps Edit on a draft for its setter', () => {
      expect(asViewer(draftClimb, 'setter-1')).toContain('edit');
    });

    it("does not offer the wall's owner Edit on a climb somebody else set", () => {
      expect(asViewer(publishedHoursAgo(2), 'wall-owner')).not.toContain('edit');
      expect(asViewer(draftClimb, 'wall-owner')).not.toContain('edit');
    });

    // #5960: any age, since the server, not the clock, decides (no ticks yet).
    it('offers the setter Delete, last, on their published climb at any age', () => {
      for (const hours of [2, 30]) {
        const actions = asViewer(publishedHoursAgo(hours), 'setter-1');
        expect(actions[actions.length - 1]).toBe('delete');
      }
    });

    it('offers Delete to nobody else, never on a draft, and never on an archived wall', () => {
      expect(asViewer(publishedHoursAgo(2), 'wall-owner')).not.toContain('delete');
      expect(asViewer(draftClimb, 'setter-1')).not.toContain('delete');
      ctrl.wallArchived = true;
      expect(asViewer(publishedHoursAgo(2), 'setter-1')).not.toContain('delete');
    });

    it('never offers Delete off a spray wall', () => {
      expect(
        ids({
          climb: publishedHoursAgo(2),
          boardConfig: kilterBoard,
          isAuthenticated: true,
          currentUserId: 'setter-1',
        }),
      ).not.toContain('delete');
    });

    it('delete.run closes the menu, then starts the delete; a success closes the player behind it', () => {
      const onAfterAction = vi.fn();
      const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
      const viewed = publishedHoursAgo(2);
      const { result } = renderActions({
        climb: viewed,
        boardConfig: sprayBoard,
        isAuthenticated: true,
        currentUserId: 'setter-1',
        onAfterAction,
        dismissPlayerAndWait,
      });

      act(() => result.current.find((action) => action.id === 'delete')!.run());

      expect(onAfterAction).toHaveBeenCalledTimes(1);
      expect(openers.requestDelete).toHaveBeenCalledWith(viewed, 'spray', expect.any(Function));
      expect(onAfterAction.mock.invocationCallOrder[0]).toBeLessThan(openers.requestDelete.mock.invocationCallOrder[0]);
      expect(dismissPlayerAndWait).not.toHaveBeenCalled();

      const onDeleted = openers.requestDelete.mock.calls[0][2]!;
      onDeleted();
      expect(dismissPlayerAndWait).toHaveBeenCalledTimes(1);
    });
  });

  it('offers Fork and Edit on Woods with the usual ownership rules', () => {
    const woodsIds = ids({
      climb: ownerClimb,
      boardConfig: woodsBoard,
      isAuthenticated: false,
      currentUserId: 'user-1',
    });

    expect(woodsIds).toContain('fork');
    expect(woodsIds).toContain('edit');
    expect(woodsIds).toEqual(expect.arrayContaining(['preview', 'queue', 'playlist', 'favorite', 'tick']));
  });

  // An archived wall keeps its climbs, but takes no new climb and no edit.
  it('offers neither Fork nor Edit on an archived spray wall, and keeps the rest', () => {
    ctrl.wallArchived = true;
    const archivedIds = ids({
      climb: ownerClimb,
      boardConfig: sprayBoard,
      isAuthenticated: true,
      currentUserId: 'user-1',
    });
    expect(archivedIds).not.toContain('fork');
    expect(archivedIds).not.toContain('edit');
    expect(archivedIds).toEqual(expect.arrayContaining(['preview', 'queue', 'playlist', 'tick']));
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

  it('hides "Play next" for the climb already on the wall', () => {
    ctrl.activeClimbUuid = climb.uuid;
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).not.toContain('playNext');
    // Another climb being active leaves the row in place.
    ctrl.activeClimbUuid = 'some-other-climb';
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).toContain('playNext');
  });

  it('playNext.run forwards the queue slot when the menu came from a queue row', () => {
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: false,
      queueItemUuid: 'queue-slot-7',
      onAfterAction,
    });
    result.current.find((action) => action.id === 'playNext')?.run();
    expect(openers.playNext).toHaveBeenCalledWith({
      item: { uuid: 'queue-uuid', climb },
      queueItemUuid: 'queue-slot-7',
    });
    // Fire-and-forget: the cross-board prompt sits above the dismissed sheet, so
    // the dismiss must not wait on the promise.
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('playNext.run omits the queue slot everywhere else', () => {
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: false });
    result.current.find((action) => action.id === 'playNext')?.run();
    expect(openers.playNext).toHaveBeenCalledWith({ item: { uuid: 'queue-uuid', climb }, queueItemUuid: undefined });
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

  it('report.run opens the root report sheet and fires onAfterAction by default', () => {
    const onAfterAction = vi.fn();
    const { result } = renderActions({ climb, boardConfig: kilterBoard, isAuthenticated: true, onAfterAction });
    result.current.find((action) => action.id === 'report')?.run();
    expect(openers.openReportClimb).toHaveBeenCalledWith(climb, kilterBoard);
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('report.run calls onReportClimb (in-tree) instead of the root sheet when provided', () => {
    const onReportClimb = vi.fn();
    const onAfterAction = vi.fn();
    const { result } = renderActions({
      climb,
      boardConfig: kilterBoard,
      isAuthenticated: true,
      onReportClimb,
      onAfterAction,
    });
    result.current.find((action) => action.id === 'report')?.run();
    // Same climb/board snapshot the root path uses, so a live queue change can't retarget it.
    expect(onReportClimb).toHaveBeenCalledWith(climb, kilterBoard);
    // The play drawer's own sheet takes over — the root opener is skipped, but the
    // reaction menu still dismisses.
    expect(openers.openReportClimb).not.toHaveBeenCalled();
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
        // The parent's grade rides along so a remix on a board that publishes
        // with the setter's own grade (a spray wall) opens at it (#5443).
        forkDifficulty: 'V4',
        // The parent, so the editor can draw the holds it lost.
        forkParentUuid: climb.uuid,
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  it('edit.run pushes create with the climb uuid, not the fork frames', () => {
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
