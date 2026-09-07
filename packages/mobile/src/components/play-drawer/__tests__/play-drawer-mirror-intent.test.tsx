// @vitest-environment jsdom
// #5217 — the wall's orientation follows the mirror toggle, and never outlives it.
//
// The drawer owns `isMirrored` locally and resets it to false at eight separate
// navigation sites. The provider cannot see any of those, so the drawer has to
// re-state the orientation on every climb change; without that, flipping a climb
// and coming back to it later would re-light it mirrored under a screen (and a
// button) showing it un-mirrored — the reported bug, in reverse.
//
// The provider half is pinned in `bluetooth-provider-wall-confirm.test.tsx`.
// This file renders the real PlayDrawer so the hand-off itself is covered.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  board: [] as Props[],
  headers: [] as Props[],
  switchOverlay: [] as Props[],
  actionBar: [] as Props[],
  deferredSections: [] as Props[],
  logAscent: [] as Props[],
  favoriteStatus: [] as Props[],
  playback: [] as Props[],
  angleSheet: [] as Props[],
}));
const bluetooth = vi.hoisted(() => ({
  context: null as unknown,
  setMirrorIntent: vi.fn(),
  clearMirrorIntent: vi.fn(),
}));
const queueState = vi.hoisted(() => ({
  queue: [] as unknown[],
  currentClimbQueueItem: null as unknown,
}));
// What the prefetch walk hands back, per case. Empty by default: most cases here
// assert on the displayed board, not on what is warmed ahead of it.
const prefetchWalk = vi.hoisted(() => ({ items: [] as unknown[] }));
const navigation = vi.hoisted(() => ({
  state: {
    nextItem: null as unknown,
    prevItem: null as unknown,
    canNext: false,
    canPrevious: false,
  },
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
// Navigation is driven per-case so a peek can be aimed at another board.
// `@boardsesh/board-config` and `lib/board-details` stay REAL: the resolver
// reads real layouts, sizes and hold placements, which is the whole question.
vi.mock('@boardsesh/play-view', () => ({
  findUpcomingQueueItemsWithSuggestions: () => prefetchWalk.items,
  computeNavigationStateWithSuggestions: () => navigation.state,
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
vi.mock('../DeferredBoard', () => ({
  DeferredBoard: (props: Props) => {
    recorded.board.push(props);
    return createElement('div', { 'data-testid': 'board' });
  },
}));
vi.mock('../SwitchBoardOverlay', () => ({
  SwitchBoardOverlay: (props: Props) => {
    recorded.switchOverlay.push(props);
    return createElement('div', { 'data-testid': 'switch-board-overlay' });
  },
}));
vi.mock('../PlayDrawerActionBar', () => ({
  PlayDrawerActionBar: (props: Props) => {
    recorded.actionBar.push(props);
    return createElement('div', { 'data-testid': 'action-bar' });
  },
}));
vi.mock('../DeferredSections', () => ({
  DeferredSections: (props: Props) => {
    recorded.deferredSections.push(props);
    return createElement('div', { 'data-testid': 'deferred-sections' });
  },
}));
vi.mock('../../LogAscentSheet', () => ({
  LogAscentSheet: (props: Props) => {
    recorded.logAscent.push(props);
    return createElement('div', { 'data-testid': 'log-ascent' });
  },
}));
vi.mock('../WallStatePill', () => ({ WallStatePill: () => null }));
vi.mock('../WallStateCallout', () => ({ WallStateCallout: () => null }));
vi.mock('../BrowseFrameOverlay', () => ({ BrowseFrameOverlay: () => null }));
vi.mock('../PanePlaceholder', () => ({ PanePlaceholder: () => null }));
vi.mock('../BoardRenderUnavailable', () => ({ BoardRenderUnavailable: () => null }));
vi.mock('../../playback/PlaybackControls', () => ({ PlaybackControls: () => null }));
vi.mock('../PlayDrawerHeader', () => ({
  LivePlayDrawerHeader: (props: Props) => {
    recorded.headers.push(props);
    return null;
  },
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current, peek }: { current?: ReactNode; peek?: ReactNode }) =>
    createElement('div', null, current, peek),
}));
vi.mock('../AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: Props) => {
    recorded.angleSheet.push(props);
    return null;
  },
}));
vi.mock('../../ClimbActionsSheet', () => ({ ClimbActionsSheet: () => null }));
vi.mock('../../AddBetaVideoSheet', () => ({ AddBetaVideoSheet: () => null }));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => queueState,
  useQueueActions: () => ({
    setCurrentClimb: vi.fn(),
    nextClimb: vi.fn(),
    previousClimb: vi.fn(),
    addToQueue: vi.fn(async () => 'added'),
    noteClimbViewed: vi.fn(),
  }),
  useQueueSessionId: () => ({ sessionId: null }),
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => bluetooth.context,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: (boardName: string, uuid: string | null, angle: number) => {
    recorded.favoriteStatus.push({ boardName, uuid, angle });
    return { data: undefined };
  },
}));
vi.mock('../../../hooks/use-display-grade', () => ({ useDisplayGrade: () => ({ boardseshActive: false }) }));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn() }));
vi.mock('../../../hooks/use-mounted-on-first-open', () => ({ useMountedOnFirstOpen: (open: boolean) => open }));
vi.mock('../use-mobile-playback', () => ({
  useMobilePlayback: (args: Props) => {
    recorded.playback.push(args);
    return { isAnimatable: false };
  },
}));
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

