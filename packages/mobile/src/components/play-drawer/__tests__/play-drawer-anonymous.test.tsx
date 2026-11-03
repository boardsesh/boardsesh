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
import { render as renderInitial, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { configKey, type ClimbQueueItem, type PlaylistSuggestionSource } from '@boardsesh/queue';

type Props = Record<string, unknown>;
const toggleFavorite = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());

const recorded = vi.hoisted(() => ({
  actionBar: [] as Props[],
  wallPill: [] as Props[],
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
  boardSheet: [] as Props[],
  previewFirstTip: [] as Props[],
  board: [] as Props[],
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
  } as {
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
    uuid?: string;
    gymUuid?: string | null;
  } | null,
}));
const gymBoards = vi.hoisted(() => ({ current: undefined as UserBoard[] | undefined }));
const queueActions = vi.hoisted(() => ({
  setCurrentClimb: vi.fn(),
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  addToQueue: vi.fn(async () => 'added'),
  mirrorCurrentClimb: vi.fn(async () => true),
  getQueueSnapshot: () => ({
    sessionId: session.sessionId,
    queue: session.queue,
    currentClimbQueueItem: session.currentItem,
  }),
}));
// Mutable session fixtures: whether another climber is in the session, and the
// navigation state the drawer swipes through. Read at call time so a case can
// change them between renders — which is how "the latch survives the session
// ending" is exercised at all.
const session = vi.hoisted(() => ({
  isShared: false,
  // The roster's crew (`useIsCrewSession`); null reads `isShared`. The two differ
  // while the browse latch outlives a crew that just left.
  isCrew: null as boolean | null,
  useRealNavigation: false,
  suggestionSource: null as PlaylistSuggestionSource | null,
  sessionId: null as string | null,
  nextItem: null as { uuid: string; climb: unknown } | null,
  // The committed queue head. Null in the preview-only cases (the drawer renders
  // the pinned preview); set where a case needs a live climb to fall back to.
  currentItem: null as {
    uuid: string;
    climb: unknown;
    addedByUser?: { id: string; username: string };
  } | null,
  currentClimbMover: null as { username: string; avatarUrl: string | null } | null,
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
// `pressAction` is what a tap on the bulb would do; 'connect' is the
// disconnected phone Put on the wall connects from (#6939).
const lightbulb = vi.hoisted(() => ({
  lit: false,
  holderIsAuthoritative: false,
  pressAction: 'noop' as string,
  pending: false,
  localConnected: false,
  connect: vi.fn(async () => true),
  moveToClimbBoard: vi.fn(async () => true),
  // A board with no lights (a wall this phone takes and releases, nothing to light).
  ledless: false,
}));
const wall = vi.hoisted(() => ({
  uuid: null as string | null,
  name: null as string | null,
  // Server-stamped. Only the cold-start cases set it: it is how a read that
  // merely ARRIVED late is told from a climb a peer lit mid-browse.
  sentAt: null as string | null,
  // The climb a crewmate's Turn off all lights left dark, per the feed (#7015).
  clearedClimbUuid: null as string | null,
}));
// The BLE link. Null (no transport) unless a case needs to watch what does and
// doesn't reach the board.
const ble = vi.hoisted(() => ({
  current: null as {
    isConnected: boolean;
    sendFramesToBoard: ReturnType<typeof vi.fn>;
    wallHeldByOtherUser?: boolean;
    reassertWall?: ReturnType<typeof vi.fn>;
    armUndoWallChangeToast?: ReturnType<typeof vi.fn>;
    staleCurrentHold?: { queueItemUuid: string; lastCurrentChangeAt: number } | null;
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
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  PixelRatio: { get: () => 3 },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  AccessibilityInfo: { announceForAccessibility: announceMock },
}));
// The settings store backs the player's settings (Always drive the wall, Stop
// driving after, In a session too). Kept in memory so each case can set them.
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
  // Main's RNGH 2 preview keeps the legacy handler under its original name.
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Gesture: { Simultaneous: (...gestures: unknown[]) => ({ gestures }) },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => undefined,
  useSharedValue: (initial: unknown) => ({ value: initial }),
  runOnJS: (fn: unknown) => fn,
}));
const routerMock = vi.hoisted(() => ({ dismiss: vi.fn(), push: vi.fn() }));
vi.mock('expo-router', () => ({ router: routerMock }));
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
vi.mock('@boardsesh/analytics', async (importOriginal) => ({
  SHARED_EVENTS: {
    ClimbShared: 'Climb Shared',
    FavoriteToggle: 'Favorite Toggle',
    QuickTickOpened: 'Quick Tick Opened',
  },
  // Put on board's keep-lighting starts a drive (2.7): the store reports it.
  driveModeStarted: (properties: unknown) => ({ name: 'Drive Mode Started', properties }),
  driveModeEnded: (properties: unknown) => ({ name: 'Drive Mode Ended', properties }),
  // Pure: the reason a preview reports is the real rule.
  wallControlPreviewReason: (await importOriginal<typeof import('@boardsesh/analytics')>()).wallControlPreviewReason,
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
// Queue Navigation's payloads have their own suites (use-play-selection-controller,
// play-drawer-cross-board); the analytics package is stubbed above.
const queueAnalytics = vi.hoisted(() => ({ navigation: vi.fn() }));
vi.mock('../../../lib/queue-navigation-analytics', () => ({
  trackQueueNavigation: queueAnalytics.navigation,
  trackQueueSheetOpened: vi.fn(),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current, isPending: false }),
}));

// --- Children ----------------------------------------------------------------
// Recorded rather than stubbed: these three carry the props under test.
// The tablet rule (#7000) reads the device's chrome; a phone here.
vi.mock('../use-mini-player-mirrors', () => ({ useMiniPlayerMirrorsPlayer: () => false }));
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
vi.mock('../WallStatePill', () => ({
  WallStatePill: (props: Props) => {
    recorded.wallPill.push(props);
    return createElement('div', { 'data-testid': 'wall-state-pill' });
  },
}));
// Recorded, not stubbed: only the host decides when the explainer opens, and
// there is no card of its own any more when a browse begins.
// Record the real resolver's result, including a climb for another board at
// the same gym, where the switch-board scrim stays hidden.
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
vi.mock('../DeferredBoard', () => ({
  DeferredBoard: (props: Props) => {
    recorded.board.push(props);
    return createElement('div', { 'data-testid': 'board' });
  },
}));
// The preview-first card's seen flag. Seen unless a case says otherwise, so the
// card stays out of every other case here.
const previewFirstSeen = vi.hoisted(() => ({ current: true }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: async () => previewFirstSeen.current,
  markTipSeen: async () => undefined,
}));
// The one-shot preview-first card (2.7): recorded, so a case can see where the
// player puts it and what it hands it.
vi.mock('../../onboarding/PlayerPreviewTip', () => ({
  PlayerPreviewTip: (props: Props) => {
    recorded.previewFirstTip.push(props);
    return createElement('div', { 'data-testid': 'player-preview-tip' });
  },
}));
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
vi.mock('../../ble/BleControlSheetHost', () => ({
  BleControlSheetHost: (props: Props) => {
    recorded.boardSheet.push(props);
    return null;
  },
}));
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
  useQueueData: () => ({
    queue: session.queue,
    currentClimbQueueItem: session.currentItem,
    currentClimbMover: session.currentClimbMover,
  }),
  useQueueActions: () => queueActions,
  useQueueSessionId: () => ({ sessionId: session.sessionId }),
  useIsSharedSession: () => session.isShared,
  useIsCrewSession: () => session.isCrew ?? session.isShared,
  usePlaylistSuggestionSource: () => session.suggestionSource,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ble.current }));
// Board presence, read continuously so the pill can say "On the wall" after any
// navigation and the confirm has a before-and-after to compare.
vi.mock('../use-wall-climb', () => ({
  useWallClimb: () => wall,
  usePresenceClearedClimbUuid: () => wall.clearedClimbUuid,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGymBoards: () => ({ data: gymBoards.current }),
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
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => null }));
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
  useLightbulbControl: () => ({
    lit: lightbulb.lit,
    localConnected: lightbulb.localConnected,
    pending: lightbulb.pending,
    onPress: vi.fn(),
    pressAction: lightbulb.pressAction,
    holderIsAuthoritative: lightbulb.holderIsAuthoritative,
    connect: lightbulb.connect,
    moveToClimbBoard: lightbulb.moveToClimbBoard,
    ledless: lightbulb.ledless,
  }),
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
const haptics = vi.hoisted(() => ({ selection: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({
  hapticSuccess: vi.fn(),
  hapticMedium: vi.fn(),
  hapticWarning: vi.fn(),
  hapticSelection: haptics.selection,
}));
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 100, boardHeight: 100, holdsData: [], imagesToHolds: {} }),
}));

// `play-drawer-navigation`, `play-drawer-layout`, `wall-state`,
// and `boardsesh-grade-display` stay REAL — the wiring of
// those helpers into the render is exactly what this file exists to measure.

const { AccessibilityInfo } = await import('react-native');
const { PlayDrawer, SHARED_BROWSE_LATCH_RELEASE_MS } = await import('../PlayDrawer');
const { getSetting, setSetting, resetAllSettings } = await import('../../../settings');
const { _resetJoinedBrowseNoticeForTests } = await import('../joined-browse-notice');
const { resetPreviewNotesForTests } = await import('../use-then-signposts');
// Put on board's keep-lighting arms a drive (2.7): each test starts with nobody driving.
const { getDriveMode, resetDriveModeForTests, startAlwaysDrive, stopDrivingForLink } =
  await import('../drive-mode-store');

/**
 * Always drive the wall's drive, as `DriveModeWatcher` starts it once this
 * phone's link is up: every change of climb lights the wall. The player reads
 * the drive store, so the watcher itself is not mounted here.
 */
function driveTheWall(): void {
  setSetting('alwaysDrive', true);
  startAlwaysDrive({ sessionId: null, boardId: null });
}
const { _resetPreviewFirstTipForTests, getPreviewFirstTipState } =
  await import('../../../lib/onboarding/preview-first-tip');
const { markWallCleared, resetWallCleared } = await import('../../ble/wall-cleared-store');
const { BUSY_WALL_TAP_DEBOUNCE_MS } = await import('../busy-wall-question');
const { clearLetsGo, showLetsGo } = await import('../board-lets-go-store');
const { QueueSessionBoardPathContext } = await import('../../../providers/queue/queue-contexts');

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

/**
 * Runs `answer` once the busy-wall question's tap debounce has run out: taps in
 * its first 500 ms are dropped (`useBusyWallQuestion`).
 */
