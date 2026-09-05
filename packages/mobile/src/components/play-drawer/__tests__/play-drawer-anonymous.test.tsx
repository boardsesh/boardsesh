// @vitest-environment jsdom
// The one test that actually RENDERS PlayDrawer.
//
// Every anonymous rule in this component was previously pinned one hop away —
// `play-drawer-action-bar.test.tsx` renders the bar with a `viewer` handed
// straight in, `play-drawer-navigation.test.ts` calls `getSimilarClimbTapMode`
// as a pure function, `play-drawer-layout.test.ts` calls
// `initialDrawerPreviewItem` as a pure function. All three oracles are sound and
// none of them can see whether PlayDrawer *uses* them: hardcoding
// `viewer="member"` at the action-bar call site, or deleting the
// similar-climb guard outright, left the whole 6576-test mobile suite green.
//
// So this file renders the real component with its children recorded, and
// asserts the joins:
//
//   1. `viewer` and `onSignInPress` reach PlayDrawerActionBar.
//   2. A similar-climb tap writes nothing anonymously — no `addToQueue`, no
//      `setCurrentClimb` (which is what re-arms the BLE auto-sender) — and still
//      does both for a member.
//   3. No wall-state chrome anonymously — no header pill, and the action bar's
//      second row never swaps to the commit controls. The commit button calls
//      `setCurrentClimb`, so it is the same queue write and the same BLE re-arm
//      wearing a different label.
//   4. The favourite query is disarmed anonymously (`favorites` is
//      `requireAuthenticated`, so an armed one can only 401).
//   5. The pane never paints its "Pick a climb" placeholder when the open target
//      already carries the climb — not even on the first commit.
//   6. The shared-session browse latch actually reaches the gestures: swipes and
//      similar-climb taps go view-only in a crew, a queue-sheet tap stays live,
//      the latch survives the session ending, and Back to live drops it. The
//      rules themselves are pure and tested in `play-drawer-navigation.test.ts`;
//      hardcoding `inSharedSession: false` at these call sites leaves all of
//      those green while the wall gets taken on the next swipe.
//   7. A playlist peek never reaches `setCurrentClimb` from the commit button.
//   8. The busy-wall confirm: the FIRST commit tap on a wall someone else moved
//      mid-browse asks instead of taking it, and stands down only on the three
//      things amendment B allows (never a timer).
//   9. The mirror toggle doesn't push a previewed climb's frames to a board that
//      is lit with the LIVE climb.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  actionBar: [] as Props[],
  wallPill: [] as Props[],
  wallCallout: [] as Props[],
  deferredSections: [] as Props[],
  favoriteStatus: [] as Props[],
  browseFrame: 0,
  panePlaceholder: 0,
}));
const queueActions = vi.hoisted(() => ({
  setCurrentClimb: vi.fn(),
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  addToQueue: vi.fn(async () => 'added'),
  // Board-render A/B telemetry (issue #2202). The preview path writes nothing
  // to the queue, so this is the only way the climb it puts on the board gets
  // counted as a view.
  noteClimbViewed: vi.fn(),
}));
// Mutable session fixtures: whether another climber is in the session, and the
// navigation state the drawer swipes through. Read at call time so a case can
// change them between renders — which is how "the latch survives the session
// ending" is exercised at all.
const session = vi.hoisted(() => ({
  isShared: false,
  sessionId: null as string | null,
  nextItem: null as { uuid: string; climb: unknown } | null,
  // The committed queue head. Null in the preview-only cases (the drawer renders
  // the pinned preview); set where a case needs a live climb to fall back to.
  currentItem: null as { uuid: string; climb: unknown } | null,
}));
// What board presence says is physically lit. Mutated between renders so a case
// can move the wall UNDER a browsing climber — which is the whole premise of the
// busy-wall confirm.
// The lightbulb's own signal — this device's BLE link, or a session member's.
// `resolveWallPillState` / `resolveCommitBarModel` read it as `wallDriven`.
const lightbulb = vi.hoisted(() => ({ lit: false }));
const wall = vi.hoisted(() => ({
  uuid: null as string | null,
  name: null as string | null,
  // Server-stamped. Only the cold-start cases set it: it is how a read that
  // merely ARRIVED late is told from a climb a peer lit mid-browse.
  sentAt: null as string | null,
}));
// The BLE link. Null (no transport) unless a case needs to watch what does and
// doesn't reach the board.
const ble = vi.hoisted(() => ({
  current: null as { isConnected: boolean; sendFramesToBoard: ReturnType<typeof vi.fn> } | null,
}));

