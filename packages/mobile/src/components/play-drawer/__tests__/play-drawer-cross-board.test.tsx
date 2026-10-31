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
import { render as renderInitial, act, renderHook } from '@testing-library/react';
import { createElement, useEffect, useRef, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { LayoutChangeEvent } from 'react-native';
import { clearOpeningLayoutCache } from '../opening-layout-cache';
import { publishHingeStatus, resetHingeStatusForTests } from '../../../lib/device-hinge-store';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  board: [] as Props[],
  boardMounts: 0,
  boardUnmounts: 0,
  headers: [] as Props[],
  topBar: [] as Props[],
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
const crew = vi.hoisted(() => ({ shared: false }));
// `wall-swipe-to-drive` (#7113). Off by default here, so the older tests keep
// today's button; the swipe's own tests turn it on.
const swipeToDrive = vi.hoisted(() => ({ on: false }));
const wallClimbState = vi.hoisted(() => ({ uuid: null as string | null, sentAt: null as string | null }));
const boardSheet = vi.hoisted(() => ({ props: [] as Props[], opened: vi.fn() }));
const wallControlTapped = vi.hoisted(() => vi.fn());
const disconnectAllBluetooth = vi.hoisted(() => vi.fn());
const wallHaptics = vi.hoisted(() => ({ hapticWarning: vi.fn(), hapticMedium: vi.fn(), hapticLight: vi.fn() }));
const announceQueued = vi.hoisted(() => vi.fn());
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
    if (testID === 'play-drawer-tabletop-controls') return createElement('div', { 'data-testid': testID }, children);
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
  // RNGH 3's default component cannot coordinate with the player's builders.
  ScrollView: () => {
    throw new Error('The player must use the legacy scroll handler on RNGH 3');
  },
  LegacyScrollView: ({ children, ...props }: { children?: ReactNode } & Props) => {
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
const queueAnalytics = vi.hoisted(() => ({ navigation: vi.fn(), sheetOpened: vi.fn() }));
vi.mock('../../../lib/queue-navigation-analytics', () => ({
  trackQueueNavigation: queueAnalytics.navigation,
  trackQueueSheetOpened: queueAnalytics.sheetOpened,
}));

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
// The tablet rule (#7000) reads the device's chrome; here it is a switch.
const miniPlayerBeside = vi.hoisted(() => ({ mirrors: false }));
vi.mock('../use-mini-player-mirrors', () => ({ useMiniPlayerMirrorsPlayer: () => miniPlayerBeside.mirrors }));
// The bar records the board control model flattened (#7000), so the assertions
// read the state, the holder, and each view's tap and hold through one handler.
vi.mock('../PlayDrawerActionBar', () => ({
  PlayDrawerActionBar: (props: Props) => {
    const model = props.wallControl as
      | { state: string | null; holder: string | null; longPress: string | null; holderFace: unknown }
      | undefined;
    const press = props.onWallControlPress as ((control: string) => void) | undefined;
    const hold = props.onWallControlLongPress as ((control: string) => void) | undefined;
    const holdable = model?.longPress === 'sheet' && hold !== undefined;
    recorded.actionBar.push({
      ...props,
      wallControlState: model?.state ?? null,
      wallHolder: model?.holder ?? null,
      commitLabel: (model as { labelKey?: string } | undefined)?.labelKey === 'setActive' ? 'setActive' : 'putOnWall',
      onWallControl: press ? () => press('button') : undefined,
      onLightbulb: press ? () => press('bulb') : undefined,
      onWallControlLongPress: holdable ? () => hold('button') : undefined,
      onLightbulbLongPress: holdable ? () => hold('bulb') : undefined,
    });
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
vi.mock('../TrackEndCard', () => ({ TrackEndCard: () => null }));
vi.mock('../WorkoutRunnerOverlay', () => ({ WorkoutRunnerOverlay: () => null }));
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
// The workout position (#5379) has its own suites; here only that the top bar
// is handed the position of the climb on screen.
vi.mock('../use-workout-stage-label', () => ({
  useWorkoutQueueUuids: () => [],
  useWorkoutStageParts: (_run: unknown, _queueUuids: unknown, queueItemUuid: string | null | undefined) =>
    queueItemUuid
      ? { name: `stage:${queueItemUuid}`, count: '2 of 5', accessibilityLabel: `stage:${queueItemUuid}, 2 of 5` }
      : null,
}));
vi.mock('../PlayListContext', () => ({
  PlayListContext: (props: Props) => {
    recorded.topBar.push(props);
    return null;
  },
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
vi.mock('../../../providers/feature-flags-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../providers/feature-flags-provider')>()),
  useWallSwipeToDriveEnabled: () => swipeToDrive.on,
}));
vi.mock('../../ble/BleControlSheetHost', () => ({
  BleControlSheetHost: (props: Props) => {
    boardSheet.props.push(props);
    return null;
  },
}));
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
    getQueueSnapshot: () => queueState,
    setCurrentClimb,
    nextClimb: vi.fn(),
    previousClimb: vi.fn(),
    addToQueue: vi.fn(async () => 'added'),
  }),
  useQueueSessionId: () => ({ sessionId: null }),
  // Solo unless a case says otherwise (the busy-wall question needs a crew):
  // the crew gate is off, so gestures commit as they always have.
  useIsSharedSession: () => crew.shared,
  useIsCrewSession: () => crew.shared,
  usePlaylistSuggestionSource: () => null,
}));
// Null (no Bluetooth transport) unless a case hands the player a context, as
// the #4979 stale-climb hold cases do.
const bluetoothContext = vi.hoisted(() => ({ value: null as Props | null }));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => bluetoothContext.value,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  // The preview angle re-anchor asks for the climb at the live angle; nothing
  // here pins a preview at another angle, so it never resolves.
  useClimb: () => ({ data: undefined }),
  // No gym roster: Put on {board} reads it (#7076).
  useGymBoards: () => ({ data: undefined }),
  useProfile: () => ({ data: undefined }),
  useToggleFavorite: () => ({ mutate: toggleFavorite }),
  useFavoriteStatus: (boardName: string, uuid: string | null, angle: number) => {
    recorded.favoriteStatus.push({ boardName, uuid, angle });
    return { data: undefined };
  },
}));
vi.mock('../../../hooks/use-display-grade', () => ({ useDisplayGrade: () => ({ boardseshActive: false }) }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => null }));
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
vi.mock('../use-wall-climb', () => ({
  useWallClimb: () => ({ uuid: wallClimbState.uuid, name: wallClimbState.uuid, sentAt: wallClimbState.sentAt }),
  usePresenceClearedClimbUuid: () => null,
}));
// The status-line cases drive a wall and pick a ledless board; the wall-control
// cases (#7000) also hold the link and say what a bare tap would do.
const lightbulbState = vi.hoisted(() => ({
  lit: false,
  ledless: false,
  localConnected: false,
  pressAction: 'noop' as string,
  holderIsAuthoritative: false,
  onPress: vi.fn(),
  connect: vi.fn(async () => true),
}));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: { canRelay?: boolean; onRelayToHolder?: () => void }) => {
    recorded.lightbulb.push(options);
    return {
      lit: lightbulbState.lit,
      localConnected: lightbulbState.localConnected,
      pending: false,
      onPress: lightbulbState.onPress,
      connect: lightbulbState.connect,
      pressAction: lightbulbState.pressAction,
      holderIsAuthoritative: lightbulbState.holderIsAuthoritative,
      ledless: lightbulbState.ledless,
    };
  },
}));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardControlsOpened: boardSheet.opened }));
vi.mock('../../../lib/ble/bluetooth-status-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/ble/bluetooth-status-store')>()),
  disconnectAllBluetooth,
}));
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackWallControlTapped: wallControlTapped,
  trackWallControlShown: vi.fn(),
  trackDriveModeEnded: vi.fn(),
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({
  hapticSuccess: vi.fn(),
  hapticMedium: wallHaptics.hapticMedium,
  hapticWarning: wallHaptics.hapticWarning,
  hapticLight: wallHaptics.hapticLight,
}));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));