const { PlayDrawer } = await import('../PlayDrawer');

const BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

function climb(uuid: string, frames: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames,
    difficulty: '7A',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
  } as unknown as Climb;
}

const CLIMB_A = climb('AAAA0000000000000000000000000001', 'p1145r15');
const CLIMB_B = climb('BBBB0000000000000000000000000002', 'p2145r15');

function queueItem(c: Climb, uuid: string): ClimbQueueItem {
  return { uuid, climb: c } as unknown as ClimbQueueItem;
}

function renderDrawer() {
  return render(
    createElement(PlayDrawer, {
      presentation: 'pane' as const,
      boardConfig: BOARD,
      openTarget: null,
      onOpenQueue: vi.fn(),
      onSwitchBoard: vi.fn(),
    }),
  );
}

/** Fire the action bar's mirror button, the way a tap would. */
function tapMirror() {
  const props = recorded.actionBar.at(-1);
  if (!props) throw new Error('PlayDrawerActionBar never rendered');
  act(() => {
    (props.onMirror as () => void)();
  });
}

function mirrorIntentCalls(): [string, boolean][] {
  return bluetooth.setMirrorIntent.mock.calls as [string, boolean][];
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.board = [];
  recorded.headers = [];
  recorded.switchOverlay = [];
  recorded.actionBar = [];
  recorded.deferredSections = [];
  recorded.logAscent = [];
  recorded.favoriteStatus = [];
  recorded.playback = [];
  recorded.angleSheet = [];
  queueState.queue = [];
  queueState.currentClimbQueueItem = null;
  navigation.state = { nextItem: null, prevItem: null, canNext: false, canPrevious: false };
  prefetchWalk.items = [];
  bluetooth.setMirrorIntent = vi.fn();
  bluetooth.clearMirrorIntent = vi.fn();
  bluetooth.context = {
    isConnected: true,
    setMirrorIntent: bluetooth.setMirrorIntent,
    clearMirrorIntent: bluetooth.clearMirrorIntent,
    sendFramesToBoard: vi.fn(),
  };
});

describe('PlayDrawer mirror intent (#5217)', () => {
  it('states the un-mirrored orientation for the climb it opens on', () => {
    queueState.currentClimbQueueItem = queueItem(CLIMB_A, 'queue-a');
    renderDrawer();

    expect(mirrorIntentCalls()).toContainEqual([CLIMB_A.uuid, false]);
  });

  it('asks for the mirrored orientation when the flip button is tapped', () => {
    queueState.currentClimbQueueItem = queueItem(CLIMB_A, 'queue-a');
    renderDrawer();

    tapMirror();

    expect(mirrorIntentCalls().at(-1)).toEqual([CLIMB_A.uuid, true]);
  });

  it('re-states un-mirrored for the next climb, so a flip cannot outlive the navigation', () => {
    // The regression: the drawer resets its toggle on navigation, but if it
    // stays silent the provider keeps the old intent and re-lights the mirror
    // the next time this climb comes round.
    queueState.currentClimbQueueItem = queueItem(CLIMB_A, 'queue-a');
    const { rerender } = renderDrawer();

    tapMirror();
    expect(mirrorIntentCalls().at(-1)).toEqual([CLIMB_A.uuid, true]);

    queueState.currentClimbQueueItem = queueItem(CLIMB_B, 'queue-b');
    act(() => {
      rerender(
        createElement(PlayDrawer, {
          presentation: 'pane' as const,
          boardConfig: BOARD,
          openTarget: null,
          onOpenQueue: vi.fn(),
          onSwitchBoard: vi.fn(),
        }),
      );
    });

    expect(mirrorIntentCalls().at(-1)).toEqual([CLIMB_B.uuid, false]);
  });

  it('forgets the flip when the drawer goes away', () => {
    // On iPhone the drawer is a route. The current climb keeps moving after it
    // closes (Live Activity next/prev, a party peer), so an intent left behind
    // would re-light a remembered mirror with no button showing it.
    queueState.currentClimbQueueItem = queueItem(CLIMB_A, 'queue-a');
    const { unmount } = renderDrawer();

    tapMirror();
    expect(mirrorIntentCalls().at(-1)).toEqual([CLIMB_A.uuid, true]);
    expect(bluetooth.clearMirrorIntent).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });

    expect(bluetooth.clearMirrorIntent).toHaveBeenCalled();
  });

  it('states the orientation even while disconnected, so a flip survives taking the wall', () => {
    // Recording the intent is free; the auto-sender only acts on it once a link
    // exists. Gating on isConnected lost the flip when the lightbulb re-took
    // the wall afterwards.
    bluetooth.context = {
      isConnected: false,
      setMirrorIntent: bluetooth.setMirrorIntent,
      clearMirrorIntent: bluetooth.clearMirrorIntent,
      sendFramesToBoard: vi.fn(),
    };
    queueState.currentClimbQueueItem = queueItem(CLIMB_A, 'queue-a');
    renderDrawer();

    tapMirror();

    expect(mirrorIntentCalls().at(-1)).toEqual([CLIMB_A.uuid, true]);
  });
});
