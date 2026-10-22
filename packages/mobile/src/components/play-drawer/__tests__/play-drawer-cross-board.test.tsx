// @vitest-environment jsdom
// #5099 — the drawer draws the climb it is SHOWING, on the board that climb
// belongs to.
//
// Browse the Kilter Homewall (layout 8), switch the selected board to the
// Original 12x12 (layout 1), and the climb that carries over as
// `currentClimbQueueItem` is still a Homewall climb. Rendered against the
// 12x12's placements none of its hold ids exist, the renderer drops every hold
// and returns Ok, and the board comes out as a wash over bare art — no throw,
// nothing logged.
//
// The resolver is unit-tested next to itself (`lib/boards/__tests__`); this file
// exists because a sound resolver nobody calls leaves the bug exactly where it
// was. It renders the real PlayDrawer and asserts the joins: which board reaches
// DeferredBoard, whether the switch gate is up, which board "Switch board"
// targets, and that a neighbouring climb from another board is not peeked under
// the current art.
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render as renderInitial, act } from '@testing-library/react';
import { createElement, useEffect, useRef, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { LayoutChangeEvent } from 'react-native';
import { clearOpeningLayoutCache } from '../opening-layout-cache';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  board: [] as Props[],
  boardMounts: 0,
  boardUnmounts: 0,
  headers: [] as Props[],
  switchOverlay: [] as Props[],
  actionBar: [] as Props[],
  deferredSections: [] as Props[],
  playbackFrames: [] as Array<string | null>,
  logAscent: [] as Props[],
  favoriteStatus: [] as Props[],
  playback: [] as Props[],
  angleSheet: [] as Props[],
  lightbulb: [] as { canRelay?: boolean; onRelayToHolder?: () => void }[],
  scroll: [] as Props[],
  firstScreen: [] as Props[],
  sectionsSheet: [] as Props[],
  actionsMenu: [] as Props[],
  pinnedSheets: new Map<string, Props>(),
  scrollGate: [] as Props[],
  headerLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
  boardLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
}));
const viewport = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1 }));
// Web: the content gesture skips the native scroll-intent composition.
const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' }));
const setCurrentClimb = vi.hoisted(() => vi.fn());
const toggleFavorite = vi.hoisted(() => vi.fn());
const dismissGestureRef = vi.hoisted(() => ({ current: undefined as unknown }));
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

// What the playback hook reports: a static climb unless a case animates one.
const playbackState = vi.hoisted(() => ({ isAnimatable: false, currentFrameString: '' }));

const drawerSections = vi.hoisted(() => ({
  defaults: {
    activeHolds: false,
    logbook: true,
    climberLogs: true,
    setterNotes: true,
    betaVideos: true,
    boardseshGrade: true,
    community: true,
    similarClimbs: true,
  },
  sections: {
    activeHolds: false,
    logbook: true,
    climberLogs: true,
    setterNotes: true,
    betaVideos: true,
    boardseshGrade: true,
    community: true,
    similarClimbs: true,
  },
  ready: true,
}));
vi.mock('../../../lib/play-drawer-sections-preference', () => {
  const order = [
    'activeHolds',
    'logbook',
    'climberLogs',
    'setterNotes',
    'betaVideos',
    'boardseshGrade',
    'community',
    'similarClimbs',
  ];
  return {
    DEFAULT_PLAY_DRAWER_SECTIONS: drawerSections.defaults,
    DEFAULT_PLAY_DRAWER_SECTION_ORDER: order,
    PLAY_DRAWER_SECTION_IDS: order,
    usePlayDrawerSectionsPreference: () => ({
      sections: drawerSections.sections,
      order,
      ready: drawerSections.ready,
      setSection: vi.fn(),
      setAll: vi.fn(),
    }),
  };
});
vi.mock('../use-deliberate-scroll-gesture', () => ({
  useDeliberateScrollGesture: (options: Props) => {
    recorded.scrollGate.push(options);
    return {};
  },
}));
vi.mock('../PlayDrawerSectionsSheet', () => ({
  PlayDrawerSectionsSheet: (props: Props) => {
    recorded.sectionsSheet.push(props);
    return null;
  },
}));