const { PlayDrawer } = await import('../PlayDrawer');
const { setSetting, resetAllSettings } = await import('../../../settings');
const { resetWallCleared } = await import('../../ble/wall-cleared-store');
const { getDriveMode, isDrivingStoppedForLink, markDriveLive, enterDriveMode, resetDriveModeForTests } =
  await import('../drive-mode-store');

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

const onOpenQueueForDrawer = vi.fn();
function drawerElement(onSwitchBoard?: (boardConfig?: unknown) => void) {
  return createElement(PlayDrawer, {
    presentation: 'pane' as const,
    boardConfig: TWELVE_BY_TWELVE,
    openTarget: null,
    onOpenQueue: onOpenQueueForDrawer,
    onSwitchBoard,
  });
}

function renderDrawer(onSwitchBoard?: (boardConfig?: unknown) => void) {
  return render(drawerElement(onSwitchBoard));
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
  swipeToDrive.on = false;
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
  recorded.topBar = [];
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
  bluetoothContext.value = null;
  lightbulbState.lit = false;
  lightbulbState.ledless = false;
  lightbulbState.localConnected = false;
  lightbulbState.pressAction = 'noop';
  lightbulbState.holderIsAuthoritative = false;
  disconnectAllBluetooth.mockClear();
  crew.shared = false;
  wallClimbState.uuid = null;
  wallClimbState.sentAt = null;
  boardSheet.props = [];
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

  // #6745: at the front of the header's stats line the stage pushed the sends
  // and stars off a phone. It lives in the top bar, which doesn't swipe, so it
  // names the climb on screen.
  it('puts the workout position of the climb on screen in the top bar', () => {
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

    expect(recorded.topBar.at(-1)?.parts).toMatchObject({ name: 'stage:queue-twelve', count: '2 of 5' });
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

  it('keeps the pinned tick orientation when a matching current UUID belongs to another board', () => {
    queueState.currentClimbQueueItem = queueItem(
      { ...TWELVE_CLIMB, uuid: HOMEWALL_CLIMB.uuid, mirrored: true },
      'current-slot',
    );
    renderDrawer();
    const openTick = recorded.actionsMenu.at(-1)?.onTick as (climb: Climb, boardConfig: unknown) => void;
    const targetBoard = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27', angle: 30 };
    act(() => openTick({ ...HOMEWALL_CLIMB, mirrored: false }, targetBoard));
    expect(recorded.logAscent.at(-1)).toMatchObject({ climbUuid: HOMEWALL_CLIMB.uuid, layoutId: 8, isMirror: false });
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
  // #7000: on a mirror board the heart, Share and Angle are ⋯ rows; Mirror and
  // the queue sit in the bar.
  it('tells ⋯ which bar buttons are put away', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: true,
      share: true,
      queue: false,
      mirror: false,
    });
  });

  it('hands ⋯ a button the climber switched off, and the bar the same buttons', () => {
    onTestFinished(() => resetAllSettings());
    setSetting('playerButtonsV2', {
      version: 1,
      order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
      visible: { queue: false },
    });
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({ queue: true, mirror: false });
    expect(recorded.actionBar.at(-1)?.buttons).toMatchObject({ visible: { queue: false } });
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
    setSetting('playerButtonsV2', {
      version: 1,
      order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
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

// #4979 (docs/current-climb-outside-queue.md, section 6, decision 9): the board
// connected but the hold kept the current climb dark. The wall button reads it
// as dark and re-lights it, and the player says when the climb was last on the
// wall, so the dark board doesn't read as a Bluetooth failure.
describe('PlayDrawer stale-climb hold', () => {
  const LAST_ON_WALL_AT = Date.parse('2026-10-20T08:00:00.000Z');

  function connectedBluetooth(staleCurrentHold: { queueItemUuid: string; lastCurrentChangeAt: number } | null) {
    return {
      isConnected: true,
      staleCurrentHold,
      reassertWall: vi.fn(),
      armUndoWallChangeToast: vi.fn(),
      sendFramesToBoard: vi.fn(async () => true),
      wallHeldByOtherUser: false,
      autoDisconnectWarning: false,
    };
  }

  it('reads the held current climb as dark, re-lights it on a tap, with no last-on-the-wall line', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = connectedBluetooth({ queueItemUuid: 'queue-twelve', lastCurrentChangeAt: LAST_ON_WALL_AT });
    bluetoothContext.value = bluetooth;
    lightbulbState.localConnected = true;
    lightbulbState.pressAction = 'disconnect';
    lightbulbState.lit = true;
    const screen = renderDrawer();

    const actionBar = recorded.actionBar.at(-1);
    expect(actionBar?.commitButton).toBeNull();
    expect(actionBar?.wallControlState).toBe('dark');
    expect(screen.queryByTestId('play-drawer-last-on-wall')).toBeNull();

    const onWallControl = actionBar?.onWallControl;
    if (typeof onWallControl !== 'function') throw new Error('The wall button has no handler');
    act(() => {
      onWallControl();
    });
    expect(bluetooth.armUndoWallChangeToast).toHaveBeenCalledTimes(1);
    expect(bluetooth.reassertWall).toHaveBeenCalledTimes(1);
    expect(setCurrentClimb).not.toHaveBeenCalled();
  });

  // Decision A: only the automatic send on connect is held. A pick of the held
  // climb from a list lights it; the accessory bar reopening it does not, and a
  // queue-sheet tap leaves it to the clock its own setCurrentClimb restarted.
  it.each([
    { label: 'a list pick', options: undefined, lights: true },
    { label: 'an accessory bar reopen', options: { reopensCurrent: true }, lights: false },
    { label: 'a queue-sheet tap', options: { committedExternally: true }, lights: false },
  ])('$label of the held climb lights=$lights', ({ options, lights }) => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = connectedBluetooth({ queueItemUuid: 'queue-twelve', lastCurrentChangeAt: LAST_ON_WALL_AT });
    bluetoothContext.value = bluetooth;
    render(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: TWELVE_BY_TWELVE,
        openTarget: { climb: TWELVE_CLIMB, options, nonce: 1 },
        onOpenQueue: vi.fn(),
      }),
    );
    expect(bluetooth.reassertWall).toHaveBeenCalledTimes(lights ? 1 : 0);
    expect(bluetooth.armUndoWallChangeToast).toHaveBeenCalledTimes(lights ? 1 : 0);
    expect(setCurrentClimb).not.toHaveBeenCalled();
  });

  it('reads lit for a hold that names another climb, or with no hold at all (the kill switch)', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = connectedBluetooth({ queueItemUuid: 'queue-other', lastCurrentChangeAt: LAST_ON_WALL_AT });
    const otherClimb = renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).not.toBe('dark');
    expect(recorded.actionBar.at(-1)?.commitButton).toBeNull();
    otherClimb.unmount();

    bluetoothContext.value = connectedBluetooth(null);
    const killed = renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).not.toBe('dark');
    expect(recorded.actionBar.at(-1)?.commitButton).toBeNull();
  });
});