// --- Host platform -----------------------------------------------------------
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
}));
// The settings store backs `lightOnSwipe`, which decides whether a preview's
// next swipe commits — and therefore whether the browse chrome is telling the
// truth. Kept in memory so each case can set it.
vi.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    createMMKV: () => ({
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => store.set(key, value),
      remove: (key: string) => store.delete(key),
      clearAll: () => store.clear(),
    }),
  };
});
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => undefined,
  useSharedValue: (initial: unknown) => ({ value: initial }),
  runOnJS: (fn: unknown) => fn,
}));
vi.mock('expo-router', () => ({ router: { dismiss: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'random-uuid' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

// --- Shared packages ---------------------------------------------------------
vi.mock('@boardsesh/play-view', () => ({
  computeNavigationStateWithSuggestions: () => ({
    nextItem: session.nextItem,
    prevItem: null,
    canNext: session.nextItem != null,
    canPrevious: false,
  }),
  boardSupportsMirroring: () => true,
}));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    ClimbShared: 'Climb Shared',
    FavoriteToggle: 'Favorite Toggle',
    QuickTickOpened: 'Quick Tick Opened',
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

// --- Children ----------------------------------------------------------------
// Recorded rather than stubbed: these three carry the props under test.
vi.mock('../PlayDrawerActionBar', () => ({
  PlayDrawerActionBar: (props: Props) => {
    recorded.actionBar.push(props);
    return createElement('div', { 'data-testid': 'action-bar' });
  },
}));
vi.mock('../WallStatePill', () => ({
  WallStatePill: (props: Props) => {
    recorded.wallPill.push(props);
    return createElement('div', { 'data-testid': 'wall-state-pill' });
  },
}));
// Recorded, not stubbed: the one-shot "you're browsing now" notice is rendered
// through this same component, and only the host decides when.
vi.mock('../WallStateCallout', () => ({
  WallStateCallout: (props: Props) => {
    recorded.wallCallout.push(props);
    return null;
  },
}));
vi.mock('../BrowseFrameOverlay', () => ({
  BrowseFrameOverlay: () => {
    recorded.browseFrame += 1;
    return createElement('div', { 'data-testid': 'browse-frame' });
  },
}));
vi.mock('../DeferredSections', () => ({
  DeferredSections: (props: Props) => {
    recorded.deferredSections.push(props);
    return createElement('div', { 'data-testid': 'deferred-sections' });
  },
}));
vi.mock('../PanePlaceholder', () => ({
  PanePlaceholder: () => {
    recorded.panePlaceholder += 1;
    return createElement('div', { 'data-testid': 'pane-placeholder' });
  },
}));
vi.mock('../DeferredBoard', () => ({ DeferredBoard: () => createElement('div', { 'data-testid': 'board' }) }));
vi.mock('../BoardRenderUnavailable', () => ({ BoardRenderUnavailable: () => null }));
vi.mock('../PlaybackControls', () => ({ PlaybackControls: () => null }));
// Renders its `leading` slot: that is where the wall-state pill lands, so a mock
// that swallowed it would hide whether PlayDrawer passes one at all.
vi.mock('../PlayDrawerHeader', () => ({
  LivePlayDrawerHeader: ({ leading }: { leading?: ReactNode }) => createElement('div', null, leading),
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current }: { current?: ReactNode }) => createElement('div', null, current),
}));
vi.mock('../SwitchBoardOverlay', () => ({ SwitchBoardOverlay: () => null }));
vi.mock('../AngleSelectorSheet', () => ({ AngleSelectorSheet: () => null }));
vi.mock('../../LogAscentSheet', () => ({ LogAscentSheet: () => null }));
vi.mock('../../ClimbActionsSheet', () => ({ ClimbActionsSheet: () => null }));
vi.mock('../../AddBetaVideoSheet', () => ({ AddBetaVideoSheet: () => null }));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ queue: [], currentClimbQueueItem: session.currentItem }),
  useQueueActions: () => queueActions,
  useQueueSessionId: () => ({ sessionId: session.sessionId }),
  useIsSharedSession: () => session.isShared,
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ble.current }));
// Board presence, read continuously so the pill can say "On the wall" after any
// navigation and the confirm has a before-and-after to compare.
vi.mock('../use-wall-climb', () => ({ useWallClimb: () => wall }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: (_boardName: string, _uuid: string | null, _angle: number, options?: Props) => {
    recorded.favoriteStatus.push(options ?? {});
    return { data: undefined };
  },
  // The angle re-anchor's fetch. Nothing here changes the angle, so it never
  // resolves — the point is that its absence doesn't drop the pinned preview.
  useClimb: () => ({ data: undefined }),
}));
vi.mock('../../../hooks/use-display-grade', () => ({ useDisplayGrade: () => ({ boardseshActive: false }) }));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn() }));
vi.mock('../../../hooks/use-mounted-on-first-open', () => ({ useMountedOnFirstOpen: (open: boolean) => open }));
vi.mock('../use-mobile-playback', () => ({ useMobilePlayback: () => ({ isAnimatable: false }) }));
vi.mock('../use-below-fold-content-request', () => ({
  useBelowFoldContentRequest: () => ({ requested: false, request: vi.fn(), requestFromScrollOffset: vi.fn() }),
}));
vi.mock('../use-drawer-dismiss-gesture', () => ({
  useDrawerDismissGesture: () => ({ gesture: { enabled: () => ({}) }, translateY: { value: 0 } }),
}));
vi.mock('../use-play-drawer-wake-lock', () => ({ usePlayDrawerWakeLock: () => undefined }));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: () => ({ lit: lightbulb.lit, localConnected: false, pending: false, onPress: vi.fn() }),
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 100, boardHeight: 100, holdsData: [], imagesToHolds: {} }),
}));