// --- Host platform -----------------------------------------------------------
vi.mock('react-native', () => ({
  View: ({
    children,
    onLayout,
    style,
    testID,
  }: {
    children?: ReactNode;
    onLayout?: (event: LayoutChangeEvent) => void;
    style?: Props[] | Props;
    testID?: string;
  }) => {
    const firstScreenStyle = Array.isArray(style)
      ? style.find((entry) => entry && 'height' in entry && 'paddingTop' in entry)
      : undefined;
    if (firstScreenStyle) recorded.firstScreen.push(firstScreenStyle);
    if (onLayout && style && !Array.isArray(style) && 'marginHorizontal' in style) recorded.boardLayout = onLayout;
    else if (onLayout && !style) recorded.headerLayout = onLayout;
    if (testID === 'play-drawer-controls-region') {
      const flattened = Object.assign({}, ...[style].flat(10).filter(Boolean)) as Props;
      return createElement(
        'div',
        { 'data-testid': testID, 'data-min-height': flattened.minHeight, 'data-z-index': flattened.zIndex },
        children,
      );
    }
    return createElement('div', null, children);
  },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: {
    get OS() {
      return platform.OS;
    },
    select: (spec: Record<string, unknown>) => spec[platform.OS] ?? spec.default,
  },
  PixelRatio: { get: () => 3 },
  useWindowDimensions: () => viewport,
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
  ScrollView: ({ children, ...props }: { children?: ReactNode } & Props) => {
    recorded.scroll.push(props);
    return createElement('div', null, children);
  },
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  // Native platforms compose the dismiss and scroll-intent gestures.
  Gesture: { Simultaneous: (...gestures: unknown[]) => ({ gestures }) },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => undefined,
  useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
  runOnJS: (fn: unknown) => fn,
}));
vi.mock('expo-router', () => ({ router: { dismiss: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'random-uuid' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// The drawer reads the ACTIVE board — not the one it is drawing — to decide what
// a forward swipe may land on (#5099, selection half). That is a React Query
// hook, and this file mounts PlayDrawer with no QueryClientProvider. These cases
// are about the RENDER board and drive navigation through the mock below, so the
// answer here is inert; it just has to be the selected 12x12 rather than a
// throw. Literal instead of a reference to TWELVE_BY_TWELVE because vi.mock
// factories hoist above that const.
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({
    data: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
    isPending: false,
  }),
}));

// --- Shared packages ---------------------------------------------------------
// Navigation is driven per-case so a peek can be aimed at another board.
// `@boardsesh/board-config` and `lib/board-details` stay REAL: the resolver
// reads real layouts, sizes and hold placements, which is the whole question.
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  // Real: PlayDrawer calls this to resolve the navigation source (#5403); every
  // case here drives navigation through the canned `navigation.state` above, so
  // it only ever sees a null preview item and returns the (irrelevant) source.
  resolveNavigationSuggestionSource: (await importOriginal<typeof import('@boardsesh/play-view')>())
    .resolveNavigationSuggestionSource,
  findUpcomingQueueItemsWithSuggestions: () => prefetchWalk.items,
  computeNavigationTargetsWithSuggestions: () => navigation.state,
  countRemainingQueueItemsWithSuggestions: () => 0,
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
    useEffect(() => {
      recorded.boardMounts += 1;
      return () => {
        recorded.boardUnmounts += 1;
      };
    }, []);
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
vi.mock('../DeferredSections', async () => {
  const { useContext } = await import('react');
  const { PlaybackFrameContext } = await import('../playback-frame-context');
  return {
    DeferredSections: (props: Props) => {
      recorded.deferredSections.push(props);
      // What Active holds would read: the playback frame comes by context, not props.
      recorded.playbackFrames.push(useContext(PlaybackFrameContext));
      return createElement('div', { 'data-testid': 'deferred-sections' });
    },
  };
});
vi.mock('../../LogAscentSheet', () => ({
  LogAscentSheet: (props: Props) => {
    recorded.logAscent.push(props);
    return createElement('div', { 'data-testid': 'log-ascent' });
  },
}));
vi.mock('../WallStatePill', () => ({ WallStatePill: () => null }));
vi.mock('../WallStateCallout', () => ({ WallStateCallout: () => null }));
vi.mock('../PanePlaceholder', () => ({ PanePlaceholder: () => null }));
vi.mock('../BoardRenderUnavailable', () => ({ BoardRenderUnavailable: () => null }));
vi.mock('../../playback/PlaybackControls', () => ({ PlaybackControls: () => null }));
vi.mock('../PlayDrawerStatusBarScrim', () => ({ PlayDrawerStatusBarScrim: () => null }));
vi.mock('../PlayDrawerHeader', () => ({
  useLivePlayDrawerHeaderModel: (props: Props) =>
    props.climb
      ? {
          headerProps: props,
          reduceMotion: false,
          layoutFingerprint: JSON.stringify(props.climb),
        }
      : null,
  PreparedPlayDrawerHeader: ({ model, ...props }: { model: { headerProps: Props } } & Props) => {
    recorded.headers.push({ ...model.headerProps, ...props });
    return null;
  },
  LivePlayDrawerHeader: (props: Props) => {
    recorded.headers.push(props);
    return null;
  },
}));
// The workout position (#5379) has its own suites; here only that each header
// is handed the label for ITS queue item.
vi.mock('../use-workout-stage-label', () => ({
  useWorkoutQueueUuids: () => [],
  useWorkoutStageLabel: (_run: unknown, _queueUuids: unknown, queueItemUuid: string | null | undefined) =>
    queueItemUuid ? `stage:${queueItemUuid}` : null,
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current, previous, next }: { current?: ReactNode; previous?: ReactNode; next?: ReactNode }) =>
    createElement('div', null, previous, current, next),
}));
vi.mock('../AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: Props) => {
    recorded.angleSheet.push(props);
    return null;
  },
}));
// The player's ⋯. Its rows have their own suite; here only what the drawer
// hands it: the board, the gate and the player's own sheet openers.
vi.mock('../PlayDrawerActionsMenu', () => ({
  PlayDrawerActionsMenu: (props: Props) => {
    recorded.actionsMenu.push(props);
    return null;
  },
}));
// The lost-hold banner and the Remix handoff behind it, stubbed like every
// other collaborator above. Both reach native modules this suite has no runtime
// for: the banner through the design-system Button, the handoff through Sentry.
vi.mock('../LostHoldsBanner', () => ({ LostHoldsBanner: () => null }));
vi.mock('../../create-climb/use-create-climb-navigation', () => ({
  useCreateClimbNavigation: () => ({ openRemix: vi.fn(), openEdit: vi.fn(), resetActionGuard: vi.fn() }),
}));
vi.mock('../../AddBetaVideoSheet', () => ({
  AddBetaVideoSheet: (props: Props) => {
    recorded.pinnedSheets.set('beta', props);
    return null;
  },
}));
vi.mock('../../AddToPlaylistSheet', () => ({
  AddToPlaylistSheet: (props: Props) => {
    recorded.pinnedSheets.set('playlist', props);
    return null;
  },
}));
vi.mock('../logbook/LogbookFullSheet', () => ({ LogbookFullSheet: () => null }));
vi.mock('../ClimberLogsSheet', () => ({ ClimberLogsSheet: () => null }));
vi.mock('../../report-climb/ReportClimbSheet', () => ({
  ReportClimbSheet: (props: Props) => {
    recorded.pinnedSheets.set('report', props);
    return null;
  },
}));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../queue-control/RestTimerPillHost', () => ({ RestTimerPillHost: () => null }));
vi.mock('../../ChromeIconButton', () => ({
  ChromeIconButton: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }),
  useChromeIconButtonSize: () => 44,
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => queueState,
  useQueueActions: () => ({
    setCurrentClimb,
    nextClimb: vi.fn(),
    previousClimb: vi.fn(),
    addToQueue: vi.fn(async () => 'added'),
  }),
  useQueueSessionId: () => ({ sessionId: null }),
  // Solo for every case here: the crew gate is off, so gestures commit as they
  // always have and the board question stays the only variable.
  useIsSharedSession: () => false,
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  // The preview angle re-anchor asks for the climb at the live angle; nothing
  // here pins a preview at another angle, so it never resolves.
  useClimb: () => ({ data: undefined }),
  useProfile: () => ({ data: undefined }),
  useToggleFavorite: () => ({ mutate: toggleFavorite }),
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
    return { ...playbackState };
  },
}));
vi.mock('../use-drawer-dismiss-gesture', () => ({
  useDrawerDismissGesture: () => ({
    gesture: { enabled: () => ({}) },
    translateY: { value: 0 },
    gestureRef: dismissGestureRef,
  }),
}));
vi.mock('../use-play-drawer-wake-lock', () => ({ usePlayDrawerWakeLock: () => undefined }));
// The lit-climb read reaches board presence → the ws client → secure storage;
// none of that is under test here, and the wall is dark for every case.
vi.mock('../use-wall-climb', () => ({ useWallClimb: () => ({ uuid: null, name: null, sentAt: null }) }));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: { canRelay?: boolean; onRelayToHolder?: () => void }) => {
    recorded.lightbulb.push(options);
    return { lit: false, localConnected: false, pending: false, onPress: vi.fn() };
  },
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));