describe('PlayDrawer in tabletop (iPhone Duo half open, upright)', () => {
  beforeEach(() => {
    resetHingeStatusForTests();
    platform.OS = 'ios';
    viewport.width = 669;
    viewport.height = 951;
  });
  afterEach(() => resetHingeStatusForTests());

  function renderRoute() {
    return render(createElement(PlayDrawer, { boardConfig: TWELVE_BY_TWELVE, openTarget: null, onOpenQueue: vi.fn() }));
  }

  it('ends the first screen at the fold and moves the controls just below it', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    const rendered = renderRoute();
    expect(recorded.firstScreen.at(-1)?.height).toBe(464);
    const belowFold = rendered.getByTestId('play-drawer-tabletop-controls');
    expect(belowFold.querySelector('[data-testid="play-drawer-controls-region"]')).not.toBeNull();
  });

  it('puts the controls back under the board when the Duo opens flat', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    const rendered = renderRoute();
    act(() => publishHingeStatus('fullyOpen'));
    expect(rendered.queryByTestId('play-drawer-tabletop-controls')).toBeNull();
    expect(rendered.getByTestId('play-drawer-controls-region')).not.toBeNull();
    expect(recorded.firstScreen.at(-1)?.height).not.toBe(464);
  });

  it('keeps the controls below the fold when the View options put them above the board', () => {
    setSetting('playerButtonsPosition', 'above');
    onTestFinished(() => resetAllSettings());
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    const rendered = renderRoute();
    const belowFold = rendered.getByTestId('play-drawer-tabletop-controls');
    expect(belowFold.querySelector('[data-testid="action-bar"]')).not.toBeNull();
    expect(recorded.actionBar.at(-1)?.edge).toBe('top');
  });

  it('loads the section bodies on open, since they start inside the viewport', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    renderRoute();
    expect(recorded.deferredSections.at(-1)?.contentEnabled).toBe(true);
  });

  it('still scrolls with every section hidden, so tall controls stay reachable', () => {
    drawerSections.sections = Object.fromEntries(
      Object.keys(drawerSections.defaults).map((id) => [id, false]),
    ) as typeof drawerSections.sections;
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    renderRoute();
    expect(recorded.scroll.at(-1)?.scrollEnabled).toBe(true);
  });

  it('leaves the persistent pane alone', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    act(() => publishHingeStatus('partiallyOpen'));
    const rendered = renderDrawer();
    expect(rendered.queryByTestId('play-drawer-tabletop-controls')).toBeNull();
  });
});