// `play-drawer-navigation`, `play-drawer-layout`, `wall-state`,
// `boardsesh-grade-display` and `favorite-rollback` stay REAL — the wiring of
// those helpers into the render is exactly what this file exists to measure.

const { AccessibilityInfo } = await import('react-native');
const { PlayDrawer, SHARED_BROWSE_LATCH_RELEASE_MS } = await import('../PlayDrawer');
const { setSetting, resetAllSettings } = await import('../../../settings');
const { _resetJoinedBrowseNoticeForTests } = await import('../joined-browse-notice');

const BOARD_CONFIG = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const CLIMB = {
  uuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
  name: 'Crimpy Thing',
  frames: 'p1145r15',
  difficulty: '7A',
} as unknown as Climb;
const SIMILAR_CLIMB = {
  uuid: 'FFEE0011223344556677889900AABBCC',
  name: 'Neighbour',
  frames: 'p1200r15',
} as unknown as Climb;

function openTargetFor(climb: Climb) {
  return { climb, options: { previewQueueItem: { uuid: 'queue-item-uuid', climb } }, nonce: 1 };
}

/** What a queue-sheet tap / playlist activation hands the drawer: already committed. */
function committedTargetFor(climb: Climb) {
  return { climb, options: { committedExternally: true }, nonce: 1 };
}

/**
 * What a tick in the session feed, a Logbook row, a profile climb or a search hit
 * hands the drawer: no preview, no commit — just "show me this climb", which solo
 * means making it current.
 */
function freshTargetFor(climb: Climb) {
  return { climb, options: {}, nonce: 1 };
}

function drawerElement(
  viewer: 'member' | 'anonymous',
  openTarget:
    | ReturnType<typeof openTargetFor>
    | ReturnType<typeof committedTargetFor>
    | ReturnType<typeof freshTargetFor>,
  onSignIn?: () => void,
) {
  return createElement(PlayDrawer, {
    presentation: 'pane' as const,
    viewer,
    boardConfig: BOARD_CONFIG,
    openTarget,
    onOpenQueue: vi.fn(),
    onSignIn,
  });
}

function renderDrawer(viewer: 'member' | 'anonymous', onSignIn?: () => void) {
  return render(drawerElement(viewer, openTargetFor(CLIMB), onSignIn));
}

function lastActionBarProps(): Props {
  const props = recorded.actionBar.at(-1);
  if (!props) throw new Error('PlayDrawerActionBar never rendered');
  return props;
}

function lastSimilarClimbHandler(): (climb: Climb) => Promise<void> {
  const props = recorded.deferredSections.at(-1);
  if (!props) throw new Error('DeferredSections never rendered');
  return props.onSimilarClimbPress as (climb: Climb) => Promise<void>;
}

/**
 * The climb the drawer is currently showing, read back off the last
 * DeferredSections render. Goes through the same never-rendered guard as
 * `lastSimilarClimbHandler` so a drawer that failed to render fails the test by
 * saying so, rather than by throwing a TypeError from a dereferenced `undefined`.
 */
function lastDisplayedClimbUuid(): string {
  const props = recorded.deferredSections.at(-1);
  if (!props) throw new Error('DeferredSections never rendered');
  return (props.climb as Climb).uuid;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.actionBar = [];
  recorded.wallPill = [];
  recorded.wallCallout = [];
  recorded.deferredSections = [];
  recorded.favoriteStatus = [];
  recorded.browseFrame = 0;
  recorded.panePlaceholder = 0;
  queueActions.addToQueue.mockResolvedValue('added');
  session.isShared = false;
  session.sessionId = null;
  session.nextItem = null;
  session.currentItem = null;
  wall.uuid = null;
  lightbulb.lit = false;
  wall.name = null;
  wall.sentAt = null;
  ble.current = null;
  resetAllSettings();
  _resetJoinedBrowseNoticeForTests();
});