const { PlayDrawer } = await import('../PlayDrawer');
const { setSetting, resetAllSettings } = await import('../../../settings');

// The Original 12x12 the climber switched TO.
const TWELVE_BY_TWELVE = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

function climbOn(boardType: string, layoutId: number, angle: number, uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1145r15',
    difficulty: '7A',
    boardType,
    layoutId,
    angle,
  } as unknown as Climb;
}

function queueItem(climb: Climb, uuid: string): ClimbQueueItem {
  return { uuid, climb } as unknown as ClimbQueueItem;
}

// A smaller wall on the SAME Kilter layout, so a climb set on the 12x12 needs
// an upsize rather than another board.
const SMALL_TWELVE_LAYOUT = { boardName: 'kilter', layoutId: 1, sizeId: 14, setIds: '1,20', angle: 40 };

// A Kilter Homewall climb (layout 8) — the board the climber was browsing.
const HOMEWALL_CLIMB = climbOn('kilter', 8, 30, 'HOMEWALL00000000000000000000AAAA');
// A climb that genuinely belongs to the selected 12x12.
const TWELVE_CLIMB = climbOn('kilter', 1, 40, 'TWELVE0000000000000000000000BBBB');

function renderDrawer(onSwitchBoard?: (boardConfig?: unknown) => void) {
  return render(
    createElement(PlayDrawer, {
      presentation: 'pane' as const,
      boardConfig: TWELVE_BY_TWELVE,
      openTarget: null,
      onOpenQueue: vi.fn(),
      onSwitchBoard,
    }),
  );
}

function lastBoardProps(): Props {
  const props = recorded.board.at(-1);
  if (!props) throw new Error('DeferredBoard never rendered');
  return props;
}

const openingFrames = new Map<number, FrameRequestCallback>();
let nextOpeningFrame = 0;
function flushOpeningFrame() {
  const scheduled = [...openingFrames.values()];
  openingFrames.clear();
  act(() => scheduled.forEach((callback) => callback(0)));
}
function render(...args: Parameters<typeof renderInitial>) {
  const rendered = renderInitial(...args);
  flushOpeningFrame();
  return rendered;
}

beforeEach(() => {
  clearOpeningLayoutCache();
  viewport.width = 390;
  viewport.height = 844;
  viewport.fontScale = 1;
  openingFrames.clear();
  nextOpeningFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    openingFrames.set(++nextOpeningFrame, callback);
    return nextOpeningFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => openingFrames.delete(handle));
  vi.clearAllMocks();
  recorded.board = [];
  recorded.boardMounts = 0;
  recorded.boardUnmounts = 0;
  recorded.headers = [];
  recorded.switchOverlay = [];
  recorded.actionBar = [];
  recorded.deferredSections = [];
  recorded.playbackFrames = [];
  recorded.scrollGate = [];
  recorded.logAscent = [];
  recorded.favoriteStatus = [];
  recorded.playback = [];
  recorded.angleSheet = [];
  recorded.lightbulb = [];
  recorded.scroll = [];
  recorded.headerLayout = undefined;
  recorded.boardLayout = undefined;
  recorded.firstScreen = [];
  recorded.sectionsSheet = [];
  recorded.actionsMenu = [];
  recorded.pinnedSheets.clear();
  playbackState.isAnimatable = false;
  playbackState.currentFrameString = '';
  platform.OS = 'web';
  drawerSections.sections = { ...drawerSections.defaults };
  drawerSections.ready = true;
  queueState.queue = [];
  queueState.currentClimbQueueItem = null;
  navigation.state = { nextItem: null, prevItem: null, canNext: false, canPrevious: false };
  prefetchWalk.items = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('PlayDrawer relay board compatibility', () => {
  it('forwards the claimed dismiss gesture ref', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();

    expect(lastBoardProps().dismissRef).toBe(dismissGestureRef);
  });

  it.each([
    { climb: HOMEWALL_CLIMB, canRelay: false },
    { climb: TWELVE_CLIMB, canRelay: true },
  ])('allows relay=$canRelay for a preview on layout $climb.layoutId', ({ climb, canRelay }) => {
    const previewQueueItem = queueItem(climb, 'preview-item');
    render(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: TWELVE_BY_TWELVE,
        openTarget: { climb, options: { previewQueueItem }, nonce: 1 },
        onOpenQueue: vi.fn(),
        // No explicit mismatch flag or overlay callback: the climb determines fit.
      }),
    );

    const control = recorded.lightbulb.at(-1);
    expect(control?.canRelay).toBe(canRelay);
    act(() => control?.onRelayToHolder?.());
    if (canRelay) expect(setCurrentClimb).toHaveBeenCalledWith(previewQueueItem, expect.anything());
    else expect(setCurrentClimb).not.toHaveBeenCalled();
  });
});