// #6940: which control asked for the step decides `method`; the selection
// controller's own suite pins the moved / preview split.
describe('PlayDrawer queue analytics', () => {
  function arrangeNeighbours() {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = {
      nextItem: queueItem({ ...TWELVE_CLIMB, uuid: 'twelve-next' }, 'queue-next'),
      prevItem: queueItem({ ...TWELVE_CLIMB, uuid: 'twelve-prev' }, 'queue-prev'),
      canNext: true,
      canPrevious: true,
    };
  }
  const solo = { surface: 'player', inSharedSession: false, boardType: 'kilter', layoutId: 1 };
  function press(props: Props | undefined, handler: string) {
    const onPress = props?.[handler];
    if (typeof onPress !== 'function') throw new Error(`${handler} was not handed over`);
    act(() => {
      onPress();
    });
  }

  it('reports the action bar ⏮ ⏭ as button steps, once each', () => {
    arrangeNeighbours();
    renderDrawer();
    press(recorded.actionBar.at(-1), 'onPrevClick');
    press(recorded.actionBar.at(-1), 'onNextClick');
    expect(queueAnalytics.navigation.mock.calls).toEqual([
      [expect.objectContaining({ ...solo, direction: 'previous', method: 'button', outcome: 'moved' })],
      [expect.objectContaining({ ...solo, direction: 'next', method: 'button', outcome: 'moved' })],
    ]);
  });

  it('reports a board swipe as a swipe step', () => {
    arrangeNeighbours();
    renderDrawer();
    const pager = lastBoardProps().pager as { requestStep: (direction: 1 | -1, step: number) => void };
    act(() => pager.requestStep(-1, 1));
    expect(queueAnalytics.navigation).toHaveBeenCalledOnce();
    expect(queueAnalytics.navigation).toHaveBeenCalledWith(
      expect.objectContaining({ ...solo, direction: 'previous', method: 'swipe', outcome: 'moved' }),
    );
  });

  it("counts the board's screen-reader adjust action as the swipe it stands in for", () => {
    arrangeNeighbours();
    renderDrawer();
    press(lastBoardProps(), 'onSwipeNext');
    expect(queueAnalytics.navigation).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'next', method: 'swipe' }),
    );
  });

  it('reports the queue button and the ⋯ row as separate surfaces', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    press(recorded.actionBar.at(-1), 'onOpenQueue');
    press(recorded.actionsMenu.at(-1), 'onOpenQueue');
    expect(queueAnalytics.sheetOpened.mock.calls).toEqual([
      [{ surface: 'player', boardType: 'kilter' }],
      [{ surface: 'player_menu', boardType: 'kilter' }],
    ]);
  });
});

