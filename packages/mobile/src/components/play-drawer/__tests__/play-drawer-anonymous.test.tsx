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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderInitial, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

type Props = Record<string, unknown>;
const toggleFavorite = vi.hoisted(() => vi.fn());

const recorded = vi.hoisted(() => ({
  actionBar: [] as Props[],
  wallPill: [] as Props[],
  wallCallout: [] as Props[],
  deferredSections: [] as Props[],
  favoriteStatus: [] as Props[],
  navigationBoardConfigs: [] as unknown[],
  actionsMenu: [] as Props[],
  liveHeader: [] as Props[],
  trackEndCard: [] as Props[],
  workoutOverlay: [] as Props[],
  listContext: [] as Props[],
  swipeableHeader: [] as { next?: ReactNode; previous?: ReactNode }[],
  panePlaceholder: 0,
}));
// Signed out unless a case says otherwise: both viewers here render without a
// session, which is what the web export's read-only climb view is.
const auth = vi.hoisted(() => ({ isAuthenticated: false }));
// The board the climber is STANDING at, deliberately different from the
// boardConfig prop the drawer renders with (see the navigation-board case).
const activeBoard = vi.hoisted(() => ({
  current: {
    boardType: 'tension',
    layoutId: 8,
    sizeId: 20,
    setIds: '3',
    angle: 40,
  } as { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number } | null,
}));
const queueActions = vi.hoisted(() => ({
  setCurrentClimb: vi.fn(),
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  addToQueue: vi.fn(async () => 'added'),
  mirrorCurrentClimb: vi.fn(async () => true),
}));
// Mutable session fixtures: whether another climber is in the session, and the
// navigation state the drawer swipes through. Read at call time so a case can
// change them between renders — which is how "the latch survives the session
// ending" is exercised at all.
const session = vi.hoisted(() => ({
  isShared: false,
  useRealNavigation: false,
  suggestionSource: null as PlaylistSuggestionSource | null,
  sessionId: null as string | null,
  nextItem: null as { uuid: string; climb: unknown } | null,
  // The committed queue head. Null in the preview-only cases (the drawer renders
  // the pinned preview); set where a case needs a live climb to fall back to.
  currentItem: null as { uuid: string; climb: unknown } | null,
  // The real queue, read by `computeNavigationStateWithSuggestions` when
  // `useRealNavigation` is on. Empty by default: most cases here drive
  // navigation through the canned `nextItem` above instead.
  queue: [] as { uuid: string; climb: unknown }[],
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
  current: null as {
    isConnected: boolean;
    sendFramesToBoard: ReturnType<typeof vi.fn>;
    getMirrorIntent: ReturnType<typeof vi.fn>;
    setMirrorIntent: ReturnType<typeof vi.fn>;
    retainMirrorIntentFor: ReturnType<typeof vi.fn>;
  } | null,
}));

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
vi.mock('../use-deliberate-scroll-gesture', () => ({ useDeliberateScrollGesture: () => ({}) }));
vi.mock('../PlayDrawerSectionsSheet', () => ({ PlayDrawerSectionsSheet: () => null }));