describe('PlayDrawer opening layout', () => {
  it('keeps the interactive board mounted from the first commit through queue broadcasts and new targets', () => {
    const initialItem = queueItem(TWELVE_CLIMB, 'preview-twelve');
    const target = { climb: TWELVE_CLIMB, options: { previewQueueItem: initialItem }, nonce: 1 };
    const onOpenQueue = vi.fn();
    const element = (openTarget: typeof target) =>
      createElement(PlayDrawer, {
        presentation: 'pane',
        boardConfig: TWELVE_BY_TWELVE,
        onOpenQueue,
        openTarget,
      });
    const view = renderInitial(element(target));
    const initialBoard = view.getByTestId('board');
    const firstBoardProps = recorded.board[0];
    expect(firstBoardProps).toMatchObject({
      open: true,
      currentFrames: TWELVE_CLIMB.frames,
      enabled: true,
      dismissRef: dismissGestureRef,
    });
    expect(firstBoardProps.onSwipeNext).toBeTypeOf('function');
    expect(firstBoardProps.onSwipePrevious).toBeTypeOf('function');
    expect(firstBoardProps.onResetZoomReady).toBeTypeOf('function');
    expect(firstBoardProps.pager).toBeTruthy();
    expect(firstBoardProps.boardRenderData).toBeTruthy();
    expect(recorded.boardMounts).toBe(1);
    expect(recorded.favoriteStatus).toHaveLength(0);

    flushOpeningFrame();
    expect(recorded.favoriteStatus.length).toBeGreaterThan(0);
    expect(view.getByTestId('board')).toBe(initialBoard);
    expect(lastBoardProps().pager).toBe(firstBoardProps.pager);

    queueState.queue = [queueItem(TWELVE_CLIMB, 'broadcast-twelve')];
    view.rerender(element(target));
    expect(lastBoardProps().pager).toBe(firstBoardProps.pager);
    expect(view.getByTestId('board')).toBe(initialBoard);

    const newClimb = { ...TWELVE_CLIMB, uuid: 'replacement-climb', frames: 'p1200r15' };
    const replacement = {
      climb: newClimb,
      options: { previewQueueItem: queueItem(newClimb, 'replacement-item') },
      nonce: 2,
    };
    view.rerender(element(replacement));
    expect(lastBoardProps().currentFrames).toBe(newClimb.frames);
    expect(lastBoardProps().pager).toBe(firstBoardProps.pager);
    expect(view.getByTestId('board')).toBe(initialBoard);
    expect(recorded.boardMounts).toBe(1);
    expect(recorded.boardUnmounts).toBe(0);
    expect(setCurrentClimb).not.toHaveBeenCalled();
    view.unmount();
    expect(recorded.boardUnmounts).toBe(1);
  });

  it.each(['viewport-first', 'headers-first'])('keeps the board mounted through layout callbacks (%s)', (order) => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const rendered = renderInitial(
      createElement(PlayDrawer, {
        presentation: 'pane',
        boardConfig: TWELVE_BY_TWELVE,
        onOpenQueue: vi.fn(),
        openTarget: null,
      }),
    );
    const initialBoard = rendered.getByTestId('board');
    expect(lastBoardProps()).toMatchObject({ open: true, currentFrames: TWELVE_CLIMB.frames });
    expect(recorded.favoriteStatus).toHaveLength(0);
    flushOpeningFrame();
    expect(recorded.favoriteStatus.length).toBeGreaterThan(0);
    const viewportLayout = recorded.scroll.at(-1)?.onLayout as (event: LayoutChangeEvent) => void;
    const headerLayout = recorded.headerLayout;
    const logbookLayout = recorded.deferredSections.at(-1)?.onFirstSectionHeaderLayout as (height: number) => void;
    if (!headerLayout) throw new Error('Title header is not measured');
    const event = (height: number) =>
      ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } }) as LayoutChangeEvent;
    const firstMeasurement =
      order === 'viewport-first' ? () => viewportLayout(event(844)) : () => headerLayout(event(70));
    const secondMeasurement =
      order === 'viewport-first' ? () => headerLayout(event(70)) : () => viewportLayout(event(844));

    act(firstMeasurement);
    expect(rendered.getByTestId('board')).toBe(initialBoard);
    act(() => logbookLayout(44));
    expect(rendered.getByTestId('board')).toBe(initialBoard);
    act(secondMeasurement);
    expect(rendered.getByTestId('board')).toBe(initialBoard);

    act(() => viewportLayout(event(600)));
    expect(rendered.getByTestId('board')).toBe(initialBoard);
    expect(recorded.scroll.at(-1)).toMatchObject({
      showsVerticalScrollIndicator: false,
      showsHorizontalScrollIndicator: false,
      nestedScrollEnabled: true,
    });
  });

  it('reuses measured board geometry on a matching open and invalidates it for font scale', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const first = renderDrawer();
    const layout = (width: number, height: number) =>
      ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }) as LayoutChangeEvent;
    act(() => {
      (recorded.scroll.at(-1)?.onLayout as (event: LayoutChangeEvent) => void)(layout(390, 844));
      recorded.headerLayout?.(layout(390, 70));
      (recorded.deferredSections.at(-1)?.onFirstSectionHeaderLayout as (height: number) => void)(44);
      recorded.boardLayout?.(layout(358, 650));
    });
    first.unmount();
    const same = renderInitial(
      createElement(PlayDrawer, {
        presentation: 'pane',
        boardConfig: TWELVE_BY_TWELVE,
        onOpenQueue: vi.fn(),
        openTarget: null,
      }),
    );
    expect(lastBoardProps().containerSize).toEqual({ width: 358, height: 650 });
    expect(same.getByTestId('board')).toBeTruthy();
    same.unmount();
    viewport.fontScale = 1.2;
    const changed = renderInitial(
      createElement(PlayDrawer, {
        presentation: 'pane',
        boardConfig: TWELVE_BY_TWELVE,
        onOpenQueue: vi.fn(),
        openTarget: null,
      }),
    );
    expect(lastBoardProps().containerSize).toBeUndefined();
    expect(changed.getByTestId('board')).toBeTruthy();
  });
});