// Joining a crew changes what every browse-shaped gesture means: a swipe, a
// similar-climb tap and (elsewhere) a climb-list tap stop writing the queue
// EVERYONE reads. The rules are pinned pure in `play-drawer-navigation.test.ts`;
// what only a render can see is whether PlayDrawer feeds them the crew flag at
// all — hardcoding `inSharedSession: false` at these call sites leaves every
// pure test green while the wall gets taken on the next swipe.
describe('PlayDrawer — the shared-session browse latch', () => {
  const CREW = () => {
    session.isShared = true;
    session.sessionId = 'session-1';
  };

  it('browses a pinned preview in a crew even with lighting on', () => {
    // Solo, this exact state commits on the next swipe (the case below it in
    // this file). The crew flag is the only difference.
    CREW();
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');
    expect(recorded.browseFrame).toBeGreaterThan(0);
    expect(lastActionBarProps().secondaryMode).toBe('commit');
  });

  it('keeps a swipe view-only instead of moving the crew queue', () => {
    CREW();
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    renderDrawer('member');

    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });

    // `nextClimb()` is the shared-queue write and the BLE re-arm. The drawer
    // still MOVES — a dead swipe would be its own regression — it just moves
    // locally.
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
  });

  it('previews a similar climb instead of double-writing it', () => {
    CREW();
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    return act(async () => {
      await onSimilarClimbPress(SIMILAR_CLIMB);
    }).then(() => {
      // The member branch appends to the crew's queue AND takes the wall.
      expect(queueActions.addToQueue).not.toHaveBeenCalled();
      expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
      expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    });
  });

  // Every "show me this climb" opener that carries no preview — a tick in the
  // session feed, a Logbook row, a profile climb, a search hit — lands in the
  // drawer's fresh-active-open branch, which commits. In a crew that is the
  // ordinary look-at-my-logbook gesture taking the wall from someone mid-attempt,
  // so it browses instead. Gated at the opener rather than at each caller: they
  // are many, and every one of them is the same gesture.
  it('browses a tick-shaped open in a crew instead of taking the wall', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    render(drawerElement('member', freshTargetFor(CLIMB)));

    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(CLIMB.uuid);
    expect(lastActionBarProps().secondaryMode).toBe('commit');
  });

  it('still commits the same open when nobody else is here', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    render(drawerElement('member', freshTargetFor(CLIMB)));

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb.mock.calls[0][0].climb.uuid).toBe(CLIMB.uuid);
  });

  // Amendment A again, on the open path this time: the gate reads the LATCH, not
  // the live roster, so a peer's phone dropping off the wifi for a moment can't
  // turn the tap the climber is already making into a queue write.
  it('keeps a fresh open browsing while the latch is up, session or no session', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    const view = render(drawerElement('member', openTargetFor(SIMILAR_CLIMB)));

    session.isShared = false;
    session.sessionId = null;
    view.rerender(drawerElement('member', freshTargetFor(CLIMB)));

    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(CLIMB.uuid);
  });

  // The accessory bar opens the climb that is ALREADY current. Nothing is
  // written either way, so pinning it as a preview would only invent a browse the
  // climber never started — and a commit row for a climb already up.
  it('leaves an open of the current climb exactly as it was', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', freshTargetFor(CLIMB)));

    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastActionBarProps().secondaryMode).toBe('actions');
    expect(recorded.browseFrame).toBe(0);
  });

  // The one browse-shaped gesture that is deliberately NOT gated: tapping a row
  // in the queue sheet is an explicit "play this now", and it arrives here
  // already committed. Gating it would leave the crew with no way to drive the
  // wall from the queue at all.
  it('leaves a queue-sheet tap live — it arrives already committed', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));

    expect(recorded.wallPill.at(-1)?.state).not.toBe('browsing');
    expect(recorded.browseFrame).toBe(0);
    expect(lastActionBarProps().secondaryMode).toBe('actions');
  });

  // The latch outlasts the crew, but only for a dwell. Mid-browse the roster
  // changes under you — a peer drops off the wifi, the session ends — and reading
  // the gate live would turn the very next swipe into a wall-driving commit while
  // the climber's hand was already moving. Holding it FOREVER was the other
  // failure: a climber who never opened the commit row was left with swipes that
  // no longer lit the board and a crew that was long gone.
  it('holds the latch when the session ends mid-browse', () => {
    CREW();
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    // One target object across both renders, so re-rendering doesn't re-run the
    // drawer's open effect and confuse the state under test.
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    // The crew evaporates.
    session.isShared = false;
    session.sessionId = null;
    view.rerender(drawerElement('member', target));

    expect(lastActionBarProps().secondaryMode).toBe('commit');
    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');

    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
  });

  it('releases the latch on its own once the session has been solo for a dwell', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    // Everyone leaves. The latch holds at first — that is the point of it.
    session.isShared = false;
    session.sessionId = null;
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();

    // ...and then lets go, without the climber having to find a button.
    act(() => {
      vi.advanceTimersByTime(SHARED_BROWSE_LATCH_RELEASE_MS + 100);
    });
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('takes the browsing notice down with the latch that raised it', () => {
    // The card says navigation is view-only, so it must not outlive the latch —
    // and now that the latch can release on its own, it can. It stands down
    // because releasing moves the pill from `browsing` to `live` and the dismiss
    // effect above keys on that; this pins the connection, which is otherwise
    // two effects apart and easy to sever by making the pill latch-independent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    CREW();
    wall.uuid = 'some-other-climb';
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));
    expect(recorded.wallCallout.at(-1)?.presentation).toBe('notice');

    // The crew goes but the SESSION stays — the climber is alone in a session they
    // started, which is the ordinary state. This render is what schedules the
    // release timer, so it has to happen before the clock moves, and the latch is
    // still up here, so the notice is still legitimately on screen.
    session.isShared = false;
    view.rerender(drawerElement('member', target));

    act(() => {
      vi.advanceTimersByTime(SHARED_BROWSE_LATCH_RELEASE_MS + 100);
    });
    view.rerender(drawerElement('member', target));

    // Recorded from a clean slate AFTER the state settles, then rendered once
    // more. A closed callout stops rendering entirely, so reading `.at(-1)` would
    // hold a stale notice frame — and clearing any earlier would catch the
    // transitional render that happens before the effects run.
    recorded.wallCallout = [];
    view.rerender(drawerElement('member', target));

    expect(recorded.wallCallout.filter((props) => props.presentation === 'notice')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('drops the latch on Back to live, so the next swipe drives the wall again', () => {
    CREW();
    // A committed head to fall back to, on a different climb than the preview.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    act(() => {
      (lastActionBarProps().onBackToLive as () => void)();
    });
    // Back to live is an exit, not a commit: nothing is sent on the way out.
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();

    // Solo again — and with the latch disarmed, swipes commit as they did before.
    session.isShared = false;
    session.sessionId = null;
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).toHaveBeenCalledTimes(1);
  });

  // Joining a crew silently changes what a swipe does, so the drawer says so —
  // once. A card that reappears on every open is what people remember about a
  // feature instead of the feature.
  it('explains the new rule once, the first time the latch engages', () => {
    CREW();
    render(drawerElement('member', openTargetFor(CLIMB)));

    const notices = recorded.wallCallout.filter((props) => props.presentation === 'notice');
    expect(notices).toHaveLength(1);
  });

  it('does not explain it again on the next drawer open in the same session', () => {
    CREW();
    render(drawerElement('member', openTargetFor(CLIMB))).unmount();
    recorded.wallCallout = [];

    // The drawer is a modal route: it unmounts on every dismiss, which is why the
    // claim can't live in component state.
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(recorded.wallCallout.filter((props) => props.presentation === 'notice')).toHaveLength(0);
  });

  it('never explains it to a climber with no wall to explain', () => {
    // Board lighting off for swipes, but no board connected, no session and
    // nothing lit: "the wall stays put" would be a sentence about something this
    // climber hasn't got — the commit button reads "Set active" here for the same
    // reason.
    setSetting('lightOnSwipe', false);
    renderDrawer('member');

    expect(recorded.wallCallout.filter((props) => props.presentation === 'notice')).toHaveLength(0);
  });

  // The solo half of the same rule (#4640): turning board lighting off for swipes
  // and taps quietly makes navigation view-only, and nothing else says so.
  it('explains view-only navigation to a solo climber standing at a lit board', () => {
    setSetting('lightOnSwipe', false);
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    render(drawerElement('member', openTargetFor(CLIMB))).unmount();

    expect(recorded.wallCallout.filter((props) => props.presentation === 'notice')).toHaveLength(1);
  });

  it('tells that climber once, not once per drawer open', () => {
    // Unlike the crew claim, this one is a decision about a device the climber
    // keeps — so it is persisted, and a cold start does not re-explain it.
    setSetting('lightOnSwipe', false);
    wall.uuid = 'wall-climb-a';
    render(drawerElement('member', openTargetFor(CLIMB))).unmount();
    recorded.wallCallout = [];

    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(recorded.wallCallout.filter((props) => props.presentation === 'notice')).toHaveLength(0);
  });

  // The card is the visual half. The spoken half has to come from here on BOTH
  // platforms: a live region on a card that MOUNTS holding its text is not a
  // content change (Android can miss it), and the drawer can open straight into a
  // browse, where there is no transition for the wall-state announcer to narrate.
  it('speaks the rule it just put on screen', () => {
    CREW();
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('playView.wallState.joinedBrowseNotice');
  });

  it('does not read the shorter browse sentence over the notice', () => {
    vi.useFakeTimers();
    try {
      // A crew forming mid-preview IS a pill transition, so the announcer would
      // otherwise narrate it 600ms after the notice said the same thing at length.
      const target = openTargetFor(CLIMB);
      const view = render(drawerElement('member', target));
      session.isShared = true;
      session.sessionId = 'session-1';
      view.rerender(drawerElement('member', target));

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
      expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith(
        'playView.wallState.a11y.browseAnnounce',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Browsing a suggestion track walks onto transient `playlist-peek:<uuid>`
  // items, and `toQueueItemWireInput` puts `item.uuid` on the wire verbatim —
  // so a peek reaching setCurrentClimb broadcasts a uuid no peer can reconcile
  // against their queue. The commit button points at whatever is on screen.
  it('launders a playlist peek before putting it on the wall', () => {
    CREW();
    render(
      drawerElement('member', {
        climb: CLIMB,
        options: { previewQueueItem: { uuid: `playlist-peek:${CLIMB.uuid}`, climb: CLIMB } },
        nonce: 1,
      }),
    );

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    const [committed] = queueActions.setCurrentClimb.mock.calls[0];
    expect(committed.uuid.startsWith('playlist-peek:')).toBe(false);
    // Same climb, so the climber puts up what they were looking at.
    expect(committed.climb.uuid).toBe(CLIMB.uuid);
  });

  // A session ending is not an exit (amendment A), so the commit row is still
  // there afterwards — and it has to keep working. What changes is what it can
  // honestly promise: while a crew member drives a wall the button offers to put
  // the climb on it; with the crew gone, no BLE link and a dark wall, "Put on
  // the wall" would be a lighting this phone cannot do (#4872: the label follows
  // `wallDriven`, never the bare fact of a session).
  it('still commits, as a local set-active, after the session ends mid-browse', () => {
    CREW();
    lightbulb.lit = true;
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));
    expect(lastActionBarProps().commitLabel).toBe('putOnWall');

    session.isShared = false;
    session.sessionId = null;
    lightbulb.lit = false;
    view.rerender(drawerElement('member', target));

    expect(lastActionBarProps().commitLabel).toBe('setActive');
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });
});

