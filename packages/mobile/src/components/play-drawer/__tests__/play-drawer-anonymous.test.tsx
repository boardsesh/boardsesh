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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  actionBar: [] as Props[],
  wallPill: [] as Props[],
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
  // The prefetch walk: these suites assert on the displayed board, not on
  // what is warmed ahead, so nothing is ahead.
  findUpcomingQueueItemsWithSuggestions: () => [],
  computeNavigationStateWithSuggestions: () => ({
    nextItem: null,
    prevItem: null,
    canNext: false,
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
vi.mock('../WallStateCallout', () => ({ WallStateCallout: () => null }));
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
vi.mock('../../playback/PlaybackControls', () => ({ PlaybackControls: () => null }));
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
  useQueueData: () => ({ queue: [], currentClimbQueueItem: null }),
  useQueueActions: () => queueActions,
  useQueueSessionId: () => ({ sessionId: null }),
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: (_boardName: string, _uuid: string | null, _angle: number, options?: Props) => {
    recorded.favoriteStatus.push(options ?? {});
    return { data: undefined };
  },
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
  useLightbulbControl: () => ({ lit: false, localConnected: false, pending: false, onPress: vi.fn() }),
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 100, boardHeight: 100, holdsData: [], imagesToHolds: {} }),
}));

// `play-drawer-navigation`, `play-drawer-layout`, `wall-state`,
// `boardsesh-grade-display` and `favorite-rollback` stay REAL — the wiring of
// those helpers into the render is exactly what this file exists to measure.

const { PlayDrawer } = await import('../PlayDrawer');
const { setSetting, resetAllSettings } = await import('../../../settings');

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

function renderDrawer(viewer: 'member' | 'anonymous', onSignIn?: () => void) {
  return render(
    createElement(PlayDrawer, {
      presentation: 'pane' as const,
      viewer,
      boardConfig: BOARD_CONFIG,
      openTarget: openTargetFor(CLIMB),
      onOpenQueue: vi.fn(),
      onSignIn,
    }),
  );
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

beforeEach(() => {
  vi.clearAllMocks();
  recorded.actionBar = [];
  recorded.wallPill = [];
  recorded.deferredSections = [];
  recorded.favoriteStatus = [];
  recorded.browseFrame = 0;
  recorded.panePlaceholder = 0;
  queueActions.addToQueue.mockResolvedValue('added');
  resetAllSettings();
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