// #7000: "Lit on the wall" in Put on the wall's gap, wired to the real resolver.
// Its states are pinned in wall-lit.test.ts; these check the inputs PlayCore feeds it.
describe('PlayDrawer wall button reads the wall', () => {
  const connectedBluetooth = () => ({
    isConnected: true,
    staleCurrentHold: null,
    reassertWall: vi.fn(),
    armUndoWallChangeToast: vi.fn(),
    setMirrorIntent: vi.fn(),
    getMirrorIntent: vi.fn(() => undefined),
    retainMirrorIntentFor: vi.fn(),
    sendFramesToBoard: vi.fn(async () => true),
    wallHeldByOtherUser: false,
    autoDisconnectWarning: false,
  });

  it('says Lit on the wall for the current climb on this phone’s link, with this phone as the holder', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = connectedBluetooth();
    lightbulbState.lit = true;
    lightbulbState.localConnected = true;
    lightbulbState.pressAction = 'disconnect';
    renderDrawer();
    expect(recorded.actionBar.at(-1)).toMatchObject({ wallControlState: 'lit', wallHolder: 'self' });
  });

  it('says Put on board with no link, and names no holder', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = { ...connectedBluetooth(), isConnected: false };
    lightbulbState.pressAction = 'connect';
    renderDrawer();
    expect(recorded.actionBar.at(-1)).toMatchObject({ wallControlState: 'connect', wallHolder: null });
  });

  it('offers nothing on a board without lights that this phone is linked to', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = connectedBluetooth();
    lightbulbState.lit = true;
    lightbulbState.localConnected = true;
    lightbulbState.pressAction = 'disconnect';
    lightbulbState.ledless = true;
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBeNull();
  });

  it('offers nothing without Bluetooth at all', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBeNull();
  });
});