describe('PlayDrawer draws the climb on its own board (#5099)', () => {
  it('renders a carried-over Homewall climb on the Homewall, not on the selected 12x12', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    // Layout 8 is the Homewall. Rendering it under layout 1's placements is the
    // bug: every hold id is dropped and the board comes out as a plain wash.
    expect(board.layoutId).toBe(8);
    expect(board.boardName).toBe('kilter');
    expect(board.sizeId).not.toBe(TWELVE_BY_TWELVE.sizeId);
    expect(board.currentFrames).toBe(HOMEWALL_CLIMB.frames);
  });

  it('raises the switch-board gate for a carried-over climb, with no override in play', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    // `boardMismatch` is NOT passed: nobody set a board override — the drawer has
    // to notice the disagreement from the climb itself.
    renderDrawer(vi.fn());

    expect(recorded.switchOverlay).not.toHaveLength(0);
    // Not the bare brand: "Switch to Kilter" reads as a no-op on a Kilter board,
    // and Homewall vs Original is the whole of #5099.
    expect(recorded.switchOverlay.at(-1)?.boardLabel).toBe('Kilter Board Homewall');
  });

  it('sends "Switch board" to the CLIMB board, so the host has something to switch to', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    const onSwitchBoard = vi.fn();
    renderDrawer(onSwitchBoard);

    act(() => {
      (recorded.switchOverlay.at(-1)?.onSwitchBoard as () => void)();
    });

    // Without the board, the host reads its (empty) override, returns early, and
    // the only button on the scrim does nothing.
    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
    expect(onSwitchBoard.mock.calls[0][0]).toMatchObject({ boardName: 'kilter', layoutId: 8, angle: 30 });
  });

  it('leaves a climb from the selected board completely alone', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    expect(board.boardName).toBe(TWELVE_BY_TWELVE.boardName);
    expect(board.layoutId).toBe(TWELVE_BY_TWELVE.layoutId);
    expect(board.sizeId).toBe(TWELVE_BY_TWELVE.sizeId);
    expect(board.setIds).toBe(TWELVE_BY_TWELVE.setIds);
    // Nothing to switch to — the controls stay live.
    expect(recorded.switchOverlay).toHaveLength(0);
  });

  it('draws a climb that needs a bigger wall on the bigger wall, with no switch prompt', () => {
    // Same board name and layout, one size up. There is no other board to
    // switch TO — the host matches owned boards by name + layout, so a prompt
    // here would "switch" to the board the climber is already on and never
    // clear. Playlist rows already render these without a prompt.
    queueState.currentClimbQueueItem = queueItem(
      { ...TWELVE_CLIMB, compatibleSizeIds: [10] } as unknown as Climb,
      'queue-upsized',
    );
    render(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: SMALL_TWELVE_LAYOUT,
        openTarget: null,
        onOpenQueue: vi.fn(),
        onSwitchBoard: vi.fn(),
      }),
    );

    const board = lastBoardProps();
    expect(board.layoutId).toBe(1);
    expect(board.sizeId).toBe(10);
    expect(recorded.switchOverlay).toHaveLength(0);
    // Same board, so the wall can still be driven.
    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(false);
  });

  it('uses the incoming Woods board for the swipe header while Kilter stays current', () => {
    const woods = {
      ...TWELVE_CLIMB,
      uuid: 'woods-peek',
      boardType: 'woods',
      layoutId: 1,
      frames: 'p0r4p1r3',
      compatibleSizeIds: [1],
      characteristics: [],
    };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = { nextItem: queueItem(woods, 'queue-woods'), prevItem: null, canNext: true, canPrevious: false };
    renderDrawer(vi.fn());
    const header = recorded.headers.find((props) => (props.climb as Climb).uuid === 'woods-peek');
    expect(header).toMatchObject({ boardName: 'woods', layoutId: 1 });
  });

  it('hands the current and neighbour headers their own workout position', () => {
    const woods = { ...TWELVE_CLIMB, uuid: 'woods-peek', boardType: 'woods', layoutId: 1, characteristics: [] };
    const previous = { ...TWELVE_CLIMB, uuid: 'twelve-prev' };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = {
      nextItem: queueItem(woods, 'queue-woods'),
      prevItem: queueItem(previous, 'queue-prev'),
      canNext: true,
      canPrevious: true,
    };
    renderDrawer(vi.fn());

    const labelFor = (climbUuid: string) =>
      recorded.headers.find((props) => (props.climb as Climb).uuid === climbUuid)?.workoutStageLabel;
    expect(labelFor(TWELVE_CLIMB.uuid)).toBe('stage:queue-twelve');
    expect(labelFor('woods-peek')).toBe('stage:queue-woods');
    expect(labelFor('twelve-prev')).toBe('stage:queue-prev');
  });

  it('withholds a peek whose climb lives on another board', () => {
    // Swiping from a 12x12 climb toward a Homewall neighbour: the peek is drawn
    // over the 12x12 art, where the neighbour has no holds.
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = {
      nextItem: queueItem(HOMEWALL_CLIMB, 'queue-homewall'),
      prevItem: queueItem(TWELVE_CLIMB, 'queue-twelve-prev'),
      canNext: true,
      canPrevious: true,
    };
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    expect(board.nextFrames).toBeNull();
    // The same-board neighbour still peeks — this must not blanket-disable peeks.
    expect(board.prevFrames).toBe(TWELVE_CLIMB.frames);
  });

  it('warms the upcoming boulders and leaves multi-frame routes alone', () => {
    const firstBoulder = { ...TWELVE_CLIMB, uuid: 'twelve-b1', frames: 'p1145r15p1146r13' };
    // A route: the drawer plays this one frame by frame once it is current, so
    // the flattened catalog string is not a key anything will ask for.
    const route = { ...TWELVE_CLIMB, uuid: 'twelve-route', frames: 'p1145r15,p1200r13' };
    const secondBoulder = { ...TWELVE_CLIMB, uuid: 'twelve-b2', frames: 'p1300r15' };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    prefetchWalk.items = [
      queueItem(firstBoulder as Climb, 'queue-b1'),
      queueItem(route as Climb, 'queue-route'),
      queueItem(secondBoulder as Climb, 'queue-b2'),
    ];
    renderDrawer(vi.fn());

    expect(lastBoardProps().prefetchFrames).toEqual([firstBoulder.frames, secondBoulder.frames]);
  });

  it('warms nothing for a climb that lives on another board', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    prefetchWalk.items = [queueItem(HOMEWALL_CLIMB, 'queue-homewall')];
    renderDrawer(vi.fn());

    // Same rule as the peeks: a Homewall climb has no holds on the 12x12 art.
    expect(lastBoardProps().prefetchFrames).toEqual([]);
  });

  it('keeps the below-fold sections and the tick sheet on the climb board', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    // Logbook / beta / similar climbs are all per-board reads.
    expect(recorded.deferredSections.at(-1)?.layoutId).toBe(8);
    // The favourite heart is keyed on (board, climb, angle); keyed on the wrong
    // board it reads and writes another board's favourite.
    expect(recorded.favoriteStatus.at(-1)?.angle).toBe(30);

    act(() => {
      (recorded.actionBar.at(-1)?.onTickPress as () => void)();
    });

    expect(recorded.logAscent.at(-1)?.layoutId).toBe(8);
    expect(recorded.logAscent.at(-1)?.angle).toBe(30);
  });

  it('never lets a wrong-board climb reach the wall', () => {
    // Its hold ids address a different wall. The scrim hides the play button,
    // but a party peer's playback event starts the engine with no local tap —
    // so the suppression flag, not the UI, is what keeps the board dark.
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(true);
  });

  it('leaves wall writes armed for a climb that belongs to this board', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer(vi.fn());

    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(false);
  });

  it('asks the angle sheet for no per-climb stats on a wrong-board climb', () => {
    // The sheet reads by-angle stats against the SELECTED board, where this
    // climb does not exist.
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    act(() => {
      (recorded.actionBar.at(-1)?.onOpenAngleSelector as () => void)();
    });

    expect(recorded.angleSheet.at(-1)?.climbUuid).toBeUndefined();
    // Still the selected board's angles — that is the wall the pill moves.
    expect(recorded.angleSheet.at(-1)?.currentAngle).toBe(TWELVE_BY_TWELVE.angle);
  });

  it('still shows the angle pill for the board the climber is standing at', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    // The pill changes the SELECTED board's angle — it must not offer to move a
    // wall the climber is not on.
    expect(recorded.actionBar.at(-1)?.currentAngle).toBe(TWELVE_BY_TWELVE.angle);
  });
});