// --- Host platform -----------------------------------------------------------
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  PixelRatio: { get: () => 3 },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// --- Shared packages ---------------------------------------------------------
vi.mock('@boardsesh/play-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/play-view')>();
  return {
    ...actual,
    // Real: the #5403 lineage rule (preview vs. committed track) is exactly
    // what the source-less-preview cases in this file exercise.
    resolveNavigationSuggestionSource: actual.resolveNavigationSuggestionSource,
    // The prefetch walk: these suites assert on the displayed board, not on
    // what is warmed ahead, so nothing is ahead.
    findUpcomingQueueItemsWithSuggestions: () => [],
    computeNavigationTargetsWithSuggestions: (
      ...args: Parameters<typeof actual.computeNavigationTargetsWithSuggestions>
    ) => {
      recorded.navigationBoardConfigs.push(args[3]);
      return session.useRealNavigation
        ? actual.computeNavigationTargetsWithSuggestions(...args)
        : {
            nextItem: session.nextItem,
            prevItem: null,
            canNext: session.nextItem != null,
            canPrevious: false,
          };
    },
    countRemainingQueueItemsWithSuggestions: (
      ...args: Parameters<typeof actual.countRemainingQueueItemsWithSuggestions>
    ) => (session.useRealNavigation ? actual.countRemainingQueueItemsWithSuggestions(...args) : 0),
    boardSupportsMirroring: () => true,
  };
});
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    ClimbShared: 'Climb Shared',
    FavoriteToggle: 'Favorite Toggle',
    QuickTickOpened: 'Quick Tick Opened',
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current, isPending: false }),
}));

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
// Recorded, not stubbed: only the host decides when the explainer opens, and
// there is no card of its own any more when a browse begins.
vi.mock('../WallStateCallout', () => ({
  WallStateCallout: (props: Props) => {
    recorded.wallCallout.push(props);
    return createElement('div', { 'data-testid': 'wall-callout' });
  },
}));
// Recorded: the end of a list (#6664) is a join this file pins, see below.
vi.mock('../TrackEndCard', () => ({
  TrackEndCard: (props: Props) => {
    recorded.trackEndCard.push(props);
    return createElement('div', { 'data-testid': 'track-end-card' });
  },
}));
// Recorded: the workout cards (#6291) wait while the end card owns the board.
vi.mock('../WorkoutRunnerOverlay', () => ({
  WorkoutRunnerOverlay: (props: Props) => {
    recorded.workoutOverlay.push(props);
    return null;
  },
}));
// Recorded: the top bar's "Projects · 4 of 23" (#6664) is a join this file pins.
vi.mock('../PlayListContext', () => ({
  PlayListContext: (props: Props) => {
    recorded.listContext.push(props);
    return createElement('div', { 'data-testid': 'play-drawer-track-label' });
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
vi.mock('../PlayDrawerStatusBarScrim', () => ({ PlayDrawerStatusBarScrim: () => null }));
vi.mock('../PlayDrawerHeader', () => ({
  useLivePlayDrawerHeaderModel: (props: Props) =>
    recorded.liveHeader.push(props) && props.climb
      ? {
          headerProps: props,
          reduceMotion: false,
          layoutFingerprint: JSON.stringify(props.climb),
        }
      : null,
  PreparedPlayDrawerHeader: ({ leading }: { leading?: ReactNode }) => createElement('div', null, leading),
  LivePlayDrawerHeader: ({ leading }: { leading?: ReactNode }) => createElement('div', null, leading),
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: (props: { current?: ReactNode; next?: ReactNode; previous?: ReactNode }) => {
    recorded.swipeableHeader.push(props);
    return createElement('div', null, props.current);
  },
}));
vi.mock('../SwitchBoardOverlay', () => ({ SwitchBoardOverlay: () => null }));
vi.mock('../AngleSelectorSheet', () => ({ AngleSelectorSheet: () => null }));
vi.mock('../../LogAscentSheet', () => ({ LogAscentSheet: () => null }));
// The player's ⋯: whether it is there at all, and what the drawer hands it.
vi.mock('../PlayDrawerActionsMenu', () => ({
  PlayDrawerActionsMenu: (props: Props) => {
    recorded.actionsMenu.push(props);
    return null;
  },
}));
vi.mock('../../AddToPlaylistSheet', () => ({ AddToPlaylistSheet: () => null }));
// The lost-hold banner and the Remix handoff behind it, stubbed like every
// other collaborator above. Both reach native modules this suite has no runtime
// for: the banner through the design-system Button, the handoff through Sentry.
vi.mock('../LostHoldsBanner', () => ({ LostHoldsBanner: () => null }));
vi.mock('../../create-climb/use-create-climb-navigation', () => ({
  useCreateClimbNavigation: () => ({ openRemix: vi.fn(), openEdit: vi.fn(), resetActionGuard: vi.fn() }),
}));
vi.mock('../../AddBetaVideoSheet', () => ({ AddBetaVideoSheet: () => null }));
vi.mock('../logbook/LogbookFullSheet', () => ({ LogbookFullSheet: () => null }));
vi.mock('../ClimberLogsSheet', () => ({ ClimberLogsSheet: () => null }));
vi.mock('../../report-climb/ReportClimbSheet', () => ({ ReportClimbSheet: () => null }));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../queue-control/RestTimerPillHost', () => ({ RestTimerPillHost: () => null }));
vi.mock('../../ChromeIconButton', () => ({
  ChromeIconButton: ({
    onPress,
    accessibilityLabel,
    icon,
    testID,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    icon: string;
    testID?: string;
  }) =>
    createElement('button', {
      onClick: onPress,
      'aria-label': accessibilityLabel,
      'data-icon': icon,
      'data-testid': testID,
    }),
  useChromeIconButtonSize: () => 44,
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ queue: session.queue, currentClimbQueueItem: session.currentItem }),
  useQueueActions: () => queueActions,
  useQueueSessionId: () => ({ sessionId: session.sessionId }),
  useIsSharedSession: () => session.isShared,
  usePlaylistSuggestionSource: () => session.suggestionSource,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ble.current }));
// Board presence, read continuously so the pill can say "On the wall" after any
// navigation and the confirm has a before-and-after to compare.
vi.mock('../use-wall-climb', () => ({ useWallClimb: () => wall }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: undefined }),
  useToggleFavorite: () => ({ mutate: toggleFavorite }),
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

/**
 * The iPad pane by default. `'route'` is the phone's sheet: it has a ⌄ to close,
 * so an empty queue is not somewhere for the back chip to go.
 */
type Presentation = 'pane' | 'route';

function drawerElement(
  viewer: 'member' | 'anonymous',
  openTarget:
    | ReturnType<typeof openTargetFor>
    | ReturnType<typeof committedTargetFor>
    | ReturnType<typeof freshTargetFor>,
  onSignIn?: () => void,
  presentation: Presentation = 'pane',
) {
  return createElement(PlayDrawer, {
    presentation,
    viewer,
    boardConfig: BOARD_CONFIG,
    openTarget,
    onOpenQueue: vi.fn(),
    onSignIn,
  });
}

function renderDrawer(viewer: 'member' | 'anonymous', onSignIn?: () => void, presentation?: Presentation) {
  return render(drawerElement(viewer, openTargetFor(CLIMB), onSignIn, presentation));
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

/** How many times the joined-a-crew sentence reached the screen reader. */
function joinedNoticeAnnouncements(): number {
  return vi
    .mocked(AccessibilityInfo.announceForAccessibility)
    .mock.calls.filter(([sentence]) => sentence === 'playView.wallState.joinedBrowseNotice').length;
}

/** Taps the header pill as last rendered (or the given render of it). */
function pressWallPill(pillProps: Props | undefined = recorded.wallPill.at(-1)): void {
  if (!pillProps) throw new Error('WallStatePill never rendered');
  (pillProps.onPress as () => void)();
}

function lastActionBarProps(): Props {
  const props = recorded.actionBar.at(-1);
  if (!props) throw new Error('PlayDrawerActionBar never rendered');
  return props;
}

function lastSimilarClimbHandler(): (climb: Climb, similarClimbs?: Climb[]) => void {
  const props = recorded.deferredSections.at(-1);
  if (!props) throw new Error('DeferredSections never rendered');
  return props.onSimilarClimbPress as (climb: Climb, similarClimbs?: Climb[]) => void;
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
  openingFrames.clear();
  nextOpeningFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    openingFrames.set(++nextOpeningFrame, callback);
    return nextOpeningFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => openingFrames.delete(handle));
  vi.clearAllMocks();
  recorded.actionBar = [];
  recorded.wallPill = [];
  recorded.wallCallout = [];
  recorded.deferredSections = [];
  recorded.favoriteStatus = [];
  recorded.navigationBoardConfigs = [];
  recorded.actionsMenu = [];
  recorded.liveHeader = [];
  recorded.trackEndCard = [];
  recorded.workoutOverlay = [];
  recorded.listContext = [];
  recorded.swipeableHeader = [];
  recorded.panePlaceholder = 0;
  queueActions.addToQueue.mockResolvedValue('added');
  session.isShared = false;
  session.useRealNavigation = false;
  session.suggestionSource = null;
  session.sessionId = null;
  session.nextItem = null;
  session.currentItem = null;
  session.queue = [];
  wall.uuid = null;
  lightbulb.lit = false;
  wall.name = null;
  wall.sentAt = null;
  ble.current = null;
  resetAllSettings();
  _resetJoinedBrowseNoticeForTests();
  drawerSections.sections = { ...drawerSections.defaults };
  drawerSections.ready = true;
  auth.isAuthenticated = false;
});
afterEach(() => vi.unstubAllGlobals());

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
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill?.state).toBe('browsing');
    // The latch is up, so the chip may say the wall stays where it is.
    expect(pill?.latched).toBe(true);
    // The wall is dark: back lands on the climber's own climb, with no face.
    expect(pill?.backTarget).toBe('current');
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    // No face on the chip, so the bulb's pip keeps its place.
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });

  it('puts the face on the back chip when the wall shows the crew’s current climb', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill?.state).toBe('browsing');
    expect(pill?.backTarget).toBe('wall');
    // The chip carries the driver's face, so the bulb's pip stands down.
    expect(lastActionBarProps().showHolderBadge).toBe(false);
    // The commit bar is told which climb is lit, to name who put it up.
    expect(lastActionBarProps().wallClimbUuid).toBe(SIMILAR_CLIMB.uuid);
  });

  it('sends the back chip to the climber’s own climb when the wall shows a third one', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)).toMatchObject({ state: 'browsing', backTarget: 'current' });
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });

  // The back chip goes back to the committed climb. With nothing committed (a
  // crew that hasn't lit anything yet) it would empty the sheet, so it stays
  // away (⌄ closes) while Put on the wall, the one way forward, stays.
  it('keeps the back chip away in the sheet when there is nothing committed to go back to', () => {
    CREW();
    renderDrawer('member', undefined, 'route');

    expect(recorded.wallPill).toHaveLength(0);
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    // No chip, no face in the header: the bulb's pip is the only one left.
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });

  // The iPad pane has no ⌄, and its empty placeholder is somewhere to land.
  it('keeps the back chip in the iPad pane with nothing committed, going to the placeholder', () => {
    CREW();
    renderDrawer('member', undefined, 'pane');

    expect(recorded.wallPill.at(-1)).toMatchObject({ state: 'browsing', backTarget: 'current' });
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });

  // Solo with lighting on, a lit wall makes the pill say Live. A pinned preview
  // over a committed climb shows the back chip instead: back to live used to
  // be in the second row, and the header chip is the one way back now.
  it('gives a solo pinned preview the back chip, not Live, while the wall is lit', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    lightbulb.lit = true;
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill?.state).toBe('browsing');
    expect(pill?.backTarget).toBe('wall');
    // Lighting is on and no latch is up, so the chip makes no "the wall stays
    // where it is" promise.
    expect(pill?.latched).toBe(false);
    expect(lastActionBarProps().showHolderBadge).toBe(false);
    expect(lastActionBarProps().commitButton).toBe('putOnWall');

    // Its tap is the way back, not the explainer.
    recorded.wallPill = [];
    act(() => {
      pressWallPill(pill);
    });
    expect(recorded.wallCallout).toHaveLength(0);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    // Back on the lit climb: the chip is On the wall again.
    expect(recorded.wallPill.at(-1)?.state).toBe('onWall');
  });

  it('gives a solo pinned preview the back chip to the climber’s climb while a different one is lit', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    lightbulb.lit = true;
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill).toMatchObject({ state: 'browsing', backTarget: 'current', latched: false });
    expect(lastActionBarProps().showHolderBadge).toBe(true);

    act(() => {
      pressWallPill(pill);
    });
    // Back on the committed climb with a different one lit: Live, as before.
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    expect(recorded.wallPill.at(-1)).toMatchObject({ state: 'live', backTarget: null });
  });

  // A preview of the committed climb itself: back goes nowhere, so there is no
  // back chip, even in the pane and under a crew's latch.
  it('shows no back chip when the preview is the committed climb', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member', undefined, 'pane');

    expect(recorded.wallPill).toHaveLength(0);
    expect(lastActionBarProps().showHolderBadge).toBe(true);
  });

  it('keeps Live, not a back chip, on a solo preview of the committed climb', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    lightbulb.lit = true;
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)).toMatchObject({ state: 'live', backTarget: null });
  });

  // Solo with lighting on and nothing lit, a pinned preview has no pill of its
  // own. The back chip stands in for the Back to live the second row used to
  // carry, so the climber can still return to their climb without closing.
  it('gives a solo pinned preview with nothing lit the back chip', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
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

  // Before #5403's fix, a browse that walked onto a suggestion-track peek
  // CAPTURED that track into `drawerPreviewSuggestionSource` on the first swipe
  // (`crewCapturedSuggestionSourceRef`), so it kept going even after the
  // provider's own committed track was cleared out from under it — a private
  // copy of a list the climber's browse had no independent claim to. That
  // capture is gone: a preview belongs to ONE lineage (the track it was opened
  // with, or none), so once the committed track disappears there is nothing
  // left to walk. A mid-browse peek is never in the real queue either (it is
  // only inserted on commit), so the queue has no fallback successor for it —
  // the swipe is a dead end, not a landing on `thirdClimb`.
  it.each(['next', 'previous'] as const)(
    'stops at a dead end instead of continuing on a captured copy after a peer leaves the track',
    (direction) => {
      CREW();
      session.useRealNavigation = true;
      const thirdClimb = { ...CLIMB, uuid: 'third-climb', name: 'Third climb' };
      const climbs = direction === 'next' ? [CLIMB, SIMILAR_CLIMB, thirdClimb] : [thirdClimb, SIMILAR_CLIMB, CLIMB];
      session.suggestionSource = {
        playlistUuid: 'list-1',
        activatedClimbUuid: CLIMB.uuid,
        boardKey: 'kilter:1:10:1,20',
        climbs,
      } as unknown as PlaylistSuggestionSource;
      session.currentItem = { uuid: 'queue-current', climb: CLIMB };
      const target = committedTargetFor(CLIMB);
      const view = render(drawerElement('member', target));
      const swipe = () => {
        const props = lastActionBarProps();
        (props[direction === 'next' ? 'onNextClick' : 'onPrevClick'] as () => void)();
      };
      act(swipe);
      expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);

      // The provider clears its shared track when a peer commits outside it.
      session.currentItem = { uuid: 'peer-current', climb: { ...CLIMB, uuid: 'outside-list' } };
      session.suggestionSource = null;
      view.rerender(drawerElement('member', target));
      act(swipe);

      expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
      expect(queueActions.nextClimb).not.toHaveBeenCalled();
      expect(queueActions.previousClimb).not.toHaveBeenCalled();
      expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
      expect(queueActions.addToQueue).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'releases only a crew-captured track after departure (explicit preview: %s)',
    (explicitPreview) => {
      vi.useFakeTimers();
      try {
        CREW();
        session.useRealNavigation = true;
        const thirdClimb = { ...CLIMB, uuid: 'third-climb' };
        const source = {
          playlistUuid: 'list-1',
          activatedClimbUuid: CLIMB.uuid,
          boardKey: 'kilter:1:10:1,20',
          climbs: [CLIMB, SIMILAR_CLIMB, thirdClimb],
        } as unknown as PlaylistSuggestionSource;
        session.suggestionSource = source;
        session.currentItem = { uuid: 'queue-current', climb: CLIMB };
        const target = explicitPreview
          ? { ...openTargetFor(CLIMB), options: { ...openTargetFor(CLIMB).options, playlistSuggestionSource: source } }
          : committedTargetFor(CLIMB);
        const view = render(drawerElement('member', target));
        act(() => {
          (lastActionBarProps().onNextClick as () => void)();
        });
        expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);

        session.isShared = false;
        session.sessionId = null;
        view.rerender(drawerElement('member', target));
        act(() => {
          vi.advanceTimersByTime(SHARED_BROWSE_LATCH_RELEASE_MS);
        });
        act(() => {
          (lastActionBarProps().onNextClick as () => void)();
        });

        if (explicitPreview) {
          expect(lastDisplayedClimbUuid()).toBe(thirdClimb.uuid);
          expect(queueActions.nextClimb).not.toHaveBeenCalled();
        } else {
          expect(queueActions.nextClimb).toHaveBeenCalledOnce();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('previews a similar climb instead of double-writing it', () => {
    CREW();
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    return act(async () => {
      onSimilarClimbPress(SIMILAR_CLIMB);
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
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
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
  // climber never started — and a Put on the wall for a climb already up.
  it('leaves an open of the current climb exactly as it was', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', freshTargetFor(CLIMB)));

    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastActionBarProps().commitButton).toBeNull();
    expect(recorded.wallPill.at(-1)?.state).not.toBe('browsing');
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
    expect(lastActionBarProps().commitButton).toBeNull();
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
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    // One target object across both renders, so re-rendering doesn't re-run the
    // drawer's open effect and confuse the state under test.
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    // The crew evaporates.
    session.isShared = false;
    session.sessionId = null;
    view.rerender(drawerElement('member', target));

    expect(lastActionBarProps().commitButton).toBe('putOnWall');
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

  // Browsing, the header chip is the way back. On the wall and Live it is an
  // indicator that opens the explainer. The pill only calls what it is handed,
  // so which handler PlayCore hands it is the contract.
  it('hands the browsing pill Back to live, not the explainer', () => {
    CREW();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    render(drawerElement('member', openTargetFor(CLIMB)));
    const browsingPill = recorded.wallPill.at(-1);
    expect(browsingPill?.state).toBe('browsing');
    recorded.wallPill = [];

    act(() => {
      pressWallPill(browsingPill);
    });

    // Back on the committed head: no explainer, nothing sent, the latch is gone.
    expect(recorded.wallCallout).toHaveLength(0);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    expect(recorded.wallPill.filter((props) => props.state === 'browsing')).toHaveLength(0);
    expect(lastActionBarProps().commitButton).toBeNull();
  });

  it('keeps the on-the-wall pill an indicator that opens the explainer', () => {
    CREW();
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));
    expect(recorded.wallPill.at(-1)?.state).toBe('onWall');

    act(() => {
      pressWallPill();
    });

    expect(recorded.wallCallout.at(-1)?.state).toBe('onWall');
    expect(lastDisplayedClimbUuid()).toBe(CLIMB.uuid);
  });

  it('drops the latch on Back to live, so the next swipe drives the wall again', () => {
    CREW();
    // A committed head to fall back to, on a different climb than the preview.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));

    // The browsing chip in the header is the way back now.
    act(() => {
      pressWallPill();
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

  // Joining a crew silently changes what a swipe does, so the drawer says so to
  // a screen reader — once. Sighted climbers get Put on the wall and the back
  // chip appearing; no card goes over the board any more.
  it('explains the new rule once, the first time the latch engages, without a card', () => {
    CREW();
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(joinedNoticeAnnouncements()).toBe(1);
    expect(recorded.wallCallout).toHaveLength(0);
  });

  it('does not explain it again on the next drawer open in the same session', () => {
    CREW();
    render(drawerElement('member', openTargetFor(CLIMB))).unmount();
    vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear();

    // The drawer is a modal route: it unmounts on every dismiss, which is why the
    // claim can't live in component state.
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(joinedNoticeAnnouncements()).toBe(0);
  });

  it('never explains it to a climber with no wall to explain', () => {
    // Board lighting off for swipes, but no board connected, no session and
    // nothing lit: "the wall stays put" would be a sentence about something this
    // climber hasn't got — the commit button reads "Set active" here for the same
    // reason.
    setSetting('lightOnSwipe', false);
    renderDrawer('member');

    expect(joinedNoticeAnnouncements()).toBe(0);
  });

  // The solo half of the same rule (#4640): turning board lighting off for swipes
  // and taps quietly makes navigation view-only, and nothing else says so.
  it('explains view-only navigation to a solo climber standing at a lit board', () => {
    setSetting('lightOnSwipe', false);
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    const rendered = render(drawerElement('member', openTargetFor(CLIMB)));
    expect(joinedNoticeAnnouncements()).toBe(1);
    expect(recorded.wallCallout).toHaveLength(0);
    rendered.unmount();
  });

  it('tells that climber once, not once per drawer open', () => {
    // Unlike the crew claim, this one is a decision about a device the climber
    // keeps — so it is persisted, and a cold start does not re-explain it.
    setSetting('lightOnSwipe', false);
    wall.uuid = 'wall-climb-a';
    render(drawerElement('member', openTargetFor(CLIMB))).unmount();
    vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear();

    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(joinedNoticeAnnouncements()).toBe(0);
  });

  // Spoken from here on BOTH platforms: the drawer can open straight into a
  // browse, where there is no transition for the wall-state announcer to narrate.
  it('speaks the rule when the latch engages', () => {
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

// Issue #5403: a preview that carries no suggestion source of its own must
// navigate the QUEUE, never a track left behind by an earlier, unrelated
// activation. `resolveNavigationSuggestionSource` (@boardsesh/play-view) is
// pinned pure elsewhere; what only a render can see is that PlayDrawer actually
// calls it instead of falling back to the provider's committed source, and that
// nothing captures that committed source into the preview later either.
describe('PlayDrawer — source-less preview walks the queue (#5403)', () => {
  // A climb list carrying no board metadata classifies as 'unknown' rather than
  // 'incompatible', so the mismatched `activeBoard` default in this file (tension)
  // never interferes with the queue walk under test.
  const climb = (uuid: string, name: string): Climb => ({ ...CLIMB, uuid, name }) as unknown as Climb;

  it('walks the queue instead of a leftover track when a source-less preview swipes', () => {
    // Forces the swipe to stay view-only even solo, so the drawer's own
    // navigation resolves the target rather than a mocked `nextClimb()`.
    setSetting('lightOnSwipe', false);
    session.useRealNavigation = true;
    const a = climb('climb-a', 'A');
    const p = climb('climb-p', 'P');
    const z = climb('climb-z', 'Z');
    const q = climb('climb-q', 'Q');
    // The provider is still tracking an EARLIER activation's list — [A, P, Z] —
    // which a source-less preview must never inherit.
    session.suggestionSource = {
      playlistUuid: 'climblist',
      activatedClimbUuid: a.uuid,
      boardKey: 'kilter:1:10:1,20',
      climbs: [a, p, z],
    } as unknown as PlaylistSuggestionSource;
    const itemA = { uuid: 'queue-a', climb: a };
    const itemP = { uuid: 'queue-p', climb: p };
    const itemQ = { uuid: 'queue-q', climb: q };
    session.currentItem = itemA;
    session.queue = [itemA, itemP, itemQ];

    // A list tap that pins P as a preview with no suggestion source of its own.
    render(drawerElement('member', { climb: p, options: { previewQueueItem: itemP }, nonce: 1 }));

    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });

    expect(lastDisplayedClimbUuid()).toBe(q.uuid);
  });

  it('does not capture a leftover track on the second swipe of a source-less browse', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    session.useRealNavigation = true;
    const a = climb('climb-a', 'A');
    const p = climb('climb-p', 'P');
    const z = climb('climb-z', 'Z');
    const q = climb('climb-q', 'Q');
    const r = climb('climb-r', 'R');
    session.suggestionSource = {
      playlistUuid: 'climblist',
      activatedClimbUuid: a.uuid,
      boardKey: 'kilter:1:10:1,20',
      climbs: [a, p, z],
    } as unknown as PlaylistSuggestionSource;
    const itemA = { uuid: 'queue-a', climb: a };
    const itemP = { uuid: 'queue-p', climb: p };
    const itemQ = { uuid: 'queue-q', climb: q };
    const itemR = { uuid: 'queue-r', climb: r };
    session.currentItem = itemA;
    session.queue = [itemA, itemP, itemQ, itemR];

    render(drawerElement('member', { climb: p, options: { previewQueueItem: itemP }, nonce: 1 }));

    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(lastDisplayedClimbUuid()).toBe(q.uuid);

    // If the old bug's capture still fired, this second swipe would have picked
    // up [A, P, Z] on the first swipe and landed on Z here instead of the queue's
    // real successor.
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(lastDisplayedClimbUuid()).toBe(r.uuid);
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

    expect(lastActionBarProps().commitButton).toBe('confirm');
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
    expect(lastActionBarProps().commitButton).not.toBe('confirm');

    // Their own auto-sender lights the queue head mid-preview.
    wall.uuid = 'wall-climb-head';
    wall.name = 'My Own Climb';
    view.rerender(drawerElement('member', target));

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  // The question row speaks when it mounts (PlayDrawerCommitBar, stubbed here);
  // saying it from the commit tap too would read the question twice.
  it('leaves speaking the question to the question row', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().commitButton).toBe('confirm');
    const spoken = vi.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([sentence]) => sentence);
    expect(spoken.filter((sentence) => sentence.startsWith('playView.wallState.commitOverride'))).toEqual([]);
  });

  // Put on the wall keeps the heart and the queue in the row (angle and share
  // already wait in ⋯). The question takes the whole row, so ⋯ picks up the
  // rest of it too.
  it('hands the row the question took to ⋯', () => {
    browseThenLoseTheWall();
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: false,
      queue: false,
      share: true,
      angle: true,
    });

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: true,
      queue: true,
      share: true,
      angle: true,
    });
  });

  it('commits on the second tap, marked as Put on the wall', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb.mock.calls[0][0].climb.uuid).toBe(CLIMB.uuid);
    expect(queueActions.setCurrentClimb.mock.calls[0][1]).toMatchObject({ trigger: 'put_on_wall' });
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

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
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
    expect(lastActionBarProps().commitButton).toBe('confirm');

    // "Keep theirs" IS the exit — the row is handed the same handler.
    act(() => {
      (lastActionBarProps().onKeepTheirs as () => void)();
    });

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('stands down when the climber browses on', () => {
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    browseThenLoseTheWall();
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().commitButton).toBe('confirm');

    // The question was "put THIS up instead of theirs" — and this isn't on
    // screen any more.
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
  });

  it('stands down when the conflict resolves itself', () => {
    const { view, target } = browseThenLoseTheWall();
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().commitButton).toBe('confirm');

    // The other climber put back what was up when this browse began. There is
    // no longer anything to take.
    act(() => {
      wall.uuid = 'wall-climb-a';
      wall.name = 'What Was Up';
      view.rerender(drawerElement('member', target));
    });

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
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

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
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

    expect(lastActionBarProps().commitButton).toBe('confirm');
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

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
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
    ble.current = {
      isConnected: true,
      sendFramesToBoard: vi.fn(async () => true),
      getMirrorIntent: vi.fn(),
      setMirrorIntent: vi.fn(),
      retainMirrorIntentFor: vi.fn(),
    };
    return ble.current;
  };

  it.each(['normal', 'legacy-cpp', 'selected-cpp'] as const)(
    'isolates a restored shared-session mirror only for new explicit CPP selections (%s)',
    (mode) => {
      const previousMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      const previousCommands = process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS;
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = mode === 'normal' ? '0' : '1';
      process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS =
        mode === 'selected-cpp' ? '{"hero-1":{"route":"/climbs?screenshotClimbId=real"}}' : '{}';
      queueActions.mirrorCurrentClimb.mockClear();
      try {
        session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
        const { rerender } = render(drawerElement('member', committedTargetFor(CLIMB)));
        // Restore after the local surface was eligible: the action must use the
        // current session state, rather than trusting the earlier capture gate.
        session.sessionId = 'restored-session';
        session.isShared = true;
        rerender(drawerElement('member', committedTargetFor(CLIMB)));
        act(() => {
          (lastActionBarProps().onMirror as () => void)();
        });
        // mirrorCurrentClimb is the provider's setQueueMirrored dispatch path.
        expect(queueActions.mirrorCurrentClimb).toHaveBeenCalledTimes(mode === 'selected-cpp' ? 0 : 1);
        if (mode !== 'selected-cpp')
          expect(queueActions.mirrorCurrentClimb).toHaveBeenCalledWith(true, 'queue-item-current');
      } finally {
        if (previousMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
        else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = previousMode;
        if (previousCommands === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS;
        else process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS = previousCommands;
      }
    },
  );

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

  it('still states the live mirror intent when nothing is pinned', () => {
    const bluetooth = connectBle();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));

    act(() => {
      (lastActionBarProps().onMirror as () => void)();
    });

    // The provider owns the write and reads the explicit solo mirror intent.
    expect(bluetooth.setMirrorIntent).toHaveBeenCalledWith(CLIMB.uuid, true);
  });
});

describe('PlayDrawer — the anonymous joins', () => {
  it('hands its own viewer and sign-in prompt to the action bar', () => {
    const onSignIn = vi.fn();
    renderDrawer('anonymous', onSignIn);

    const props = lastActionBarProps();
    // Hardcoding `viewer="member"` here is invisible to every action-bar test,
    // which passes `viewer` in directly: it would restore the queue button, the
    // heart, the lightbulb and the tick sheet for a signed-out reader with the
    // whole suite green.
    expect(props.viewer).toBe('anonymous');
    // The tick is the only conversion prompt on the surface. With the prop
    // dropped in the middle, the bar calls `onSignInPress?.()` on undefined and
    // the tap silently does nothing.
    expect(typeof props.onSignInPress).toBe('function');
    (props.onSignInPress as () => void)();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  // A signed-out reader has no ⋯ and no Settings, so a member's "Hide all" left
  // in this browser would strand them with nothing below the board and no way
  // back. They get the defaults instead, ready at once: there is nothing to read.
  it('gives a signed-out reader the default sections, whatever this device stored', () => {
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
    drawerSections.ready = false;
    renderDrawer('anonymous');

    expect(recorded.deferredSections.at(-1)?.sections).toEqual(drawerSections.defaults);
  });

  // Same reason as the sections: the reader can't reach View options to put the
  // controls back, so a member's choice left in this browser never applies.
  it('keeps the controls under the board for a signed-out reader, whatever this device stored', () => {
    setSetting('playerButtonsPosition', 'above');
    const screen = renderDrawer('anonymous');
    const board = screen.getByTestId('board');
    expect(board.compareDocumentPosition(screen.getByTestId('action-bar')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(lastActionBarProps().edge).toBe('top');
  });

  it('moves a member’s controls above the board', () => {
    setSetting('playerButtonsPosition', 'above');
    const screen = renderDrawer('member');
    const bar = screen.getByTestId('action-bar');
    expect(bar.compareDocumentPosition(screen.getByTestId('board')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(lastActionBarProps().edge).toBe('bottom');
  });

  it("keeps a member's stored Hide all", () => {
    auth.isAuthenticated = true;
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
    renderDrawer('member');

    expect(recorded.deferredSections).toHaveLength(0);
  });

  // A guest without an account is still a member viewer: ⋯ → View options and
  // Settings → Climb view both write the stored choices, so the drawer has to
  // honour them. Only the anonymous reader, who can reach neither, is overridden.
  it('keeps a signed-out member viewer on their stored Hide all', () => {
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
    renderDrawer('member');

    expect(auth.isAuthenticated).toBe(false);
    expect(recorded.deferredSections).toHaveLength(0);
  });

  // The reader gets the default sections, and Active holds is off by default.
  it('never shows a signed-out reader Active holds, even when this device switched it on', () => {
    drawerSections.sections = { ...drawerSections.defaults, activeHolds: true };
    renderDrawer('anonymous');
    expect(recorded.deferredSections.at(-1)?.sections).toEqual(drawerSections.defaults);
    expect(drawerSections.defaults.activeHolds).toBe(false);
  });

  it('shows Active holds to a member who switched it on', () => {
    drawerSections.sections = { ...drawerSections.defaults, activeHolds: true };
    renderDrawer('member');
    expect(recorded.deferredSections.at(-1)?.sections).toMatchObject({ activeHolds: true });
  });

  it("keeps a signed-out member viewer's partial choices too", () => {
    drawerSections.sections = { ...drawerSections.defaults, logbook: false };
    renderDrawer('member');

    expect(recorded.deferredSections.at(-1)?.sections).toEqual(drawerSections.sections);
  });

  // Every ⋯ row is an account action, and the reader's route gate bounces most
  // of their targets to login.
  it('gives a signed-out reader no ⋯, and a member one', () => {
    const anonymous = renderDrawer('anonymous');
    expect(recorded.actionsMenu).toHaveLength(0);
    anonymous.unmount();

    renderDrawer('member');
    expect(recorded.actionsMenu.at(-1)).toBeDefined();
  });

  it('passes the member viewer through unchanged', () => {
    renderDrawer('member');
    expect(lastActionBarProps().viewer).toBe('member');
  });

  it('writes nothing when a signed-out reader taps a similar climb', async () => {
    renderDrawer('anonymous');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      onSimilarClimbPress(SIMILAR_CLIMB);
    });

    // Both halves matter. `addToQueue` is a queue a signed-out visitor cannot
    // carry anywhere; `setCurrentClimb` re-arms the BLE auto-sender, and the
    // browser export is the one surface where Web Bluetooth is mounted.
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    // It still swaps what the drawer shows — Similar Climbs is the best reason
    // a visitor has to keep looking, so a dead tap would be its own regression.
    expect((recorded.deferredSections.at(-1)?.climb as Climb).uuid).toBe(SIMILAR_CLIMB.uuid);
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
  });

  // Issue #6665: a member's tap plays from the similar-climbs strip. It goes
  // up once, inserted after the current climb, and is never appended to the
  // end of the queue first.
  it('activates a similar climb for a member, playing from the strip, without queuing it', async () => {
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      onSimilarClimbPress(SIMILAR_CLIMB, [SIMILAR_CLIMB]);
    });

    expect(queueActions.addToQueue).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: SIMILAR_CLIMB.uuid }) }),
      {
        playlistSuggestionSource: expect.objectContaining({
          activatedClimbUuid: SIMILAR_CLIMB.uuid,
          label: 'playView.track.similarClimbs',
        }),
      },
    );
  });

  it('shows a signed-out reader no wall-state chrome at all', () => {
    renderDrawer('anonymous');
    // The anonymous drawer is ALWAYS a preview (that is what keeps the queue
    // untouched), so ungated wall chrome would put a back chip and a live Put on
    // the wall button on every read-only open — and that button's press is
    // `setCurrentClimb`, the same queue write and BLE re-arm the similar-climb
    // guard above blocks.
    expect(recorded.wallPill).toHaveLength(0);
    expect(lastActionBarProps().commitButton).toBeNull();
  });

  it('gives a member previewing a climb the back chip and Put on the wall', () => {
    // The browse latch is "a preview whose navigation genuinely stays view-only",
    // which with no suggestion source means lightOnSwipe off.
    setSetting('lightOnSwipe', false);
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    renderDrawer('member');

    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');
    const props = lastActionBarProps();
    expect(props.commitButton).toBe('putOnWall');
    expect(props.onCommit).toBeTypeOf('function');
    // No BLE link, no session, no known lit climb — the button must not promise
    // a lighting it cannot do.
    expect(props.commitLabel).toBe('setActive');
  });

  // Put on the wall needs the room: one button keeps its place on each side
  // (the heart, and the queue on this mirror board) and the angle and share
  // wait in ⋯ until the climb is up.
  it('keeps the heart in the row while browsing, and hands the angle and share to ⋯', () => {
    setSetting('lightOnSwipe', false);
    renderDrawer('member');

    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: false,
      queue: false,
      angle: true,
      share: true,
    });
  });

  // The chrome's whole premise is that it never claims more than it can keep.
  // With lightOnSwipe ON and no suggestion source, `getSwipeNavigationTarget`
  // sends the next swipe through `setCurrentClimb` — the shared-queue write and
  // BLE re-arm — so a browsing chip ("the wall stays where it is") would be
  // lying about the very next gesture. The commit BUTTON is the one piece that
  // stays: the pinned climb still needs its activation button (the old banner's
  // "Set active" contract), and dropping it here would strand the explicit
  // Preview action with no way to promote.
  it('withholds the browse promise — but not the commit button — from a preview whose next swipe would commit', () => {
    // The sheet, with nothing committed: back has nowhere to go, so no chip.
    const sheet = renderDrawer('member', undefined, 'route');

    expect(recorded.wallPill).toHaveLength(0);
    const props = lastActionBarProps();
    expect(props.commitButton).toBe('putOnWall');
    expect(props.commitLabel).toBe('setActive');
    sheet.unmount();

    // The iPad pane can go back to its placeholder, so it gets the back chip,
    // but never the latch's "the wall stays where it is".
    recorded.wallPill = [];
    renderDrawer('member', undefined, 'pane');
    expect(recorded.wallPill.at(-1)).toMatchObject({ state: 'browsing', backTarget: 'current', latched: false });
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
  });

  it('drops the latch when a member taps the back chip', () => {
    setSetting('lightOnSwipe', false);
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    renderDrawer('member');
    expect(recorded.wallPill.at(-1)?.state).toBe('browsing');

    act(() => {
      pressWallPill();
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

  it('applies a new preview after the simultaneous solo angle reset', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    session.nextItem = { uuid: 'queue-item-next', climb: CLIMB };
    const view = render(elementAtAngle(40, trackedTargetFor(CLIMB)));
    const replacementTarget = { ...trackedTargetFor(SIMILAR_CLIMB), nonce: 2 };

    view.rerender(elementAtAngle(45, replacementTarget));

    // If target application ran before the angle reset, the committed climb
    // would win and the new tracked preview would silently lose its authority.
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    act(() => (lastActionBarProps().onNextClick as () => void)());
    expect(lastDisplayedClimbUuid()).toBe(CLIMB.uuid);
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
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
    expect(lastActionBarProps().commitButton).toBe('putOnWall');

    view.rerender(elementAtAngle(45, target));

    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
  });
});

// Issue #5099. Forward navigation skips queued climbs the wall can't draw, and
// the board it scans against decides which ones. `boardConfig` is NOT that
// board: it is `boardConfigOverride ?? storedActiveBoardConfig`, so opening a
// Kilter climb from the board sheet while standing at a Tension board would
// scan the Tension queue against Kilter, call every remaining climb
// incompatible and kill canNext — a dead swipe under an action bar still
// reading "N left". PR #5102 rebinds these same destructured names to the
// DISPLAYED CLIMB's board, which would invert the fix without a merge conflict,
// so this case is the guard.
describe('PlayDrawer — which board forward navigation is scanned against', () => {
  it('scans against the active board, not the board config it renders with', () => {
    renderDrawer('member');
    // BOARD_CONFIG is kilter/layout 1; the climber is standing at tension/layout 8.
    expect(recorded.navigationBoardConfigs.at(-1)).toEqual({ boardName: 'tension', layoutId: 8 });
  });

  it('scans against nothing when no board is active, so nothing is skipped', () => {
    activeBoard.current = null;
    try {
      renderDrawer('member');
      expect(recorded.navigationBoardConfigs.at(-1)).toBeUndefined();
    } finally {
      activeBoard.current = { boardType: 'tension', layoutId: 8, sizeId: 20, setIds: '3', angle: 40 };
    }
  });
});

// Issue #6664: the player names the list it walks and stops at its end. The
// rules are pure and tested in @boardsesh/play-view (`resolveTrackLabel`, the
// end-of-track result) and in `track-end.test.ts`; what only a render can see
// is that PlayCore wires them in. Dropping any of the three joins below (the
// top bar label, Next staying live at the end, Next opening the card) left every
// other test green.
describe('PlayDrawer — the list it walks, and its end (#6664)', () => {
  const climb = (uuid: string, name: string): Climb => ({ ...CLIMB, uuid, name }) as unknown as Climb;
  const first = climb('climb-first', 'First');
  const last = climb('climb-last', 'Last');
  const queued = climb('climb-queued', 'Queued');
  // The climber stands at a Tension wall (`activeBoard`): a Kilter climb is
  // still queued, and the walk passes over it.
  const offBoard = { ...climb('climb-off-board', 'Queued'), boardType: 'kilter', layoutId: 1 } as unknown as Climb;
  const itemFirst = { uuid: 'queue-first', climb: first };
  const itemLast = { uuid: 'queue-last', climb: last };
  const itemQueued = { uuid: 'queue-queued', climb: queued };
  const itemOffBoard = { uuid: 'queue-off-board', climb: offBoard };
  const projects = {
    playlistUuid: 'smart:projects:user',
    activatedClimbUuid: first.uuid,
    boardKey: 'kilter:1:10:1,20',
    climbs: [first, last],
    label: 'Projects',
    total: 2,
  } as unknown as PlaylistSuggestionSource;

  /** On the list's last climb with `upNext` queued after it (#6777: Next plays it first). */
  function onTheLastClimbOfProjects(upNext: ClimbQueueItem = itemQueued) {
    session.useRealNavigation = true;
    session.suggestionSource = projects;
    session.queue = [itemFirst, itemLast, upNext];
    session.currentItem = itemLast;
    render(drawerElement('member', committedTargetFor(last)));
  }

  function lastLiveHeaderProps(): Props {
    const props = recorded.liveHeader.at(-1);
    if (!props) throw new Error('the live header never rendered');
    return props;
  }

  function pressNext() {
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
  }

  function lastTrackEndCardProps(): Props {
    const props = recorded.trackEndCard.at(-1);
    if (!props) throw new Error('the end card never opened');
    return props;
  }

  /** What the top bar says about the list, or null when it says nothing. */
  function lastListParts(): unknown {
    return recorded.listContext.at(-1)?.parts ?? null;
  }

  it('names the list in the top bar while it walks one, with the count', () => {
    onTheLastClimbOfProjects();
    expect(lastListParts()).toEqual({
      name: 'Projects',
      count: 'playView.track.position',
      accessibilityLabel: 'playView.track.playingFromPositionAria',
    });
  });

  // On the stats line it pushed the sends and stars off the end of a phone.
  it('keeps the list off the header, so its stats line has the sends and stars', () => {
    onTheLastClimbOfProjects();
    expect(lastLiveHeaderProps()).not.toHaveProperty('trackLabel');
  });

  it('still names the list in a crew', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    onTheLastClimbOfProjects();
    expect(lastListParts()).toMatchObject({ name: 'Projects' });
  });

  /** The props of the header waiting beside the current one. */
  function neighbourHeaderProps(side: 'next' | 'previous'): Props | undefined {
    const neighbour = recorded.swipeableHeader.at(-1)?.[side];
    if (!neighbour || typeof neighbour !== 'object' || !('props' in neighbour)) return undefined;
    return neighbour.props as Props;
  }

  // The header sliding in once promised the list, and a crew's swipe opens a
  // preview that walks none (#5403). The top bar doesn't swipe and names only
  // the climb on screen, so no header, sliding in or not, carries a list.
  it('never promises a list on the header sliding in, even when the swipe opens a preview (crew)', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    onTheLastClimbOfProjects();
    const previous = neighbourHeaderProps('previous');
    expect(previous).toBeDefined();
    expect(previous).not.toHaveProperty('trackLabel');
  });

  it('names nothing for a climb with no list', () => {
    session.useRealNavigation = true;
    session.queue = [itemLast, itemQueued];
    session.currentItem = itemLast;
    render(drawerElement('member', committedTargetFor(last)));
    expect(lastListParts()).toBeNull();
    // Playing from the queue, Next is Up next already: no badge.
    expect(lastActionBarProps().upNextBadgeCount).toBeNull();
  });

  // #6777: what you queue plays before the list continues, so the last list
  // climb's Next goes into Up next, not to the end card.
  it('plays Up next from the last climb of the list before any end card', () => {
    onTheLastClimbOfProjects();
    expect(lastActionBarProps().canSwipeNext).toBe(true);

    pressNext();

    expect(queueActions.nextClimb).toHaveBeenCalledTimes(1);
    expect(recorded.trackEndCard).toHaveLength(0);
  });

  it('says Up next in the top bar while a queued climb plays in the middle of the list', () => {
    session.useRealNavigation = true;
    session.suggestionSource = { ...projects, resume: { climbUuid: first.uuid, queueItemUuid: itemFirst.uuid } };
    session.queue = [itemFirst, itemQueued, itemLast];
    session.currentItem = itemQueued;
    render(drawerElement('member', committedTargetFor(queued)));

    expect(lastListParts()).toEqual({
      name: 'playView.track.upNext',
      count: 'playView.track.position',
      accessibilityLabel: 'playView.track.upNextPositionAria',
    });
  });

  it('keeps Next live at the end of the list, and opens the end card once Up next is done', () => {
    onTheLastClimbOfProjects(itemOffBoard);
    expect(lastActionBarProps().canSwipeNext).toBe(true);
    expect(recorded.trackEndCard).toHaveLength(0);

    pressNext();

    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    // The Kilter climb is all that is left queued: the card still offers it.
    expect(lastTrackEndCardProps().model).toMatchObject({
      listName: 'Projects',
      upNextCount: 1,
      firstUpNextName: 'Queued',
      action: { kind: 'nextInQueue', target: itemOffBoard },
    });
  });

  // #6291: the rest and workout-done cards share the board with the end card,
  // so they wait while it is open, and they are for the climb on screen.
  it('holds the workout cards back while the end card owns the board', () => {
    session.sessionId = 'session-1';
    // Up next is for another board, so Next opens the end card instead of playing it.
    onTheLastClimbOfProjects(itemOffBoard);
    expect(recorded.workoutOverlay.at(-1)).toMatchObject({
      sessionId: 'session-1',
      run: null,
      displayedQueueItemUuid: itemLast.uuid,
      suppressed: false,
    });

    pressNext();

    expect(recorded.trackEndCard.length).toBeGreaterThan(0);
    expect(recorded.workoutOverlay.at(-1)).toMatchObject({ suppressed: true });
  });

  // #6238: Next plays the list, so the queue button keeps Up next in sight.
  it('badges the queue button with Up next while it walks a list', () => {
    onTheLastClimbOfProjects();
    expect(lastActionBarProps().upNextBadgeCount).toBe(1);
  });

  it('carries on with the queue solo, leaving the list behind', () => {
    onTheLastClimbOfProjects(itemOffBoard);
    pressNext();

    act(() => {
      (lastTrackEndCardProps().onKeepGoing as () => void)();
    });

    expect(queueActions.setCurrentClimb).toHaveBeenCalledWith(itemOffBoard, { playlistSuggestionSource: null });
  });

  it('only previews the queued climb with a crew here, so the wall stays put', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    onTheLastClimbOfProjects(itemOffBoard);
    pressNext();

    act(() => {
      (lastTrackEndCardProps().onKeepGoing as () => void)();
    });

    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(offBoard.uuid);
  });
});

// The caption on the top bar's second line (#6667 panel, confusions 1 and 4;
// #6745 moved it off the stats line). The rule is table-tested in
// `wall-state.test.ts`; what only a render can see is that PlayDrawer feeds it
// the preview, the crew and the wall it actually has.
describe('PlayDrawer — the browse caption', () => {
  function lastCaption(): unknown {
    // No list, no stage and no caption: the top bar context is not rendered.
    return recorded.listContext.at(-1)?.caption ?? null;
  }

  it('says a solo preview is not lit while a climb is on the wall', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBe('playView.wallState.previewNotLit');
  });

  it('says nothing solo with no board connected and nothing lit', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBeNull();
  });

  it('tells a crew the look is private and what the wall is on', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBe('playView.wallState.onlyYouSeeThisWallOn');
  });

  it('says nothing once the climb on screen is the lit one', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBeNull();
  });

  it('says nothing to the signed-out reader', () => {
    session.isShared = true;
    wall.uuid = SIMILAR_CLIMB.uuid;
    renderDrawer('anonymous');

    expect(lastCaption()).toBeNull();
  });
});