// #7000: what a tap on the wall button or the bulb does, through the real
// PlayCore with a mock Bluetooth context.
describe('PlayDrawer wall button taps', () => {
  // "Turn off all lights" marks the climb in a module-wide store; start each case lit.
  beforeEach(() => {
    resetWallCleared();
    resetDriveModeForTests();
    wallControlTapped.mockClear();
    wallHaptics.hapticWarning.mockClear();
    wallHaptics.hapticLight.mockClear();
    announceQueued.mockClear();
  });
  afterEach(() => {
    resetAllSettings();
    resetDriveModeForTests();
  });

  function linkedBluetooth(staleCurrentHold: { queueItemUuid: string; lastCurrentChangeAt: number } | null = null) {
    return {
      isConnected: true,
      loading: false,
      staleCurrentHold,
      reassertWall: vi.fn(),
      armUndoWallChangeToast: vi.fn(),
      clearBoard: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
      setMirrorIntent: vi.fn(),
      getMirrorIntent: vi.fn(() => undefined),
      retainMirrorIntentFor: vi.fn(),
      sendFramesToBoard: vi.fn(async () => true),
      wallHeldByOtherUser: false,
      autoDisconnectWarning: false,
    };
  }
  function linkedTo(bluetooth: ReturnType<typeof linkedBluetooth>, lit: boolean) {
    bluetoothContext.value = bluetooth;
    lightbulbState.localConnected = true;
    lightbulbState.pressAction = 'disconnect';
    lightbulbState.lit = lit;
  }
  function tap(prop: 'onLightbulb' | 'onWallControl' | 'onCommit') {
    const handler = recorded.actionBar.at(-1)?.[prop];
    if (typeof handler !== 'function') throw new Error(`${prop} has no handler`);
    act(() => {
      handler();
    });
  }

  // Marco's phone test: a tap on Disconnect board (lit, not driving) lets go
  // of it, the board sheet's own Disconnect. A hold opens the sheet (below).
  it.each([
    ['the wall button', 'onWallControl', 'button'],
    ['the bulb, back in the first row', 'onLightbulb', 'bulb'],
  ] as const)('a tap on Disconnect board on %s disconnects, and opens no sheet', (_control, prop, control) => {
    // Not driving: solo with lighting on swipes off.
    setSetting('lightOnSwipe', false);
    disconnectAllBluetooth.mockClear();
    boardSheet.opened.mockClear();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = linkedBluetooth();
    linkedTo(bluetooth, true);
    const view = renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBe('lit');

    tap(prop);

    expect(disconnectAllBluetooth).toHaveBeenCalledOnce();
    expect(boardSheet.opened).not.toHaveBeenCalled();
    expect(bluetooth.clearBoard).not.toHaveBeenCalled();
    expect(lightbulbState.onPress).not.toHaveBeenCalled();
    expect(wallControlTapped).toHaveBeenCalledOnce();
    expect(wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control });
    // Letting go buzzes like a warning, and a screen reader hears it once the link drops.
    expect(wallHaptics.hapticWarning).toHaveBeenCalledOnce();
    expect(announceQueued).not.toHaveBeenCalled();
    act(() => {
      lightbulbState.localConnected = false;
      lightbulbState.lit = false;
      lightbulbState.pressAction = 'connect';
      bluetoothContext.value = { ...bluetooth, isConnected: false };
    });
    view.rerender(drawerElement());
    expect(announceQueued).toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
  });

  // Marco's bug: after a tap-disconnect the face stayed on, read from presence.
  it('puts no face up once the link is gone, whatever presence still says', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = linkedBluetooth();
    linkedTo(bluetooth, true);
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallHolder).toBe('self');

    // The link drops; presence has not caught up and still names a holder,
    // but nobody's link is authoritative.
    act(() => {
      lightbulbState.localConnected = false;
      lightbulbState.pressAction = 'connect';
      lightbulbState.lit = false;
      bluetoothContext.value = { ...bluetooth, isConnected: false };
    });
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallHolder).toBeNull();
    expect(recorded.actionBar.at(-1)?.wallControl).toMatchObject({ holder: null, holderFace: null });
  });

  // F1b: the lit button glows with the climb's holds, in the player's role colours.
  it('hands the lit wall button the climb’s holds, once per climb and frame', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    linkedTo(linkedBluetooth(), true);
    const view = renderDrawer();
    const glow = recorded.actionBar.at(-1)?.wallGlow as {
      key: string;
      holds: { x: number; y: number; color: string }[];
      boardWidth: number;
    } | null;
    expect(glow?.holds).toHaveLength(1);
    expect(glow?.holds[0]?.color).toMatch(/^#/);
    expect(glow?.boardWidth).toBeGreaterThan(0);
    // An unrelated re-render hands the same input, so the glow does no work.
    view.rerender(drawerElement());
    expect(recorded.actionBar.at(-1)?.wallGlow).toBe(glow);
  });

  it('hands no glow while the climb on screen is dark', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    linkedTo(linkedBluetooth(), false);
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallGlow).toBeNull();
  });

  // #7113: one rule, solo included. A press on the frosted button stops driving
  // and keeps the link; swipes go back to previews until the link drops.
  const nothingToArrange = (): void => {};
  const startLiveDrive = (): void => {
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    markDriveLive();
  };
  it.each<[string, () => void]>([
    ['solo with lighting on swipes', nothingToArrange],
    ['a live drive', startLiveDrive],
  ])('a tap on You are driving the wall (%s) stops driving and keeps the link', (_case, arrange) => {
    disconnectAllBluetooth.mockClear();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    linkedTo(linkedBluetooth(), true);
    act(() => arrange());
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControl).toMatchObject({
      driving: true,
      labelKey: 'youAreDriving',
      tapAction: 'stop_driving',
    });

    tap('onWallControl');

    expect(disconnectAllBluetooth).not.toHaveBeenCalled();
    expect(getDriveMode()).toBeNull();
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action: 'stop_driving', control: 'button' });
    expect(wallHaptics.hapticLight).toHaveBeenCalledOnce();
    expect(wallHaptics.hapticWarning).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControl).toMatchObject({
      driving: false,
      labelKey: 'disconnectBoard',
      tapAction: 'disconnect',
    });
  });

  // #7000, the tablet rule: beside a MiniPlayer (the open Duo's pane, a
  // tablet's player route) the player's first row is the wall button, and the
  // bar can draw the player's own board control.
  it('tells the bar the MiniPlayer stands in for its first row, and hands the bar its board control', async () => {
    const { usePaneWallControl } = await import('../pane-wall-control-store');
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    linkedTo(linkedBluetooth(), true);
    setSetting('lightOnSwipe', false);
    miniPlayerBeside.mirrors = true;
    onTestFinished(() => {
      miniPlayerBeside.mirrors = false;
    });
    const view = renderDrawer();
    expect(recorded.actionBar.at(-1)?.miniPlayerMirrors).toBe(true);
    const handed = renderHook(() => usePaneWallControl());
    expect(handed.result.current?.model.state).toBe('lit');
    // The bar's bulb runs the player's own handler, as `mini_bar`.
    act(() => handed.result.current?.press());
    expect(wallControlTapped).toHaveBeenLastCalledWith({ state: 'lit', action: 'disconnect', control: 'mini_bar' });
    view.unmount();
    handed.rerender();
    expect(handed.result.current).toBeNull();
  });

  it('hands the bar nothing on a phone', async () => {
    const { usePaneWallControl } = await import('../pane-wall-control-store');
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.miniPlayerMirrors).toBe(false);
    expect(renderHook(() => usePaneWallControl()).result.current).toBeNull();
  });

  // QA #147: the Climbs header's capsule opened the wall's climb with no link
  // on this phone, and the button said Put on the wall over a lit climb.
  describe('on the wall per presence, no link', () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    function unlinkedOnTheWall(sentAt: string) {
      queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
      wallClimbState.uuid = TWELVE_CLIMB.uuid;
      wallClimbState.sentAt = sentAt;
      // The #4979 hold: the auto-sender would keep the current climb dark.
      const bluetooth = {
        ...linkedBluetooth({ queueItemUuid: 'queue-twelve', lastCurrentChangeAt: Date.now() - 5 * 3600_000 }),
        isConnected: false,
      };
      bluetoothContext.value = bluetooth;
      lightbulbState.localConnected = false;
      lightbulbState.pressAction = 'connect';
      lightbulbState.lit = false;
      return bluetooth;
    }

    it('says the climb is on the wall under an hour, and the tap connects and lights it again through the hold', async () => {
      const bluetooth = unlinkedOnTheWall(minutesAgo(10));
      renderDrawer();
      const model = recorded.actionBar.at(-1)?.wallControl as { state: string; look: string; holder: unknown };
      expect(model).toMatchObject({ state: 'on_wall_unlinked', look: 'ready', holder: null });
      // No frost: the glow means "you have the board".
      expect(recorded.actionBar.at(-1)?.wallGlow).toBeNull();

      tap('onWallControl');
      await act(async () => {
        await Promise.resolve();
      });
      expect(lightbulbState.connect).toHaveBeenCalledWith(
        'play_drawer',
        expect.objectContaining({ uuid: TWELVE_CLIMB.uuid }),
      );
      // Lit explicitly, never left to the auto-send the hold would stop.
      expect(bluetooth.reassertWall).toHaveBeenCalledOnce();
      expect(wallControlTapped).toHaveBeenCalledWith({
        state: 'on_wall_unlinked',
        action: 'relight',
        control: 'button',
      });
    });

    it("offers a connect past the hour, never a preview's put-up", () => {
      unlinkedOnTheWall(minutesAgo(61));
      renderDrawer();
      expect(recorded.actionBar.at(-1)?.wallControlState).toBe('connect');
    });
  });

  it('hands the bar the climber’s board control choice', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    setSetting('playerButtonsV2', {
      version: 1,
      order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
      visible: { mirror: true, favorite: true, queue: true, share: false, angle: false },
      boardControl: 'lightbulb',
    });
    onTestFinished(() => resetAllSettings());
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.boardControl).toBe('lightbulb');
  });

  it("relays a tap on a crewmate's board to their phone, and never disconnects", () => {
    disconnectAllBluetooth.mockClear();
    lightbulbState.onPress.mockClear();
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    lightbulbState.holderIsAuthoritative = true;
    lightbulbState.pressAction = 'relay';
    onTestFinished(() => {
      lightbulbState.holderIsAuthoritative = false;
    });
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBe('crew');

    tap('onWallControl');

    expect(lightbulbState.onPress).toHaveBeenCalledOnce();
    expect(disconnectAllBluetooth).not.toHaveBeenCalled();
    expect(wallControlTapped).toHaveBeenCalledWith({ state: 'crew', action: 'relay', control: 'button' });
  });

  it('opens the board sheet from a hold on the wall button and from ⋯ › Board controls, connected', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    linkedTo(linkedBluetooth(), true);
    renderDrawer();

    const hold = recorded.actionBar.at(-1)?.onWallControlLongPress;
    if (typeof hold !== 'function') throw new Error('no hold');
    act(() => {
      hold();
    });
    expect(boardSheet.opened).toHaveBeenLastCalledWith({ surface: 'play_drawer', source: 'button' });
    expect(boardSheet.props.at(-1)).toMatchObject({ visible: true, showLightingSwitches: false });
    expect(disconnectAllBluetooth).not.toHaveBeenCalled();

    const menuRow = recorded.actionsMenu.at(-1)?.onOpenBoardControls;
    if (typeof menuRow !== 'function') throw new Error('no ⋯ › Board controls');
    act(() => {
      menuRow();
    });
    expect(boardSheet.opened).toHaveBeenLastCalledWith({ surface: 'play_drawer', source: 'player_menu' });
  });

  it('offers no hold and no ⋯ › Board controls without a link', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = { ...linkedBluetooth(), isConnected: false };
    lightbulbState.pressAction = 'connect';
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.onWallControlLongPress).toBeUndefined();
    expect(recorded.actionsMenu.at(-1)?.onOpenBoardControls).toBeUndefined();
  });

  // #7113 PR 3: the swipe, its screen-reader action, the frost it wipes in and
  // the board sheet's row, all behind `wall-swipe-to-drive`.
  describe('swipe to drive', () => {
    const putOnBoardWithNoLink = () => {
      queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
      bluetoothContext.value = { ...linkedBluetooth(), isConnected: false };
      lightbulbState.pressAction = 'connect';
    };

    it('wires nothing with the flag off: no swipe, no action, no frost, no sheet row', () => {
      putOnBoardWithNoLink();
      renderDrawer();
      const bar = recorded.actionBar.at(-1);
      expect(bar?.wallControl).toMatchObject({ swipeAction: 'drive' });
      expect(bar?.onWallControlSwipe).toBeUndefined();
      expect(bar?.onWallControlSwipeCancel).toBeUndefined();
      expect(bar?.onWallControlDrive).toBeUndefined();
      expect(bar?.wallGlow).toBeNull();
      expect(recorded.actionsMenu.at(-1)?.onOpenBoardControls).toBeUndefined();
    });

    it('hands the swipe, the action and the climb’s frost where the swipe is offered', () => {
      swipeToDrive.on = true;
      putOnBoardWithNoLink();
      renderDrawer();
      const bar = recorded.actionBar.at(-1);
      expect(bar?.onWallControlSwipe).toEqual(expect.any(Function));
      expect(bar?.onWallControlSwipeCancel).toEqual(expect.any(Function));
      expect(bar?.onWallControlDrive).toEqual(expect.any(Function));
      // Built for the climb on screen, though nothing is lit: the swipe wipes it in.
      const glow = bar?.wallGlow as { holds: unknown[] } | null;
      expect(glow?.holds).toHaveLength(1);
    });

    it('opens ⋯ › Board controls with no link, offering Light every climb', () => {
      swipeToDrive.on = true;
      putOnBoardWithNoLink();
      renderDrawer();
      const menuRow = recorded.actionsMenu.at(-1)?.onOpenBoardControls;
      if (typeof menuRow !== 'function') throw new Error('no ⋯ › Board controls');
      act(() => {
        menuRow();
      });
      expect(boardSheet.opened).toHaveBeenLastCalledWith({ surface: 'play_drawer', source: 'player_menu' });
      const sheet = boardSheet.props.at(-1);
      expect(sheet?.visible).toBe(true);
      expect(sheet?.onDrive).toEqual(expect.any(Function));
    });
  });

  it('re-lights the #4979 held climb on a tap, with no Put on the wall beside it', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = linkedBluetooth({
      queueItemUuid: 'queue-twelve',
      lastCurrentChangeAt: Date.parse('2026-10-20T08:00:00Z'),
    });
    linkedTo(bluetooth, true);
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.commitButton).toBeNull();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBe('dark');

    tap('onWallControl');

    expect(bluetooth.armUndoWallChangeToast).toHaveBeenCalledOnce();
    expect(bluetooth.reassertWall).toHaveBeenCalledOnce();
    expect(bluetooth.clearBoard).not.toHaveBeenCalled();
    expect(lightbulbState.onPress).not.toHaveBeenCalled();
  });

  it('gives a climb the connected wall can’t light no control, and a tap does nothing', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = linkedBluetooth();
    linkedTo(bluetooth, true);
    lightbulbState.ledless = true;
    renderDrawer();
    expect(recorded.actionBar.at(-1)?.wallControlState).toBeNull();

    tap('onWallControl');

    expect(bluetooth.reassertWall).not.toHaveBeenCalled();
    expect(bluetooth.clearBoard).not.toHaveBeenCalled();
    expect(lightbulbState.onPress).not.toHaveBeenCalled();
  });

  it('does not answer the busy-wall question from the bulb that comes back with it', () => {
    crew.shared = true;
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    const bluetooth = linkedBluetooth();
    linkedTo(bluetooth, false);
    const PREVIEW = climbOn('kilter', 1, 40, 'PREVIEW000000000000000000000CCCC');
    const props = {
      presentation: 'pane' as const,
      boardConfig: TWELVE_BY_TWELVE,
      openTarget: { climb: PREVIEW, nonce: 1 },
      onOpenQueue: vi.fn(),
    };
    const screen = render(createElement(PlayDrawer, props));
    expect(recorded.actionBar.at(-1)?.commitButton).toBe('putOnWall');

    // Someone lights a third climb while this climber looks around.
    wallClimbState.uuid = 'SOMEONE-ELSES-CLIMB';
    screen.rerender(createElement(PlayDrawer, props));
    flushOpeningFrame();
    tap('onWallControl');
    expect(recorded.actionBar.at(-1)?.commitButton).toBe('confirm');
    setCurrentClimb.mockClear();

    tap('onLightbulb');

    expect(recorded.actionBar.at(-1)?.commitButton).toBe('confirm');
    expect(setCurrentClimb).not.toHaveBeenCalled();
    expect(bluetooth.reassertWall).not.toHaveBeenCalled();
    expect(lightbulbState.onPress).not.toHaveBeenCalled();
    expect(wallControlTapped).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'noop', control: 'bulb' }));
  });

  it('hands the bar one model for both views, and the bulb’s tap runs the same handler', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    bluetoothContext.value = { ...linkedBluetooth(), isConnected: false };
    lightbulbState.pressAction = 'connect';
    renderDrawer();
    const props = recorded.actionBar.at(-1);
    expect(props?.wallControlState).toBe('connect');
    // The words come from the model (wall-control-text.ts); the layout rule is
    // pinned in resolve-action-bar-layout.test.ts.
    expect(props?.wallControl).toMatchObject({
      labelKey: 'putOnBoard',
      a11yHintKey: 'connectHint',
      tapAction: 'connect',
      swipeAction: 'drive',
    });

    tap('onLightbulb');

    // The current climb rides along: its board picks the board to connect to (#7001).
    expect(lightbulbState.connect).toHaveBeenCalledWith(
      'play_drawer',
      expect.objectContaining({ uuid: TWELVE_CLIMB.uuid }),
    );
  });
});