describe('PlayDrawer configurable sections', () => {
  function hideEverySection() {
    drawerSections.sections = {
      activeHolds: false,
      logbook: false,
      climberLogs: false,
      setterNotes: false,
      betaVideos: false,
      boardseshGrade: false,
      community: false,
      similarClimbs: false,
    };
  }
  const layoutEvent = (height: number) =>
    ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } }) as LayoutChangeEvent;
  it('hiding everything removes content and scroll without waiting for a nonexistent header', () => {
    hideEverySection();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.deferredSections).toHaveLength(0);
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(false);
    // The way back after Hide all: ⋯ → View options.
    const openViewOptions = recorded.actionsMenu.at(-1)?.onOpenViewOptions as () => void;
    act(openViewOptions);
    expect(recorded.sectionsSheet.at(-1)?.visible).toBe(true);
    const viewportLayout = recorded.scroll.at(-1)?.onLayout as (event: LayoutChangeEvent) => void;
    const headerLayout = recorded.headerLayout;
    if (!headerLayout) throw new Error('Title header is not measured');
    act(() => {
      viewportLayout(layoutEvent(568));
      headerLayout(layoutEvent(70));
    });
    expect(lastBoardProps().open).toBe(true);
    expect(recorded.firstScreen.at(-1)?.height).toBe(568);
  });
  it('can restore a first enabled header and scrolling after hiding everything', () => {
    hideEverySection();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const rendered = renderDrawer();
    drawerSections.sections = { ...drawerSections.sections, betaVideos: true };
    rendered.rerender(
      createElement(PlayDrawer, { boardConfig: TWELVE_BY_TWELVE, onOpenQueue: vi.fn(), openTarget: null }),
    );
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(true);
    expect(recorded.deferredSections.at(-1)?.sections).toEqual(drawerSections.sections);
    expect(recorded.firstScreen.at(-1)?.height).toBeLessThan(844);
  });
  it('remeasures the newly selected first header and opens its content on explicit expand', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const rendered = renderDrawer();
    const viewportLayout = recorded.scroll.at(-1)?.onLayout as (event: LayoutChangeEvent) => void;
    const headerLayout = recorded.headerLayout;
    const logbookHeaderLayout = recorded.deferredSections.at(-1)?.onFirstSectionHeaderLayout as (
      height: number,
    ) => void;
    if (!headerLayout) throw new Error('Title header is not measured');
    act(() => {
      viewportLayout(layoutEvent(844));
      headerLayout(layoutEvent(70));
      logbookHeaderLayout(70);
    });
    expect(lastBoardProps().open).toBe(true);
    expect(recorded.firstScreen.at(-1)?.height).toBe(754);
    hideEverySection();
    drawerSections.sections = { ...drawerSections.sections, betaVideos: true };
    rendered.rerender(
      createElement(PlayDrawer, { boardConfig: TWELVE_BY_TWELVE, onOpenQueue: vi.fn(), openTarget: null }),
    );
    expect(lastBoardProps().open).toBe(true);
    const betaHeaderLayout = recorded.deferredSections.at(-1)?.onFirstSectionHeaderLayout as (height: number) => void;
    act(() => betaHeaderLayout(60));
    expect(lastBoardProps().open).toBe(true);
    expect(recorded.firstScreen.at(-1)?.height).toBe(764);
    const expandFirst = recorded.deferredSections.at(-1)?.onFirstSectionToggle as (expanded: boolean) => void;
    act(() => expandFirst(true));
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(true);
  });
  it('opens a lone deferred section on deliberate scroll intent before any offset exists', () => {
    hideEverySection();
    drawerSections.sections = { ...drawerSections.sections, betaVideos: true };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(false);
    const onScrollIntent = recorded.scrollGate.at(-1)?.onScrollIntent as () => void;
    act(onScrollIntent);
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(true);
  });
  it('opens a lone deferred section when a native drag begins, before its first offset', () => {
    hideEverySection();
    drawerSections.sections = { ...drawerSections.sections, betaVideos: true };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(false);
    expect(recorded.scroll.at(-1)?.contentContainerStyle).toHaveProperty('minHeight', 845);
    const beginDrag = recorded.scroll.at(-1)?.onScrollBeginDrag as () => void;
    act(beginDrag);
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(true);
    expect(recorded.scroll.at(-1)?.contentContainerStyle).toHaveProperty('minHeight', undefined);
  });
  it('gives initial overflow and removes it after scrolling or hiding everything', () => {
    hideEverySection();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const rendered = renderDrawer();
    expect(recorded.scroll.at(-1)?.contentContainerStyle).not.toHaveProperty('minHeight', 845);
    const ignoredIntent = recorded.scrollGate.at(-1)?.onScrollIntent as () => void;
    act(ignoredIntent);
    drawerSections.sections = { ...drawerSections.sections, betaVideos: true };
    rendered.rerender(
      createElement(PlayDrawer, { boardConfig: TWELVE_BY_TWELVE, onOpenQueue: vi.fn(), openTarget: null }),
    );
    const viewportLayout = recorded.scroll.at(-1)?.onLayout as (event: LayoutChangeEvent) => void;
    act(() => viewportLayout(layoutEvent(844)));
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(false);
    expect(recorded.scroll.at(-1)?.contentContainerStyle).toHaveProperty('minHeight', 845);
    const onScroll = recorded.scroll.at(-1)?.onScroll as (event: {
      nativeEvent: { contentOffset: { y: number } };
    }) => void;
    act(() => onScroll({ nativeEvent: { contentOffset: { y: 1 } } }));
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(true);
    expect(recorded.scroll.at(-1)?.contentContainerStyle).toHaveProperty('minHeight', undefined);
  });
  it('mounts the board while preference hydration still withholds sections', () => {
    drawerSections.ready = false;
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.deferredSections).toHaveLength(0);
    expect(lastBoardProps()).toMatchObject({ open: true, currentFrames: TWELVE_CLIMB.frames });
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(false);
  });

  // ⋯ → View options opens the sections sheet mounted in the player, which
  // presents above `/play`; a root-level sheet would land under it.
  it("opens View options from ⋯ through the player's own sections sheet", () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.sectionsSheet).toHaveLength(0);

    const openViewOptions = recorded.actionsMenu.at(-1)?.onOpenViewOptions as () => void;
    act(openViewOptions);
    expect(recorded.sectionsSheet.at(-1)?.visible).toBe(true);
  });

  // The eye is gone from the bar; with every section hidden, ⋯ is still there.
  it('keeps ⋯ when every section is switched off, and hands the bar no eye', () => {
    hideEverySection();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)).toBeDefined();
    expect(recorded.actionBar.at(-1)).not.toHaveProperty('onEditSections');
    expect(recorded.actionBar.at(-1)).not.toHaveProperty('onOpenActions');
  });
});