// Someone else lit a climb while this climber was browsing. Taking the wall on
// the next tap would blank a climb another climber may be mid-attempt on, so the
// first tap asks. The predicate is table-tested in `wall-state.test.ts`; what
// only a render can see is the bookkeeping around it — the wall-at-latch-start
// snapshot, and the three (and only three) ways the question stands down.
describe('PlayDrawer — the busy-wall confirm', () => {
  const CREW = () => {
    session.isShared = true;
    session.sessionId = 'session-1';
  };

  /** Latch onto a preview against wall A, then let a peer move the wall to B. */
  function browseThenLoseTheWall() {
    CREW();
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    view.rerender(drawerElement('member', target));
    return { view, target };
  }

  it('asks before taking a wall that moved under the climber', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(true);
    expect(lastActionBarProps().wallClimbName).toBe('Their Project');
    // The whole point: the first tap did NOT take the wall.
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  // "Someone just lit X" needs a someone. A solo climber with `lightOnSwipe` off
  // is latched too, and the one way their wall moves under a preview is their own
  // lightbulb tap — so the question is never asked of them.
  it('never asks a solo climber to confirm over their own lighting', () => {
    setSetting('lightOnSwipe', false);
    wall.uuid = null;
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));
    expect(lastActionBarProps().showConfirm).toBe(false);

    // Their own auto-sender lights the queue head mid-preview.
    wall.uuid = 'wall-climb-head';
    wall.name = 'My Own Climb';
    view.rerender(drawerElement('member', target));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('speaks the question, since the bubble that carries it cannot be reached', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('playView.wallState.commitOverride.body');
  });

  it('commits on the second tap', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb.mock.calls[0][0].climb.uuid).toBe(CLIMB.uuid);
  });

  it('does not ask when the wall is still showing what it showed when browsing began', () => {
    // Nothing happened while the climber was away — asking here would train
    // people to tap through the question that matters.
    CREW();
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    render(drawerElement('member', openTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  // Amendment B: no auto-timeout. These next three are the ONLY ways out.
  it('stands down on Keep theirs, sending nothing', () => {
    // A committed head to land back on: "Keep theirs" drops the preview, and
    // with nothing behind it the drawer would have no climb left to render.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    browseThenLoseTheWall();
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().showConfirm).toBe(true);

    // "Keep theirs" IS the exit — the row hands it the same handler.
    act(() => {
      (lastActionBarProps().onBackToLive as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('stands down when the climber browses on', () => {
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    browseThenLoseTheWall();
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().showConfirm).toBe(true);

    // The question was "put THIS up instead of theirs" — and this isn't on
    // screen any more.
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
  });

  it('stands down when the conflict resolves itself', () => {
    const { view, target } = browseThenLoseTheWall();
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().showConfirm).toBe(true);

    // The other climber put back what was up when this browse began. There is
    // no longer anything to take.
    act(() => {
      wall.uuid = 'wall-climb-a';
      wall.name = 'What Was Up';
      view.rerender(drawerElement('member', target));
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
  });

  // The snapshot is taken the moment browsing begins, and at a cold start the
  // presence feed may not have delivered yet — so it reads null, which is what a
  // dark wall reads like too. The lighting's own server timestamp is what tells
  // the two apart.
  it('does not accuse a peer when the wall read merely arrived late', () => {
    CREW();
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    // The catch-up lands, carrying the climb that had been lit the whole time.
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    wall.sentAt = new Date(Date.now() - 10 * 60_000).toISOString();
    view.rerender(drawerElement('member', target));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('still asks when the climb the feed delivers was lit during the browse', () => {
    CREW();
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    wall.sentAt = new Date().toISOString();
    view.rerender(drawerElement('member', target));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(true);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('never asks a solo climber with no latch', () => {
    // With lighting on and nobody else here, a pinned preview's swipes commit —
    // there is no browse to have a "before" for, so the commit goes straight
    // through even though the wall is showing something else.
    wall.uuid = 'wall-climb-b';
    wall.name = 'Something Else';
    render(drawerElement('member', openTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().showConfirm).toBe(false);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });
});

// Until the drawer read board presence continuously it only knew the wall's
// climb in one situation — the accessory-bar preview, which arrives already
// knowing it is the lit one — so "On the wall" could never be said after any
// other navigation landed on it.
describe('PlayDrawer — reading the wall', () => {
  it('says On the wall when presence reports the displayed climb as lit', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    render(drawerElement('member', committedTargetFor(CLIMB)));

    expect(recorded.wallPill.at(-1)?.state).toBe('onWall');
    // The same face never twice: the pill owns the driver's avatar in this
    // state, so the lightbulb's holder pip stands down.
    expect(lastActionBarProps().showHolderBadge).toBe(false);
  });

  it('says nothing about a wall lit with a different climb', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = 'a-different-climb';
    wall.name = 'Their Project';
    render(drawerElement('member', committedTargetFor(CLIMB)));

    expect(recorded.wallPill.at(-1)?.state).not.toBe('onWall');
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });
});

// The auto-sender is already browse-safe (it keys on the committed queue item),
// but two paths in the drawer write frames directly off the DISPLAYED climb. Both
// would put a climb nobody committed on a board that is lit with the live one.
describe('PlayDrawer — the mirror toggle and the wall', () => {
  const connectBle = () => {
    ble.current = { isConnected: true, sendFramesToBoard: vi.fn(async () => true) };
    return ble.current;
  };

  it('mirrors a preview on screen only', () => {
    const bluetooth = connectBle();
    session.isShared = true;
    session.sessionId = 'session-1';
    render(drawerElement('member', openTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onMirror as () => void)();
    });

    // The board is showing the LIVE climb; a re-push here would swap it for the
    // one being browsed, which is the loudest possible reading of "flip the
    // picture I'm looking at".
    expect(bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
    // The drawer still mirrors — a dead toggle would be its own regression.
    expect(lastActionBarProps().isMirrored).toBe(true);
  });

  // The commit lights the queue item's own `climb.mirrored` (the auto-sender's
  // key), never the drawer's toggle. Left set, the toggle would keep the drawer
  // flipped while the wall came up straight — the one navigation that did not
  // reset drawer-local mirroring.
  it('drops a preview mirror on commit so the drawer matches the wall', () => {
    connectBle();
    session.isShared = true;
    session.sessionId = 'session-1';
    // The live climb the preview sits over; the drawer falls back to it once the
    // preview clears, which is the render the assertion below reads.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    render(drawerElement('member', openTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onMirror as () => void)();
    });
    expect(lastActionBarProps().isMirrored).toBe(true);

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(lastActionBarProps().isMirrored).toBe(false);
  });

  it('still re-pushes the live climb when nothing is pinned', () => {
    const bluetooth = connectBle();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onMirror as () => void)();
    });

    // The auto-sender keys off the queue item's own `climb.mirrored`, so without
    // this the LEDs would keep the old orientation.
    expect(bluetooth.sendFramesToBoard).toHaveBeenCalledWith(CLIMB.frames, true);
  });
});

describe('PlayDrawer — the anonymous joins', () => {
  it('hands its own viewer and sign-in prompt to the action bar', () => {
    const onSignIn = vi.fn();
    renderDrawer('anonymous', onSignIn);

    const props = lastActionBarProps();
    // Hardcoding `viewer="member"` here is invisible to every action-bar test,
    // which passes `viewer` in directly: it would restore the queue button, the
    // heart, the lightbulb, the ellipsis and the tick sheet for a signed-out
    // reader with the whole suite green.
    expect(props.viewer).toBe('anonymous');
    // The tick is the only conversion prompt on the surface. With the prop
    // dropped in the middle, the bar calls `onSignInPress?.()` on undefined and
    // the tap silently does nothing.
    expect(typeof props.onSignInPress).toBe('function');
    (props.onSignInPress as () => void)();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('passes the member viewer through unchanged', () => {
    renderDrawer('member');
    expect(lastActionBarProps().viewer).toBe('member');
  });

  it('writes nothing when a signed-out reader taps a similar climb', async () => {
    renderDrawer('anonymous');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      await onSimilarClimbPress(SIMILAR_CLIMB);
    });

    // Both halves matter. `addToQueue` is a queue a signed-out visitor cannot
    // carry anywhere; `setCurrentClimb` re-arms the BLE auto-sender, and the
    // browser export is the one surface where Web Bluetooth is mounted.
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    // It still swaps what the drawer shows — Similar Climbs is the best reason
    // a visitor has to keep looking, so a dead tap would be its own regression.
    expect((recorded.deferredSections.at(-1)?.climb as Climb).uuid).toBe(SIMILAR_CLIMB.uuid);
    // And because it IS drawn on the board, it still counts as a climb view —
    // the queue never sees it, so the drawer has to report it (issue #2202).
    expect(queueActions.noteClimbViewed).toHaveBeenCalledExactlyOnceWith(SIMILAR_CLIMB.uuid);
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
  });

  it('still queues and activates a similar climb for a member', async () => {
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      await onSimilarClimbPress(SIMILAR_CLIMB);
    });

    expect(queueActions.addToQueue).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('shows a signed-out reader no wall-state chrome at all', () => {
    renderDrawer('anonymous');
    // The anonymous drawer is ALWAYS a preview (that is what keeps the queue
    // untouched), so ungated wall chrome would put a "Browsing" pill, the
    // viewfinder brackets and a live commit button on every read-only open —
    // and that button's press is `setCurrentClimb`, the same queue write and
    // BLE re-arm the similar-climb guard above blocks.
    expect(recorded.wallPill).toHaveLength(0);
    expect(recorded.browseFrame).toBe(0);
    expect(lastActionBarProps().secondaryMode).toBe('actions');
  });

  it('gives a member previewing a climb the browse chrome and the commit row', () => {
    // The browse latch is "a preview whose navigation genuinely stays view-only",
    // which with no suggestion source means lightOnSwipe off.
    setSetting('lightOnSwipe', false);
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');
    expect(recorded.browseFrame).toBeGreaterThan(0);
    const props = lastActionBarProps();
    expect(props.secondaryMode).toBe('commit');
    expect(props.showBackToLive).toBe(true);
    expect(props.showPutOnWall).toBe(true);
    // No BLE link, no session, no known lit climb — the button must not promise
    // a lighting it cannot do.
    expect(props.commitLabel).toBe('setActive');
  });

  // The chrome's whole premise is that it never claims more than it can keep.
  // With lightOnSwipe ON and no suggestion source, `getSwipeNavigationTarget`
  // sends the next swipe through `setCurrentClimb` — the shared-queue write and
  // BLE re-arm — so a "Browsing / the wall stays where it is" pill and the
  // viewfinder brackets would be lying about the very next gesture. The COMMIT
  // ROW is the one piece that stays: the pinned climb still needs its
  // activation button (the old banner's "Set active" contract), and dropping it
  // here would strand the explicit Preview action with no way to promote.
  it('withholds the browse chrome — but not the commit row — from a preview whose next swipe would commit', () => {
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)?.state).not.toBe('browsing');
    expect(recorded.browseFrame).toBe(0);
    const props = lastActionBarProps();
    expect(props.secondaryMode).toBe('commit');
    expect(props.showPutOnWall).toBe(true);
    expect(props.commitLabel).toBe('setActive');
  });

  it('drops the latch when a member takes Back to live', () => {
    setSetting('lightOnSwipe', false);
    renderDrawer('member');

    act(() => {
      (lastActionBarProps().onBackToLive as () => void)();
    });

    // Purely local: the pinned preview is dropped and the drawer re-derives from
    // the committed queue head. Nothing is sent, nothing is written — Back to
    // live is an exit, not a commit, and wiring it to `handleSetActive` by
    // mistake would light the wall on the way OUT of browsing.
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
  });

  it('disarms the favourite query for a signed-out reader', () => {
    renderDrawer('anonymous');
    // `favorites` is `requireAuthenticated` server-side, so an armed query has
    // exactly one possible outcome on every anonymous open.
    expect(recorded.favoriteStatus.at(-1)?.enabled).toBe(false);
  });

  it('arms it for a member', () => {
    renderDrawer('member');
    expect(recorded.favoriteStatus.at(-1)?.enabled).toBe(true);
  });

  it('never paints the "Pick a climb" placeholder when the target already carries one', () => {
    renderDrawer('anonymous');
    // Counted across every commit, not just the last: the open target is applied
    // by an effect that runs after the first commit, so a pane seeded only there
    // shows the placeholder for one frame — a lie on a surface the visitor
    // reached by following a link to one specific climb.
    expect(recorded.panePlaceholder).toBe(0);
  });
});

// A pinned preview silences the wall: it is what `useMobilePlayback`'s `viewOnly`
// and the mirror re-push both gate on, and — with a suggestion source alongside
// it — what makes every onward swipe view-only regardless of `lightOnSwipe`. So
// how a preview ENDS is a wall-control question, and the angle change is the one
// exit a climber can reach without knowing the browse chrome exists. #4683
// removed it and solo climbers reported the board lighting only sometimes.
describe('PlayDrawer — an angle change and the pinned preview', () => {
  const SUGGESTION_SOURCE = {
    playlistUuid: 'list-1',
    activatedClimbUuid: CLIMB.uuid,
    boardKey: 'kilter:1:10:1,20',
    climbs: [CLIMB, SIMILAR_CLIMB],
  } as unknown as Props;

  /** A preview WITH a track — the shape whose swipes stay view-only on their own. */
  function trackedTargetFor(climb: Climb) {
    return {
      climb,
      options: {
        previewQueueItem: { uuid: 'queue-item-uuid', climb },
        playlistSuggestionSource: SUGGESTION_SOURCE,
      },
      nonce: 1,
    } as unknown as ReturnType<typeof openTargetFor>;
  }

  function elementAtAngle(angle: number, openTarget: ReturnType<typeof trackedTargetFor>) {
    return createElement(PlayDrawer, {
      presentation: 'pane' as const,
      viewer: 'member' as const,
      boardConfig: { ...BOARD_CONFIG, angle },
      openTarget,
      onOpenQueue: vi.fn(),
    });
  }

  it('drops a solo preview when the angle moves, so the next swipe drives the wall', () => {
    // A committed head to fall back to once the preview goes.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    // Same target object across both renders, so re-rendering doesn't re-run the
    // open effect and re-pin the preview from underneath the case.
    const target = trackedTargetFor(CLIMB);
    const view = render(elementAtAngle(40, target));

    // Preview + track: view-only, even though this climber never turned
    // `lightOnSwipe` off. The board stays on the committed climb.
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();

    view.rerender(elementAtAngle(45, target));

    // The angle moved and nobody is browsing with this climber, so the drawer is
    // back on the live climb and ordinary wall control returns.
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).toHaveBeenCalledTimes(1);
  });

  it('keeps a crew preview across an angle change', () => {
    // The other half of the rule: in a crew the preview IS where the climber is
    // living, and one tap on the angle pill must not throw away the climb they
    // were looking at or the track they were walking.
    session.isShared = true;
    session.sessionId = 'session-1';
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    const target = trackedTargetFor(CLIMB);
    const view = render(elementAtAngle(40, target));
    expect(lastActionBarProps().secondaryMode).toBe('commit');

    view.rerender(elementAtAngle(45, target));

    expect(lastActionBarProps().secondaryMode).toBe('commit');
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
  });
});