function afterBusyWallDebounce(answer: () => void): void {
  const realNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + BUSY_WALL_TAP_DEBOUNCE_MS);
  try {
    act(answer);
  } finally {
    clock.mockRestore();
  }
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
  lightbulb.pressAction = 'noop';
  lightbulb.pending = false;
  lightbulb.localConnected = false;
  lightbulb.ledless = false;
  activeBoard.current = { boardType: 'tension', layoutId: 8, sizeId: 20, setIds: '3', angle: 40 };
  gymBoards.current = undefined;
  resetWallCleared();
  recorded.actionBar = [];
  recorded.boardSheet = [];
  recorded.wallPill = [];
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
  recorded.previewFirstTip = [];
  recorded.board = [];
  resetPreviewNotesForTests();
  queueActions.addToQueue.mockResolvedValue('added');
  session.isShared = false;
  session.isCrew = null;
  session.useRealNavigation = false;
  session.suggestionSource = null;
  session.sessionId = null;
  session.nextItem = null;
  session.currentItem = null;
  session.currentClimbMover = null;
  session.queue = [];
  wall.uuid = null;
  lightbulb.lit = false;
  wall.name = null;
  wall.sentAt = null;
  wall.clearedClimbUuid = null;
  lightbulb.holderIsAuthoritative = false;
  ble.current = null;
  resetAllSettings();
  resetDriveModeForTests();
  _resetJoinedBrowseNoticeForTests();
  _resetPreviewFirstTipForTests();
  previewFirstSeen.current = true;
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
// #7000: the wall button says Put on board (a connect) on the climber's own climb; Put
// on the wall is for previews and crew browsing.
describe('PlayDrawer — the wall button with no board connected (#6939, #7000)', () => {
  it('offers Put on board on the current climb, and the tap connects', () => {
    lightbulb.pressAction = 'connect';
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member');

    const bar = lastActionBarProps();
    expect(bar.commitButton).toBeNull();
    expect(bar.wallControlState).toBe('connect');
    act(() => (bar.onWallControl as () => void)());
    // The climb rides along: its board picks the board to connect to (#7001).
    expect(lightbulb.connect).toHaveBeenCalledWith('play_drawer', expect.objectContaining({ uuid: CLIMB.uuid }));
  });

  it('leaves the current climb alone when a tap on the bulb would not connect', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member');

    expect(lastActionBarProps().commitButton).toBeNull();
  });

  it('labels a preview Put on the wall, not Set active, and connects after setting it', () => {
    lightbulb.pressAction = 'connect';
    renderDrawer('member');

    const bar = lastActionBarProps();
    expect(bar.commitButton).toBe('putOnWall');
    expect(bar.wallControlState).toBe('put_on_wall');
    expect(bar.commitLabel).toBe('putOnWall');
    act(() => (bar.onWallControl as () => void)());
    // The climb just set, which the queue may not report yet, picks the board
    // to connect to (#7001).
    expect(lightbulb.connect).toHaveBeenCalledWith('put_on_wall', expect.objectContaining({ uuid: CLIMB.uuid }));
  });

  it('keeps Set active on a preview when a tap would not connect', () => {
    renderDrawer('member');

    expect(lastActionBarProps().commitLabel).toBe('setActive');
    act(() => (lastActionBarProps().onWallControl as () => void)());
    expect(lightbulb.connect).not.toHaveBeenCalled();
  });

  it('keeps Put on board while the connect it started is still finding the board', () => {
    lightbulb.pending = true;
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member');

    expect(lastActionBarProps().wallControlState).toBe('connect');
  });

  it('is not offered while another account holds the board', () => {
    lightbulb.pressAction = 'connect';
    ble.current = {
      isConnected: false,
      sendFramesToBoard: vi.fn(async () => true),
      wallHeldByOtherUser: true,
    };
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member');

    expect(lastActionBarProps().commitButton).toBeNull();
  });

  const linkWith = (extra: Partial<NonNullable<typeof ble.current>> = {}) => {
    ble.current = {
      isConnected: false,
      sendFramesToBoard: vi.fn(async () => true),
      reassertWall: vi.fn(),
      armUndoWallChangeToast: vi.fn(),
      staleCurrentHold: null,
      ...extra,
    };
    return ble.current;
  };

  // Codex review: a climb unchanged for 4 h is held dark on the connect's first
  // write, and the tap that asked for it must not need a second tap.
  it('releases a 4 h hold the connect it started runs into', () => {
    lightbulb.pressAction = 'connect';
    const link = linkWith();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    const { rerender } = renderDrawer('member');
    act(() => (lastActionBarProps().onWallControl as () => void)());

    link.staleCurrentHold = { queueItemUuid: 'queue-item-current', lastCurrentChangeAt: 0 };
    ble.current = { ...link };
    rerender(drawerElement('member', openTargetFor(CLIMB)));

    expect(ble.current.reassertWall).toHaveBeenCalledTimes(1);
  });

  it('leaves a hold alone when no tap asked for the climb', () => {
    const link = linkWith({ staleCurrentHold: { queueItemUuid: 'queue-item-current', lastCurrentChangeAt: 0 } });
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('member');

    expect(link.reassertWall).not.toHaveBeenCalled();
  });

  // Codex review: Turn off all lights leaves the link up and the queue still.
  it('reads the climb as dark after the lights were turned off, and a tap re-lights it', () => {
    lightbulb.lit = true;
    lightbulb.localConnected = true;
    lightbulb.pressAction = 'disconnect';
    const link = linkWith({ isConnected: true });
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    markWallCleared(CLIMB.uuid);
    renderDrawer('member');

    const bar = lastActionBarProps();
    expect(bar.commitButton).toBeNull();
    expect(bar.wallControlState).toBe('dark');
    act(() => (bar.onWallControl as () => void)());
    expect(link.reassertWall).toHaveBeenCalledTimes(1);
    expect(lastActionBarProps().wallControlState).toBe('lit');
  });

  it('never offers it to the signed-out reader', () => {
    lightbulb.pressAction = 'connect';
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    renderDrawer('anonymous');

    expect(lastActionBarProps().commitButton).toBeNull();
  });
});

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
    // Lit a minute ago: with no link, presence is trusted for an hour (QA #147).
    wall.sentAt = new Date(Date.now() - 60_000).toISOString();
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill?.state).toBe('browsing');
    expect(pill?.backTarget).toBe('wall');
    // The chip carries the driver's face, so the bulb's pip stands down.
    expect(lastActionBarProps().showHolderBadge).toBe(false);
    // No question is up, so the bar has no busy-wall model to draw.
    expect(lastActionBarProps().busyWall).toBeNull();
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

  // A pinned preview over a committed climb shows the back chip: the header
  // chip is the one way back, and since #7000 the header's only chip.
  it('gives a solo pinned preview the back chip while the wall is lit', () => {
    driveTheWall();
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
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    // Back on the lit climb: no chip; the wall button says it is lit.
    expect(recorded.wallPill).toHaveLength(0);
  });

  it('gives a solo pinned preview the back chip to the climber’s climb while a different one is lit', () => {
    driveTheWall();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    lightbulb.lit = true;
    renderDrawer('member');

    const pill = recorded.wallPill.at(-1);
    expect(pill).toMatchObject({ state: 'browsing', backTarget: 'current', latched: false });
    expect(lastActionBarProps().showHolderBadge).toBe(true);

    recorded.wallPill = [];
    act(() => {
      pressWallPill(pill);
    });
    // Back on the committed climb: no chip at all.
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    expect(recorded.wallPill).toHaveLength(0);
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

  it('draws no chip at all on a solo preview of the committed climb, whatever the wall shows', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    lightbulb.lit = true;
    renderDrawer('member');

    expect(recorded.wallPill).toHaveLength(0);
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
  // CAPTURED the provider's track into `drawerPreviewSuggestionSource`
  // (`crewCapturedSuggestionSourceRef`), and #5403 took that capture out: a
  // preview walked the track it was opened with, or none. That left a look off
  // the climb on the wall with no list at all, so its swipes stopped after one
  // list climb, or at the end of the queue (#7227). Now the step itself hands
  // the look the list it walked, with its place in Up next: the climber's own
  // list, the one they were already walking, not a leftover from an older tap.
  // A crewmate moving the wall off it changes what is on the wall, not the
  // list this phone is looking down, so the look keeps going, writing nothing.
  it.each(['next', 'previous'] as const)(
    'keeps walking the list it stepped onto after a peer moves the wall off it (%s)',
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

      // A peer commits outside the list: the provider's track stops steering.
      session.currentItem = { uuid: 'peer-current', climb: { ...CLIMB, uuid: 'outside-list' } };
      session.suggestionSource = null;
      view.rerender(drawerElement('member', target));
      act(swipe);

      expect(lastDisplayedClimbUuid()).toBe(thirdClimb.uuid);
      expect(queueActions.nextClimb).not.toHaveBeenCalled();
      expect(queueActions.previousClimb).not.toHaveBeenCalled();
      expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
      expect(queueActions.addToQueue).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps the list a look walks once the crew leaves and the wall is driven (explicit preview: %s)',
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
        // Solo again, this phone starts driving (Always drive the wall's drive
        // once the link is up): the next step lights.
        act(() => {
          driveTheWall();
        });
        view.rerender(drawerElement('member', target));
        act(() => {
          (lastActionBarProps().onNextClick as () => void)();
        });

        // The climber's own list stays, whether the list tap opened the preview
        // or a swipe off the climb on the wall handed it over (#7227): the
        // climb the peek shows goes up, from that list.
        expect(queueActions.setCurrentClimb).toHaveBeenCalledWith(
          expect.objectContaining({ climb: expect.objectContaining({ uuid: thirdClimb.uuid }) }),
          expect.objectContaining({ playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'list-1' }) }),
        );
        // Only the look off the climb on the wall says it is one, so only its
        // step keeps the queue whatever it walked past; the list tap's prunes.
        const [, stepOptions] = queueActions.setCurrentClimb.mock.calls.at(-1) as [
          unknown,
          { playlistSuggestionSource: PlaylistSuggestionSource },
        ];
        expect(stepOptions.playlistSuggestionSource.lookOffWall).toBe(explicitPreview ? undefined : true);
        expect(queueActions.nextClimb).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('previews a similar climb instead of double-writing it', async () => {
    CREW();
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    // Awaited, not chained: React's act thenable returns nothing from `then`, so
    // a returned `act(...).then(...)` let these assertions run during whichever
    // later case first yielded to the event loop.
    await act(async () => {
      onSimilarClimbPress(SIMILAR_CLIMB);
    });
    // The member branch appends to the crew's queue AND takes the wall.
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
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
    driveTheWall();
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
    // #6940: the latch made that step a preview, so it reports the crew mode
    // that decided it, not the roster that just emptied.
    expect(queueAnalytics.navigation).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: 'next', method: 'button', outcome: 'preview', inSharedSession: true }),
      expect.objectContaining({ player_layout_version: 3, player_previous_next: false }),
    );
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

    expect(queueAnalytics.navigation).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'preview', inSharedSession: true }),
      expect.anything(),
    );

    // ...and then lets go, without the climber having to find a button: the
    // next step reads solo. Outside a drive it still only looks.
    act(() => {
      vi.advanceTimersByTime(SHARED_BROWSE_LATCH_RELEASE_MS + 100);
    });
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(queueAnalytics.navigation).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'preview', inSharedSession: false }),
      expect.anything(),
    );

    // Driving from here (Always drive the wall's drive), the climb its peek
    // shows goes up, not the queue's next from the wall.
    act(() => {
      driveTheWall();
    });
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uuid: 'queue-item-next' }),
      expect.objectContaining({ keepWalkedTrack: true, trigger: 'next' }),
    );
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
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lastDisplayedClimbUuid()).toBe(SIMILAR_CLIMB.uuid);
    expect(recorded.wallPill.filter((props) => props.state === 'browsing')).toHaveLength(0);
    expect(lastActionBarProps().commitButton).toBeNull();
  });

  // #7000: the header has no On the wall chip; the wall button says it.
  it('draws no header chip on the lit climb in a crew', () => {
    CREW();
    // A crewmate's link drives the wall.
    lightbulb.lit = true;
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));
    expect(recorded.wallPill).toHaveLength(0);
    expect(lastDisplayedClimbUuid()).toBe(CLIMB.uuid);
  });

  it('drops the latch on Back to live, so the next swipe drives the wall again', () => {
    driveTheWall();
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
    renderDrawer('member');

    expect(joinedNoticeAnnouncements()).toBe(0);
  });

  // The solo half of the same rule (#4640): turning board lighting off for swipes
  // and taps quietly makes navigation view-only, and nothing else says so.
  it('explains view-only navigation to a solo climber standing at a lit board', () => {
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    const rendered = render(drawerElement('member', openTargetFor(CLIMB)));
    expect(joinedNoticeAnnouncements()).toBe(1);
    rendered.unmount();
  });

  it('tells that climber once, not once per drawer open', () => {
    // Unlike the crew claim, this one is a decision about a device the climber
    // keeps — so it is persisted, and a cold start does not re-explain it.
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

// Issue #7227: since 2.7 nothing lights unless this phone drives the wall, so
// every swipe off the climb on the wall is a look. The look used to carry no
// list: it walked only the queue, so swipes stopped at the end of Up next, or
// one climb past the wall's with Up next empty. The step now hands the look the
// list it walked, with its place in Up next, and the look goes on as Next would.
describe('PlayDrawer — a look off the climb on the wall keeps walking its list (#7227)', () => {
  const climb = (uuid: string, name: string): Climb => ({ ...CLIMB, uuid, name }) as unknown as Climb;
  const a = climb('climb-a', 'A');
  const b = climb('climb-b', 'B');
  const c = climb('climb-c', 'C');
  const d = climb('climb-d', 'D');
  const results = {
    playlistUuid: 'search',
    activatedClimbUuid: a.uuid,
    boardKey: 'kilter:1:10:1,20',
    label: 'Search results',
    climbs: [a, b, c, d],
  } as unknown as PlaylistSuggestionSource;
  // The climb on the wall: a search tap committed it, flagged `suggested`.
  const onWall = { uuid: 'queue-a', climb: a, suggested: true };
  const playNext1 = { uuid: 'queue-u1', climb: climb('climb-u1', 'U1') };
  const playNext2 = { uuid: 'queue-u2', climb: climb('climb-u2', 'U2') };

  function onTheWall(queue: { uuid: string; climb: unknown }[]) {
    session.useRealNavigation = true;
    session.suggestionSource = results;
    session.queue = queue;
    session.currentItem = onWall;
    return render(drawerElement('member', committedTargetFor(a)));
  }

  /** Presses Next (or Previous) `times` times and says which climb each press left on screen. */
  function swipeNext(times: number, button: 'onNextClick' | 'onPrevClick' = 'onNextClick'): string[] {
    const shown: string[] = [];
    for (let press = 0; press < times; press += 1) {
      act(() => {
        (lastActionBarProps()[button] as () => void)();
      });
      shown.push(lastDisplayedClimbUuid());
    }
    return shown;
  }
  const swipePrevious = (times: number) => swipeNext(times, 'onPrevClick');

  function expectNothingWritten() {
    expect(queueActions.nextClimb).not.toHaveBeenCalled();
    expect(queueActions.previousClimb).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
  }

  it('with Up next empty, walks on down the list to its end card, not dead after one climb', () => {
    onTheWall([onWall]);
    expect(swipeNext(3)).toEqual([b.uuid, c.uuid, d.uuid]);
    // The look still names the list it walks.
    expect(recorded.listContext.at(-1)?.parts).toMatchObject({ name: 'Search results' });
    expect(recorded.trackEndCard).toHaveLength(0);
    // One more past the list's last climb opens its end card, as from the wall.
    expect(swipeNext(1)).toEqual([d.uuid]);
    expect(recorded.trackEndCard.length).toBeGreaterThan(0);
    expectNothingWritten();
  });

  it('with Up next filled, plays Up next and then carries on into the list', () => {
    onTheWall([onWall, playNext1, playNext2]);
    expect(swipeNext(1)).toEqual([playNext1.climb.uuid]);
    expect(recorded.listContext.at(-1)?.parts).toMatchObject({ name: 'playView.track.upNext' });
    expect(swipeNext(4)).toEqual([playNext2.climb.uuid, b.uuid, c.uuid, d.uuid]);
    expect(recorded.listContext.at(-1)?.parts).toMatchObject({ name: 'Search results' });
    expectNothingWritten();
  });

  it('puts the look up with its list and its place in Up next', () => {
    onTheWall([onWall, playNext1, playNext2]);
    swipeNext(1);
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uuid: playNext1.uuid }),
      {
        playlistSuggestionSource: expect.objectContaining({
          playlistUuid: 'search',
          resume: { climbUuid: a.uuid, queueItemUuid: onWall.uuid },
        }),
        // A queued climb goes up as Next puts it up: the queue stays as it is.
        keepQueue: true,
        trigger: 'put_on_wall',
      },
    );
  });

  // Previous retraces the look (#6777's rule): the Up next it played, then the
  // list climb it left, on that climb's own entry, never a peek of it.
  it('swipes back through the Up next it played to the climb it left', () => {
    onTheWall([onWall, playNext1, playNext2]);
    expect(swipeNext(3)).toEqual([playNext1.climb.uuid, playNext2.climb.uuid, b.uuid]);
    expect(swipePrevious(3)).toEqual([playNext2.climb.uuid, playNext1.climb.uuid, a.uuid]);
    // Back on A's own entry, Next plays Up next again rather than jumping to B.
    expect(swipeNext(1)).toEqual([playNext1.climb.uuid]);
    expect(recorded.listContext.at(-1)?.parts).toMatchObject({ name: 'playView.track.upNext' });
    expectNothingWritten();
  });

  // A drive that starts while a look stands on the list climb (Always drive
  // the wall once the link comes up): the step that lights still keeps the
  // list's place, or Up next would end the list.
  it('keeps the list when a drive starts mid-look and the step goes into Up next', () => {
    onTheWall([onWall, playNext1, playNext2]);
    swipeNext(1);
    expect(swipePrevious(1)).toEqual([a.uuid]);
    act(() => {
      driveTheWall();
    });
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uuid: playNext1.uuid }),
      expect.objectContaining({
        playlistSuggestionSource: expect.objectContaining({
          playlistUuid: 'search',
          resume: { climbUuid: a.uuid, queueItemUuid: onWall.uuid },
        }),
        keepQueue: true,
        trigger: 'next',
      }),
    );
  });

  it('drops the Up next place when a drive starts mid-look and the step goes back to the list', () => {
    onTheWall([onWall, playNext1, playNext2]);
    expect(swipeNext(2)).toEqual([playNext1.climb.uuid, playNext2.climb.uuid]);
    act(() => {
      driveTheWall();
    });
    act(() => {
      (lastActionBarProps().onNextClick as () => void)();
    });
    const [[committed, options]] = queueActions.setCurrentClimb.mock.calls as [
      [{ climb: { uuid: string } }, { playlistSuggestionSource: PlaylistSuggestionSource }],
    ];
    expect(committed.climb.uuid).toBe(b.uuid);
    // Back on the list: no resume left to go stale, the stretch kept for
    // Previous, from the Up next climb the look stepped off.
    expect(options.playlistSuggestionSource.resume).toBeUndefined();
    expect(options.playlistSuggestionSource.detour).toEqual({
      climbUuid: a.uuid,
      queueItemUuid: onWall.uuid,
      lastUpNextQueueItemUuid: playNext2.uuid,
    });
  });

  // #7227 re-review: solo, outside now-slot mode, a commit with a list prunes
  // the suggested climbs after it, and a workout's climbs are suggested. A look
  // that played the workout in Up next and went on to the list's next climb
  // asks to keep the queue (`keepQueue`) with a list that holds the detour,
  // which is what the provider keeps it for.
  describe('a look that walked a workout in Up next', () => {
    const limit1 = { uuid: 'queue-limit-1', climb: climb('climb-limit-1', 'Limit 1'), suggested: true };
    const limit2 = { uuid: 'queue-limit-2', climb: climb('climb-limit-2', 'Limit 2'), suggested: true };
    const walkedDetour = { climbUuid: a.uuid, queueItemUuid: onWall.uuid, lastUpNextQueueItemUuid: limit2.uuid };

    it('Put on board from the list’s peek keeps the workout queued', () => {
      onTheWall([onWall, limit1, limit2]);
      expect(swipeNext(3)).toEqual([limit1.climb.uuid, limit2.climb.uuid, b.uuid]);
      act(() => {
        (lastActionBarProps().onCommit as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: b.uuid }) }),
        {
          playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'search', detour: walkedDetour }),
          keepQueue: true,
          historyCopy: 'fresh',
          trigger: 'put_on_wall',
        },
      );
    });

    it('Next from limit 2 once a drive starts keeps the workout queued', () => {
      onTheWall([onWall, limit1, limit2]);
      expect(swipeNext(2)).toEqual([limit1.climb.uuid, limit2.climb.uuid]);
      act(() => {
        driveTheWall();
      });
      act(() => {
        (lastActionBarProps().onNextClick as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: b.uuid }) }),
        expect.objectContaining({
          playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'search', detour: walkedDetour }),
          keepQueue: true,
          trigger: 'next',
        }),
      );
    });
  });

  // #7227 re-review: a look back up the list never enters Up next, so its
  // list holds no resume and no detour. It carries the look's mark instead
  // (`lookOffWall`), which is what the provider keeps the workout for. A list
  // tap's preview of the same climb never has it, and still prunes.
  describe('a look back up the list, with a workout in Up next', () => {
    const limit1 = { uuid: 'queue-limit-1', climb: climb('climb-limit-1', 'Limit 1'), suggested: true };
    const limit2 = { uuid: 'queue-limit-2', climb: climb('climb-limit-2', 'Limit 2'), suggested: true };
    const onC = { uuid: 'queue-c', climb: c, suggested: true };

    function onTheWallAtC(target: Parameters<typeof drawerElement>[1] = committedTargetFor(c)) {
      session.useRealNavigation = true;
      session.suggestionSource = { ...results, activatedClimbUuid: c.uuid };
      session.queue = [onC, limit1, limit2];
      session.currentItem = onC;
      return render(drawerElement('member', target));
    }

    it('Put on board from the peek it stepped back to keeps the workout queued', () => {
      onTheWallAtC();
      expect(swipePrevious(1)).toEqual([b.uuid]);
      act(() => {
        (lastActionBarProps().onCommit as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: b.uuid }) }),
        {
          playlistSuggestionSource: expect.objectContaining({
            playlistUuid: 'search',
            activatedClimbUuid: b.uuid,
            lookOffWall: true,
          }),
          keepQueue: true,
          historyCopy: 'fresh',
          trigger: 'put_on_wall',
        },
      );
    });

    it('Previous once a drive starts keeps the workout queued', () => {
      onTheWallAtC();
      expect(swipePrevious(1)).toEqual([b.uuid]);
      act(() => {
        driveTheWall();
      });
      act(() => {
        (lastActionBarProps().onPrevClick as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: a.uuid }) }),
        expect.objectContaining({
          playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'search', lookOffWall: true }),
          keepQueue: true,
          trigger: 'previous',
        }),
      );
    });

    it('a list tap’s preview of the same climb never carries the mark, even a step on', () => {
      const tappedB = { uuid: 'tapped-b', climb: b };
      onTheWallAtC({
        climb: b,
        options: { previewQueueItem: tappedB, playlistSuggestionSource: { ...results, activatedClimbUuid: b.uuid } },
        nonce: 1,
      } as unknown as Parameters<typeof drawerElement>[1]);
      expect(swipePrevious(1)).toEqual([a.uuid]);
      act(() => {
        (lastActionBarProps().onCommit as () => void)();
      });
      const [[committed, options]] = queueActions.setCurrentClimb.mock.calls as [
        [{ climb: { uuid: string } }, { playlistSuggestionSource: PlaylistSuggestionSource; keepQueue?: boolean }],
      ];
      expect(committed.climb.uuid).toBe(a.uuid);
      expect(options.playlistSuggestionSource).toMatchObject({ playlistUuid: 'search' });
      expect(options.playlistSuggestionSource).not.toHaveProperty('lookOffWall');
    });
  });

  it('driving, still commits and lights each step', () => {
    driveTheWall();
    onTheWall([onWall, playNext1]);
    swipeNext(2);
    expect(queueActions.nextClimb).toHaveBeenCalledTimes(2);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('in a crew, looks the same way and never writes the room’s queue', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    onTheWall([onWall, playNext1]);
    expect(swipeNext(4)).toEqual([playNext1.climb.uuid, b.uuid, c.uuid, d.uuid]);
    expectNothingWritten();
  });

  it('walks a workout queued with no list as before: its climbs, then nothing', () => {
    session.useRealNavigation = true;
    session.sessionId = 'session-1';
    const warmUp = { uuid: 'queue-warm-up', climb: climb('climb-warm-up', 'Warm-up'), suggested: true };
    const limit1 = { uuid: 'queue-limit-1', climb: climb('climb-limit-1', 'Limit 1'), suggested: true };
    const limit2 = { uuid: 'queue-limit-2', climb: climb('climb-limit-2', 'Limit 2'), suggested: true };
    session.queue = [warmUp, limit1, limit2];
    session.currentItem = warmUp;
    render(drawerElement('member', committedTargetFor(warmUp.climb)));
    expect(swipeNext(3)).toEqual([limit1.climb.uuid, limit2.climb.uuid, limit2.climb.uuid]);
    expect(recorded.listContext.at(-1)?.parts ?? null).toBeNull();
    expect(recorded.trackEndCard).toHaveLength(0);
    expectNothingWritten();
  });

  // #5403's stale list: a list tap that opens as a preview with no list of its
  // own never walks a list from before, here the very list the look carried.
  it('never hands a carried list to a preview opened later with none', () => {
    const p = climb('climb-p', 'P');
    const itemP = { uuid: 'queue-p', climb: p };
    const itemC = { uuid: 'queue-c', climb: c };
    const view = onTheWall([onWall, itemP, itemC]);
    // The look carries the list: Up next first, from A.
    expect(swipeNext(1)).toEqual([p.uuid]);
    // Only a look that carries the list counts Up next on it.
    expect(recorded.listContext.at(-1)?.parts).toMatchObject({ name: 'playView.track.upNext' });

    // A list tap pins C, which the carried list holds, with no list of its own.
    view.rerender(drawerElement('member', { climb: c, options: { previewQueueItem: itemC }, nonce: 2 }));
    expect(lastDisplayedClimbUuid()).toBe(c.uuid);
    // Nothing queued after C: a dead end, never D off the old list.
    expect(swipeNext(1)).toEqual([c.uuid]);
    expectNothingWritten();
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

  // After Put on board, keep lighting (2.7): the wall button's press runs the
  // ordinary put-up, so the question still guards it in a crew, and only Put
  // mine up opens the window. Keep theirs leaves nothing armed.
  describe('with Put on board keeping lighting', () => {
    const linkThisPhone = () => {
      lightbulb.lit = true;
      lightbulb.localConnected = true;
      ble.current = { isConnected: true, sendFramesToBoard: vi.fn(async () => true) };
    };

    it('opens the window only once Put mine up puts the climb up', () => {
      linkThisPhone();
      browseThenLoseTheWall();
      expect(lastActionBarProps().wallControl).toMatchObject({ state: 'put_on_wall', tapDrive: 'window' });

      act(() => {
        (lastActionBarProps().onWallControl as () => void)();
      });
      expect(lastActionBarProps().commitButton).toBe('confirm');
      expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
      expect(getDriveMode()).toBeNull();

      afterBusyWallDebounce(() => {
        (lastActionBarProps().onCommit as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
      expect(getDriveMode()).toMatchObject({
        phase: 'arming',
        startedBy: 'tap',
        sessionId: 'session-1',
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });

    it('arms nothing on Keep theirs', () => {
      session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
      linkThisPhone();
      browseThenLoseTheWall();
      act(() => {
        (lastActionBarProps().onWallControl as () => void)();
      });
      afterBusyWallDebounce(() => {
        (lastActionBarProps().onKeepTheirs as () => void)();
      });
      expect(lastActionBarProps().commitButton).not.toBe('confirm');
      expect(getDriveMode()).toBeNull();
    });

    it('lights one climb in a crew with In a session too off', () => {
      setSetting('putOnBoardDrivesInSession', false);
      linkThisPhone();
      browseThenLoseTheWall();
      expect(lastActionBarProps().wallControl).toMatchObject({ state: 'put_on_wall', tapDrive: null });
      act(() => {
        (lastActionBarProps().onWallControl as () => void)();
      });
      afterBusyWallDebounce(() => {
        (lastActionBarProps().onCommit as () => void)();
      });
      expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
      expect(getDriveMode()).toBeNull();
    });
  });

  it('asks before taking a wall that moved under the climber', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(lastActionBarProps().busyWall).toMatchObject({ wallClimbName: 'Their Project', ready: false });
    // The whole point: the first tap did NOT take the wall.
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('names the current mover rather than the person who added the climb', () => {
    session.currentItem = {
      uuid: 'queue-wall-b',
      climb: { ...CLIMB, uuid: 'wall-climb-b' },
      addedByUser: { id: 'user-alex', username: 'Alex' },
    };
    session.currentClimbMover = { username: 'Sam', avatarUrl: 'sam.png' };
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().busyWall).toMatchObject({
      holderName: 'Sam',
      holderFace: { name: 'Sam', avatarUrl: 'sam.png' },
    });
    expect(recorded.listContext.at(-1)?.caption).toBe('playView.wallState.busyWall.captionNamed');
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('keeps an unknown mover unnamed even when the queue author is known', () => {
    session.currentItem = {
      uuid: 'queue-wall-b',
      climb: { ...CLIMB, uuid: 'wall-climb-b' },
      addedByUser: { id: 'user-alex', username: 'Alex' },
    };
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().busyWall).toMatchObject({ holderName: null, holderFace: null });
    expect(recorded.listContext.at(-1)?.caption).toBe('playView.wallState.busyWall.caption');
  });

  // "Someone just lit X" needs a someone. A solo climber who isn't driving
  // is latched too, and the one way their wall moves under a preview is their own
  // lightbulb tap — so the question is never asked of them.
  it('never asks a solo climber to confirm over their own lighting', () => {
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

  // The question row speaks when it mounts (WallControlButton, stubbed here);
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

  // Put on the wall is a wall button state, so the queue, heart and Share keep
  // their default positions (Angle waits in ⋯ on this mirror board). The
  // question takes the whole row; with no Bluetooth here there is no bulb to
  // bring back, so the queue keeps its slot through it.
  it('keeps the queue through the question where there is no bulb to bring back', () => {
    browseThenLoseTheWall();
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: false,
      queue: false,
      share: false,
      angle: true,
    });

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: false,
      queue: false,
      share: false,
      angle: true,
    });
  });

  // #7017: the question is the header's caption, in place of "Only you see
  // this", and VoiceOver hears it once; nothing draws over the first row.
  it('puts the question in the header caption and says it once', () => {
    browseThenLoseTheWall();
    expect(recorded.listContext.at(-1)?.caption).toBe('playView.wallState.onlyYouSeeThisWallOn');

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    // Unnamed here: no server-recorded mover is available.
    expect(recorded.listContext.at(-1)?.caption).toBe('playView.wallState.busyWall.caption');
    const spoken = vi.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([sentence]) => sentence);
    expect(spoken.filter((sentence) => sentence.startsWith('playView.wallState.busyWall'))).toEqual([
      'playView.wallState.busyWall.caption',
    ]);
  });

  // #7017: the question arrives under a thumb already moving toward the wall
  // button, so a second tap inside 500 ms is that thumb, not an answer.
  it('drops a Put mine up that lands in the question’s first 500 ms', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
      (lastActionBarProps().onKeepTheirs as () => void)();
    });

    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('commits on the second tap, marked as Put on the wall', () => {
    browseThenLoseTheWall();

    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    afterBusyWallDebounce(() => {
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
    afterBusyWallDebounce(() => {
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

describe('PlayDrawer — busy-wall confirmation on another gym board (#7126)', () => {
  const kilterGymBoard: UserBoard = {
    uuid: 'gym-kilter',
    slug: 'gym-kilter',
    ownerId: null,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    name: 'Gym Kilter',
    gymUuid: 'gym-uuid',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    isAngleAdjustable: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
  };
  const moonboardGymBoard: UserBoard = {
    ...kilterGymBoard,
    uuid: 'gym-moonboard',
    slug: 'gym-moonboard',
    boardType: 'moonboard',
    layoutId: 3,
    sizeId: 1,
    setIds: '5,6,7,8,9,10',
    name: 'Gym MoonBoard',
    isAngleAdjustable: false,
  };
  const moonboardClimb: Climb = {
    ...CLIMB,
    uuid: 'moonboard-preview',
    name: 'MoonBoard Preview',
    boardType: 'moonboard',
    layoutId: 3,
    compatibleSizeIds: [1],
  };

  function browseGymClimbThenLoseTheWall({
    linked = true,
    previewClimb = moonboardClimb,
    crewBoardPath = '',
  }: { linked?: boolean; previewClimb?: Climb; crewBoardPath?: string } = {}) {
    auth.isAuthenticated = true;
    activeBoard.current = kilterGymBoard;
    gymBoards.current = [kilterGymBoard, moonboardGymBoard];
    session.isShared = true;
    session.sessionId = 'session-1';
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    lightbulb.localConnected = linked;
    lightbulb.lit = linked;
    lightbulb.pressAction = linked ? 'noop' : 'connect';
    ble.current = { isConnected: linked, sendFramesToBoard: vi.fn(async () => true) };
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    const target = openTargetFor(previewClimb);
    const reachableBoardKeys = new Set([
      configKey(BOARD_CONFIG),
      configKey({ boardName: moonboardGymBoard.boardType, layoutId: moonboardGymBoard.layoutId }),
    ]);
    const player = () =>
      createElement(
        QueueSessionBoardPathContext.Provider,
        { value: crewBoardPath },
        createElement(PlayDrawer, {
          viewer: 'member',
          presentation: 'pane',
          boardConfig: BOARD_CONFIG,
          reachableBoardKeys,
          openTarget: target,
          onOpenQueue: vi.fn(),
        }),
      );
    const view = render(player());
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    view.rerender(player());
  }

  it.each([true, false])('commits then moves after Put mine up, linked=%s', (linked) => {
    browseGymClimbThenLoseTheWall({ linked });
    expect(lastActionBarProps().wallControlState).toBe('move_to_board');

    act(() => (lastActionBarProps().onWallControl as () => void)());

    expect(lastActionBarProps().commitButton).toBe('confirm');
    // Confirmation disables the ordinary tap action, but the answer must still
    // remember which board the wall control is offering to move to.
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'move_to_board', tapAction: 'noop' });
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lightbulb.moveToClimbBoard).not.toHaveBeenCalled();

    act(() => (lastActionBarProps().onCommit as () => void)());
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lightbulb.moveToClimbBoard).not.toHaveBeenCalled();

    afterBusyWallDebounce(() => (lastActionBarProps().onCommit as () => void)());

    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ climb: moonboardClimb }),
      expect.objectContaining({ trigger: 'put_on_wall' }),
    );
    expect(lightbulb.moveToClimbBoard).toHaveBeenCalledExactlyOnceWith('move_to_board', moonboardClimb);
    expect(queueActions.setCurrentClimb.mock.invocationCallOrder[0]).toBeLessThan(
      lightbulb.moveToClimbBoard.mock.invocationCallOrder[0],
    );
    expect(lightbulb.connect).not.toHaveBeenCalled();
    expect(ble.current?.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('keeps both boards unchanged when Keep theirs answers the cross-board question', () => {
    browseGymClimbThenLoseTheWall();
    act(() => (lastActionBarProps().onWallControl as () => void)());
    expect(lastActionBarProps().commitButton).toBe('confirm');

    afterBusyWallDebounce(() => (lastActionBarProps().onKeepTheirs as () => void)());

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(lightbulb.moveToClimbBoard).not.toHaveBeenCalled();
    expect(lightbulb.connect).not.toHaveBeenCalled();
    expect(ble.current?.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('still commits a same-board answer without moving to another board', () => {
    browseGymClimbThenLoseTheWall({ previewClimb: CLIMB });
    expect(lastActionBarProps().wallControlState).toBe('put_on_wall');
    act(() => (lastActionBarProps().onWallControl as () => void)());
    expect(lastActionBarProps().commitButton).toBe('confirm');

    afterBusyWallDebounce(() => (lastActionBarProps().onCommit as () => void)());

    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ climb: CLIMB }),
      expect.objectContaining({ trigger: 'put_on_wall' }),
    );
    expect(lightbulb.moveToClimbBoard).not.toHaveBeenCalled();
    expect(lightbulb.connect).not.toHaveBeenCalled();
  });

  it('relays an answer to the crew’s gym board without taking its connection', () => {
    browseGymClimbThenLoseTheWall({ crewBoardPath: '/b/gym-moonboard' });
    expect(lastActionBarProps().wallControlState).toBe('put_on_wall');
    act(() => (lastActionBarProps().onWallControl as () => void)());
    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(lastActionBarProps().wallControlState).toBe('crew');

    afterBusyWallDebounce(() => (lastActionBarProps().onCommit as () => void)());

    expect(queueActions.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ climb: moonboardClimb }),
      expect.objectContaining({ trigger: 'put_on_wall' }),
    );
    expect(lightbulb.moveToClimbBoard).not.toHaveBeenCalled();
    expect(lightbulb.connect).not.toHaveBeenCalled();
    expect(ble.current?.sendFramesToBoard).not.toHaveBeenCalled();
  });
});

// Until the drawer read board presence continuously it only knew the wall's
// climb in one situation — the accessory-bar preview, which arrives already
// knowing it is the lit one — so "On the wall" could never be said after any
// other navigation landed on it.
describe('PlayDrawer — reading the wall', () => {
  const connectBoard = () => {
    lightbulb.lit = true;
    lightbulb.localConnected = true;
    ble.current = {
      isConnected: true,
      sendFramesToBoard: vi.fn(async () => true),
    };
  };

  it('keeps a retained Tension climb navigable without claiming Moon is lighting it', () => {
    connectBoard();
    const tensionBoard = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 };
    const moonBoard = { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10', angle: 40 };
    const masquerade = { ...CLIMB, name: 'Masquerade', boardType: 'tension', layoutId: 10, compatibleSizeIds: [6] };
    const target = committedTargetFor(masquerade);
    const reachableBoardKeys = new Set([configKey(tensionBoard), configKey(moonBoard)]);
    session.currentItem = { uuid: 'queue-item-masquerade', climb: masquerade };
    session.nextItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    wall.uuid = masquerade.uuid;
    const playerAt = (boardConfig: typeof tensionBoard) =>
      createElement(PlayDrawer, {
        viewer: 'member',
        presentation: 'pane',
        boardConfig,
        reachableBoardKeys,
        openTarget: target,
        onOpenQueue: vi.fn(),
      });
    const view = render(playerAt(tensionBoard));
    expect(lastActionBarProps().wallControlState).toBe('lit');

    // The normal queue head survives the BLE board switch. Moon's clear leaves
    // its feed empty; being able to walk to Tension keeps navigation available.
    wall.uuid = null;
    recorded.wallPill = [];
    view.rerender(playerAt(moonBoard));

    // #7000: the connected wall can't light it, so there is no wall control, and no chip.
    expect(lastActionBarProps().wallControlState).toBeNull();
    expect(recorded.wallPill).toHaveLength(0);
    expect(lastDisplayedClimbUuid()).toBe(masquerade.uuid);
    expect(lastActionBarProps().canSwipeNext).toBe(true);
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    expect(ble.current?.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('keeps the wall button accurate when the lights are cleared and relit', () => {
    connectBoard();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    const target = committedTargetFor(CLIMB);
    render(drawerElement('member', target));
    expect(lastActionBarProps().wallControlState).toBe('lit');

    act(() => markWallCleared(CLIMB.uuid));
    expect(lastActionBarProps().wallControlState).toBe('dark');

    act(() => resetWallCleared());
    expect(lastActionBarProps().wallControlState).toBe('lit');
  });

  // #7017, Marco: the coloured lit look only while this climber drives the
  // board, i.e. the next swipe from this screen changes what the wall shows.
  // Always drive the wall's drive goes on as a crew forms (In a session too on),
  // and a tap on the frosted button stops it.
  it('drives the board on its own lit climb while driving, a crew forming included, and not once it stops', () => {
    driveTheWall();
    connectBoard();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    const target = committedTargetFor(CLIMB);
    const view = render(drawerElement('member', target));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'lit', holder: 'self', driving: true });

    session.isShared = true;
    session.sessionId = 'session-1';
    view.rerender(drawerElement('member', target));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'lit', holder: 'self', driving: true });

    act(() => {
      stopDrivingForLink();
    });
    view.rerender(drawerElement('member', target));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'lit', holder: 'self', driving: false });
  });

  // After Put on board, keep lighting (2.7), at its defaults: a press that puts
  // a climb up opens the 45 s window. A MoonBoard takes the same Stop driving
  // after as every board (2026-11: its own Until I stop choice went).
  const MOON_CONFIG = { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10', angle: 40 };
  const MOON_CLIMB = { ...CLIMB, boardType: 'moonboard', layoutId: 3 } as unknown as Climb;
  function renderDarkClimb(boardConfig: typeof BOARD_CONFIG | typeof MOON_CONFIG, climb: Climb) {
    connectBoard();
    lightbulb.lit = false;
    session.currentItem = { uuid: 'queue-item-current', climb };
    wall.uuid = null;
    render(
      createElement(PlayDrawer, {
        viewer: 'member',
        presentation: 'pane',
        boardConfig,
        reachableBoardKeys: new Set([configKey(boardConfig)]),
        openTarget: committedTargetFor(climb),
        onOpenQueue: vi.fn(),
      }),
    );
  }

  it.each([
    ['a Kilter', BOARD_CONFIG, CLIMB],
    ['a MoonBoard', MOON_CONFIG, MOON_CLIMB],
  ] as const)('on %s, a solo press that lights a dark climb opens the 45 s window', (_board, boardConfig, climb) => {
    renderDarkClimb(boardConfig, climb);
    expect(lastActionBarProps().wallControl).toMatchObject({
      state: 'dark',
      tapAction: 'relight',
      tapDrive: 'window',
      tapKeepLighting: { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' },
    });
  });

  it('lights one climb on a MoonBoard with Stop driving after set to Right away', () => {
    setSetting('putOnBoardKeepsLighting', 'off');
    renderDarkClimb(MOON_CONFIG, MOON_CLIMB);
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'dark', tapDrive: null, tapKeepLighting: null });
  });

  // In a session too is one rule for every board: on a MoonBoard in a crew
  // with it off, neither Put on board nor Always drive the wall drives.
  it.each([
    ['Put on board', false],
    ['Always drive the wall on', true],
  ] as const)(
    'on a MoonBoard in a crew with In a session too off, %s lights one climb and starts no drive',
    (_case, alwaysDrive) => {
      setSetting('alwaysDrive', alwaysDrive);
      setSetting('putOnBoardDrivesInSession', false);
      session.isShared = true;
      session.sessionId = 'session-1';
      renderDarkClimb(MOON_CONFIG, MOON_CLIMB);
      expect(lastActionBarProps().wallControl).toMatchObject({
        state: 'dark',
        tapAction: 'relight',
        tapDrive: null,
        tapKeepLighting: null,
      });
    },
  );

  // Always drive the wall on, a stop holding its drive off: the press drops the
  // stop and Always drive the wall's open-ended drive comes back, whatever Stop
  // driving after says. In a crew with In a session too off it doesn't drive,
  // so Put on board is its plain self there.
  it.each([
    ['solo', false, true, 'resume', null],
    ['a crew with In a session too off', true, false, null, null],
  ] as const)(
    'with Always drive the wall on, %s, a press that lights a dark climb: %s',
    (_case, crew, drivesInSession, tapDrive, plan) => {
      setSetting('alwaysDrive', true);
      setSetting('putOnBoardDrivesInSession', drivesInSession);
      if (crew) {
        session.isShared = true;
        session.sessionId = 'session-1';
      }
      connectBoard();
      lightbulb.lit = false;
      session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
      wall.uuid = null;
      render(drawerElement('member', committedTargetFor(CLIMB)));
      expect(lastActionBarProps().wallControl).toMatchObject({ state: 'dark', tapDrive, tapKeepLighting: plan });
    },
  );

  it('lights one climb with After Put on board, keep lighting set to Off', () => {
    setSetting('putOnBoardKeepsLighting', 'off');
    connectBoard();
    lightbulb.lit = false;
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = null;
    render(drawerElement('member', committedTargetFor(CLIMB)));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'dark', tapDrive: null, tapKeepLighting: null });
  });

  // #7015: the crewmate holding the link turned all the lights off. This phone
  // has no link; it only hears it through board presence. The board control
  // stops reading their climb as lit (an amber outline, not filled), and a new
  // climb the queue moves to before the feed's echo is not called dark.
  it("stops calling a crewmate's turned-off climb lit, and lets a new climb be lit", () => {
    lightbulb.lit = true;
    lightbulb.holderIsAuthoritative = true;
    lightbulb.pressAction = 'relay';
    ble.current = { isConnected: false, sendFramesToBoard: vi.fn(async () => true) };
    session.isShared = true;
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    const view = render(drawerElement('member', committedTargetFor(CLIMB)));
    expect(lastActionBarProps().wallControlState).toBe('crew');
    // A crewmate's board is an outline whether lit or dark; filled means yours.
    // Not driving either: no frost on their board (#7017).
    expect(lastActionBarProps().wallControl).toMatchObject({ look: 'ready', driving: false });

    const pillsBeforeClear = recorded.wallPill.length;
    wall.uuid = null;
    wall.clearedClimbUuid = CLIMB.uuid;
    view.rerender(drawerElement('member', committedTargetFor(CLIMB)));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'crew', look: 'ready' });
    expect(recorded.wallPill.slice(pillsBeforeClear).map((pill) => pill.state)).not.toContain('onWall');
    // Known limitation: no relight from here, the holder relights from their bulb.
    expect(lastActionBarProps().commitButton).toBeNull();

    // The queue moves on before the feed's echo: the new climb is not called dark.
    session.currentItem = { uuid: 'queue-item-next', climb: SIMILAR_CLIMB };
    view.rerender(drawerElement('member', committedTargetFor(SIMILAR_CLIMB)));
    expect(lastActionBarProps().wallControl).toMatchObject({ state: 'crew', look: 'ready' });
    expect(recorded.wallPill.at(-1)?.state).not.toBe('browsing');
  });

  // Fable review: a Turn off all lights outlived the link, so after a
  // tap-disconnect and a reconnect the lit climb read "Put on the wall".
  it('forgets a Turn off all lights when the link drops, so the reconnect reads lit', () => {
    connectBoard();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    const view = render(drawerElement('member', committedTargetFor(CLIMB)));
    act(() => markWallCleared(CLIMB.uuid));
    expect(lastActionBarProps().wallControlState).toBe('dark');

    lightbulb.lit = false;
    lightbulb.localConnected = false;
    ble.current = { isConnected: false, sendFramesToBoard: vi.fn(async () => true) };
    view.rerender(drawerElement('member', committedTargetFor(CLIMB)));

    connectBoard();
    view.rerender(drawerElement('member', committedTargetFor(CLIMB)));
    expect(lastActionBarProps().wallControlState).toBe('lit');
  });

  it('forgets a Turn off all lights once the wall comes back to that climb (clear A, Next, Previous)', () => {
    connectBoard();
    session.currentItem = { uuid: 'queue-item-a', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    const view = render(drawerElement('member', committedTargetFor(CLIMB)));
    act(() => markWallCleared(CLIMB.uuid));
    expect(lastActionBarProps().wallControlState).toBe('dark');

    // Next: the wall moves on to B.
    session.currentItem = { uuid: 'queue-item-b', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    view.rerender(drawerElement('member', { ...committedTargetFor(SIMILAR_CLIMB), nonce: 2 }));
    // Previous: the write lights A again.
    session.currentItem = { uuid: 'queue-item-a', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    view.rerender(drawerElement('member', { ...committedTargetFor(CLIMB), nonce: 3 }));
    expect(lastActionBarProps().wallControlState).toBe('lit');
  });

  // #7000 review: Turn off all lights from a lit preview of the wall's climb (not
  // the queue head) marks the climb on screen, so the preview reads dark.
  it('reads a lit preview dark once its lights are turned off from the board sheet', () => {
    connectBoard();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = CLIMB.uuid;
    render(drawerElement('member', openTargetFor(CLIMB)));
    expect(lastActionBarProps().wallControlState).toBe('lit');
    // A hold on the wall button opens the board sheet, which marks the climb on screen.
    const openSheet = lastActionBarProps().onWallControlLongPress;
    if (typeof openSheet !== 'function') throw new Error('no wall button');
    act(() => {
      openSheet();
    });
    expect(recorded.boardSheet.at(-1)?.clearedClimbUuid).toBe(CLIMB.uuid);

    act(() => markWallCleared(CLIMB.uuid));
    expect(lastActionBarProps().wallControlState).toBe('dark');
  });

  it('says Lit on the wall, and draws no header chip, when the climb on screen is lit on a driven wall', () => {
    connectBoard();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    render(drawerElement('member', committedTargetFor(CLIMB)));

    expect(lastActionBarProps().wallControlState).toBe('lit');
    expect(lastActionBarProps().wallHolder).toBe('self');
    expect(recorded.wallPill).toHaveLength(0);
  });

  // #7000 QA: presence can name a climb lit hours ago; with no link nobody
  // can vouch for the LEDs.
  it('claims nothing from presence alone when no link drives the wall', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    wall.uuid = CLIMB.uuid;
    wall.name = CLIMB.name;
    render(drawerElement('member', committedTargetFor(CLIMB)));

    expect(recorded.wallPill.at(-1)?.state).not.toBe('onWall');
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

// The one-shot preview-first card (2.7, brief B5) and its screen-reader line
// (B1). The card's own rules are pure and tested in `preview-first-tip.test.ts`
// and `use-preview-first-tip.test.tsx`; what only a render can see is where the
// player docks it, that the player's real states reach those rules, and whether
// its line really replaces the browse notice.
describe('PlayDrawer — the preview-first card (2.7)', () => {
  const PREVIEW_FIRST_LINE = 'playView.wallState.a11y.previewFirstAnnounce';
  beforeEach(() => {
    previewFirstSeen.current = false;
    auth.isAuthenticated = true;
    // This phone holds a lit board, so the preview's Put on board lights it.
    ble.current = { isConnected: true, sendFramesToBoard: vi.fn(async () => true) };
    lightbulb.lit = true;
    lightbulb.localConnected = true;
    lightbulb.pressAction = 'disconnect';
  });

  async function renderFirstPreview() {
    const view = render(drawerElement('member', openTargetFor(CLIMB)));
    await waitFor(() => expect(recorded.previewFirstTip.length).toBeGreaterThan(0));
    return view;
  }

  /** Let the seen flag's read land, for a case where the card must stay away. */
  async function settlePreviewFirstFlag() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  // "Nothing over the climb": the card is the first section under the board and
  // its controls, above Logbook. It is not in the board's box, so it can't cover
  // or resize the board.
  it('docks below the board and the wall button, above the sections', async () => {
    const view = await renderFirstPreview();
    const tip = view.getByTestId('player-preview-tip');
    const board = view.getByTestId('board');
    const controls = view.getByTestId('action-bar');
    const sections = view.getByTestId('deferred-sections');

    expect(board.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tip.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(board.parentElement?.contains(tip)).toBe(false);
    expect(controls.parentElement?.contains(tip)).toBe(false);
  });

  it('hands the card the glow on screen, and keeps the wall button plain', async () => {
    await renderFirstPreview();
    // Stop driving after is one choice for every board, so the card needs no board name.
    expect(recorded.previewFirstTip.at(-1)).not.toHaveProperty('boardName');
    // The card's sample needs hold geometry; the real button frosts only while driving.
    expect(lastActionBarProps().wallGlow).toBeNull();
  });

  // The card's window line reads the same plan the press arms, so it never
  // promises a window that can't start here.
  it('tells the card the window Put on board opens here: 45 s at the defaults', async () => {
    await renderFirstPreview();
    expect(recorded.previewFirstTip.at(-1)?.keepLighting).toEqual({
      windowMs: 45_000,
      setting: 'putOnBoardKeepsLighting',
    });
  });

  it.each([
    [true, { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' }],
    [false, null],
  ] as const)('in a crew session with In a session too %s, tells the card %j', async (drivesInSession, plan) => {
    session.isShared = true;
    session.sessionId = 'session-1';
    setSetting('putOnBoardDrivesInSession', drivesInSession);
    await renderFirstPreview();
    expect(recorded.previewFirstTip.at(-1)?.keepLighting).toEqual(plan);
  });

  // The crew has left but the browse latch still holds (or a crewmate's arrival
  // is still in its dwell): the roster says solo, so In a session too has no
  // say. The press, the watcher and this card all read the roster, never the
  // latch, so none of them promises a window another one would refuse.
  it('reads the roster, not the browse latch: no crew means the 45 s window, In a session too off', async () => {
    session.isShared = true;
    session.isCrew = false;
    session.sessionId = 'session-1';
    setSetting('putOnBoardDrivesInSession', false);
    await renderFirstPreview();
    expect(recorded.previewFirstTip.at(-1)?.keepLighting).toEqual({
      windowMs: 45_000,
      setting: 'putOnBoardKeepsLighting',
    });
    expect(lastActionBarProps().wallControl).toMatchObject({
      state: 'put_on_wall',
      tapDrive: 'window',
      tapKeepLighting: { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' },
    });
  });

  it('stays away from a climber who saw it before', async () => {
    previewFirstSeen.current = true;
    render(drawerElement('member', openTargetFor(CLIMB)));
    await settlePreviewFirstFlag();
    expect(recorded.previewFirstTip).toEqual([]);
  });

  it('never shows signed out', async () => {
    auth.isAuthenticated = false;
    render(drawerElement('member', openTargetFor(CLIMB)));
    await settlePreviewFirstFlag();
    expect(recorded.previewFirstTip).toEqual([]);
  });

  it('goes when Got it is tapped', async () => {
    const view = await renderFirstPreview();
    const onExit = recorded.previewFirstTip.at(-1)?.onExit as ((exit: string) => void) | undefined;
    if (!onExit) throw new Error('The preview-first card never rendered');
    act(() => onExit('got_it'));
    expect(view.queryByTestId('player-preview-tip')).toBeNull();
  });

  // One moment, one sentence: the solo browse notice would say the wall stays
  // put, at the same moment and in more words.
  it('speaks its line in place of the browse notice, and spends the notice', async () => {
    wall.uuid = 'wall-climb-a';
    await renderFirstPreview();

    await waitFor(() => expect(announceMock).toHaveBeenCalledWith(PREVIEW_FIRST_LINE));
    expect(joinedNoticeAnnouncements()).toBe(0);
    expect(getSetting('browseNoticeSeen')).toBe(true);
  });

  it('opens Settings › Board on its lighting group from Lighting settings', async () => {
    const view = await renderFirstPreview();
    const onExit = recorded.previewFirstTip.at(-1)?.onExit as ((exit: string) => void) | undefined;
    if (!onExit) throw new Error('The preview-first card never rendered');
    act(() => onExit('settings'));

    expect(routerMock.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/settings/board-look',
      params: { section: 'lighting' },
    });
    expect(view.queryByTestId('player-preview-tip')).toBeNull();
  });

  // Spec B5: never on Set active, a spray wall or a board with no lights. Each
  // case changes one thing from the first preview above, so it is that one
  // thing that keeps the card away.
  it('never shows on Set active, where no wall is in reach', async () => {
    ble.current = { isConnected: false, sendFramesToBoard: vi.fn(async () => true) };
    lightbulb.lit = false;
    lightbulb.localConnected = false;
    lightbulb.pressAction = 'noop';
    render(drawerElement('member', openTargetFor(CLIMB)));
    expect(lastActionBarProps().commitLabel).toBe('setActive');
    await settlePreviewFirstFlag();
    expect(recorded.previewFirstTip).toEqual([]);
  });

  it('never shows on a board with no lights', async () => {
    lightbulb.ledless = true;
    render(drawerElement('member', openTargetFor(CLIMB)));
    await settlePreviewFirstFlag();
    expect(recorded.previewFirstTip).toEqual([]);
  });

  // With every section hidden the first screen fills the viewport and does not
  // scroll: the card would spend itself where nobody can see it.
  it('waits while every section is hidden, with nothing for its slot to peek over', async () => {
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
    render(drawerElement('member', openTargetFor(CLIMB)));
    await settlePreviewFirstFlag();
    expect(recorded.previewFirstTip).toEqual([]);
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'unseen', opens: 0 });
  });

  // The pane stays mounted: each climb opened into it is an open of its own.
  it('counts each climb the pane opens toward its limit', async () => {
    const view = await renderFirstPreview();
    expect(getPreviewFirstTipState().opens).toBe(1);

    view.rerender(drawerElement('member', { ...openTargetFor(SIMILAR_CLIMB), nonce: 2 }));
    await waitFor(() => expect(getPreviewFirstTipState().opens).toBe(2));
    expect(view.queryByTestId('player-preview-tip')).not.toBeNull();
  });

  // One card at a time: the busy-wall question owns the moment.
  it('steps aside while the busy-wall question is up', async () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    wall.uuid = 'wall-climb-a';
    wall.name = 'What Was Up';
    const target = openTargetFor(CLIMB);
    const view = render(drawerElement('member', target));
    await waitFor(() => expect(view.queryByTestId('player-preview-tip')).not.toBeNull());

    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    view.rerender(drawerElement('member', target));
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });

    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(view.queryByTestId('player-preview-tip')).toBeNull();
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

  it('records a committed solo Mirror against its exact queue occurrence', () => {
    connectBle();
    session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));
    act(() => (lastActionBarProps().onMirror as () => void)());
    expect(queueActions.mirrorCurrentClimb).toHaveBeenCalledWith(true, 'queue-item-current');
  });

  it('restores a saved solo orientation when reopening the same occurrence', () => {
    connectBle();
    session.currentItem = { uuid: 'queue-item-current', climb: { ...CLIMB, mirrored: true } };
    render(drawerElement('member', committedTargetFor(CLIMB)));
    expect(lastActionBarProps().isMirrored).toBe(true);
  });

  it('leaves a preview unchanged when the committed occurrence flips', () => {
    connectBle();
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    const { rerender } = render(drawerElement('member', openTargetFor(CLIMB)));
    expect(lastActionBarProps().isMirrored).toBe(false);
    session.currentItem = { uuid: 'queue-item-current', climb: { ...SIMILAR_CLIMB, mirrored: true } };
    rerender(drawerElement('member', openTargetFor(CLIMB)));
    expect(lastActionBarProps().isMirrored).toBe(false);
  });

  it('rejects a retained mirror callback after the exact slot changes', () => {
    connectBle();
    session.currentItem = { uuid: 'old-slot', climb: CLIMB };
    render(drawerElement('member', committedTargetFor(CLIMB)));
    const onMirror = lastActionBarProps().onMirror as () => void;
    queueActions.mirrorCurrentClimb.mockClear();
    session.currentItem = { uuid: 'new-slot', climb: CLIMB };
    act(() => onMirror());
    expect(queueActions.mirrorCurrentClimb).not.toHaveBeenCalled();
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
    driveTheWall();
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
    // which with no suggestion source means nothing drives the wall.
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

  // Put on the wall is a wall button state, so browsing moves nothing: the
  // queue, heart and Share keep their positions; Angle stays in ⋯ on this
  // mirror board.
  it('keeps the bar as it was while browsing', () => {
    renderDrawer('member');

    expect(lastActionBarProps().commitButton).toBe('putOnWall');
    expect(recorded.actionsMenu.at(-1)?.hidden).toMatchObject({
      favorite: false,
      queue: false,
      angle: true,
      share: false,
    });
  });

  // The chrome's whole premise is that it never claims more than it can keep.
  // While driving, with no suggestion source, `getSwipeNavigationTarget`
  // sends the next swipe through `setCurrentClimb` — the shared-queue write and
  // BLE re-arm — so a browsing chip ("the wall stays where it is") would be
  // lying about the very next gesture. The commit BUTTON is the one piece that
  // stays: the pinned climb still needs its activation button (the old banner's
  // "Set active" contract), and dropping it here would strand the explicit
  // Preview action with no way to promote.
  it('withholds the browse promise — but not the commit button — from a preview whose next swipe would commit', () => {
    driveTheWall();
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
// it — what makes every onward swipe view-only outside a drive. So
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
    driveTheWall();
    // A committed head to fall back to once the preview goes.
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    // Same target object across both renders, so re-rendering doesn't re-run the
    // open effect and re-pin the preview from underneath the case.
    const target = trackedTargetFor(CLIMB);
    const view = render(elementAtAngle(40, target));

    // Preview + track: view-only. The board stays on the committed climb.
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

  // The header sliding in once promised the list, while a crew's swipe opened a
  // preview that walked none (#5403, until #7227). The top bar doesn't swipe and
  // names only the climb on screen, so no header, sliding in or not, carries a
  // list.
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
    driveTheWall();
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

    // The list carries on after Up next: "· then Projects" (the then-signposts).
    expect(lastListParts()).toEqual({
      name: 'playView.track.upNext',
      count: 'playView.track.position',
      thenTail: { before: 'playView.track.then ', name: 'Projects', after: '' },
      accessibilityLabel: 'playView.track.upNextPositionThenAria',
    });
  });

  // The then-signposts, wired end to end: the rules are tested in
  // `use-then-signposts.test.tsx` and `@boardsesh/play-view`; what only a
  // render can see is that PlayCore feeds them the walk it actually has.
  describe('the then-signposts', () => {
    function lastCaption(): unknown {
      return recorded.listContext.at(-1)?.caption ?? null;
    }
    function lastBoardProps(): Props {
      const props = recorded.board.at(-1);
      if (!props) throw new Error('the board never rendered');
      return props;
    }
    function swipeNext() {
      act(() => {
        (lastBoardProps().onSwipeNext as () => void)();
      });
    }
    /** Your own climb, the last of Up next before the list picks up at Last. */
    function onTheLastOfUpNext() {
      session.useRealNavigation = true;
      session.suggestionSource = { ...projects, resume: { climbUuid: first.uuid, queueItemUuid: itemFirst.uuid } };
      session.queue = [itemFirst, itemQueued];
      session.currentItem = itemQueued;
      render(drawerElement('member', committedTargetFor(queued)));
    }

    it('says "Up next first" on your own climb when Next plays Up next', () => {
      session.useRealNavigation = true;
      session.suggestionSource = projects;
      session.queue = [itemFirst, itemQueued];
      session.currentItem = itemFirst;
      render(drawerElement('member', committedTargetFor(first)));
      expect(lastCaption()).toBe('playView.track.upNextFirst');
    });

    it('says nothing new with Up next empty', () => {
      session.useRealNavigation = true;
      session.suggestionSource = projects;
      session.queue = [itemFirst];
      session.currentItem = itemFirst;
      render(drawerElement('member', committedTargetFor(first)));
      expect(lastCaption()).toBeNull();
      expect(lastListParts()).not.toHaveProperty('thenTail');
      expect(lastBoardProps().accessibilityValueText).toBeUndefined();
      expect(lastBoardProps().nextActionLabel).toBeUndefined();
    });

    it('names the list for a screen reader on the board, and ticks once on the swipe across', () => {
      onTheLastOfUpNext();
      expect(lastBoardProps().accessibilityValueText).toBe('playView.track.upNextPositionThenAria');
      expect(lastBoardProps().nextActionLabel).toBe('playView.track.nextIn');
      swipeNext();
      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(queueAnalytics.navigation).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'next',
          method: 'swipe',
          walk: { track: 'list', from: 'current', upNextCount: 0, crossed: true },
        }),
        expect.anything(),
      );
    });

    // Owner answer 1: the first swipe in a list preview, with Up next waiting,
    // swaps the second line for the note until the next swipe.
    it.each([
      ['solo', false],
      ['in a crew, counting the room’s Up next', true],
    ])('notes Up next waiting after the first swipe in a list preview, until the next swipe (%s)', (_case, crew) => {
      session.isShared = crew;
      session.sessionId = crew ? 'session-1' : null;
      const searchA = climb('climb-search-a', 'Sloper Town');
      const searchB = climb('climb-search-b', 'B');
      const searchC = climb('climb-search-c', 'C');
      const search = {
        playlistUuid: 'search',
        activatedClimbUuid: searchA.uuid,
        boardKey: 'kilter:1:10:1,20',
        climbs: [searchA, searchB, searchC],
        label: 'Search results',
        total: 3,
      } as unknown as PlaylistSuggestionSource;
      session.useRealNavigation = true;
      session.suggestionSource = projects;
      session.queue = [itemFirst, itemQueued];
      session.currentItem = itemFirst;
      const openSearch = (nonce: number) =>
        drawerElement('member', {
          climb: searchA,
          options: { previewQueueItem: { uuid: 'preview-a', climb: searchA }, playlistSuggestionSource: search },
          nonce,
        } as unknown as Parameters<typeof drawerElement>[1]);
      const view = render(openSearch(1));
      expect(lastCaption()).not.toBe('playView.track.previewUpNextWaiting');
      swipeNext();
      expect(lastCaption()).toBe('playView.track.previewUpNextWaiting');
      // A screen reader hears it too: the board's value after the swipe.
      expect(lastBoardProps().accessibilityValueText).toBe('playView.track.previewUpNextWaiting');
      swipeNext();
      expect(lastCaption()).not.toBe('playView.track.previewUpNextWaiting');
      expect(lastBoardProps().accessibilityValueText).toBeUndefined();
      // A look at a list never crosses anything: no tick.
      expect(haptics.selection).not.toHaveBeenCalled();
      // Once per open: a new open of the list earns it once more.
      view.rerender(openSearch(2));
      swipeNext();
      expect(lastCaption()).toBe('playView.track.previewUpNextWaiting');
    });

    // The end card from a preview names the climb back goes to, as "On the
    // wall" only while trusted presence shows it lit.
    it.each([
      ['your climb is lit', first.uuid, true],
      ["a crewmate's climb is lit", 'someone-elses-climb', false],
      ['nothing is lit', null, false],
    ])('tells the end card whether the wall shows your climb when %s', (_case, wallUuid, onWall) => {
      wall.uuid = wallUuid;
      wall.sentAt = wallUuid ? new Date(Date.now() - 60_000).toISOString() : null;
      const lastOfSearch = climb('climb-search-last', 'Last of search');
      const search = {
        playlistUuid: 'search',
        activatedClimbUuid: lastOfSearch.uuid,
        boardKey: 'kilter:1:10:1,20',
        climbs: [lastOfSearch],
        label: 'Search results',
        total: 1,
      } as unknown as PlaylistSuggestionSource;
      session.useRealNavigation = true;
      session.suggestionSource = projects;
      session.queue = [itemFirst, itemQueued];
      session.currentItem = itemFirst;
      render(
        drawerElement('member', {
          climb: lastOfSearch,
          options: {
            previewQueueItem: { uuid: 'preview-last', climb: lastOfSearch },
            playlistSuggestionSource: search,
          },
          nonce: 1,
        } as unknown as Parameters<typeof drawerElement>[1]),
      );
      swipeNext();
      expect(lastTrackEndCardProps().model).toMatchObject({ action: { kind: 'backToCommitted' } });
      expect(lastTrackEndCardProps().committedOnWall).toBe(onWall);
    });

    it('stays silent on the Next button across', () => {
      onTheLastOfUpNext();
      pressNext();
      expect(haptics.selection).not.toHaveBeenCalled();
      expect(queueAnalytics.navigation).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'button', walk: expect.objectContaining({ crossed: true }) }),
        expect.anything(),
      );
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
    driveTheWall();
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

  it('says a solo preview is not on the wall while a climb lit under an hour ago is up', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    wall.sentAt = new Date(Date.now() - 10 * 60_000).toISOString();
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBe('playView.wallState.previewNotOnWall');
  });

  // B1: the commonest 2.7 state. The wall button draws its own state, and the
  // board art glows lit or not, so before this the line was hidden on every
  // board with lights.
  it('says a solo preview is not on the wall on a linked phone with a dark wall', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    ble.current = { isConnected: true, sendFramesToBoard: vi.fn(async () => true) };
    lightbulb.lit = true;
    lightbulb.localConnected = true;
    lightbulb.pressAction = 'disconnect';
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBe('playView.wallState.previewNotOnWall');
  });

  it('says nothing about a climb lit hours ago with no link', () => {
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = SIMILAR_CLIMB.uuid;
    wall.name = SIMILAR_CLIMB.name;
    wall.sentAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    render(drawerElement('member', openTargetFor(CLIMB)));

    expect(lastCaption()).toBeNull();
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

  // Board plan item 8: the board let go mid-drive. Its line is said beside the
  // art, here, on any climb, ahead of the browse caption.
  describe('when the board let go mid-drive', () => {
    afterEach(() => act(() => clearLetsGo()));

    it('puts the line over the browse caption', () => {
      session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
      wall.uuid = SIMILAR_CLIMB.uuid;
      wall.name = SIMILAR_CLIMB.name;
      wall.sentAt = new Date(Date.now() - 10 * 60_000).toISOString();
      act(() => showLetsGo({ kind: 'dropped' }));
      render(drawerElement('member', openTargetFor(CLIMB)));

      expect(lastCaption()).toBe('playView.wallControl.boardDropped');
    });

    it('shows it on the climb on screen too, and goes when it is cleared', () => {
      session.currentItem = { uuid: 'queue-item-current', climb: CLIMB };
      const view = render(drawerElement('member', openTargetFor(CLIMB)));
      const topBarContext = () => view.queryByTestId('play-drawer-track-label');
      expect(topBarContext()).toBeNull();

      act(() => showLetsGo({ kind: 'taken_named', name: 'Sam' }));
      expect(lastCaption()).toBe('playView.wallControl.boardTakenBy');
      expect(topBarContext()).not.toBeNull();
      // Nothing else to say on this climb: the top bar's context goes with it.
      act(() => clearLetsGo());
      expect(topBarContext()).toBeNull();
    });
  });
});

// Owner decision A: the MiniPlayer's bulb on an unlit last pick opens the
// player on the pick (`putOnBoard`) and presses Put on board once the preview
// lands, through the wall button's own handler. The hook's suites mock each
// side; these drive the PlayCore wiring end to end: the open, the
// `usePutOnBoardIntent` readiness gate and the busy-wall seed.
describe('PlayDrawer — the MiniPlayer bulb on a last pick', () => {
  const PICK_ITEM = { uuid: 'queue-item-uuid', climb: CLIMB };

  const linkThisPhone = () => {
    lightbulb.lit = true;
    lightbulb.localConnected = true;
    ble.current = { isConnected: true, sendFramesToBoard: vi.fn(async () => true) };
  };

  function bulbTarget(latchStart?: { wallClimbUuid: string | null; at: number }) {
    return {
      climb: CLIMB,
      options: {
        previewQueueItem: PICK_ITEM,
        putOnBoard: true,
        ...(latchStart ? { previewLatchStart: latchStart } : {}),
      },
      nonce: 1,
    } as unknown as ReturnType<typeof openTargetFor>;
  }

  it('puts the pick up once the preview lands, solo, with no question', () => {
    linkThisPhone();
    render(drawerElement('member', bulbTarget()));

    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb.mock.calls[0][0].climb.uuid).toBe(CLIMB.uuid);
    expect(lastActionBarProps().commitButton).not.toBe('confirm');
  });

  // The wall moved while the player was closed: a crewmate lit "Their
  // Project" after the climber started looking at the pick (the seed says the
  // wall showed A then). The press asks first, exactly as the wall button does.
  it('asks the busy-wall question in a crew when the wall moved since the pick', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    linkThisPhone();
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    render(drawerElement('member', bulbTarget({ wallClimbUuid: 'wall-climb-a', at: Date.now() - 60_000 })));

    expect(lastActionBarProps().commitButton).toBe('confirm');
    expect(lastActionBarProps().busyWall).toMatchObject({ wallClimbName: 'Their Project' });
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();

    afterBusyWallDebounce(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('asks nothing in a crew when the wall still shows what it did at the pick', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    linkThisPhone();
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    render(drawerElement('member', bulbTarget({ wallClimbUuid: 'wall-climb-b', at: Date.now() - 60_000 })));

    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  // The seed is for the open it came with. The phone's player mounts with the
  // preview already up, so a crew's latch is up before the open applies and the
  // seed corrects it at once; a later open of the same slot with no seed (from
  // the queue sheet, after a committed climb in between) reads the wall as it
  // is then, never the old snapshot.
  it('spends the seed: a later open of the same slot reads the wall afresh', () => {
    session.isShared = true;
    session.sessionId = 'session-1';
    session.currentItem = { uuid: 'queue-item-current', climb: SIMILAR_CLIMB };
    wall.uuid = 'wall-climb-b';
    wall.name = 'Their Project';
    const target = (nonce: number, options: Record<string, unknown>) =>
      ({ climb: CLIMB, options, nonce }) as unknown as ReturnType<typeof openTargetFor>;
    const view = render(
      drawerElement(
        'member',
        target(1, { previewQueueItem: PICK_ITEM, previewLatchStart: { wallClimbUuid: 'wall-climb-a', at: 1 } }),
        undefined,
        'route',
      ),
    );
    view.rerender(
      drawerElement(
        'member',
        { climb: SIMILAR_CLIMB, options: { committedExternally: true }, nonce: 2 },
        undefined,
        'route',
      ),
    );
    view.rerender(drawerElement('member', target(3, { previewQueueItem: PICK_ITEM }), undefined, 'route'));
    act(() => {
      (lastActionBarProps().onCommit as () => void)();
    });
    expect(lastActionBarProps().commitButton).not.toBe('confirm');
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });
});