describe('PlayDrawer active holds section', () => {
  // A MoonBoard 2024 climb: Active holds is MoonBoard only.
  const MOON_CLIMB = {
    ...climbOn('moonboard', 3, 40, 'MOON00000000000000000000000DDDD'),
    frames: 'p49r42p90r43p196r44',
  };
  function showOnlyActiveHolds() {
    drawerSections.sections = {
      activeHolds: true,
      logbook: false,
      climberLogs: false,
      setterNotes: false,
      betaVideos: false,
      boardseshGrade: false,
      community: false,
      similarClimbs: false,
    };
  }
  function lastSectionsClimb(): unknown {
    const props = recorded.deferredSections.at(-1);
    if (!props) throw new Error('DeferredSections never rendered');
    return props.climb;
  }
  function rerenderDrawer(rendered: ReturnType<typeof renderDrawer>) {
    rendered.rerender(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: TWELVE_BY_TWELVE,
        openTarget: null,
        onOpenQueue: vi.fn(),
      }),
    );
  }

  it('is the peek on its own on a MoonBoard climb, so the drawer scrolls to it', () => {
    showOnlyActiveHolds();
    queueState.currentClimbQueueItem = queueItem(MOON_CLIMB, 'queue-moon');
    renderDrawer();
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(true);
    expect(recorded.deferredSections.at(-1)).toMatchObject({ boardName: 'moonboard', layoutId: 3 });
    expect(lastSectionsClimb()).toBe(MOON_CLIMB);
    // A static climb: no playback frame, so Active holds reads the climb's frames.
    expect(recorded.playbackFrames.at(-1)).toBeNull();
  });

  it('lists its switch in View options on a MoonBoard climb, even with another board active', () => {
    queueState.currentClimbQueueItem = queueItem(MOON_CLIMB, 'queue-moon');
    renderDrawer();
    const openViewOptions = recorded.actionsMenu.at(-1)?.onOpenViewOptions as () => void;
    act(openViewOptions);
    expect(recorded.sectionsSheet.at(-1)).toMatchObject({ visible: true, listsActiveHolds: true });
  });

  it('leaves its switch out of View options on another board', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    const openViewOptions = recorded.actionsMenu.at(-1)?.onOpenViewOptions as () => void;
    act(openViewOptions);
    expect(recorded.sectionsSheet.at(-1)).toMatchObject({ visible: true, listsActiveHolds: false });
  });

  it('never shows on another board, switched on or not: the drawer has nothing to scroll to', () => {
    showOnlyActiveHolds();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.deferredSections).toHaveLength(0);
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(false);
  });

  it('follows the board to the next climb', () => {
    showOnlyActiveHolds();
    queueState.currentClimbQueueItem = queueItem(MOON_CLIMB, 'queue-moon');
    const rendered = renderDrawer();
    const nextClimb = { ...MOON_CLIMB, uuid: 'NEXTMOON000000000000000000EEEE', frames: 'p5r42p100r44' };
    queueState.currentClimbQueueItem = queueItem(nextClimb, 'queue-next');
    rerenderDrawer(rendered);
    expect(lastSectionsClimb()).toBe(nextClimb);
  });

  it("hands Active holds the playback frame the board paints by context, keeping the sections' props", () => {
    showOnlyActiveHolds();
    playbackState.isAnimatable = true;
    playbackState.currentFrameString = 'p49r42';
    queueState.currentClimbQueueItem = queueItem(MOON_CLIMB, 'queue-moon');
    const rendered = renderDrawer();
    expect(lastBoardProps().currentFrameOverride).toBe('p49r42');
    expect(recorded.playbackFrames.at(-1)).toBe('p49r42');
    const before = recorded.deferredSections.at(-1) ?? {};
    playbackState.currentFrameString = 'p90r43';
    rerenderDrawer(rendered);
    expect(recorded.playbackFrames.at(-1)).toBe('p90r43');
    const after = recorded.deferredSections.at(-1) ?? {};
    // No prop carries the frame, so the memoised sections skip a playback tick.
    expect(Object.values(after)).not.toContain('p90r43');
    expect(after.climb).toBe(before.climb);
    expect(after.sections).toBe(before.sections);
  });

  it('provides no playback frame while Active holds is off, so a tick changes nothing for nobody', () => {
    playbackState.isAnimatable = true;
    playbackState.currentFrameString = 'p49r42';
    queueState.currentClimbQueueItem = queueItem(MOON_CLIMB, 'queue-moon');
    renderDrawer();
    expect(lastBoardProps().currentFrameOverride).toBe('p49r42');
    expect(recorded.playbackFrames.at(-1)).toBeNull();
  });
});

describe('PlayDrawer ⋯ menu', () => {
  // #5099: a climb from another board is queued, shared and reported against ITS
  // board, and every row that writes stands down behind the switch-board gate.
  it('builds ⋯ on the board the climb is drawn on, and gates it like the scrim', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    const menuProps = recorded.actionsMenu.at(-1);
    expect(menuProps?.climb).toBe(HOMEWALL_CLIMB);
    expect(menuProps?.boardConfig).toMatchObject({ boardName: 'kilter', layoutId: 8, angle: 30 });
    expect(menuProps?.boardMismatch).toBe(true);
  });

  it('offers Change angle in ⋯ only where the bar would show the angle pill', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const adjustable = renderDrawer();
    expect(typeof recorded.actionsMenu.at(-1)?.onOpenAngle).toBe('function');
    adjustable.unmount();
    recorded.actionsMenu = [];
    render(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: TWELVE_BY_TWELVE,
        openTarget: null,
        onOpenQueue: vi.fn(),
        isAngleAdjustable: false,
      }),
    );
    expect(recorded.actionsMenu.at(-1)).toBeDefined();
    expect(recorded.actionsMenu.at(-1)?.onOpenAngle).toBeUndefined();
  });

  it('opens nothing ahead of a mismatch on the climber own board', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();

    const menuProps = recorded.actionsMenu.at(-1);
    expect(menuProps?.boardConfig).toMatchObject({ boardName: 'kilter', layoutId: 1 });
    expect(menuProps?.boardMismatch).toBe(false);
  });

  // Each sheet row opens the player's OWN sheet, pinned to the climb ⋯ was opened
  // for. A root opener presents under `/play` and flashes closed (#3505, #3294).
  it("opens each of ⋯'s sheets in the player, pinned to the climb and board it was opened for", () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    type PinnedOpener = (climb: Climb, boardConfig: unknown) => void;
    const menuProps = recorded.actionsMenu.at(-1) ?? {};
    // Pinned to the Homewall climb while the Twelve climb is on screen, so a
    // sheet that read the displayed climb instead would show up here.
    const pinnedBoard = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27', angle: 30 };
    const openTick = menuProps.onTick as PinnedOpener;
    const openBeta = menuProps.onAddBetaVideo as PinnedOpener;
    const openReport = menuProps.onReportClimb as PinnedOpener;
    const openPlaylist = menuProps.onSelectPlaylist as PinnedOpener;

    act(() => openTick(HOMEWALL_CLIMB, pinnedBoard));
    expect(recorded.logAscent.at(-1)).toMatchObject({ visible: true, climbUuid: HOMEWALL_CLIMB.uuid, layoutId: 8 });
    act(() => openBeta(HOMEWALL_CLIMB, pinnedBoard));
    expect(recorded.pinnedSheets.get('beta')).toMatchObject({ visible: true, climb: HOMEWALL_CLIMB, layoutId: 8 });
    act(() => openReport(HOMEWALL_CLIMB, pinnedBoard));
    expect(recorded.pinnedSheets.get('report')).toMatchObject({ visible: true, climb: HOMEWALL_CLIMB, layoutId: 8 });
    act(() => openPlaylist(HOMEWALL_CLIMB, pinnedBoard));
    expect(recorded.pinnedSheets.get('playlist')).toMatchObject({
      visible: true,
      climb: HOMEWALL_CLIMB,
      layoutId: 8,
      angle: 30,
    });
  });

  // The menu flips the bar heart, so the two can never disagree.
  it("hands ⋯ the bar heart's favourite state and toggle", () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)?.isFavorited).toBe(recorded.actionBar.at(-1)?.isFavorited);
    expect(typeof recorded.actionsMenu.at(-1)?.onToggleFavorite).toBe('function');
  });

  // Nothing on the bar is hidden outside commit mode and the connect pill.
  it('tells ⋯ which bar buttons are put away', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)?.hidden).toEqual({
      favorite: false,
      share: false,
      queue: false,
      mirror: false,
      angle: false,
    });
  });

  it('hands ⋯ a button the climber switched off, and the bar the same buttons', () => {
    onTestFinished(() => resetAllSettings());
    setSetting('playerButtonsV1', {
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'share', 'queue'],
      visible: { share: false },
    });
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({ share: true, favorite: false });
    expect(recorded.actionBar.at(-1)?.buttons).toMatchObject({ visible: { share: false } });
    // Mirror and the angle sheet from ⋯ run the bar's own handlers.
    expect(recorded.actionsMenu.at(-1)?.onToggleMirror).toBe(recorded.actionBar.at(-1)?.onMirror);
    expect(recorded.actionsMenu.at(-1)?.onOpenAngle).toBe(recorded.actionBar.at(-1)?.onOpenAngleSelector);
  });
});

describe('PlayDrawer controls position (#6229)', () => {
  afterEach(() => resetAllSettings());
  const follows = (first: Element, second: Element) =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('draws the controls under the board by default, with the hairline facing it', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const screen = renderDrawer();
    expect(follows(screen.getByTestId('board'), screen.getByTestId('action-bar'))).toBe(true);
    expect(recorded.actionBar.at(-1)?.edge).toBe('top');
  });

  it('moves the whole controls block above the board, switch-board scrim and all', () => {
    setSetting('playerButtonsPosition', 'above');
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    const screen = renderDrawer(vi.fn());
    const bar = screen.getByTestId('action-bar');
    const scrim = screen.getByTestId('switch-board-overlay');
    const board = screen.getByTestId('board');

    expect(follows(bar, board)).toBe(true);
    expect(follows(scrim, board)).toBe(true);
    // The scrim stays a sibling of the controls it covers, in the same region.
    expect(scrim.parentElement?.contains(bar)).toBe(true);
    expect(recorded.actionBar.at(-1)?.edge).toBe('bottom');
  });

  // The card is taller than the controls, more so with the small row off. Left
  // to spill, it would sit under the board (above the fold) or the first section
  // (below it), and they would take the taps meant for Switch board.
  it('holds the whole switch-board card inside the controls, above the board with every small button off', () => {
    setSetting('playerButtonsPosition', 'above');
    setSetting('playerButtonsV1', {
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'share', 'queue'],
      visible: { mirror: false, favorite: false, angle: false, share: false, queue: false },
    });
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    const screen = renderDrawer(vi.fn());
    const region = screen.getByTestId('play-drawer-controls-region');

    // A typical card until the real one is measured, plus 8 pt above and below.
    expect(region.getAttribute('data-min-height')).toBe('200');
    const reportCardHeight = recorded.switchOverlay.at(-1)?.onCardHeight as ((height: number) => void) | undefined;
    if (!reportCardHeight) throw new Error('SwitchBoardOverlay was never handed onCardHeight');
    act(() => reportCardHeight(231.4));
    expect(region.getAttribute('data-min-height')).toBe(String(232 + 16));
    // Over its later siblings, the lost-holds banner and the board.
    expect(region.getAttribute('data-z-index')).toBe('1');
  });

  it('holds the card under the board too, and lets the region go back to its own height on its own board', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    const mismatch = renderDrawer(vi.fn());
    expect(mismatch.getByTestId('play-drawer-controls-region').getAttribute('data-min-height')).toBe('200');
    expect(mismatch.getByTestId('play-drawer-controls-region').getAttribute('data-z-index')).toBeNull();
    mismatch.unmount();

    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const ownBoard = renderDrawer(vi.fn());
    expect(ownBoard.getByTestId('play-drawer-controls-region').getAttribute('data-min-height')).toBeNull();
  });

  it('follows a position change while the player is open', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const screen = renderDrawer();
    act(() => setSetting('playerButtonsPosition', 'above'));
    expect(follows(screen.getByTestId('action-bar'), screen.getByTestId('board'))).toBe(true);
  });
});
