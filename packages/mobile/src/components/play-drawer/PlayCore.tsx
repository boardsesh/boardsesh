import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ComponentType,
  type RefObject,
} from 'react';
import { usePrivacyCredentialScope, usePrivacyScopedState } from '../../hooks/use-privacy-scoped-state';
import {
  AccessibilityInfo,
  Platform,
  PixelRatio,
  View,
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as GestureHandler from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { configKey, getQueueBoardKey, isClimbOnReachableBoard } from '@boardsesh/queue';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import { formatRenderBoardLabel, resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import {
  findGymBoardToConnectForClimb,
  gymBoardButtonName,
  sessionBoardPathNamesBoard,
} from '../../lib/boards/gym-board-for-climb';
import { useSessionBoardPath } from '../../providers/queue/queue-contexts';
import type { ActiveSubDrawer } from '@boardsesh/play-view';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { buildOpeningLayoutKey } from './opening-layout-cache';
import { usePlayNavigationModel } from './use-play-navigation-model';
import { usePlayLayoutMeasurements, usePlayOpeningLayout } from './use-play-opening-layout';
import { DeferredBoard } from './DeferredBoard';
import { screenshotPaintedClimbTestId, screenshotLocalMirrorTestId } from '../../lib/screenshot-climb-selection';
import { PlayCoreSheetHosts } from './PlayCoreSheetHosts';
import { usePlayFavorite } from './use-play-favorite';
import { usePlaySelectionController, type PlayNavigationStep } from './use-play-selection-controller';
import { trackQueueNavigation, trackQueueSheetOpened } from '../../lib/queue-navigation-analytics';
import { useDeferredUntilFrame } from '../../hooks/use-deferred-until-frame';
import { BoardRenderUnavailable } from './BoardRenderUnavailable';
import { PlaybackControls } from '../playback/PlaybackControls';
import { useMobilePlayback } from './use-mobile-playback';
import { LivePlayDrawerHeader, PreparedPlayDrawerHeader, useLivePlayDrawerHeaderModel } from './PlayDrawerHeader';
import { PlayDrawerStatusBarScrim } from './PlayDrawerStatusBarScrim';
import { copyClimbName } from './copy-climb-name';
import { SwipeableHeader } from './SwipeableHeader';
import { useSwipeNavigation, useSwipePager, useSwipePages, useTrackEndSwipe } from './use-swipe-pager';
import { useTrackPaging } from './use-track-paging';
import { formatBrowseCaption, formatTrackLabelParts } from './track-label-text';
import { PlayListContext } from './PlayListContext';
import { resolveTopListContextFrame } from './top-list-context-frame';
import { TrackEndCard } from './TrackEndCard';
import { ACTION_BAR_SECONDARY_ROW_HEIGHT, PlayDrawerActionBar } from './PlayDrawerActionBar';
import { LastOnWallNote } from './LastOnWallNote';
import { PlayDrawerActionsMenu } from './PlayDrawerActionsMenu';
import { resolveQueuedSlotUuid } from './play-drawer-menu-rows';
import { resolveActionBarLayout, type ActionBarCommitButton } from './action-bar-layout';
import { shouldShowWorkoutOutcome, type WorkoutOutcomeTarget } from './workout-outcome';
import { useWorkoutOutcomeHold } from './use-workout-outcome-hold';
import { WallStatePill } from './WallStatePill';
import { PlayDrawerHeaderAccessibility } from './PlayDrawerHeaderAccessibility';
import {
  resolveWallPillState,
  resolveHeaderPillState,
  type HeaderPill,
  resolveCommitBarModel,
  resolveCommitButton,
  shouldAdoptLateWallRead,
  shouldArmBusyWallConfirm,
  shouldShowHolderBadge,
  resolveBrowseCaption,
} from './wall-state';
import { useWallStateAnnouncer } from './use-wall-state-announcer';
import { usePresenceClearedClimbUuid, useWallClimb } from './use-wall-climb';
import { resolveBusyWallHolder } from './busy-wall-question';
import { formatBusyWallCaption } from './busy-wall-question-text';
import { useBusyWallQuestion } from './use-busy-wall-question';
import { claimJoinedBrowseNotice, claimSoloBrowseNotice } from './joined-browse-notice';
import { previewNeedsAngleReanchor, reanchorPreviewAtAngle } from './preview-angle-anchor';
import { SwitchBoardOverlay } from './SwitchBoardOverlay';
import { DeferredSections } from './DeferredSections';
import { PanePlaceholder } from './PanePlaceholder';
import { useRoutePlayerHandoff } from './use-route-player-handoff';
import {
  computeDrawerFirstScreenHeight,
  computeFitToHeightFirstScreenHeight,
  computeFirstSectionScrollTarget,
  initialDrawerPreviewItem,
  resolveWallStatusLinePlacement,
  shouldFitBoardToHeight,
  shouldShowPanePlaceholder,
} from './play-drawer-layout';
import { useBelowFoldContentRequest } from './use-below-fold-content-request';
import { useDeliberateScrollGesture } from './use-deliberate-scroll-gesture';
import {
  DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  DEFAULT_PLAY_DRAWER_SECTIONS,
  usePlayDrawerSectionsPreference,
} from '../../lib/play-drawer-sections-preference';
import { visiblePlayDrawerSections, withoutPanelSections } from './play-drawer-sections';
import { PlaybackFrameContext } from './playback-frame-context';
import { usePlayerButtonsPreference } from '../../lib/player-buttons-preference';
import { resolveWallLit } from './wall-lit';
import { resetWallCleared, useWallClearedClimbUuid } from '../ble/wall-cleared-store';
import { nowMs } from '../../lib/clock';
import { DEFAULT_PLAYER_BUTTONS_POSITION } from '../../lib/player-buttons';
import { useDrawerDismissGesture } from './use-drawer-dismiss-gesture';
import { useFullLogbookSheet } from './logbook/use-full-logbook-sheet';
import { usePushAfterPlayerDismiss } from './use-push-after-player-dismiss';
import { RestTimerPillHost } from '../queue-control/RestTimerPillHost';
import { useWorkoutRun } from '../../lib/workout-run-store';
import { useWorkoutQueueUuids, useWorkoutStageParts } from './use-workout-stage-label';
import { WorkoutRunnerOverlay } from './WorkoutRunnerOverlay';
import { useDevScenarioPlayer } from '../../dev/stories/load';
import { ChromeIconButton, useChromeIconButtonSize } from '../ChromeIconButton';
import { topBarByVariant } from '../../theme/top-bar';
import {
  usePlaylistSuggestionSource,
  useQueueData,
  useQueueActions,
  useQueueSessionId,
  useIsSharedSession,
} from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useSetting } from '../../settings';
import { useAuth } from '../../providers/auth-provider';
import { useBoardseshGradeEnabled } from '../../providers/feature-flags-provider';
import { useToast } from '../../providers/toast-provider';
import { useClimb, useGymBoards, useProfile } from '../../lib/graphql/hooks';
import { useBluetoothWriteInProgress } from '../../providers/bluetooth-write-activity';
import {
  PlayCoreEnhancements,
  getPlayCoreEnhancementTargetKey,
  type PlayCoreEnhancementSnapshot,
} from './PlayCoreEnhancements';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import { useTabletopFoldTop } from '../../hooks/use-tabletop-fold-top';
import { PHONE_SPLIT_FOLD_GUTTER } from '../../theme/size-class';
import { playContentSideInsets } from './play-content-side-insets';
import { useShareClimbAction } from '../../hooks/use-share-climb-action';
import { registerPaneWallControl } from './pane-wall-control-store';
import { useMiniPlayerMirrorsPlayer } from './use-mini-player-mirrors';
import { isWallPresenceTrusted, usePresenceFresh } from '../../lib/board-presence/presence-freshness';
import { resolvePlayerAngle } from './player-angle';
import { activeBoardIsMoonboard } from '../../hooks/use-active-board-is-moonboard';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { LostHoldsBanner } from './LostHoldsBanner';
import { useLostHoldRemix } from './use-lost-hold-remix';
import { getBoardRenderData } from '../../lib/board-details';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { hapticSuccess } from '../../lib/haptics';
import { resolveTickMirror } from '../../lib/queue-mirror-orientation';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { swipeStaysViewOnly } from './play-drawer-navigation';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { trackBoardControlsOpened } from '../../lib/analytics-board-connect';
import { isHolderSelfAccount, isWallControlDrawn, resolveWallControl, type WallControlState } from './wall-control';
import { useWallControl } from './use-wall-control';
import { useParseFrames } from '../board-renderer/use-parse-frames';
import type { HoldPlacement } from '../board-renderer/types';
import { useHoldStateColors } from './use-hold-state-colors';
import type { WallGlowInput } from './use-wall-glow';
import type { GlowHold } from './wall-glow';

const EMPTY_HOLD_PLACEMENTS: HoldPlacement[] = [];
import { useWallHolderIdentity } from './use-wall-holder-name';
import { track } from '../../lib/analytics';
import { spacing, sheetStyles } from '../../theme/tokens';
import type { BoardConfig, PlayDrawerProps } from './play-drawer-types';
export type { PlayDrawerOpenOptions, PlayDrawerOpenTarget, PlayDrawerProps } from './play-drawer-types';

const { GestureDetector, Gesture, ScrollView: DefaultScrollView } = GestureHandler;
// Builder gestures need the legacy scroll handler on both preview runtimes:
// RNGH 3 renamed it, while main's RNGH 2 still exports it as ScrollView.
const ScrollView =
  'LegacyScrollView' in GestureHandler
    ? (GestureHandler.LegacyScrollView as typeof DefaultScrollView)
    : DefaultScrollView;

/**
 * What identifies a queue item's page in the swipe (see use-swipe-pager): its
 * climb, or the item itself until the climb is known. Never null for an item
 * that exists, so a neighbour the queue says is there always has a page.
 */
function swipePageId(item: ClimbQueueItem | null | undefined): string {
  return item?.climb?.uuid || item?.uuid || 'unresolved';
}
// How far right of the centre line the top row's trailing cluster starts: half
// the 36pt grabber plus an 8pt gap, so the timer can never reach the grabber.
const TOP_TRAILING_CENTRE_CLEARANCE = 26;
// ⋯'s anchor as AppMenu draws it, which is split by OS rather than by variant:
// Android's M3 overflow IconButton is a 48dp target, iOS and web draw 44pt.
const MENU_ANCHOR_SIZE =
  Platform.OS === 'android' ? topBarByVariant.material.iconTarget : topBarByVariant.liquidGlass.iconTarget;
// Fallback used for the first-screen reserve before the Logbook header has
// been measured, so the board fits without a visible jump on first open.
// A collapsed section header is a single row (title + summary + chevron).
const DEFAULT_SECTION_HEADER_HEIGHT = 52;

/**
 * How long the session must stay solo before an armed browse latch lets go.
 *
 * Longer than the provider's arming dwell, and deliberately so: arming late is a
 * mild inconvenience, but releasing early re-arms wall control under a climber
 * who is still mid-browse with a crew that is merely reconnecting. Ten seconds
 * outlasts a wifi handover and a backgrounded peer's socket teardown, which are
 * the flaps worth surviving, while still guaranteeing that a climber left alone
 * gets their board back without having to find a button.
 */
export const SHARED_BROWSE_LATCH_RELEASE_MS = 10_000;

/** A typical switch-board card at the default text size, until the real one is measured. */
const SWITCH_BOARD_CARD_HEIGHT_ESTIMATE = 184;
/** Room kept above and below the card inside the controls region. */
const SWITCH_BOARD_CARD_MARGIN = spacing[2];

/**
 * Full-screen "now playing" player (Spotify-style track view). Rendered as the
 * content of the `app/play.tsx` modal route (`presentation: 'transparentModal'`):
 * the native modal VC gives the slide-up present, button dismiss, and —
 * crucially — a view-controller stack that the sub-drawers / queue / share sheet
 * present ABOVE (the FullWindowOverlay it replaced could not, since native sheets
 * present off the key window beneath it).
 */
// How long after the wall button's connect a #4979 hold still counts as the one
// that tap ran into: long enough to pick a board in the picker.
const RELIGHT_HELD_AFTER_CONNECT_MS = 60_000;

export function PlayCore({
  swipeDismiss,
  onClose,
  boardConfig,
  onAngleChange,
  isAngleAdjustable = true,
  onOpenQueue,
  boardMismatch = false,
  reachableBoardKeys,
  mismatchBoardLabel,
  onSwitchBoard,
  dismissPlayerAndWait,
  openTarget,
  presentation = 'route',
  paneTopInset = true,
  paneEmptyState,
  acceptsScrollHandoff = false,
  fitBoardToHeight = false,
  renderSidePanel,
  viewer = 'member',
  onSignIn,
}: PlayDrawerProps) {
  // The signed-out reader on app.boardsesh.com's read-only climb URL.
  const isAnonymous = viewer === 'anonymous';
  // The iPad right-column pane is persistent — it has no dismiss. Suppresses the
  // pull-down dismiss gesture, the close chevron, the grabber, and router.dismiss.
  const isPane = presentation === 'pane';
  const { t, i18n } = useTranslation('session');
  const storedSectionsPreference = usePlayDrawerSectionsPreference();
  const [sectionsSettingsOpen, setSectionsSettingsOpen] = useState(false);
  const handleOpenSectionsSettings = useCallback(() => setSectionsSettingsOpen(true), []);
  const handleCloseSectionsSettings = useCallback(() => setSectionsSettingsOpen(false), []);
  // The copy-name toast strings live in the `climbs` namespace, with the rest
  // of the climb actions' copy.
  const { t: tClimbs } = useTranslation('climbs');
  const insets = useSafeAreaInsets();
  // Clear of iPhone Duo's side status bar on the route; none in the pane. 0 on a
  // portrait iPhone. See playContentSideInsets.
  const routeSideInsets = useHorizontalSafeArea();
  const contentSideInsets = playContentSideInsets(presentation, routeSideInsets);
  // The close chevron's footprint (44pt on iOS, 48dp on Material). The top row's
  // trailing cluster takes the same height so ⋯ centres on the chevron, and an
  // Android 48dp overflow button sits inside the cluster it is tapped through.
  const chromeButtonSize = useChromeIconButtonSize();
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  // The route is mounted only while the player is open, so the player is "open"
  // for this component's whole lifetime — this gates the board render, favorite
  // fetch, wake lock, and below-fold sections. Intentionally a constant, NOT
  // useIsFocused: a presented sub-drawer / queue sheet must not drop the wake
  // lock or blank the board mid-tick.
  const isSheetOpen = true;
  const enhancementsReady = useDeferredUntilFrame(isSheetOpen);
  // Measured viewport of the scroll container; drives first-screen sizing so the
  // below-fold (Beta Videos) peek lands.
  const composerCredentialScope = usePrivacyCredentialScope();
  const {
    sheetViewportHeight,
    headerBottomY,
    sectionHeaderMeasurement,
    setSectionHeaderMeasurement,
    handleViewportLayout,
    handleHeaderLayout,
  } = usePlayLayoutMeasurements();
  // Seeded from the open target rather than left null: the effect that applies
  // the target runs after the first commit, so a pane that already has its climb
  // would otherwise paint one frame of the "Pick a climb" placeholder first.
  const [drawerPreviewItem, setDrawerPreviewItem] = usePrivacyScopedState<ClimbQueueItem | null>(() =>
    initialDrawerPreviewItem(openTarget),
  );
  const [drawerPreviewSuggestionSource, setDrawerPreviewSuggestionSource] =
    usePrivacyScopedState<PlaylistSuggestionSource | null>(() =>
      initialDrawerPreviewItem(openTarget) ? (openTarget?.options?.playlistSuggestionSource ?? null) : null,
    );
  // Only crew-captured tracks expire with the latch; explicit previews stay private.
  // True when the preview is the live wall climb (accessory bar) — the displayed
  // climb IS the one physically lit, which is what the "On the wall" pill states.
  const [drawerPreviewIsWallClimb, setDrawerPreviewIsWallClimb] = useState(
    () => !!initialDrawerPreviewItem(openTarget) && !!openTarget?.options?.previewIsWallClimb,
  );
  // The wall-state pill's explainer, and the header's measured bottom edge it
  // hangs from. Owned here rather than inside the pill because the callout is an
  // absolute sibling of the swipeable header (so it doesn't ride the swipe
  // translate) — it can't be a child of the 32pt pill in the header's flank.
  // The end card of the list the player is walking (#6664), open for this climb.
  // Keyed on the climb, and cleared on every climb change, so it never reopens
  // by itself on a climb the climber comes back to.
  const [trackEndCardClimbUuid, setTrackEndCardClimbUuid] = useState<string | null>(null);
  // A preview's mirror toggle, scoped to the climb it was made on. A bare
  // boolean went stale whenever the current climb changed by a route the drawer
  // doesn't own (a party peer advancing the queue, a reorder, the accessory
  // bar) — the drawer only resets it in its own navigation handlers. `isMirrored`
  // is derived below, so a climb this flip wasn't made on simply reads false.
  const [previewMirrorFlip, setPreviewMirrorFlip] = useState<{ climbUuid: string; mirrored: boolean } | null>(null);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const [addBetaVideoOpen, setAddBetaVideoOpen] = useState(false);
  // The climb whose full climber-logs list is open. Keyed on the uuid (like
  // `previewMirrorFlip`) so moving to another climb closes the sheet without an effect.
  const [climberLogsClimbUuid, setClimberLogsClimbUuid] = useState<string | null>(null);
  // Composer targets stay pinned while the climber types. A credential change
  // drops them and remounts the composers.
  const [betaVideoTarget, setBetaVideoTarget] = usePrivacyScopedState<{
    climb: Climb;
    boardConfig: BoardConfig;
  }>(null);
  // Keep the same target for a tick opened from the menu or FAB.
  const [tickTarget, setTickTarget] = usePrivacyScopedState<{
    climb: Climb;
    boardConfig: BoardConfig;
    isMirror: boolean;
  }>(null);
  // Reports keep their target while the climber types the reason.
  const [reportTarget, setReportTarget] = usePrivacyScopedState<{ climb: Climb; boardConfig: BoardConfig }>(null);
  const [reportClimbOpen, setReportClimbOpen] = useState(false);
  // The playlist picker stays on the climb ⋯ was opened for, like the report.
  const [playlistTarget, setPlaylistTarget] = usePrivacyScopedState<{ climb: Climb; boardConfig: BoardConfig }>(null);
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);
  const {
    requested: belowFoldContentRequested,
    request: requestBelowFoldContent,
    requestFromScrollOffset: requestBelowFoldContentFromScrollOffset,
  } = useBelowFoldContentRequest();
  const resetZoomRef = useRef<(() => void) | null>(null);
  // Set true when the user taps to expand the first section peek; the section's next
  // layout then glides it fully into view. Stays armed across the section's
  // loading→loaded height growth (so a slow fetch still lands framed) and is
  // disarmed once the user drives the scroll, collapses it, or the climb changes.
  const pendingFirstSectionScrollRef = useRef(false);

  // RNGH ref for the scroll container. Board gestures coordinate their
  // scroll blocking / simultaneous recognition through this ref (otherwise the plain RN ScrollView starved
  // them after the gorhom removal), and the dismiss gesture reads scroll offset
  // from it. Typed as the ScrollView instance for the `ref` prop; widened to
  // RNGH's GestureRef shape (same object) when handed to the board gestures.
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollGestureRef = scrollRef as unknown as RefObject<ComponentType | undefined | null>;

  // Live scroll offset, gating the pull-down-to-dismiss: it only engages at the
  // top (<= 0) so mid-scroll downward drags still scroll. JS-thread set at 16ms
  // is plenty for a top-detection gate.
  const scrollYSV = useSharedValue(0);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetY = event.nativeEvent.contentOffset.y;
      scrollYSV.value = offsetY;
      // RN Web does not synthesize onScrollBeginDrag for a mouse wheel,
      // trackpad, scrollbar, or keyboard scroll. Open the same deferred-content
      // gate from real movement so the lower drawer sections cannot stay absent.
      requestBelowFoldContentFromScrollOffset(offsetY);
      if (offsetY > 0) pendingFirstSectionScrollRef.current = false;
    },
    [requestBelowFoldContentFromScrollOffset, scrollYSV],
  );
  const handleDismiss = useCallback(() => {
    // The pane is persistent — nothing to dismiss (and no modal to pop).
    if (isPane) return;
    if (onClose) onClose();
    else router.dismiss();
  }, [isPane, onClose]);

  // Which climb is in the middle of a swipe, and the offset it rides. The board
  // carousel and the header (title + grade) share it so they move as one; the
  // carousel's gesture drives it on the UI thread. Created here, ahead of the
  // queue lookups that name the neighbours, because the dismiss gesture below
  // reads the offset. See use-swipe-pager.
  const { pager: swipePager, stepSignal: swipeStepSignal } = useSwipePager();
  const swipeTranslateX = swipePager.translateX;
  const swipeIsAnimating = swipePager.isAnimating;

  // The dismiss reads these so it can stand down while a horizontal swipe owns the
  // gesture (offset non-zero) or a fling is still settling (carousel inert) — that's
  // when an accidental downward drift would otherwise yank the drawer down.
  const {
    gesture: dismissGesture,
    translateY: dismissTranslateY,
    gestureRef: dismissGestureRef,
  } = useDrawerDismissGesture({
    onDismiss: handleDismiss,
    swipeDismiss,
    scrollYSV,
    scrollRef: scrollGestureRef,
    swipeTranslateX,
    swipeIsAnimating,
  });
  const dismissAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  const {
    setCurrentClimb,
    nextClimb,
    previousClimb,
    mirrorCurrentClimb,
    getQueueSnapshot,
    refreshPlaylistSuggestionSource,
  } = useQueueActions();
  const { sessionId } = useQueueSessionId();
  // "Is anyone else here." Read as one boolean off a dedicated selector context
  // so the ≤1/2s session-stats push and every presence delta cost the drawer
  // nothing — it flips only across the solo ↔ crew boundary.
  const isSharedSession = useIsSharedSession();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const bluetooth = useOptionalBluetoothContext();
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const [enhancementSnapshot, setEnhancementSnapshot] = usePrivacyScopedState<PlayCoreEnhancementSnapshot>();
  const handleEnhancementSnapshot = useCallback(
    (snapshot: PlayCoreEnhancementSnapshot | null) => setEnhancementSnapshot(snapshot),
    [setEnhancementSnapshot],
  );
  // App-wide grade resolver: swaps the header grade (label + colour) to the
  // Boardsesh grade when the "Show Boardsesh grades" toggle is on and a trusted
  // one exists, else the legacy Aurora grade. `boardseshActive` also seeds the
  // tick picker's default grade below.
  const { boardseshActive } = useDisplayGrade();
  const { isAuthenticated } = useAuth();
  // The anonymous reader (the web export's read-only climb view) gets the
  // default sections, whatever this browser has stored. They have no ⋯ and no
  // Settings, so a member's "Hide all" left on a shared computer would otherwise
  // strand them with nothing below the board and no way back. The defaults need
  // no read, so they are ready at once. Every other viewer, a guest without an
  // account included, keeps their stored choices: they can reach both ⋯ → View
  // options and Settings → Climb view, and those write exactly that store.
  const preferredSections = isAnonymous ? DEFAULT_PLAY_DRAWER_SECTIONS : storedSectionsPreference.sections;
  // Beside the landscape iPad panel, the column leaves Logbook and Beta to the
  // panel's segments rather than drawing them twice; every other section stays.
  const hasSidePanel = renderSidePanel != null;
  const sections = useMemo(
    () => (hasSidePanel ? withoutPanelSections(preferredSections) : preferredSections),
    [hasSidePanel, preferredSections],
  );
  const sectionOrder = isAnonymous ? DEFAULT_PLAY_DRAWER_SECTION_ORDER : storedSectionsPreference.order;
  const sectionsReady = isAnonymous || storedSectionsPreference.ready;
  // The climber's buttons and where the controls sit (#6229), read synchronously
  // so the first frame already has them. The anonymous reader gets today's bar
  // under the board for the same reason as the sections: `resolveActionBarLayout`
  // ignores the stored buttons for them, and the position is pinned here.
  const playerButtons = usePlayerButtonsPreference();
  const controlsPosition = isAnonymous ? DEFAULT_PLAYER_BUTTONS_POSITION : playerButtons.position;
  // Tabletop (the iPhone Duo half open, its inner display upright): the first
  // screen ends at the fold, so the board fills the top half and never sits on
  // the crease. The controls move out of it to just below the fold, where a
  // hand resting on the table reaches them, whatever the View options say:
  // above the board they would sit above the crease and squeeze a half-height
  // board. The sections follow. Only the full-screen route: the persistent pane
  // lives in the landscape split.
  const tabletopFoldTop = useTabletopFoldTop();
  const tabletop = !isPane && tabletopFoldTop !== null;
  const controlsAbove = controlsPosition === 'above' && !tabletop;
  // The switch-board card's height, so the controls region can hold all of it
  // (see `controlsRegion`). Starts from a typical card and follows the measured one.
  const [switchBoardCardHeight, setSwitchBoardCardHeight] = useState(SWITCH_BOARD_CARD_HEIGHT_ESTIMATE);
  const handleSwitchBoardCardHeight = useCallback((height: number) => {
    const measured = Math.ceil(height);
    setSwitchBoardCardHeight((previous) => (Math.abs(previous - measured) > 1 ? measured : previous));
  }, []);

  const displayedQueueItem = drawerPreviewItem ?? currentClimbQueueItem;
  const displayedClimb = displayedQueueItem?.climb;
  // The slot ⋯ → Play next moves when the same climb is queued twice.
  const displayedQueueItemUuid = displayedQueueItem?.uuid;
  const displayedQueueSlotUuid = useMemo(
    () => resolveQueuedSlotUuid(queue, displayedQueueItemUuid),
    [queue, displayedQueueItemUuid],
  );
  // Where the climb sits in the workout generated at Start (#5379). Null for a
  // session without one, a crew member's phone, and a climb outside the workout.
  const workoutRun = useWorkoutRun(sessionId);
  const workoutQueueUuids = useWorkoutQueueUuids(workoutRun, queue);
  const workoutStageParts = useWorkoutStageParts(workoutRun, workoutQueueUuids, displayedQueueItemUuid);
  // A view-only preview is showing (not the active/wall climb). Commit paths
  // never set `drawerPreviewItem`, so this is true only for genuine previews
  // (workout builder, logbook/cross-board, the peer-driven accessory wall climb).
  const isPreview = drawerPreviewItem != null;
  // The MiniPlayer beside this player stands in for its first row (#7000,
  // the tablet rule): the open Duo's pane, or a tablet's player route. Then the
  // first row is the full-width wall button, and the bar mirrors the rest.
  const miniPlayerMirrors = useMiniPlayerMirrorsPlayer(isPane);
  const wallControlOwnerRef = useRef(Symbol('player-wall-control'));

  // #5099: the shown climb does not have to belong to the board the climber has
  // selected. A queue item left over from a board switch, a party peer on
  // another wall, or a restored launch snapshot all keep their own
  // `boardType`/`layoutId` — and drawing them against the active board's
  // placements matches none of their hold ids, so the renderer drops every hold
  // and paints a veil over bare board art. Draw each climb on ITS board instead,
  // at its own angle, and let the mismatch raise the switch-board gate below.
  const renderBoardResolution = useMemo(
    () => resolveClimbRenderBoard(displayedClimb, boardConfig),
    [displayedClimb, boardConfig],
  );
  const renderBoardConfig = renderBoardResolution?.boardConfig ?? boardConfig;

  const drawerGradeSectionEnabled = useBoardseshGradeEnabled();
  const visibleSectionIds = useMemo(
    () =>
      visiblePlayDrawerSections({
        sections,
        order: sectionOrder,
        isAuthenticated,
        boardseshGradeEnabled: drawerGradeSectionEnabled,
        description: displayedClimb?.description,
        boardName: renderBoardConfig.boardName as BoardName,
        screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
      }),
    [
      sections,
      sectionOrder,
      isAuthenticated,
      drawerGradeSectionEnabled,
      displayedClimb?.description,
      renderBoardConfig.boardName,
    ],
  );
  const firstSectionId = visibleSectionIds[0];
  const hasVisibleSections = sectionsReady && visibleSectionIds.length > 0;
  // In tabletop the sections start inside the viewport, under the controls,
  // rather than one header peek below the fold, so their bodies load at once.
  useEffect(() => {
    if (tabletop && hasVisibleSections) requestBelowFoldContent();
  }, [tabletop, hasVisibleSections, requestBelowFoldContent]);
  const handleDeliberateScrollIntent = useCallback(() => {
    if (hasVisibleSections) requestBelowFoldContent();
  }, [hasVisibleSections, requestBelowFoldContent]);
  const handleScrollTowardBelowFold = useCallback(() => {
    pendingFirstSectionScrollRef.current = false;
    handleDeliberateScrollIntent();
  }, [handleDeliberateScrollIntent]);
  const deliberateScrollGesture = useDeliberateScrollGesture({
    scrollRef: scrollGestureRef,
    scrollYSV,
    isPane,
    onScrollIntent: handleDeliberateScrollIntent,
  });
  const contentGesture = useMemo(
    () =>
      Platform.OS === 'web'
        ? dismissGesture.enabled(!isPane)
        : Gesture.Simultaneous(dismissGesture.enabled(!isPane), deliberateScrollGesture),
    [dismissGesture, deliberateScrollGesture, isPane],
  );
  // An expanded header with a deferred body may fill the viewport exactly.
  // One pixel lets the native recognizer or browser input start scrolling and
  // request the body without waiting for another gesture to release the touch.
  const initialScrollHeight =
    hasVisibleSections && !belowFoldContentRequested ? (sheetViewportHeight || windowHeight) + 1 : undefined;
  const visibleSectionsKey = sectionsReady ? visibleSectionIds.join(',') : 'loading';
  const firstSectionHeaderHeight =
    sectionHeaderMeasurement.sectionId === firstSectionId ? sectionHeaderMeasurement.height : 0;
  const handleFirstSectionHeaderLayout = useCallback(
    (measured: number) => {
      setSectionHeaderMeasurement((previous) =>
        previous.sectionId === firstSectionId && Math.abs(previous.height - measured) <= 2
          ? previous
          : { sectionId: firstSectionId, height: Math.round(measured) },
      );
    },
    [firstSectionId],
  );
  useEffect(() => {
    pendingFirstSectionScrollRef.current = false;
    scrollYSV.value = 0;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [visibleSectionsKey, scrollYSV]);

  const displayedClimbUuid = displayedClimb?.uuid;
  // Only previews have a local flip; committed occurrences persist their own.
  const sharesMirrorState = sessionId !== null && !isPreview;
  const isMirrored =
    isPreview && previewMirrorFlip !== null && previewMirrorFlip.climbUuid === displayedClimbUuid
      ? previewMirrorFlip.mirrored
      : displayedClimb?.mirrored === true;
  const clearMirror = useCallback(() => setPreviewMirrorFlip(null), []);

  // A climb that lost a hold: the banner's count and its one action, Remix.
  const { lostHoldCount, onRemix: handleRemixLostHolds } = useLostHoldRemix({
    displayedClimb,
    renderBoardConfig,
    dismissPlayerAndWait,
  });

  const pushAfterSetterDismiss = usePushAfterPlayerDismiss(dismissPlayerAndWait, 'setter-playlist-handoff');
  const openSetterPlaylist = useCallback(() => {
    const username = displayedClimb?.setter_username;
    if (!username) return;
    pushAfterSetterDismiss(() => router.push({ pathname: '/(tabs)/climbs/setter/[username]', params: { username } }));
  }, [displayedClimb?.setter_username, pushAfterSetterDismiss]);
  // The climb belongs to a genuinely DIFFERENT board model. Same gate as an
  // explicit board override (`boardMismatch` from the host), just discovered
  // from the climb rather than handed in by the opener.
  //
  // Only `'incompatible'` raises it — never `'upsized'`, which is the same board
  // name and layout on a bigger wall (and a MoonBoard climb wanting a set this
  // wall hasn't got). There is no other board to switch TO in that case: the
  // host matches owned boards by name + layout, so the scrim's one button would
  // "switch" to the board the climber is already on and never clear. Playlist
  // rows already draw those on the upsized board without a prompt; so do we.
  const climbBoardMismatch = renderBoardResolution?.fit === 'incompatible';
  // ...but on another board at the gym the climber is standing in, which is a
  // walk rather than a wall. Queue navigation already treats those as targets
  // rather than skipping them, so a swipe lands here routinely now — and meeting
  // a lock scrim that says "switch boards to queue it" for a climb they queued on
  // purpose, twenty metres from the board that draws it, is the wrong answer.
  // The same predicate the queue provider navigates by. Without it here, the
  // drawer's peek, "N left" and canNext are computed from a DIFFERENT rule than
  // the swipe they describe — and with a reachable climb as the only thing left,
  // canNext goes false and the swipe is disabled, so the climb this feature
  // exists to reach cannot be reached forward at all.
  const isReachableClimb = useMemo(() => {
    if (!reachableBoardKeys || reachableBoardKeys.size === 0) return undefined;
    return (climb: { boardType?: string | null; layoutId?: number | null }) =>
      isClimbOnReachableBoard(climb, reachableBoardKeys);
  }, [reachableBoardKeys]);

  const climbBoardReachable =
    climbBoardMismatch &&
    reachableBoardKeys != null &&
    reachableBoardKeys.has(configKey({ boardName: renderBoardConfig.boardName, layoutId: renderBoardConfig.layoutId }));
  // Only the genuinely-elsewhere case blocks. Everything gated on this — the
  // a11y trap, the preview relay, the auto-activate — keeps its old meaning,
  // because a reachable climb is one the controls underneath can still act on.
  const showBoardMismatch = (boardMismatch || climbBoardMismatch) && !climbBoardReachable;
  const switchBoardLabel = climbBoardMismatch ? formatRenderBoardLabel(renderBoardConfig) : mismatchBoardLabel;
  // The host resolves an explicit override on its own; when the mismatch came
  // from the climb there is no override to read, so hand it the board we
  // resolved so "Switch board" lands on the CLIMB's board.
  const handleSwitchBoard = useCallback(() => {
    onSwitchBoard?.(climbBoardMismatch ? renderBoardConfig : undefined);
  }, [onSwitchBoard, climbBoardMismatch, renderBoardConfig]);

  // Everything the DISPLAYED climb is drawn from reads the resolved board. The
  // selected board's own angle stays behind `activeAngle`: the angle pill and
  // the angle sheet drive the wall the climber is standing at, not the picture.
  const { boardName, layoutId, sizeId, setIds, angle } = renderBoardConfig;
  const activeAngle = boardConfig.angle;

  // The play route hosts its OWN BLE controls sheet (below) rather than the
  // app-root one — a native sheet presented from root lands BEHIND this modal
  // route. Local visibility, opened by the lightbulb long-press.
  const [bleControlVisible, setBleControlVisible] = useState(false);
  const handleCloseBleControl = useCallback(() => setBleControlVisible(false), []);

  usePlayDrawerWakeLock(isSheetOpen);

  // The drawer's first render always beats the wall: `DrawerHostProvider` asks
  // for it from an effect. Without a registry subscription this memo would hold
  // the `null` it computed then, and the play surface — the one place a wall is
  // actually climbed on — would sit on `BoardRenderUnavailable` until the
  // climber switched board and back.
  const sprayToken = useSprayWallToken(boardName, layoutId);
  const boardRenderData = useMemo(() => {
    const parsedSetIds = setIds.split(',').map(Number);
    return getBoardRenderData({
      boardName: boardName as BoardName,
      layoutId,
      sizeId,
      setIds: parsedSetIds,
    });
    // `sprayToken` recomputes this when the wall lands or is reset.
  }, [boardName, layoutId, sizeId, setIds, sprayToken]);

  // Real favorite status for the heart, keyed on (boardName, climbUuid, angle).
  // Gated on the sheet being open so it doesn't fetch while the drawer is closed.
  // The displayed state is the local optimistic override when set, otherwise the
  // server's truth — so the heart reflects whether the climb is already a favorite
  // on open, and a single tap can't invert reality (the previous always-false
  // local state silently un-favorited already-favorited climbs).
  // `favorites` is `requireAuthenticated` on the backend, and the heart is hidden
  // anonymously anyway — arming it would fire a query that can only 401 on every
  // read-only open. The hook re-checks the session itself; this is the local half.
  const { showToast } = useToast();
  const matchingEnhancement =
    enhancementSnapshot?.targetKey ===
      getPlayCoreEnhancementTargetKey(boardName, displayedClimb?.uuid ?? null, angle) &&
    enhancementSnapshot.credentialGeneration === composerCredentialScope
      ? enhancementSnapshot
      : null;
  const serverFavorited = matchingEnhancement?.serverFavorited;
  const toggleFavoriteMutate = matchingEnhancement?.toggleFavoriteMutate;
  const { isFavorited, handleToggleFavorite, handleToggleFavoriteFromMenu } = usePlayFavorite({
    displayedClimb,
    boardName,
    layoutId,
    angle,
    serverFavorited,
    toggleFavoriteMutate,
    bluetoothConnected: bluetooth?.isConnected ?? false,
    showToast,
    t,
  });
  // Lit visual, pending pulse, and the connect/disconnect tap — shared with the
  // toolbar bulb via `useLightbulbControl`, so both light identically (this
  // device, or a session peer driving the wall) and run one connect path. The
  // press action also accounts for a session peer holding the wall; the label
  // follows that action rather than the local BLE connection alone.
  //
  // While a session peer holds the board, the tap RELAYS instead: an Aurora /
  // MoonBoard box takes one central at a time, so a connect from here could only
  // spend 15s scanning and then claim "Connection failed" over a wall that is
  // lit and working. Making the displayed climb the session's current
  // climb lights it on the holder's link — the same path a queue add already
  // rides — with no BLE from this device.
  //
  // The relay itself is `commitDisplayedToWall`, declared far below because it
  // needs the latch announcer. The bulb is handed a STABLE wrapper over a ref so
  // the hook's press callback doesn't re-create on every preview change.
  const relayToHolderRef = useRef<(() => void) | null>(null);
  const handleRelayToHolder = useCallback(() => relayToHolderRef.current?.(), []);
  // Only a PINNED PREVIEW is relayable. With none, the displayed climb is
  // already the queue's current one, so there is nothing to put up and the tap
  // resolves to 'noop' — reported honestly rather than claiming a 'relay' that
  // could only early-return. `showBoardMismatch` is excluded for the same reason the
  // commit bar excludes it (resolveCommitBarModel): committing a climb from a
  // board the climber isn't on must not reach the wall. That was previously safe
  // only because the SwitchBoardOverlay scrim happens to cover the bulb.
  const canRelayToHolder = isPreview && !showBoardMismatch;
  const {
    lit: lightbulbActive,
    localConnected: bluetoothConnected,
    pending: lightbulbPending,
    onPress: handleLightbulb,
    connect: connectLightbulb,
    moveToClimbBoard: moveLightbulbToClimbBoard,
    pressAction: lightbulbPressAction,
    holderIsAuthoritative: lightbulbHolderIsAuthoritative,
    wallHeldLocally,
    ledless: boardIsLedless,
  } = useLightbulbControl({
    surface: 'play_drawer',
    onRelayToHolder: handleRelayToHolder,
    canRelay: canRelayToHolder,
  });
  const { data: activeBoardForNavigation } = useActiveBoard();
  // The board at this gym that draws the climb on screen, when it isn't the
  // active one (#7076): what Put on {board} names and moves to. The same lookup
  // the connect and the drawer host's switch use, so all three name one board.
  const { data: playerGymBoards } = useGymBoards(activeBoardForNavigation?.gymUuid ?? null);
  const climbGymBoard = useMemo(
    () =>
      climbBoardReachable && !showBoardMismatch
        ? findGymBoardToConnectForClimb(
            { boardType: renderBoardConfig.boardName, layoutId: renderBoardConfig.layoutId },
            activeBoardForNavigation,
            playerGymBoards,
          )
        : null,
    [
      climbBoardReachable,
      showBoardMismatch,
      renderBoardConfig.boardName,
      renderBoardConfig.layoutId,
      activeBoardForNavigation,
      playerGymBoards,
    ],
  );
  const climbGymBoardName = climbGymBoard ? gymBoardButtonName(climbGymBoard, playerGymBoards) : null;
  // A crewmate moved the session to that board and lights it there. In a crew,
  // the climb is theirs to light: this phone relays to them rather than taking
  // the board (Marco: crewmates keep their own board and see the crew's state).
  const sessionBoardPath = useSessionBoardPath();
  const climbOnCrewGymBoard =
    isSharedSession && climbGymBoard !== null && sessionBoardPathNamesBoard(sessionBoardPath, climbGymBoard);
  const activeBoardForLoggingRef = useRef(activeBoardForNavigation);
  activeBoardForLoggingRef.current = activeBoardForNavigation;
  // View options lists the MoonBoard-only Active holds switch on a MoonBoard
  // climb even when the active board is another (a reachable gym board), so
  // the climber can always turn off a section they can see.
  const sectionsListActiveHolds = isMoonboardBoardName(boardName) || activeBoardIsMoonboard(activeBoardForNavigation);
  const {
    navigationSuggestionSource,
    navigationState,
    currentTrackLabel,
    trackListClimbUuid,
    trackEndCard,
    listWalkUpNextCount,
    nextHeaderClimb,
    previousHeaderClimb,
    nextHeaderBoard,
    previousHeaderBoard,
    nextPeekFrames,
    prevPeekFrames,
    upcomingPrefetchFrames,
  } = usePlayNavigationModel({
    queue,
    displayedQueueItem,
    displayedClimb,
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    currentClimbQueueItem,
    historyCount,
    playlistSuggestionSource,
    activeBoardForNavigation,
    boardConfig,
    renderBoardConfig,
    isReachableClimb,
    enhancementsReady,
  });

  // The top bar says where the player is: the workout stage (#5379) or the list
  // it walks (#6664), "Projects · 4 of 23". Not the header's stats line, where
  // either pushed the sends and stars off the end (#6745). A climb outside the
  // workout has no stage, so a list tapped mid-workout still names itself; a
  // climb in both says its stage, the frame the climber planned around.
  const trackLocale = i18n.language;
  const currentTrackParts = useMemo(
    () => formatTrackLabelParts(currentTrackLabel, t, trackLocale),
    [currentTrackLabel, t, trackLocale],
  );
  const topBarParts = workoutStageParts ?? currentTrackParts;
  // The list label sits between ⌄ and the timer + ⋯ cluster, so it needs the
  // cluster's width, which grows when the rest timer comes up. Null until the
  // cluster has laid out (see `resolveTopListContextFrame`).
  const [topTrailingContentWidth, setTopTrailingContentWidth] = useState<number | null>(null);
  const handleTopTrailingLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setTopTrailingContentWidth((previous) => (previous === measured ? previous : measured));
  }, []);
  const topListContextFrame = resolveTopListContextFrame({
    isPane,
    chromeButtonSize,
    trailingContentWidth: topTrailingContentWidth,
    hasMenu: !isAnonymous,
    gap: spacing[2],
  });
  // More of a long list arrives as the climber nears the end of what is loaded.
  const getCommittedSuggestionSource = useCallback(
    () => getQueueSnapshot().playlistSuggestionSource,
    [getQueueSnapshot],
  );
  useTrackPaging({
    source: navigationSuggestionSource,
    listClimbUuid: trackListClimbUuid,
    previewTrack: drawerPreviewItem != null,
    setPreviewSource: setDrawerPreviewSuggestionSource,
    getCommittedSource: getCommittedSuggestionSource,
    refreshCommittedSource: refreshPlaylistSuggestionSource,
  });

  // The page each of the three climbs is on. Keyed on the CLIMB, which a
  // suggestion keeps when a swipe turns it into a queue item, so the board that
  // was the neighbour is recognised as the current one and is not remounted.
  // Whether a neighbour EXISTS is `canNext` / `canPrevious`, the same answer the
  // Next and Previous buttons use: a queue item a crew member added that has
  // not been resolved to a climb yet is still somewhere to swipe to.
  const swipeCenterPage = useSwipePages(
    swipePager,
    swipeStepSignal,
    navigationState.canPrevious ? swipePageId(navigationState.prevItem) : null,
    swipePageId(displayedQueueItem),
    navigationState.canNext ? swipePageId(navigationState.nextItem) : null,
  );

  // Multi-frame route playback (animation + BLE + party-sync). Boulders
  // short-circuit inside the hook (isAnimatable === false), so nothing renders
  // and the drawer behaves exactly as before for single-frame climbs.
  const playback = useMobilePlayback({
    climb: displayedClimb ?? null,
    boardName: boardName as BoardName,
    mirrored: isMirrored,
    isOpen: isSheetOpen,
    // A pinned preview is not what the wall is showing, so scrubbing a route
    // preview animates on screen and nowhere else: no BLE frame writes, no
    // playback broadcast to the crew. The LIVE climb keeps its frames and
    // resumes writing when the preview clears.
    viewOnly: isPreview,
    // A climb from another board is suppressed for a harder reason: its hold ids
    // address a different wall, so writing them lights the WRONG holds on the
    // connected board. The scrim hides the play controls, but a party peer's
    // playback event starts the engine with no local tap, so the guard belongs
    // here rather than on the button (#5099). Frames only — the crew still
    // hears the playback, it is this wall that cannot show it.
    suppressWallWrites: climbBoardMismatch,
  });

  // Auto-close the tick bar when the climb changes.
  useEffect(() => {
    setIsTickBarActive(false);
    // Drop the local flip on EVERY climb change, not just the drawer's own
    // navigation handlers. A climb change it doesn't own (a party peer, Live
    // Activity, the accessory bar) would otherwise leave the flip parked on its
    // old climb, and coming back to that climb would resurrect it — remembering
    // a flip that swiping away forgets.
    setPreviewMirrorFlip(null);
    // A new climb's Logbook re-lays out from scratch — don't let a stale expand
    // intent auto-scroll it.
    pendingFirstSectionScrollRef.current = false;
    // The end card was about the climb that was on screen.
    setTrackEndCardClimbUuid(null);
  }, [displayedClimbUuid]);

  // --- The shared-session browse latch ---------------------------------------
  //
  // In a crew, every browse-shaped gesture stays view-only: a swipe, a climb-list
  // tap and a similar-climb tap all show you a climb without writing the shared
  // queue or moving anyone's wall. Putting a climb up becomes the one explicit
  // act, on the commit row.
  //
  // The latch has its own state rather than being read live off
  // `isSharedSession` because mid-browse the roster can change under you — a peer
  // drops off the wifi, someone leaves — and a live gate would turn the very next
  // swipe back into a wall-driving commit while the climber's hand was already
  // moving. So entering a browse in a crew ARMS it, and the climber's own exits
  // disarm it (Back to live, a commit, or opening a committed climb). The arming
  // effect is deliberately broader than "the first view-only gesture": a crew
  // forming while a preview is already pinned latches too, so the climber who was
  // mid-browse when a second phone joined gets the safe posture without
  // re-entering the preview.
  //
  // It is NOT one-way, though it was, and that was a bug rather than a strict
  // reading of the rule above. A latch that only the climber can clear assumes
  // they know it is there; the climber who never opened the commit row just found
  // that their swipes had quietly stopped lighting the board, with the crew that
  // caused it long gone. So the latch survives a peer flapping and then releases:
  // once the session has genuinely been solo for a dwell, ordinary wall control
  // comes back on its own. The exits still fire instantly — this only covers the
  // case where nobody ever took one.
  const [sharedBrowseLatched, setSharedBrowseLatched] = useState(false);
  useEffect(() => {
    if (isSharedSession && isPreview) setSharedBrowseLatched(true);
  }, [isSharedSession, isPreview]);
  useEffect(() => {
    if (isSharedSession) return;
    const timer = setTimeout(() => {
      setSharedBrowseLatched(false);
    }, SHARED_BROWSE_LATCH_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [isSharedSession]);
  // What the gestures and the chrome both read. Live crew OR a latch that armed
  // while there was one.
  const browseByDefault = isSharedSession || sharedBrowseLatched;

  // --- Wall state (header back chip + the wall button) -----------------------
  //
  // Everything keys on DISPLAYED-EQUALS-WALL, never on who holds Bluetooth.
  //
  // The lit climb is read from board presence continuously, so the pill can say
  // "On the wall" after a plain swipe lands back on it and the busy-wall confirm
  // has something to compare against. `drawerPreviewIsWallClimb` stays as the
  // fallback rather than being retired with it: the accessory-bar preview knows
  // it is the lit climb by construction, and it is still right when this drawer
  // renders outside the board-presence provider's subtree (where the read
  // degrades to a dark wall instead of throwing).
  const wallClimb = useWallClimb();
  const wallClimbUuid = wallClimb.uuid ?? (isPreview && drawerPreviewIsWallClimb ? (displayedClimbUuid ?? null) : null);
  // Board presence's wall climb is trusted with a live link, or for an hour
  // after it was lit without one (QA #147): Aurora and MoonBoard boxes keep
  // their LEDs after a disconnect. One rule for the board control, the lit
  // read and the back chip (`presence-freshness.ts`).
  const wallPresenceFresh = usePresenceFresh(wallClimb.sentAt);
  const wallPresenceTrusted = isWallPresenceTrusted({
    // A live link: this phone's, or a crewmate's (the same read the Climbs header's capsule takes).
    linked: lightbulbActive,
    presenceFresh: wallPresenceFresh,
  });
  // Being in a preview is NOT enough to claim browsing. With `lightOnSwipe` on,
  // no suggestion source and nobody else in the session (the explicit "Preview"
  // climb action, a deep link, the workout builder) the next swipe falls straight
  // through to `setCurrentClimb` — it writes the shared queue and re-arms the BLE
  // auto-sender. So the latch is "a preview whose navigation genuinely stays
  // view-only", read off the same predicate the swipe handlers use, which is what
  // stops the chrome from ever promising more than the gesture keeps.
  const browseLatchActive =
    isPreview &&
    swipeStaysViewOnly({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      lightOnSwipe,
      inSharedSession: browseByDefault,
    });
  // Whether a swipe from a NON-preview state would drive the wall — the pill's
  // `live` claim. Derived from the same predicate rather than restated, so a crew
  // (where swipes browse) can't be told its next swipe goes up on the wall.
  const navigationCommits = !swipeStaysViewOnly({
    previewItem: null,
    previewSuggestionSource: null,
    lightOnSwipe,
    inSharedSession: browseByDefault,
  });
  // --- Busy-wall confirm -----------------------------------------------------
  //
  // Someone else lit a climb while you were browsing. Taking the wall silently
  // would blank a climb another climber may be mid-attempt on, so the first
  // "Put on the wall" tap asks instead of committing.
  //
  // What it compares against is the wall AS IT WAS when browsing began, which is
  // why the snapshot is taken on the latch's rising edge and read from a ref:
  // depending on `wallClimbUuid` here would re-snapshot on every wall event and
  // the question could never arise.
  const wallClimbUuidRef = useRef(wallClimbUuid);
  wallClimbUuidRef.current = wallClimbUuid;
  const wallUuidAtLatchStartRef = useRef<string | null>(null);
  const latchStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!browseLatchActive) return;
    wallUuidAtLatchStartRef.current = wallClimbUuidRef.current;
    latchStartedAtRef.current = Date.now();
  }, [browseLatchActive]);
  // A wall read that lands AFTER the snapshot was taken. At a cold start the
  // presence feed may still be connecting when browsing begins, so the snapshot
  // reads `null` — which is what a dark wall reads like too. When the climb that
  // then arrives was lit well before this browse started, it IS the snapshot, and
  // recording it as such is what stops the first commit tap from announcing
  // "Someone just lit X" about a climb nobody touched. Ambiguous reads change
  // nothing and leave the confirm free to arm.
  const wallClimbSentAt = wallClimb.sentAt;
  useEffect(() => {
    if (!browseLatchActive) return;
    if (
      shouldAdoptLateWallRead({
        wallUuidAtLatchStart: wallUuidAtLatchStartRef.current,
        wallClimbUuid,
        wallClimbSentAt,
        latchStartedAt: latchStartedAtRef.current,
      })
    ) {
      wallUuidAtLatchStartRef.current = wallClimbUuid;
    }
  }, [browseLatchActive, wallClimbUuid, wallClimbSentAt]);
  const [busyWallConfirmArmed, setBusyWallConfirmArmed] = useState(false);
  // Browsing on is one of the three ways the confirm stands down: the question
  // was "put THIS up instead of theirs", and this is no longer what's on screen.
  // Keyed on the displayed climb rather than repeated in each of the prev /
  // next / similar / list-tap handlers, so a navigation path added later can't
  // forget it.
  useEffect(() => {
    setBusyWallConfirmArmed(false);
  }, [displayedClimbUuid]);
  // Amendment B: NO auto-timeout. A question about someone else's climb doesn't
  // get to expire on a timer while the climber is looking at the wall to decide.
  // It stands down on exactly three things: "Keep theirs" (below), any further
  // browse navigation (the displayed-climb effect above — the question was about
  // a climb that is no longer on screen), and the conflict resolving itself,
  // which is this effect: the wall going dark, coming back to what it showed
  // when browsing started, or landing on the very climb about to be committed
  // all leave nothing to ask.
  useEffect(() => {
    if (!busyWallConfirmArmed) return;
    const stillBusy = shouldArmBusyWallConfirm({
      wallClimbUuid,
      wallUuidAtLatchStart: wallUuidAtLatchStartRef.current,
      displayedClimbUuid: displayedClimbUuid ?? null,
    });
    if (!stillBusy) setBusyWallConfirmArmed(false);
  }, [busyWallConfirmArmed, wallClimbUuid, displayedClimbUuid]);

  const commitBarModel = resolveCommitBarModel({
    // Wider than the latch on purpose: a `lightOnSwipe`-on preview with no
    // suggestion source shows no browsing chrome (its swipes commit), but the
    // pinned climb keeps its activation button — the old banner's contract.
    previewPinned: isPreview,
    isAnonymous,
    boardMismatch,
    displayedClimbUuid: displayedClimbUuid ?? null,
    committedHeadUuid: currentClimbQueueItem?.climb.uuid ?? null,
    wallClimbUuid,
    confirmArmed: busyWallConfirmArmed,
    wallDriven: lightbulbActive,
    // A connect already in flight counts, so Put on the wall keeps its label
    // while the board is found. Never while
    // another account holds the board: it takes one phone at a time.
    tapConnects:
      (lightbulbPressAction === 'connect' || (lightbulbPending && !bluetoothConnected)) &&
      !(bluetooth?.wallHeldByOtherUser ?? false),
  });
  // #4979: the board connected but the hold kept this climb dark, because it
  // hasn't changed for 4 h or more. The wall button reads it as dark and its
  // tap re-lights it (a reassert, which releases the hold), with "Last on the
  // wall …" saying why the board is dark.
  const staleCurrentHold = bluetooth?.staleCurrentHold ?? null;
  // The wall button's re-light of a dark current climb: a reassert, which
  // releases the #4979 hold and clears a "Turn off all lights". A list pick of
  // the held climb takes the same path (the selection controller, section 6
  // decision A).
  const handlePutHeldClimbOnWall = useCallback(() => {
    resetWallCleared();
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);
  // "Turn off all lights" (#6939): the link is up and the queue didn't move, so
  // only this says the current climb is dark. The wall button re-lights it, the
  // same reassert as the held climb's.
  const wallClearedClimbUuid = useWallClearedClimbUuid();
  // A "Turn off all lights" is about one link and one write. A dropped link
  // forgets it, so the next connect's lit climb doesn't read dark; so does the
  // wall coming back to the cleared climb (clear A, Next, Previous), since that
  // write lit it again.
  const linkedBeforeRef = useRef(bluetoothConnected);
  useEffect(() => {
    const dropped = linkedBeforeRef.current && !bluetoothConnected;
    linkedBeforeRef.current = bluetoothConnected;
    if (dropped) resetWallCleared();
  }, [bluetoothConnected]);
  const wallClimbBeforeRef = useRef(wallClimbUuid);
  useEffect(() => {
    const changed = wallClimbBeforeRef.current !== wallClimbUuid;
    wallClimbBeforeRef.current = wallClimbUuid;
    if (changed && wallClimbUuid !== null && wallClimbUuid === wallClearedClimbUuid) resetWallCleared();
  }, [wallClimbUuid, wallClearedClimbUuid]);
  const clearedClimbOnScreen =
    wallClearedClimbUuid !== null &&
    bluetoothConnected &&
    !isAnonymous &&
    !showBoardMismatch &&
    displayedClimbUuid === wallClearedClimbUuid &&
    currentClimbQueueItem?.climb.uuid === wallClearedClimbUuid;
  // What the wall button and the hold note read: the held climb is dark
  // wherever it is on screen, a pinned preview of it included, like the
  // cleared climb above.
  const heldClimbDisplayed =
    staleCurrentHold !== null &&
    !isAnonymous &&
    !showBoardMismatch &&
    currentClimbQueueItem?.uuid === staleCurrentHold.queueItemUuid &&
    displayedClimbUuid === currentClimbQueueItem.climb.uuid;
  const displayedClimbDark = heldClimbDisplayed || clearedClimbOnScreen;
  // The resolvers take the RAW latch and do their own anonymous suppression, so
  // that rule stays where its table tests can see it rather than being pre-baked
  // out at this call site.
  const wallPillState = resolveWallPillState({
    isAnonymous,
    displayedClimbUuid: displayedClimbUuid ?? null,
    wallClimbUuid,
    browseLatchActive,
    // `lightOnSwipe` off is precisely "the next swipe does NOT drive the wall"
    // (it's what `getSwipeNavigationTarget` turns into `forceViewOnly`); in a
    // crew the same answer comes from the browse gate.
    navigationCommits,
    // The lightbulb's own signal: this device's BLE link, or a session member's.
    // Merely being IN a session is not enough — the Start button opens one solo,
    // and a solo session with nothing connected moves no wall.
    wallDriven: lightbulbActive,
    // A dark current climb (the #4979 hold, or the lights turned off) claims
    // neither On the wall nor Live, whatever presence still names (#7000).
    // Known only on this phone, the one holding the link.
    currentDark: displayedClimbDark,
    // A reachable other board's climb: the connected wall refuses its holds.
    otherBoard: climbBoardMismatch,
  });
  // Whether the climb on screen is lit, for the wall button's "Lit on the
  // wall" (#6939, #7000): the board draws the same glowing holds whether or not
  // they are lit, so this is what says so. A story can force it, and the back
  // chip below, to shoot every wall state on one simulator.
  const scenarioPlayer = useDevScenarioPlayer();
  // A crewmate's phone turned the lights off on this climb (#7015): board
  // presence says so. Only read without this phone's own link: the phone holding
  // the link has its own store above, which a re-light resets at once, while the
  // feed's copy would wait for the echo and read dark over a lit climb.
  const feedClearedClimbUuid = usePresenceClearedClimbUuid();
  const presenceClearedClimbUuid = bluetoothConnected ? null : feedClearedClimbUuid;
  const displayedWallLit = resolveWallLit({
    isAnonymous,
    boardHasLights: bluetooth !== null && !boardIsLedless && boardName !== 'spray',
    boardMismatch: showBoardMismatch,
    otherBoard: climbBoardMismatch,
    displayedClimbUuid: displayedClimbUuid ?? null,
    committedHeadUuid: currentClimbQueueItem?.climb.uuid ?? null,
    wallClimbUuid,
    isPreview,
    wallDriven: lightbulbActive,
    currentDark: displayedClimbDark,
    presenceClearedClimbUuid,
    presenceFresh: wallPresenceFresh,
  });
  const wallLit = scenarioPlayer?.wallLit !== undefined ? scenarioPlayer.wallLit : displayedWallLit;
  // "Turn off all lights" from a preview of the climb on the wall (not the queue
  // head): the board sheet marks the wall's climb, so this preview reads dark.
  const clearedWallPreviewOnScreen =
    wallClearedClimbUuid !== null &&
    bluetoothConnected &&
    displayedClimbUuid === wallClearedClimbUuid &&
    displayedClimbUuid === wallClimbUuid &&
    currentClimbQueueItem?.climb.uuid !== wallClearedClimbUuid;
  const displayedLit = wallLit === 'lit' && !clearedWallPreviewOnScreen;
  // "Last on the wall …" while the #4979 hold keeps the current climb dark.
  const heldLastOnWallAt = heldClimbDisplayed && staleCurrentHold ? staleCurrentHold.lastCurrentChangeAt : null;
  // A workout's rest or "Workout done" card owns the board; the hold note waits
  // while it, the end-of-list card or the switch-board gate is up.
  const [workoutCardShown, setWorkoutCardShown] = useState(false);
  // A timed workout block's one-tap Fell / Sent (#6231): the climb on the wall,
  // in a stage that paces the rest, that this climber can log from here. It
  // takes the second row (`workoutOutcome` below), and the bulb comes back to
  // the first row meanwhile.
  const showWorkoutOutcome =
    sessionId !== null &&
    shouldShowWorkoutOutcome({
      run: workoutRun,
      displayedQueueItemUuid: displayedQueueItemUuid ?? null,
      committedQueueItemUuid: currentClimbQueueItem?.uuid ?? null,
      signedIn: isAuthenticated && !isAnonymous,
      boardMismatch: showBoardMismatch,
      isDraft: displayedClimb?.is_draft === true,
    });
  // What a Fell / Sent tap logs against (`showWorkoutOutcome` above).
  const liveWorkoutOutcome = useMemo<WorkoutOutcomeTarget | null>(() => {
    const committedQueueItemUuid = currentClimbQueueItem?.uuid ?? null;
    if (!showWorkoutOutcome || !displayedClimb || committedQueueItemUuid === null || sessionId === null) return null;
    return {
      climb: displayedClimb,
      queueItemUuid: committedQueueItemUuid,
      sessionId,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      isMirror: isMirrored,
    };
  }, [
    showWorkoutOutcome,
    currentClimbQueueItem?.uuid,
    displayedClimb,
    sessionId,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    isMirrored,
  ]);
  // When the wall leaves the timed block (an on-the-minute beat onto a climb
  // outside it), Fell / Sent stays a moment for the climb it left, so a tap
  // already on its way lands there and not on the angle or the heart. Everything
  // below reads this, so the row swaps once, after the hold.
  const workoutOutcomeShown = useWorkoutOutcomeHold({
    live: liveWorkoutOutcome,
    committedQueueItemUuid: currentClimbQueueItem?.uuid ?? null,
    displayedQueueItemUuid: displayedQueueItemUuid ?? null,
    sessionId,
    canLog: isAuthenticated && !isAnonymous && !showBoardMismatch,
  });
  const workoutOutcome = workoutOutcomeShown?.target ?? null;
  // What the browse latch asks for: Put on the wall (one of the wall button's
  // states), or the busy-wall question in the wall button's place. A story can
  // force the question (`ScenarioOverrides.player.busyWall`).
  const scenarioBusyWall = scenarioPlayer?.busyWall ?? null;
  const commitButton: ActionBarCommitButton =
    scenarioBusyWall !== null ? 'confirm' : resolveCommitButton(commitBarModel);
  const busyWallUp = commitButton === 'confirm';
  // The board control (#7000): what it says about the climb on screen, whose
  // board it is, and what a tap and a hold do. One model for every view of
  // it (the wall button, the bulb, the open Duo's bar bulb); they draw only
  // this. A face needs a live link: presence alone never puts one up.
  const wallWriting = useBluetoothWriteInProgress();
  const wallHolderIdentity = useWallHolderIdentity();
  // The signed-in climber, from the profile or the device's stored identity, so
  // a second phone on this account knows itself before its profile loads.
  // Unknown (signed out, nothing loaded yet) is never read as somebody else.
  const viewerUserId = useViewerUserId();
  // A story can say this phone holds the board (`ScenarioOverrides.player.selfHoldsBoard`).
  const wallLinked = scenarioPlayer?.selfHoldsBoard === true || bluetoothConnected;
  const selfHoldsBoard = wallLinked || wallHeldLocally;
  // This climber's profile: their face while they hold the board.
  const { data: wallSelfProfile } = useProfile({ enabled: selfHoldsBoard && !isAnonymous });
  const selfFace = useMemo(
    () =>
      wallSelfProfile
        ? { name: wallSelfProfile.displayName ?? null, avatarUrl: wallSelfProfile.avatarUrl ?? null }
        : null,
    [wallSelfProfile],
  );
  const wallControl = useMemo(
    () =>
      resolveWallControl({
        commitButton,
        pressAction: lightbulbPressAction,
        holderIsAuthoritative: lightbulbHolderIsAuthoritative,
        localConnected: wallLinked,
        pending: lightbulbPending,
        displayedLit,
        // The switch-board overlay, another board's climb, or a board with no
        // lights: the connected wall can't light what's on screen.
        offWall: showBoardMismatch || climbBoardMismatch || boardIsLedless || boardName === 'spray',
        // ...unless another board at this gym draws it: then Put on {board} (#7076).
        gymBoardName: climbGymBoardName,
        crewGymBoard: climbOnCrewGymBoard,
        wallHeldLocally,
        // On the wall per presence with no link (QA #147).
        displayedIsWallClimb: wallClimb.uuid !== null && displayedClimbUuid === wallClimb.uuid,
        presenceFresh: wallPresenceFresh,
        displayedIsOwnCurrent:
          displayedClimbUuid != null && displayedClimbUuid === (currentClimbQueueItem?.climb.uuid ?? null),
        // Presence's named holder only, never whoever lit the climb: this phone's
        // own climb from before a relaunch is not "On your other phone".
        holderIsSelfAccount: isHolderSelfAccount(wallHolderIdentity.holderUserId, viewerUserId),
        selfFace,
        crewFace: wallHolderIdentity.face,
        confirmArmed: busyWallUp,
        commitLabel: commitBarModel.commitLabel,
        otherClimbLit: wallClimbUuid !== null && wallClimbUuid !== displayedClimbUuid,
        writing: wallWriting,
        autoDisconnectWarning: bluetooth?.autoDisconnectWarning ?? false,
        // Driving the board: a swipe from here goes up on the wall (#7017).
        navigationCommits: navigationCommits && !browseLatchActive,
      }),
    [
      commitButton,
      lightbulbPressAction,
      lightbulbHolderIsAuthoritative,
      wallLinked,
      lightbulbPending,
      displayedLit,
      showBoardMismatch,
      climbBoardMismatch,
      climbGymBoardName,
      climbOnCrewGymBoard,
      boardIsLedless,
      boardName,
      wallHeldLocally,
      wallClimb.uuid,
      wallPresenceFresh,
      currentClimbQueueItem?.climb.uuid,
      wallHolderIdentity,
      viewerUserId,
      selfFace,
      busyWallUp,
      commitBarModel.commitLabel,
      wallClimbUuid,
      displayedClimbUuid,
      wallWriting,
      bluetooth?.autoDisconnectWarning,
      navigationCommits,
      browseLatchActive,
    ],
  );
  const wallControlState: WallControlState = wallControl.state;
  const { markLatchExit, suppressBrowseAnnouncement } = useWallStateAnnouncer({
    pillState: wallPillState,
    climbName: displayedClimb?.name ?? null,
  });

  // Something silently changed what a swipe does, so say so to a screen reader,
  // once. Fires the first time the latch actually engages: joining a crew, or
  // (solo) the first navigation that stays view-only because board lighting is
  // off for swipes and taps. Sighted climbers get the Put on the wall button and
  // the back chip appearing; there's no card on top of the board any more.
  //
  // The solo half is gated on a wall being reachable at all. With no board
  // connected, no session and nothing lit, "the wall stays put" is a sentence
  // about something the climber hasn't got. Read from the wall itself, not the
  // commit label: with no board connected that label offers to connect one.
  const wallReachable = wallClimbUuid != null || lightbulbActive;
  useEffect(() => {
    if (isAnonymous || !browseLatchActive) return;
    const claimed = isSharedSession ? claimJoinedBrowseNotice(sessionId) : wallReachable && claimSoloBrowseNotice();
    if (!claimed) return;
    // Spoken on both platforms. The drawer can open straight into a browse (a
    // crew climb-list tap), where there is no state transition for the
    // wall-state announcer to narrate. Its browse sentence stands down when this
    // speaks, so one moment gets one sentence.
    suppressBrowseAnnouncement();
    AccessibilityInfo.announceForAccessibility(t('playView.wallState.joinedBrowseNotice'));
  }, [isAnonymous, isSharedSession, browseLatchActive, sessionId, wallReachable, suppressBrowseAnnouncement, t]);

  // Leave the browse latch: drop the pinned preview (and the peek anchor + wall
  // flag that ride it) so the drawer re-derives from the committed queue head,
  // and disarm the one-way shared-session latch — this is one of the two exits
  // that are allowed to. Nothing is sent, nothing is written.
  //
  // This is also "Keep theirs": answering the busy-wall question by leaving the
  // other climber's climb up IS going back to live, so the two share a handler
  // rather than drifting into two subtly different exits.
  const handleBackToLive = useCallback(() => {
    markLatchExit('backToLive');
    setBusyWallConfirmArmed(false);
    setSharedBrowseLatched(false);
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setDrawerPreviewIsWallClimb(false);
    // Mirroring is drawer-local per displayed climb: every other navigation
    // resets it, and carrying a preview's mirror onto the committed head would
    // render (and, once animatable playback resumes, re-send) the head flipped.
    clearMirror();
  }, [markLatchExit, setDrawerPreviewItem, setDrawerPreviewSuggestionSource]);
  // The header chip as drawn (`resolveHeaderPillState`): during a preview it is
  // the way back, when back goes anywhere.
  const committedHeadUuid = currentClimbQueueItem?.climb.uuid ?? null;
  const resolvedHeaderPill = useMemo(
    () =>
      resolveHeaderPillState({
        previewPinned: isPreview,
        isAnonymous,
        displayedClimbUuid: displayedClimbUuid ?? null,
        committedHeadUuid,
        // Back to the wall only while presence is trusted (QA #147).
        wallClimbUuid: wallPresenceTrusted ? wallClimbUuid : null,
        isPane,
      }),
    [isPreview, isAnonymous, displayedClimbUuid, committedHeadUuid, wallClimbUuid, wallPresenceTrusted, isPane],
  );
  // A story's forced chip replaces the resolved one, so its back target, its
  // press and the holder pip all read the one value.
  const headerPill: HeaderPill =
    scenarioPlayer?.wallPill === undefined
      ? resolvedHeaderPill
      : scenarioPlayer.wallPill === 'browsing'
        ? { state: 'browsing', backTarget: 'current' }
        : null;
  const headerPillState = headerPill?.state ?? null;
  const headerBackTarget = headerPill?.backTarget ?? null;
  // Back always lands on the climber's committed climb (the wall's too, when
  // back is to the wall), so the chip names that one to a screen reader.
  const headerBackTargetName = currentClimbQueueItem?.climb.name ?? null;

  // What looking at this climb does to the wall, while it is only a preview
  // (`resolveBrowseCaption`): "Preview, not lit", or in a crew "Only you see
  // this · the wall is on Crimp Ladder". It rides the top bar's second line
  // (#6745), not the stats line, so it never pushes the sends and stars off;
  // the top bar does not swipe, so the peeks carry none of their own. Under a
  // list or a workout stage it takes the short crew form, which fits there.
  // With the lit label resolved, the solo "Preview, not lit" steps aside; the crew form stays, since it names the climb on the wall.
  const browseCaptionModel = resolveBrowseCaption({
    isAnonymous,
    isPreview,
    climbUuid: displayedClimbUuid ?? null,
    committedHeadUuid,
    wallClimbUuid,
    wallClimbName: wallClimb.name,
    inCrew: isSharedSession,
    wallDriven: lightbulbActive,
  });
  const browseCaption = formatBrowseCaption(
    wallLit !== null && browseCaptionModel?.kind === 'preview' ? null : browseCaptionModel,
    t,
    { sharesLine: topBarParts !== null },
  );

  // The SELECTED board's angle moved (the angle pill / sheet — `activeAngle`, not
  // the render board's, which follows the displayed climb).
  //
  // Under an ACTIVE browse latch the pinned preview stays: that is where the
  // climber is living, and dropping it would throw away the climb they were
  // looking at, the suggestion track they were walking, and the latch itself —
  // for one tap on the angle pill. Its grade is re-resolved at the new angle
  // just below, the way `useQueueRegrade` re-resolves the committed climb's.
  //
  // Everywhere else the preview is DROPPED, which is what this effect did before
  // the latch existed, and restoring it fixes a real regression. Outside a crew a
  // pinned preview is not somewhere the climber is living — it is the explicit
  // Preview action, a deep link, the workout builder, a `lightOnClimbTap`-off
  // tap. Keeping it across an angle change stranded solo climbers in a state
  // where the drawer shows one climb and the wall shows another, and where a
  // pinned suggestion source makes `getViewOnlyPreviewNavigationTarget` return
  // view-only no matter what `lightOnSwipe` says — so every onward swipe stopped
  // committing and the board stopped lighting, with no visible cause. This clear
  // was the only implicit escape from that chain. On iPad it is the ONLY one:
  // `IpadPlayPane` never unmounts, so nothing else resets drawer-local state.
  //
  // The wall flag drops either way: "displayed IS the lit climb" was true at the
  // old angle, and an angle change is exactly what makes it false.
  //
  // Gated on `browseByDefault` — a crew is here, or a latch armed while one was —
  // and NOT on `browseLatchActive`. The two are easy to confuse and only one is
  // right: `browseLatchActive` means "swipes from this state stay view-only",
  // which is equally true of a SOLO climber previewing a tracked climb. Keying on
  // it would keep the preview pinned exactly where the regression bites, and the
  // solo case is the one the field reports came from.
  //
  // Read through a ref so the effect keys on `[activeAngle]` alone. As a dependency it
  // would clear the preview the moment the crew flag dropped — which is every
  // commit, and every peer leaving — and those are cases where the preview is
  // already being handled deliberately somewhere else.
  const browseByDefaultRef = useRef(browseByDefault);
  browseByDefaultRef.current = browseByDefault;
  useEffect(() => {
    setDrawerPreviewIsWallClimb(false);
    if (browseByDefaultRef.current) return;
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
  }, [activeAngle, setDrawerPreviewItem, setDrawerPreviewSuggestionSource]);

  // Re-anchor the pinned preview at the live angle. Only fetches while the
  // preview's baked-in grade actually belongs to a different angle, and the patch
  // preserves the item's uuid — that uuid is the drawer's navigation anchor, so
  // minting a fresh one would break prev/next and the remaining count.
  const previewClimbUuid = drawerPreviewItem?.climb?.uuid ?? null;
  const { data: previewClimbAtAngle } = useClimb(
    previewClimbUuid && previewNeedsAngleReanchor(drawerPreviewItem, angle)
      ? { boardName, layoutId, sizeId, setIds, angle, climbUuid: previewClimbUuid }
      : null,
  );
  useEffect(() => {
    if (!previewClimbAtAngle) return;
    // `reanchorPreviewAtAngle` returns the same reference for a stale response
    // (one that landed after the climber swiped on) or an item already at this
    // angle, so this never churns the preview.
    setDrawerPreviewItem((current) => reanchorPreviewAtAngle(current, angle, previewClimbAtAngle));
  }, [previewClimbAtAngle, angle, setDrawerPreviewItem]);

  // Tracked as an intent, with a toast when the share sheet throws (shared with the MiniPlayer's).
  const handleShare = useShareClimbAction({
    climb: displayedClimb ?? null,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    source: 'play_drawer',
  });

  // A draft is visible to its setter alone: a share link opens nowhere for
  // anyone else, and the only person who can report it is the setter (#5960).
  const displayedClimbIsDraft = displayedClimb?.is_draft === true;

  // Long-press the climb name to copy it — handy for pasting into a chat when
  // sharing beta. Delegates to the unit-tested copyClimbName helper; haptic for
  // tactile confirmation, info toast matching the "Link copied" affordance.
  const handleCopyName = useCallback(() => {
    void copyClimbName(
      displayedClimb,
      { boardName, layoutId },
      {
        haptic: hapticSuccess,
        track,
        showToast: (message, variant) => showToast(message, variant ?? 'info'),
        toastMessage: tClimbs('mobile.climbActions.nameCopied'),
        errorToastMessage: tClimbs('mobile.climbActions.copyNameError'),
      },
    );
  }, [displayedClimb, boardName, layoutId, showToast, tClimbs]);

  // The similar-climbs strip plays as a list (#6665). A preview walks it on the
  // board the player draws the climb on, which is the board its similar climbs
  // come from. A committed tap keys it to the stored active board, the board
  // the queue checks a track against: an upsized climb or a tick from another
  // size is drawn on a bigger board, and a track keyed there would go dormant
  // the moment it was set, leaving swipes to walk the queue.
  const similarTrack = useMemo(() => {
    const renderBoardKey = getQueueBoardKey({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      set_ids: setIds,
    });
    return {
      boardKey: renderBoardKey,
      committedBoardKey: activeBoardForNavigation
        ? getQueueBoardKey({
            board_name: activeBoardForNavigation.boardType,
            layout_id: activeBoardForNavigation.layoutId,
            size_id: activeBoardForNavigation.sizeId,
            set_ids: activeBoardForNavigation.setIds,
          })
        : renderBoardKey,
      label: t('playView.track.similarClimbs'),
    };
  }, [boardName, layoutId, sizeId, setIds, activeBoardForNavigation, t]);

  // `Queue Navigation` for each Next / Previous the climber takes here (#6940).
  const navigationBoardType = activeBoardForNavigation?.boardType;
  const navigationLayoutId = activeBoardForNavigation?.layoutId;
  // `sessionMode` says whether a crew decides how navigation behaves, so it reads
  // the latch the preview decision reads (`browseByDefault`), not the live
  // roster: after a peer leaves mid-browse the latch still makes a step a preview.
  const handleNavigationStep = useCallback(
    (step: PlayNavigationStep) =>
      trackQueueNavigation({
        ...step,
        surface: 'player',
        inSharedSession: browseByDefault,
        lightOnSwipe,
        boardType: navigationBoardType,
        layoutId: navigationLayoutId,
      }),
    [browseByDefault, lightOnSwipe, navigationBoardType, navigationLayoutId],
  );
  // `Queue Sheet Opened`: the action bar's queue button and the ⋯ menu's row.
  const handleOpenQueueFromBar = useCallback(() => {
    trackQueueSheetOpened({ surface: 'player', boardType: navigationBoardType });
    onOpenQueue();
  }, [onOpenQueue, navigationBoardType]);
  const handleOpenQueueFromMenu = useCallback(() => {
    trackQueueSheetOpened({ surface: 'player_menu', boardType: navigationBoardType });
    onOpenQueue();
  }, [onOpenQueue, navigationBoardType]);

  const { handlePrev, handleNext, handleSetActive, handleSimilarClimbPress, commitDisplayedToWall, continueIntoQueue } =
    usePlaySelectionController({
      openTarget,
      viewer,
      showBoardMismatch,
      preview: {
        drawerPreviewItem,
        drawerPreviewSuggestionSource,
        setDrawerPreviewItem,
        setDrawerPreviewSuggestionSource,
        setDrawerPreviewIsWallClimb,
        setSharedBrowseLatched,
      },
      queue: { currentClimbQueueItem, setCurrentClimb, previousClimb, nextClimb },
      similarTrack,
      navigation: { navigationState, lightOnSwipe, browseByDefault },
      chrome: { clearMirror, setIsTickBarActive, setActiveSubDrawer },
      confirmation: {
        busyWallConfirmArmed,
        browseLatchActive,
        wallClimbUuid,
        displayedClimbUuid,
        wallUuidAtLatchStartRef,
        setBusyWallConfirmArmed,
        markLatchExit,
      },
      hold: {
        heldQueueItemUuid: staleCurrentHold?.queueItemUuid ?? null,
        putHeldClimbOnWall: handlePutHeldClimbOnWall,
      },
      onNavigationStep: handleNavigationStep,
    });
  // The same step, told apart by how it was asked for.
  const handlePrevButton = useCallback(() => handlePrev('button'), [handlePrev]);
  const handleNextButton = useCallback(() => handleNext('button'), [handleNext]);
  const handlePrevSwipe = useCallback(() => handlePrev('swipe'), [handlePrev]);
  const handleNextSwipe = useCallback(() => handleNext('swipe'), [handleNext]);

  // A current climb unchanged for 4 h is held dark on the connect's first write
  // (#4979). A tap that connects asked for the climb, so the hold it meets right
  // after the connect is released, instead of needing a second tap.
  const relightHeldAfterConnectRef = useRef<{ queueItemUuid: string; at: number } | null>(null);
  useEffect(() => {
    const pending = relightHeldAfterConnectRef.current;
    if (!pending || !staleCurrentHold) return;
    relightHeldAfterConnectRef.current = null;
    if (staleCurrentHold.queueItemUuid !== pending.queueItemUuid) return;
    if (nowMs() - pending.at > RELIGHT_HELD_AFTER_CONNECT_MS) return;
    bluetooth?.reassertWall();
  }, [staleCurrentHold, bluetooth]);

  // "Light this climb" (#7000): the wall button (or the bulb) on a climb that
  // isn't lit, and the busy-wall question's Put mine up. A preview is set first
  // and the connect, when one is needed, runs after it (the picker when no
  // board is remembered), so it lights whatever is current by then. The
  // climber's own climb connects, or with a link already up is re-sent, which
  // also clears a "Turn off all lights" and the #4979 hold. Never a
  // disconnect: that is a row in the board sheet.
  const handleLightThisClimb = useCallback(() => {
    if (commitBarModel.mode === 'commit') {
      if (!commitBarModel.connectsOnCommit) {
        handleSetActive();
        return;
      }
      // The busy-wall question can take the tap instead of a commit: then nothing
      // went up, and connecting would light the old climb under the question.
      if (!handleSetActive()) return;
      // The climb the connect is for picks the board to connect to (#7001): the
      // one just made current, which the queue may not report yet.
      void connectLightbulb('put_on_wall', displayedClimb ?? null);
      return;
    }
    if (lightbulbPressAction === 'connect') {
      if (currentClimbQueueItem) {
        relightHeldAfterConnectRef.current = { queueItemUuid: currentClimbQueueItem.uuid, at: nowMs() };
      }
      void connectLightbulb('play_drawer', currentClimbQueueItem?.climb ?? null);
      return;
    }
    if (bluetoothConnected) handlePutHeldClimbOnWall();
  }, [
    commitBarModel.mode,
    commitBarModel.connectsOnCommit,
    displayedClimb,
    handleSetActive,
    connectLightbulb,
    lightbulbPressAction,
    currentClimbQueueItem,
    bluetoothConnected,
    handlePutHeldClimbOnWall,
  ]);
  // "On the wall" with no link (QA #147, Marco): the tap still connects and
  // lights the climb on screen explicitly, in case it went dark meanwhile. A
  // preview is made current first; then a reassert lights it, through the
  // #4979 hold, without waiting on the auto-send.
  const bluetoothForRelightRef = useRef(bluetooth);
  bluetoothForRelightRef.current = bluetooth;
  const handleLightAgain = useCallback(() => {
    let climb = currentClimbQueueItem?.climb ?? null;
    const committing = commitBarModel.mode === 'commit';
    if (committing) {
      if (!handleSetActive()) return;
      climb = displayedClimb ?? null;
    }
    const relight = () => {
      resetWallCleared();
      bluetoothForRelightRef.current?.reassertWall();
    };
    if (bluetoothConnected) {
      relight();
      return;
    }
    void connectLightbulb(committing ? 'put_on_wall' : 'play_drawer', climb).then((connected) => {
      if (connected) relight();
    });
  }, [
    currentClimbQueueItem,
    commitBarModel.mode,
    handleSetActive,
    displayedClimb,
    bluetoothConnected,
    connectLightbulb,
  ]);
  // Put on {board} (#7076): the climb on screen is on another board at this gym.
  // A preview goes up first (the busy-wall question can take the tap instead),
  // then the move to that board, which connects there and lights it.
  const handleMoveToGymBoard = useCallback(() => {
    if (commitBarModel.mode === 'commit' && !handleSetActive()) return;
    void moveLightbulbToClimbBoard('move_to_board', displayedClimb ?? null);
  }, [commitBarModel.mode, handleSetActive, moveLightbulbToClimbBoard, displayedClimb]);
  // The busy-wall question (#7017): who put the lit climb up, and the one
  // handler behind its pair, which drops taps for the first 500 ms and speaks
  // the caption once. Its words replace the browse caption while it is up.
  const busyWallHolder = useMemo(
    () =>
      scenarioBusyWall
        ? { name: scenarioBusyWall.holderName, avatarUrl: null }
        : busyWallUp
          ? resolveBusyWallHolder({
              picker: currentClimbQueueItem?.addedByUser ?? null,
              viewerUserId,
              wallClimbUuid,
              currentClimbUuid: currentClimbQueueItem?.climb.uuid ?? null,
            })
          : null,
    [scenarioBusyWall, busyWallUp, currentClimbQueueItem, viewerUserId, wallClimbUuid],
  );
  const busyWall = useBusyWallQuestion({
    armed: busyWallUp,
    holder: busyWallHolder,
    wallClimbName: scenarioBusyWall?.climbName ?? wallClimb.name,
    selfHoldsBoard,
    onKeep: handleBackToLive,
    // Confirmation makes tapAction a noop; the state still names the board move.
    onPut: wallControlState === 'move_to_board' ? handleMoveToGymBoard : handleLightThisClimb,
  });
  const topBarCaption = busyWall.model ? formatBusyWallCaption(busyWall.model, t) : browseCaption;
  // The board sheet (Re-light / Turn off all lights / Disconnect). A hold on
  // the board control opens it through `useWallControl`, which logs Board
  // Controls Opened with the view; ⋯ › Board controls logs its own.
  const openBoardSheet = useCallback(() => {
    if (!bluetooth?.isConnected) return;
    setBleControlVisible(true);
  }, [bluetooth]);
  const handleMenuBoardControls = useCallback(() => {
    if (!bluetooth?.isConnected) return;
    trackBoardControlsOpened({ surface: 'play_drawer', source: 'player_menu' });
    setBleControlVisible(true);
  }, [bluetooth]);
  // What each tap action runs; `useWallControl` (below) picks one from the model.
  const wallControlRunners = useMemo(
    () => ({
      light: handleLightThisClimb,
      // On the crew's gym board the relay commits the preview to the session;
      // the bulb's own press would connect this phone to its own board.
      toggle: climbOnCrewGymBoard ? handleRelayToHolder : handleLightbulb,
      // You have the board: let go of it, as the board sheet's Disconnect does.
      // That forgets the board on purpose: it frees it for the next climber.
      disconnect: disconnectAllBluetooth,
      openSheet: openBoardSheet,
      lightAgain: handleLightAgain,
      moveToBoard: handleMoveToGymBoard,
    }),
    [
      handleLightThisClimb,
      climbOnCrewGymBoard,
      handleRelayToHolder,
      handleLightbulb,
      openBoardSheet,
      handleLightAgain,
      handleMoveToGymBoard,
    ],
  );

  // A swipe step changes the climb with these, whichever render it follows.
  useSwipeNavigation(swipePager, handleNextSwipe, handlePrevSwipe);

  // --- The end of the list (#6664) -------------------------------------------
  //
  // At the list's last climb Next, and one more forward swipe, open the end
  // card instead of falling into the queue. While more of the list is loading
  // there is no card (`trackEndCard` is null) and Next waits for the page.
  const openTrackEndCard = useCallback(() => {
    setTrackEndCardClimbUuid(displayedClimbUuid ?? null);
  }, [displayedClimbUuid]);
  const closeTrackEndCard = useCallback(() => setTrackEndCardClimbUuid(null), []);
  const trackEndCardVisible =
    trackEndCard !== null && trackEndCardClimbUuid !== null && trackEndCardClimbUuid === displayedClimbUuid;
  useTrackEndSwipe(swipePager, trackEndCard ? openTrackEndCard : null);
  const handleNextPress = trackEndCard ? openTrackEndCard : handleNextButton;
  // The board's VoiceOver / TalkBack adjust action, the swipe's stand-in.
  const handleNextAdjust = trackEndCard ? openTrackEndCard : handleNextSwipe;
  const canPressNext = navigationState.canNext || trackEndCard !== null;
  const trackEndAction = trackEndCard?.action ?? null;
  const handleTrackEndKeepGoing = useCallback(() => {
    setTrackEndCardClimbUuid(null);
    if (!trackEndAction) return;
    if (trackEndAction.kind === 'backToCommitted') {
      // A preview's list ended: its queue starts back at the committed climb.
      handleBackToLive();
      return;
    }
    continueIntoQueue(trackEndAction.target);
  }, [trackEndAction, handleBackToLive, continueIntoQueue]);

  // The lightbulb's relay while a session peer drives the wall (see the
  // `useLightbulbControl` call above). Committing a pinned preview IS the relay:
  // it makes the climb the session's current one, and the holder's auto-sender
  // writes whatever is current, so the climb lights on their link.
  //
  // With no preview pinned, leave the session current climb alone. This is not
  // a remote re-light: recovering a failed holder write needs a reassert path.
  useEffect(() => {
    relayToHolderRef.current = commitDisplayedToWall;
  }, [commitDisplayedToWall]);

  const handleMirror = useCallback(() => {
    if (!displayedClimbUuid) return;
    // New CPP selections may photograph a local preview, never change a crew's
    // shared orientation if its session restores between readiness and the tap.
    if (
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
      process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS?.includes('screenshotClimbId=') === true &&
      sharesMirrorState
    )
      return;
    track(SHARED_EVENTS.MirrorClimb, {
      climbUuid: displayedClimbUuid,
      boardName,
      layoutId,
      isMirrored: !isMirrored, // send the new orientation
      surface: 'play_drawer',
      shared: sharesMirrorState,
    });
    if (isPreview) {
      setPreviewMirrorFlip({ climbUuid: displayedClimbUuid, mirrored: !isMirrored });
    } else if (currentClimbQueueItem) {
      const headItem = getQueueSnapshot().currentClimbQueueItem;
      if (headItem?.uuid !== currentClimbQueueItem.uuid || headItem.climb.uuid !== displayedClimbUuid) return;
      void mirrorCurrentClimb(!(headItem.climb.mirrored === true), headItem.uuid);
    }
  }, [
    displayedClimbUuid,
    isMirrored,
    isPreview,
    sharesMirrorState,
    currentClimbQueueItem,
    mirrorCurrentClimb,
    getQueueSnapshot,
    boardName,
    layoutId,
  ]);

  // Pin the current target before opening the beta composer.
  const handleOpenAddBetaVideo = useCallback(() => {
    if (!displayedClimb) return;
    setBetaVideoTarget({ climb: displayedClimb, boardConfig: { boardName, layoutId, sizeId, setIds, angle } });
    setAddBetaVideoOpen(true);
  }, [displayedClimb, boardName, layoutId, sizeId, setIds, angle, setBetaVideoTarget]);

  // ⋯ beta: pin the climb/board the menu was opened for so a party-session
  // queue/angle change mid-menu can't retarget the sheet (#3505).
  const handleOpenAddBetaVideoForClimb = useCallback(
    (targetClimb: Climb, targetBoardConfig: BoardConfig) => {
      setBetaVideoTarget({ climb: targetClimb, boardConfig: targetBoardConfig });
      setAddBetaVideoOpen(true);
    },
    [setBetaVideoTarget],
  );

  // ⋯ tick: open the drawer's OWN in-tree tick sheet (it stacks above the `/play`
  // modal) instead of the root LogAscent sheet, which mounts behind `/play` —
  // presenting it dismisses `/play` and the tick sheet closes on its own. Pin the
  // climb/board the menu was opened for so a mid-menu queue change can't retarget
  // it. ⋯ offers no tick row today (the hero button is always there), but the menu
  // still takes the opener so a row added later can't fall back to the root sheet.
  const handleOpenTickForClimb = useCallback(
    (targetClimb: Climb, targetBoardConfig: BoardConfig) => {
      resetZoomRef.current?.();
      const activeBoard = activeBoardForLoggingRef.current;
      const matchesActiveBoard =
        activeBoard?.boardType === targetBoardConfig.boardName &&
        activeBoard.layoutId === targetBoardConfig.layoutId &&
        activeBoard.sizeId === targetBoardConfig.sizeId &&
        activeBoard.setIds === targetBoardConfig.setIds &&
        activeBoard.angle === targetBoardConfig.angle;
      setTickTarget({
        climb: targetClimb,
        boardConfig: targetBoardConfig,
        isMirror:
          isPreview && targetClimb.uuid === displayedClimbUuid
            ? isMirrored
            : resolveTickMirror(
                getQueueSnapshot(),
                targetClimb,
                targetClimb.uuid === displayedClimbUuid ? (displayedQueueItemUuid ?? undefined) : undefined,
                matchesActiveBoard,
              ),
      });
      setIsTickBarActive(true);
    },
    [setTickTarget, displayedClimbUuid, displayedQueueItemUuid, isPreview, isMirrored, getQueueSnapshot],
  );

  // ⋯ report: open the drawer's OWN in-tree sheet (it stacks above the `/play`
  // modal) instead of the root one, and pin the climb/board the menu was opened
  // for so a party-session queue/angle change can't retarget it (#3505).
  const handleOpenReportClimbForClimb = useCallback(
    (targetClimb: Climb, targetBoardConfig: BoardConfig) => {
      setReportTarget({ climb: targetClimb, boardConfig: targetBoardConfig });
      setReportClimbOpen(true);
    },
    [setReportTarget],
  );

  // Same rule as handleCloseAddBetaVideo: leave reportTarget alone while the
  // sheet animates out, the next open overwrites it.
  const handleCloseReportClimb = useCallback(() => {
    setReportClimbOpen(false);
  }, []);

  // ⋯ add to playlist: the drawer's OWN picker sheet, for the reason the report
  // has one (#3294 was the root picker flashing closed under `/play`).
  const handleOpenAddToPlaylistForClimb = useCallback(
    (targetClimb: Climb, targetBoardConfig: BoardConfig) => {
      setPlaylistTarget({ climb: targetClimb, boardConfig: targetBoardConfig });
      setAddToPlaylistOpen(true);
    },
    [setPlaylistTarget],
  );
  const handleCloseAddToPlaylist = useCallback(() => {
    setAddToPlaylistOpen(false);
  }, []);

  // Don't clear betaVideoTarget here: the sheet is still animating out and reads
  // from it, so nulling it mid-dismiss would swap the shown climb for a frame. The
  // next open overwrites it with the newly selected target.
  const handleCloseAddBetaVideo = useCallback(() => {
    setAddBetaVideoOpen(false);
  }, []);

  // Logbook card "See full logbook": the virtualised history sheet.
  // Pinned to the climb it was opened on: a climb change closes it for good.
  const {
    climbUuid: fullLogbookClimbUuid,
    open: handleOpenFullLogbook,
    close: handleCloseFullLogbook,
  } = useFullLogbookSheet(displayedClimbUuid);
  // Climber logs card: "See all logs" opens the virtualised list; a row opens
  // that climber's profile; the empty states lead to climber search. Both routes
  // are plain cards on the root stack, and on iOS a card pushed while the
  // `/play` modal is up lands beneath it (docs/mobile-sheets-vs-routes.md), so
  // they leave through `usePushAfterPlayerDismiss`.
  const handleOpenClimberLogs = useCallback(() => {
    setClimberLogsClimbUuid(displayedClimbUuid ?? null);
  }, [displayedClimbUuid]);
  const handleCloseClimberLogs = useCallback(() => {
    setClimberLogsClimbUuid(null);
  }, []);
  const pushAfterPlayerDismiss = usePushAfterPlayerDismiss(dismissPlayerAndWait);
  const handleOpenClimberProfile = useCallback(
    (userId: string) => {
      pushAfterPlayerDismiss(() => router.push({ pathname: '/users/[userId]', params: { userId } }));
    },
    [pushAfterPlayerDismiss],
  );
  const handleFindClimbers = useCallback(() => {
    pushAfterPlayerDismiss(() => router.push('/users/search'));
  }, [pushAfterPlayerDismiss]);
  // "Workout done" → See your workout: the Record tab's card, once the player is
  // out of the way (the pane has nothing to dismiss and goes straight there).
  const handleSeeWorkout = useCallback(() => {
    pushAfterPlayerDismiss(() => router.navigate('/(tabs)/record'));
  }, [pushAfterPlayerDismiss]);

  // Arm (expand) / disarm (collapse) the scroll-into-view for the first section peek.
  const handleFirstSectionToggle = useCallback(
    (expanded: boolean) => {
      pendingFirstSectionScrollRef.current = expanded;
      if (expanded) requestBelowFoldContent();
    },
    [requestBelowFoldContent],
  );

  const handleOpenAngleSelector = useCallback(() => {
    setActiveSubDrawer('angleSelector');
  }, []);

  const handleCloseSubDrawer = useCallback(() => {
    setActiveSubDrawer('none');
  }, []);

  // Track only when a climb is displayed: the sheet itself is gated on
  // `displayedClimb`, and a null climbUuid would pollute the
  // Dismissed + Saved <= Opened watchdog this event exists to power.
  const trackTickOpened = useCallback(() => {
    if (!displayedClimb) return;
    track(SHARED_EVENTS.QuickTickOpened, {
      climbUuid: displayedClimb.uuid,
      layoutId: layoutId ?? null,
      source: 'play_fab',
    });
  }, [displayedClimb, layoutId]);

  const handleTickFabPress = useCallback(() => {
    resetZoomRef.current?.();
    trackTickOpened();
    if (!displayedClimb) return;
    // Keep the draft tied to its target even if the live queue or privacy changes.
    setTickTarget({
      climb: displayedClimb,
      boardConfig: { boardName, layoutId, sizeId, setIds, angle },
      isMirror: isPreview
        ? isMirrored
        : resolveTickMirror(getQueueSnapshot(), displayedClimb, displayedQueueItemUuid ?? undefined),
    });
    setIsTickBarActive(true);
  }, [
    trackTickOpened,
    displayedClimb,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    setTickTarget,
    isPreview,
    isMirrored,
    getQueueSnapshot,
    displayedQueueItemUuid,
  ]);

  // Long-press opens the same QuickTickBar as a short press; LogAscentSheet
  // has been retired in favour of a single ticking surface (see PR #2366).
  const handleTickFabLongPress = handleTickFabPress;

  const handleTickBarDismiss = useCallback(() => {
    setIsTickBarActive(false);
  }, []);

  const handleResetZoomReady = useCallback((resetFn: () => void) => {
    resetZoomRef.current = resetFn;
  }, []);

  // One element for both header sites (the swipeable header and the live model).
  const headerLeading = headerPillState ? (
    <WallStatePill
      state={headerPillState}
      backTarget={headerBackTarget}
      targetName={headerBackTargetName}
      latched={browseLatchActive}
      onPress={handleBackToLive}
    />
  ) : undefined;
  const currentHeaderModel = useLivePlayDrawerHeaderModel({
    climb: displayedClimb ?? null,
    boardName: boardName as BoardName,
    layoutId,
    angle,
    leading: headerLeading,
    onLongPressName: handleCopyName,
    onPressSetter: openSetterPlaylist,
  });
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  // The same layout the action bar resolves from the same inputs, read here for
  // the buttons it has put away (⋯ carries a row for each) and for the opening
  // layout's key (a second row that comes or goes moves the board).
  const hasBluetooth = bluetooth !== null;
  const angleAvailable = resolvePlayerAngle({ isAngleAdjustable, angle: activeAngle }) !== null;
  // A wall with lights to put a climb on; without one the wall button's row folds.
  const playerHasWall = hasBluetooth && !boardIsLedless && boardName !== 'spray';
  const actionBarLayout = useMemo(
    () =>
      resolveActionBarLayout({
        supportsMirroring,
        isAnonymous,
        commitButton,
        workoutOutcome: workoutOutcome !== null,
        showLightbulb: hasBluetooth,
        hasWall: playerHasWall,
        hasShare: !displayedClimbIsDraft,
        angleAvailable,
        buttons: playerButtons.buttons,
        previousNext: playerButtons.previousNext,
        boardControl: playerButtons.boardControl,
        miniPlayerMirrors,
      }),
    [
      supportsMirroring,
      isAnonymous,
      commitButton,
      workoutOutcome,
      hasBluetooth,
      playerHasWall,
      displayedClimbIsDraft,
      angleAvailable,
      playerButtons.buttons,
      playerButtons.previousNext,
      playerButtons.boardControl,
      miniPlayerMirrors,
    ],
  );
  // Wall Control Shown: only while the control that asks is drawn: the wall
  // button, or for a connect the bulb (the player's, or the MiniPlayer's
  // standing in for it).
  const wallControlDrawn = !isAnonymous && !showBoardMismatch && isWallControlDrawn(actionBarLayout, wallControlState);
  // The one handler behind every view of the board control: the tap, the
  // hold, and the three events, once each whichever view was used.
  const wallControlHandlers = useWallControl({
    model: wallControl,
    runners: wallControlRunners,
    climbUuid: displayedClimbUuid ?? null,
    // The sheet mounts per open. The iPad pane stays mounted, so there an open
    // is the stretch it shows a climb rather than its placeholder.
    playerOpen: isPane ? displayedClimb != null : isSheetOpen,
    visible: wallControlDrawn,
    linked: bluetoothConnected,
  });
  // With the bulb chosen, the MiniPlayer beside this player draws the bulb for
  // it: that bulb draws this model and runs these handlers, so its face and its
  // taps match (pane-wall-control-store, `control: 'mini_bar'`).
  const paneWallControl = useMemo(
    () => ({
      model: wallControl,
      press: () => wallControlHandlers.press('mini_bar'),
      longPress: () => wallControlHandlers.longPress('mini_bar'),
    }),
    [wallControl, wallControlHandlers],
  );
  useEffect(() => {
    if (!miniPlayerMirrors) return undefined;
    const owner = wallControlOwnerRef.current;
    registerPaneWallControl(owner, paneWallControl);
    return () => registerPaneWallControl(owner, null);
  }, [miniPlayerMirrors, paneWallControl]);
  // The lit wall button's glow (#7000, F1b): the climb's lit holds in the
  // colours the player draws their roles, on the playback frame for an animated
  // climb. Parsed only while the climb on screen is lit on a board this phone or
  // a crewmate holds; a new input only when the climb, the frame, the mirror or
  // the colours change, so the glow does no work otherwise.
  // Only while this climber drives the board (`wallControl.driving`, #7017).
  // A wall with no lights has no lit holds to frost.
  const wallGlowShown = !isAnonymous && wallControl.driving && wallControl.state === 'lit';
  const wallGlowFrames = wallGlowShown
    ? playback.isAnimatable
      ? playback.currentFrameString
      : (displayedClimb?.frames ?? '')
    : '';
  const wallGlowParsed = useParseFrames(
    wallGlowFrames,
    boardName as BoardName,
    boardRenderData?.holdsData ?? EMPTY_HOLD_PLACEMENTS,
    isMirrored,
  );
  const holdStateColours = useHoldStateColors(boardName as BoardName, layoutId);
  const wallGlowInput = useMemo<WallGlowInput | null>(() => {
    if (!wallGlowShown || !boardRenderData || wallGlowParsed.length === 0) return null;
    const seen = new Set<number>();
    const holds: GlowHold[] = [];
    for (const hold of wallGlowParsed) {
      if (seen.has(hold.id)) continue;
      seen.add(hold.id);
      holds.push({ x: hold.cx, y: hold.cy, color: holdStateColours.get(hold.role) ?? hold.color });
    }
    return {
      key: `${displayedClimbUuid ?? ''}|${wallGlowFrames}|${isMirrored ? 'm' : ''}|${[...holdStateColours.values()].join()}`,
      holds,
      boardWidth: boardRenderData.boardWidth,
      boardHeight: boardRenderData.boardHeight,
    };
  }, [
    wallGlowShown,
    boardRenderData,
    wallGlowParsed,
    holdStateColours,
    displayedClimbUuid,
    wallGlowFrames,
    isMirrored,
  ]);
  // View options draws its buttons preview for the board on screen.
  const buttonsPreviewBoard = useMemo(
    () => ({ supportsMirroring, angleAvailable, angle: activeAngle, showLightbulb: hasBluetooth }),
    [supportsMirroring, angleAvailable, activeAngle, hasBluetooth],
  );
  const openingLayoutKey =
    sectionsReady && boardRenderData && displayedClimb && currentHeaderModel
      ? buildOpeningLayoutKey({
          boardName: boardName as BoardName,
          layoutId,
          sizeId,
          setIds,
          boardWidth: boardRenderData.boardWidth,
          boardHeight: boardRenderData.boardHeight,
          climbUuid: displayedClimb.uuid,
          frames: displayedClimb.frames,
          viewportWidth: windowWidth,
          viewportHeight: windowHeight,
          fontScale,
          pixelRatio: PixelRatio.get(),
          locale: i18n.language,
          insets,
          preferencesFingerprint: JSON.stringify([sections, sectionOrder]),
          firstSectionId: hasVisibleSections ? (firstSectionId ?? null) : null,
          presentation: isPane ? 'pane' : 'sheet',
          paneInset: paneTopInset ? insets.top : 0,
          headerFingerprint: JSON.stringify([
            currentHeaderModel.layoutFingerprint,
            isAnonymous,
            showBoardMismatch,
            headerPillState,
          ]),
          controlsFingerprint: JSON.stringify([
            isAngleAdjustable,
            isAuthenticated,
            isTickBarActive,
            commitButton,
            heldLastOnWallAt !== null,
            workoutOutcome !== null,
            bluetooth !== null,
            boardSupportsMirroring(boardName, layoutId),
            actionBarLayout.secondaryRow,
            controlsPosition,
            tabletop,
          ]),
          lostBanner: lostHoldCount > 0,
          playbackFingerprint: JSON.stringify([playback.isAnimatable]),
        })
      : undefined;
  const {
    cachedOpeningLayout,
    boardContainerSize,
    handleBoardContainerLayout,
    onViewportMeasured,
    onHeaderMeasured,
    onSectionHeaderMeasured,
  } = usePlayOpeningLayout({
    openingLayoutKey,
    windowWidth,
    windowHeight,
    sheetViewportHeight,
    headerBottomY,
    hasVisibleSections,
    firstSectionHeaderHeight,
    handleViewportLayout,
    handleHeaderLayout,
    handleFirstSectionHeaderLayout,
  });

  // Reserve only the first eligible section's header. Without sections, content
  // plus bottom safe area exactly fills the measured viewport and cannot scroll.
  // The phone split's pane and the landscape iPad player fit the board to the
  // viewport's height instead (`computeFitToHeightFirstScreenHeight`).
  // - The pane always does, whatever its rows hold: its bottom inset clears the
  //   MiniPlayer capsule (`PhoneSplitPane`), and the first screen pads that band
  //   so every button ends above the capsule and the first section starts below
  //   the fold rather than peeking under the capsule.
  // - The iPad player does only with sections to scroll to, with the controls
  //   under the board, and with a plain second row that hangs below the fold.
  //   The wall button, the busy-wall question and Fell / Sent keep their place
  //   on screen (`shouldFitBoardToHeight`, #6956).
  const fitsBoardToHeight = shouldFitBoardToHeight({
    fitBoardToHeight,
    isPane,
    hasVisibleSections,
    controlsAbove,
    secondaryRow: actionBarLayout.secondaryRow,
  });
  const firstScreenPaddingBottom = fitsBoardToHeight && isPane ? insets.bottom : 0;
  const firstScreenViewport = sheetViewportHeight || cachedOpeningLayout?.viewportHeight || windowHeight;
  // In tabletop the controls sit between the first screen and the sections.
  const [tabletopControlsHeight, setTabletopControlsHeight] = useState(0);
  const handleTabletopControlsLayout = useCallback((event: LayoutChangeEvent) => {
    setTabletopControlsHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const firstScreenHeight = tabletop
    ? (tabletopFoldTop ?? 0)
    : fitsBoardToHeight
      ? computeFitToHeightFirstScreenHeight({
          viewport: firstScreenViewport,
          bottomInset: insets.bottom,
          belowFoldHeight: isPane ? firstScreenPaddingBottom : ACTION_BAR_SECONDARY_ROW_HEIGHT,
        })
      : computeDrawerFirstScreenHeight({
          viewport: firstScreenViewport,
          bottomInset: insets.bottom,
          firstSectionHeaderHeight: hasVisibleSections
            ? firstSectionHeaderHeight || cachedOpeningLayout?.firstSectionHeaderHeight || DEFAULT_SECTION_HEADER_HEIGHT
            : null,
          sectionTopPadding: spacing[3],
          sectionMargin: spacing[2],
        });
  // Named because the wall-state callout needs it too: it hangs off the header's
  // measured bottom edge, and that measurement is relative to the a11y-trap
  // wrapper INSIDE this padding, not to the first screen itself.
  // In the pane a docked WallStrip can already own the top inset.
  const ownsTopInset = !isPane || paneTopInset;
  const firstScreenPaddingTop = ownsTopInset ? insets.top + spacing[2] : spacing[2];

  // When the user expands the first section peek, glide it fully into view. Fires on the
  // section's layout (re-firing as a slow logbook fetch grows it) while armed.
  // The first visible section starts right after the
  // fixed-height first screen, past the DeferredSections top padding.
  const handleFirstSectionLayout = useCallback(
    (sectionHeight: number) => {
      if (!pendingFirstSectionScrollRef.current) return;
      const target = computeFirstSectionScrollTarget({
        // In tabletop the controls sit between the first screen and the sections.
        firstScreenHeight: firstScreenHeight + (tabletop ? tabletopControlsHeight : 0),
        topPadding: spacing[3],
        sectionHeight,
        viewport: sheetViewportHeight || windowHeight,
        topInset: insets.top,
        bottomInset: insets.bottom,
        margin: spacing[2],
      });
      scrollRef.current?.scrollTo({ y: target, animated: true });
    },
    [firstScreenHeight, tabletop, tabletopControlsHeight, sheetViewportHeight, windowHeight, insets.bottom, insets.top],
  );

  const ascentCount = displayedClimb?.userAscents ?? 0;

  const angleSelectorVisible = activeSubDrawer === 'angleSelector';
  const climberLogsOpen = climberLogsClimbUuid !== null && climberLogsClimbUuid === displayedClimbUuid;

  // The phone split swaps this route for the pane mid-read; the pane picks up the
  // same climb where the climber was, and waits while anything here is open (see
  // route-player-handoff).
  const readScrollOffset = useCallback(() => scrollYSV.value, [scrollYSV]);
  const routeHasOpenWork =
    isTickBarActive ||
    activeSubDrawer !== 'none' ||
    addBetaVideoOpen ||
    addToPlaylistOpen ||
    reportClimbOpen ||
    sectionsSettingsOpen ||
    climberLogsOpen ||
    fullLogbookClimbUuid !== null ||
    bleControlVisible;
  const routePreview = useMemo(
    () =>
      drawerPreviewItem
        ? {
            item: drawerPreviewItem,
            suggestionSource: drawerPreviewSuggestionSource,
            isWallClimb: drawerPreviewIsWallClimb,
          }
        : null,
    [drawerPreviewItem, drawerPreviewSuggestionSource, drawerPreviewIsWallClimb],
  );
  const handleScrollContentSizeChange = useRoutePlayerHandoff({
    isPane,
    acceptsHandoff: acceptsScrollHandoff,
    busy: routeHasOpenWork,
    displayedClimbUuid,
    preview: routePreview,
    scrollRef,
    readScrollOffset,
    viewportHeight: sheetViewportHeight || windowHeight,
    requestBelowFoldContent,
  });
  const showPanePlaceholder = shouldShowPanePlaceholder(isPane, displayedClimb != null);
  // Beside the panel the header swipes across the board column, not the window,
  // so the title keeps pace with the board and its neighbour enters at the
  // column's edge. Measured only while the panel is up.
  const [playerColumnWidth, setPlayerColumnWidth] = useState(0);
  const handlePlayerColumnLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setPlayerColumnWidth((previous) => (previous === measured ? previous : measured));
  }, []);
  const headerViewportWidth = hasSidePanel && playerColumnWidth > 0 ? playerColumnWidth : windowWidth;
  // The landscape iPad panel follows the climb on screen. Memoised on what it
  // reads, so the panel's memoised content skips the player's own re-renders.
  const sidePanelClimb = useMemo(
    () =>
      displayedClimb
        ? { climb: displayedClimb, boardName, layoutId, angle, onOpenFullLogbook: handleOpenFullLogbook }
        : null,
    [displayedClimb, boardName, layoutId, angle, handleOpenFullLogbook],
  );

  // Controls region — gated by the switch-board overlay when the displayed
  // climb is on a board the user isn't currently on. Board art + swipe stay
  // interactive for viewing. The controls are wrapped so assistive tech can't
  // reach them while gated (on BOTH platforms — the scrim's
  // accessibilityViewIsModal is iOS-only); the overlay itself stays a sibling so
  // its "Switch board" action remains focusable.
  //
  // It sits under the board, or between the header and the board when the
  // climber chose Above the board (#6229). The block moves whole, so the scrim
  // and its card still cover every control. Above the board the bar leads and
  // the playback slider follows, so the slider stays next to the board.
  //
  // The card is taller than the controls (more so with the small row switched
  // off), and a card that spilled out of the region would sit under whichever
  // sibling comes next (the board above the fold, the first section below it),
  // which then takes the taps meant for Switch board. So while the card is up
  // the region is at least as tall as the card. Above the board the region also
  // sits over its later siblings, in case a font change outgrows the last
  // measurement for a frame.
  const showSwitchBoardCard = showBoardMismatch && onSwitchBoard != null;
  const playbackControls = playback.isAnimatable ? (
    <PlaybackControls
      frameIndex={playback.frameIndex}
      frameCount={playback.frameCount}
      isPlaying={playback.isPlaying}
      paceSeconds={playback.paceSeconds}
      // Releasing near the pace this route's setter chose
      // snaps back to it exactly, so "as intended" stays
      // one easy landing on the track.
      magnetSeconds={playback.paceMs / 1000}
      peerFrameMismatch={playback.peerFrameMismatch}
      onPlay={playback.play}
      onPause={playback.pause}
      onSeek={playback.seek}
      onPaceSecondsChange={playback.setPaceSeconds}
    />
  ) : null;
  const actionBar = (
    <PlayDrawerActionBar
      canSwipePrevious={scenarioPlayer?.previousNextEnabled === true || navigationState.canPrevious}
      canSwipeNext={scenarioPlayer?.previousNextEnabled === true || canPressNext}
      isMirrored={isMirrored}
      supportsMirroring={supportsMirroring}
      isFavorited={isFavorited}
      remainingQueueCount={navigationState.remainingCount}
      upNextBadgeCount={listWalkUpNextCount}
      // The board control's one model and one handler, whichever view draws it.
      wallControl={wallControl}
      wallGlow={wallGlowInput}
      miniPlayerMirrors={miniPlayerMirrors}
      onWallControlPress={wallControlHandlers.press}
      onWallControlLongPress={wallControlHandlers.longPress}
      boardControl={playerButtons.boardControl}
      // Whether a Bluetooth transport exists at all, and only
      // that. The anonymous suppression lives in the bar, with
      // the rest of the `viewer` rules and the test that pins
      // them — Web Bluetooth IS mounted on the browser export,
      // so without it the bulb would render for a signed-out
      // visitor, whose board presence binds on an active board
      // uuid they do not have and whose first-ever visit would
      // open with a pairing prompt. Anonymous wall lighting is
      // its own feature (#4606), not a v1 side effect.
      showLightbulb={bluetooth !== null}
      hasWall={playerHasWall}
      // The back chip owns the driver's face whenever it renders
      // the avatar; suppress the bulb's pip so the same face never
      // shows twice in the drawer.
      showHolderBadge={shouldShowHolderBadge(headerPill)}
      // While browsing, the wall button says Put on the wall; going
      // back is the chip in the header. Only the busy-wall question
      // (someone else moved the wall) takes the whole row: Keep
      // theirs / Put mine up, where the second tap is the commit.
      commitButton={commitButton}
      // A timed workout block: the second row is one-tap Fell / Sent.
      workoutOutcome={workoutOutcome}
      workoutOutcomeWallLeftAtMs={workoutOutcomeShown?.wallLeftAtMs ?? null}
      busyWall={busyWall.model}
      onKeepTheirs={busyWall.keep}
      // The busy-wall question's Put mine up.
      onCommit={busyWall.put}
      ascentCount={ascentCount}
      onPrevClick={handlePrevButton}
      onNextClick={handleNextPress}
      onMirror={handleMirror}
      onToggleFavorite={handleToggleFavorite}
      onOpenQueue={handleOpenQueueFromBar}
      onShare={displayedClimbIsDraft ? undefined : handleShare}
      onTickPress={handleTickFabPress}
      onTickLongPress={handleTickFabLongPress}
      viewer={viewer}
      onSignInPress={onSignIn}
      currentAngle={activeAngle}
      onOpenAngleSelector={isAngleAdjustable ? handleOpenAngleSelector : undefined}
      buttons={playerButtons.buttons}
      previousNext={playerButtons.previousNext}
      // Above the board the hairline faces the board, under it.
      edge={controlsAbove ? 'bottom' : 'top'}
    />
  );
  // "Last on the wall …" while the #4979 hold keeps the current climb dark.
  // Hidden while a card owns the board.
  const boardTakenOver = trackEndCardVisible || workoutCardShown;
  const wallStatus =
    heldLastOnWallAt !== null && !boardTakenOver ? <LastOnWallNote lastOnWallAt={heldLastOnWallAt} /> : null;
  const wallStatusLinePlacement = resolveWallStatusLinePlacement(fitsBoardToHeight);
  const controlsRegion = (
    <View
      testID="play-drawer-controls-region"
      style={[
        styles.controlsRegion,
        controlsAbove && styles.controlsRegionAbove,
        showSwitchBoardCard && { minHeight: switchBoardCardHeight + SWITCH_BOARD_CARD_MARGIN * 2 },
      ]}
    >
      <View
        accessibilityElementsHidden={showBoardMismatch}
        importantForAccessibility={showBoardMismatch ? 'no-hide-descendants' : 'auto'}
      >
        {controlsAbove ? actionBar : playbackControls}
        {wallStatusLinePlacement === 'aboveActionBar' ? wallStatus : null}
        {controlsAbove ? playbackControls : actionBar}
        {wallStatusLinePlacement === 'afterControls' ? wallStatus : null}
      </View>

      {showSwitchBoardCard ? (
        <SwitchBoardOverlay
          boardLabel={switchBoardLabel ?? ''}
          onSwitchBoard={handleSwitchBoard}
          onCardHeight={handleSwitchBoardCardHeight}
        />
      ) : null}
    </View>
  );

  return (
    // The play route paints its background and this interactive core together.
    // The board column is always its own view, so a rotation that brings the
    // side panel in or out never remounts the board.
    <View style={[styles.root, hasSidePanel ? styles.rootSideBySide : null]}>
      <View
        style={[styles.playerColumn, hasSidePanel ? styles.playerColumnSideBySide : null]}
        onLayout={hasSidePanel ? handlePlayerColumnLayout : undefined}
      >
        {enhancementsReady ? (
          <PlayCoreEnhancements
            boardName={boardName}
            climbUuid={displayedClimb?.uuid ?? null}
            angle={angle}
            enabled={!isAnonymous}
            onSnapshot={handleEnhancementSnapshot}
          />
        ) : null}
        {showPanePlaceholder ? (
          (paneEmptyState ?? (
            <PanePlaceholder
              title={t('playView.paneEmpty.title')}
              subtitle={t('playView.paneEmpty.subtitle')}
              paddingTop={(paneTopInset ? insets.top : 0) + spacing[8]}
              paddingBottom={insets.bottom}
            />
          ))
        ) : (
          <GestureDetector gesture={contentGesture}>
            <Animated.View style={[styles.content, !swipeDismiss && dismissAnimatedStyle]}>
              <ScrollView
                ref={scrollRef}
                nestedScrollEnabled
                // In tabletop the controls hang below a fixed-height first
                // screen, so a large text size can push them past the bottom.
                scrollEnabled={hasVisibleSections || tabletop}
                directionalLockEnabled={Platform.OS === 'ios'}
                showsVerticalScrollIndicator={false}
                showsHorizontalScrollIndicator={false}
                // No top/bottom rubber-band: at the top, a downward drag is the
                // dismiss (the drawer translates) — a simultaneous scroll bounce would
                // fight it and read as double movement.
                bounces={false}
                overScrollMode="never"
                style={styles.content}
                contentContainerStyle={{
                  paddingBottom: insets.bottom,
                  paddingLeft: contentSideInsets.left,
                  paddingRight: contentSideInsets.right,
                  minHeight: initialScrollHeight,
                }}
                onLayout={onViewportMeasured}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onScrollBeginDrag={handleScrollTowardBelowFold}
                onContentSizeChange={handleScrollContentSizeChange}
              >
                {displayedClimb && (
                  <>
                    {/* The firstScreen container owns the top safe area, so the grabber +
                close + climb name sit at the very top. In the pane a docked WallStrip
                can already own the top inset (paneTopInset=false). */}
                    <View
                      style={[
                        styles.firstScreen,
                        {
                          height: firstScreenHeight,
                          paddingTop: firstScreenPaddingTop,
                          paddingBottom: firstScreenPaddingBottom,
                        },
                      ]}
                    >
                      <View style={styles.firstScreenContent}>
                        <View style={styles.topRow}>
                          {/* The persistent pane has no dismiss, so it shows no grabber or
                          close chevron; the route keeps both. */}
                          {!isPane ? (
                            <>
                              <View style={[sheetStyles.indicator, styles.grabber]} />
                              {/* A chevron, not an xmark: the player minimises, it isn't closed. */}
                              <ChromeIconButton
                                icon="chevron.down"
                                onPress={handleDismiss}
                                accessibilityLabel={t('playView.closeAria')}
                                style={styles.closeButton}
                              />
                            </>
                          ) : null}
                          {/* The workout stage or the list the player walks, under the grabber. Takes no
                          touches of its own, but keeps them (no pointerEvents="none"),
                          which on Android would hide it from TalkBack's explore by touch. */}
                          {topBarParts || topBarCaption ? (
                            <View
                              style={[
                                styles.topListContext,
                                {
                                  height: chromeButtonSize,
                                  left: topListContextFrame.left,
                                  right: topListContextFrame.right,
                                },
                                topListContextFrame.measured ? null : styles.topListContextUnmeasured,
                              ]}
                            >
                              <PlayListContext
                                parts={topBarParts}
                                caption={topBarCaption}
                                testID="play-drawer-track-label"
                              />
                            </View>
                          ) : null}
                          {/* Mirrored across the grabber from the close chevron: the rest
                          timer (#5378), then ⋯. The timer has its own host — and so its
                          own sheet — because a root-level sheet would present UNDER this
                          transparent modal. The cluster runs from just right of the
                          grabber to the edge, so the grabber stays centred and a long
                          timer shrinks rather than sliding under it. It sits outside
                          the commit bar and the switch-board scrim, so ⋯ stays in reach
                          while browsing and on another board's climb. */}
                          <View style={[styles.topTrailing, { height: chromeButtonSize }]} pointerEvents="box-none">
                            <View style={styles.topTrailingContent} onLayout={handleTopTrailingLayout}>
                              <View style={styles.restTimerSlot}>
                                <RestTimerPillHost compact />
                              </View>
                              {/* Every row is an account action, and the signed-out reader's
                            gate bounces most of their targets to login. Mounted a frame
                            after the board, like the rest of the drawer's reads; the
                            placeholder holds its place so the timer never jumps. */}
                              {isAnonymous ? null : (
                                <View style={styles.menuSlot}>
                                  {enhancementsReady ? (
                                    <PlayDrawerActionsMenu
                                      climb={displayedClimb}
                                      boardConfig={renderBoardConfig}
                                      queueItemUuid={displayedQueueSlotUuid}
                                      isAuthenticated={isAuthenticated}
                                      hidden={actionBarLayout.hidden}
                                      boardMismatch={showBoardMismatch}
                                      isFavorited={isFavorited}
                                      isMirrored={isMirrored}
                                      onToggleFavorite={handleToggleFavoriteFromMenu}
                                      onToggleMirror={handleMirror}
                                      onOpenAngle={isAngleAdjustable ? handleOpenAngleSelector : undefined}
                                      onTick={handleOpenTickForClimb}
                                      onAddBetaVideo={handleOpenAddBetaVideoForClimb}
                                      onReportClimb={handleOpenReportClimbForClimb}
                                      onSelectPlaylist={handleOpenAddToPlaylistForClimb}
                                      onOpenQueue={handleOpenQueueFromMenu}
                                      onOpenViewOptions={handleOpenSectionsSettings}
                                      dismissPlayerAndWait={dismissPlayerAndWait}
                                      onOpenBoardControls={bluetoothConnected ? handleMenuBoardControls : undefined}
                                    />
                                  ) : (
                                    <View style={styles.menuPlaceholder} />
                                  )}
                                </View>
                              )}
                            </View>
                          </View>
                        </View>

                        {/* Title + grade swipe with the board: same translateX, same
                        tilt/fling; the next climb's header slides in edge-adjacent.
                        Wrapped only to measure where the header ends, which is what
                        the wall-state callout hangs from. */}
                        <View onLayout={onHeaderMeasured}>
                          <SwipeableHeader
                            pager={swipePager}
                            centerPage={swipeCenterPage}
                            viewportWidth={headerViewportWidth}
                            // The header a screen reader reads, in one place that
                            // the climb changing never moves: every drawn header
                            // below is hidden from it.
                            accessibilityStandIn={
                              currentHeaderModel ? (
                                <PlayDrawerHeaderAccessibility
                                  model={currentHeaderModel}
                                  pillState={headerPillState}
                                  pillBackTarget={headerBackTarget}
                                  pillTargetName={headerBackTargetName}
                                  pillLatched={browseLatchActive}
                                  onPillPress={handleBackToLive}
                                  onLongPressName={handleCopyName}
                                  onPressSetter={openSetterPlaylist}
                                />
                              ) : null
                            }
                            current={
                              currentHeaderModel ? (
                                <PreparedPlayDrawerHeader
                                  model={currentHeaderModel}
                                  // What the WALL is doing rides the header's leading slot
                                  // (left of the name, opposite the grade). It's absent
                                  // entirely when there are no wall stakes, so the plain solo
                                  // header keeps today's mirrored-flank centring.
                                  leading={headerLeading}
                                  onLongPressName={handleCopyName}
                                  onPressSetter={openSetterPlaylist}
                                />
                              ) : null
                            }
                            // A neighbour's header reserves the same flank the
                            // current one spends on the pill, so the name and its
                            // attribute glyphs slide across at a fixed position
                            // instead of stepping mid-swipe. Invisible and
                            // a11y-hidden: it holds space, it claims nothing.
                            previous={
                              previousHeaderClimb ? (
                                <LivePlayDrawerHeader
                                  climb={previousHeaderClimb}
                                  boardName={previousHeaderBoard.boardName as BoardName}
                                  layoutId={previousHeaderBoard.layoutId}
                                  angle={previousHeaderBoard.angle}
                                  leading={
                                    headerPillState ? (
                                      <WallStatePill
                                        state={headerPillState}
                                        backTarget={headerBackTarget}
                                        reserveOnly
                                      />
                                    ) : undefined
                                  }
                                />
                              ) : null
                            }
                            next={
                              nextHeaderClimb ? (
                                <LivePlayDrawerHeader
                                  climb={nextHeaderClimb}
                                  boardName={nextHeaderBoard.boardName as BoardName}
                                  layoutId={nextHeaderBoard.layoutId}
                                  angle={nextHeaderBoard.angle}
                                  leading={
                                    headerPillState ? (
                                      <WallStatePill
                                        state={headerPillState}
                                        backTarget={headerBackTarget}
                                        reserveOnly
                                      />
                                    ) : undefined
                                  }
                                />
                              ) : null
                            }
                          />
                        </View>

                        {controlsAbove ? controlsRegion : null}

                        {/* A climb that lost a hold. Still listed, playable and
                          loggable, but nothing else on this screen would say why
                          the board draws fewer holds than the setter painted.
                          Above the board, because it is about what the board is
                          showing. */}
                        <LostHoldsBanner count={lostHoldCount} onRemix={handleRemixLostHolds ?? undefined} />

                        <View style={styles.boardSection} onLayout={handleBoardContainerLayout}>
                          {boardRenderData ? (
                            <DeferredBoard
                              capturePaintedTestID={screenshotPaintedClimbTestId(
                                process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
                                activeBoardForNavigation,
                                renderBoardConfig,
                                displayedClimb,
                                isMirrored,
                              )}
                              captureLocalMirrorTestID={screenshotLocalMirrorTestId(
                                {
                                  captureEnabled:
                                    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
                                    process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS?.includes('screenshotClimbId=') ===
                                      true,
                                  supportsMirroring,
                                  sessionId,
                                  isPreview,
                                },
                                activeBoardForNavigation,
                                renderBoardConfig,
                                displayedClimb,
                              )}
                              open={isSheetOpen}
                              containerSize={boardContainerSize}
                              boardName={boardName as BoardName}
                              boardRenderData={boardRenderData}
                              layoutId={layoutId}
                              sizeId={sizeId}
                              setIds={setIds}
                              readyBoardArt={
                                openTarget?.climb.uuid === displayedClimb.uuid
                                  ? openTarget.options?.readyBoardArt
                                  : undefined
                              }
                              currentFrames={displayedClimb.frames}
                              currentFrameOverride={playback.isAnimatable ? playback.currentFrameString : null}
                              nextFrames={nextPeekFrames}
                              prevFrames={prevPeekFrames}
                              prefetchFrames={upcomingPrefetchFrames}
                              mirrored={isMirrored}
                              canSwipeNext={canPressNext}
                              canSwipePrevious={navigationState.canPrevious}
                              onSwipeNext={handleNextAdjust}
                              onSwipePrevious={handlePrevSwipe}
                              onResetZoomReady={handleResetZoomReady}
                              enabled={!isTickBarActive}
                              scrollRef={scrollGestureRef}
                              pager={swipePager}
                              centerPage={swipeCenterPage}
                              dismissRef={dismissGestureRef}
                            />
                          ) : (
                            <BoardRenderUnavailable
                              boardName={boardName}
                              layoutId={layoutId}
                              sizeId={sizeId}
                              setIds={setIds}
                              climbUuid={displayedClimb.uuid}
                              climbName={displayedClimb.name}
                            />
                          )}
                          {/* A timed block's rest and "Workout done" (#6291), for the
                            climb on the wall. The rest card leaves the board live;
                            both wait while the end-of-list card or the switch-board
                            gate owns the board. */}
                          <WorkoutRunnerOverlay
                            sessionId={sessionId}
                            run={workoutRun}
                            displayedQueueItemUuid={displayedQueueItemUuid ?? null}
                            boardName={boardName}
                            suppressed={trackEndCardVisible || showBoardMismatch}
                            onSeeWorkout={handleSeeWorkout}
                            onCardShownChange={setWorkoutCardShown}
                          />
                          {/* Over the board only: the header and the action bar
                            stay live, so Previous still walks back along the list. */}
                          {trackEndCardVisible && trackEndCard ? (
                            <TrackEndCard
                              model={trackEndCard}
                              onKeepGoing={handleTrackEndKeepGoing}
                              onDismiss={closeTrackEndCard}
                            />
                          ) : null}
                        </View>

                        {controlsAbove || tabletop ? null : controlsRegion}
                      </View>
                    </View>

                    {/* Tabletop: the fold's gutter, then the controls below it, out
                      of the first screen. */}
                    {tabletop ? (
                      <View
                        testID="play-drawer-tabletop-controls"
                        style={styles.tabletopBelowFold}
                        onLayout={handleTabletopControlsLayout}
                      >
                        {controlsRegion}
                      </View>
                    ) : null}

                    {/* Below-fold deferred sections. */}
                    {hasVisibleSections && (
                      <View>
                        {/* The frame the board paints on an animated climb, for Active
                          holds alone (and only while it is on): the sections' own
                          props stay the same between playback frames. */}
                        <PlaybackFrameContext.Provider
                          value={
                            visibleSectionIds.includes('activeHolds') && playback.isAnimatable
                              ? playback.currentFrameString
                              : null
                          }
                        >
                          <DeferredSections
                            climb={displayedClimb}
                            boardName={boardName as BoardName}
                            layoutId={layoutId}
                            sizeId={sizeId}
                            setIds={setIds}
                            angle={angle}
                            enabled={isSheetOpen}
                            contentEnabled={belowFoldContentRequested}
                            sections={sections}
                            order={sectionOrder}
                            onSimilarClimbPress={handleSimilarClimbPress}
                            onFirstSectionHeaderLayout={onSectionHeaderMeasured}
                            onFirstSectionLayout={handleFirstSectionLayout}
                            onFirstSectionToggle={handleFirstSectionToggle}
                            onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
                            onOpenFullLogbook={handleOpenFullLogbook}
                            onOpenClimberLogs={handleOpenClimberLogs}
                            onOpenClimberProfile={handleOpenClimberProfile}
                            onFindClimbers={handleFindClimbers}
                          />
                        </PlaybackFrameContext.Provider>
                      </View>
                    )}
                  </>
                )}
              </ScrollView>
              {ownsTopInset && insets.top > 0 ? (
                <PlayDrawerStatusBarScrim height={insets.top} scrollY={scrollYSV} />
              ) : null}
            </Animated.View>
          </GestureDetector>
        )}

        <PlayCoreSheetHosts
          displayedClimb={displayedClimb}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
          boardConfig={boardConfig}
          activeAngle={activeAngle}
          climbBoardMismatch={climbBoardMismatch}
          sectionsSettingsOpen={sectionsSettingsOpen}
          sectionsListActiveHolds={sectionsListActiveHolds}
          buttonsPreviewBoard={buttonsPreviewBoard}
          addBetaVideoOpen={addBetaVideoOpen}
          addToPlaylistOpen={addToPlaylistOpen}
          fullLogbookClimbUuid={fullLogbookClimbUuid}
          climberLogsOpen={climberLogsOpen}
          reportClimbOpen={reportClimbOpen}
          angleSelectorVisible={angleSelectorVisible}
          isTickBarActive={isTickBarActive}
          bleControlVisible={bleControlVisible}
          // The climb physically lit: the one on screen when it says Lit on the
          // wall (a lit preview then reads dark after Turn off all lights), else
          // the wall's, else the queue head.
          wallClearedTarget={
            displayedLit ? (displayedClimbUuid ?? null) : (wallClimbUuid ?? currentClimbQueueItem?.climb.uuid ?? null)
          }
          composerCredentialScope={composerCredentialScope}
          betaVideoTarget={betaVideoTarget}
          playlistTarget={playlistTarget}
          reportTarget={reportTarget}
          tickTarget={tickTarget}
          isMirrored={isMirrored}
          boardseshActive={boardseshActive}
          sessionId={sessionId}
          onAngleChange={onAngleChange}
          handleCloseSectionsSettings={handleCloseSectionsSettings}
          handleCloseSubDrawer={handleCloseSubDrawer}
          handleCloseAddBetaVideo={handleCloseAddBetaVideo}
          handleCloseAddToPlaylist={handleCloseAddToPlaylist}
          handleCloseFullLogbook={handleCloseFullLogbook}
          handleCloseClimberLogs={handleCloseClimberLogs}
          handleOpenClimberProfile={handleOpenClimberProfile}
          handleCloseReportClimb={handleCloseReportClimb}
          handleTickBarDismiss={handleTickBarDismiss}
          handleCloseBleControl={handleCloseBleControl}
        />
      </View>
      {renderSidePanel ? renderSidePanel(sidePanelClimb) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  rootSideBySide: {
    flexDirection: 'row',
  },
  playerColumn: {
    flex: 1,
  },
  // A fling sends the board a window width away; the column clips it so the
  // outgoing board never draws over the panel.
  playerColumnSideBySide: {
    overflow: 'hidden',
  },
  content: {
    flex: 1,
  },
  firstScreen: {
    width: '100%',
  },
  tabletopBelowFold: {
    paddingTop: PHONE_SPLIT_FOLD_GUTTER,
  },
  // Takes the whole first screen so the board section inside keeps its flex:1
  // share; exists only to give the wall-state callout a sibling it can hide from
  // assistive tech while it's open.
  firstScreenContent: {
    flex: 1,
  },
  // At the top of the row, as on a system sheet, so the list label can sit
  // under it on the buttons' centre line.
  grabber: {
    position: 'absolute',
    top: 5,
  },
  // Spans the room ⌄ and the timer + ⋯ cluster leave (insets set inline), and
  // centres the label on the buttons' centre line.
  topListContext: {
    position: 'absolute',
    top: 0,
    justifyContent: 'center',
  },
  topListContextUnmeasured: {
    opacity: 0,
  },
  // Hugs the timer and ⋯ so its width says how much of the row they use; it
  // shrinks with the timer, so a long time still never crosses the grabber.
  topTrailingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
  },
  // Lines the close button, ⋯ and the list label up on one centre line; the
  // grabber sits at its top and the close button overlays the left edge.
  topRow: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Mirrors closeButton across the grabber, and spans from just right of it
  // (half the 36pt grabber plus a gap) to the edge. Absolute so the grabber stays
  // centred on the row no matter how wide the timer's digits run; the timer
  // shrinks inside it instead of crossing the middle.
  topTrailing: {
    position: 'absolute',
    top: 0,
    left: '50%',
    marginLeft: TOP_TRAILING_CENTRE_CLEARANCE,
    right: spacing[2],
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  // Collapses to nothing while no timer is armed, so ⋯ keeps the chevron's inset.
  restTimerSlot: {
    flexShrink: 1,
    minWidth: 0,
  },
  // The gap sits on ⋯'s side, not the cluster's: a `gap` would still space out
  // the empty timer slot and push ⋯ in from the edge.
  menuSlot: {
    marginLeft: spacing[2],
  },
  // ⋯'s anchor, held while the menu waits for its first frame.
  menuPlaceholder: {
    width: MENU_ANCHOR_SIZE,
    height: MENU_ANCHOR_SIZE,
  },
  closeButton: {
    position: 'absolute',
    top: 0,
    left: spacing[2],
    zIndex: 2,
  },
  boardSection: {
    flex: 1,
    position: 'relative',
    marginHorizontal: spacing[4],
  },
  // Anchors the switch-board overlay so its scrim covers exactly the playback +
  // action controls, leaving the board art and header above it interactive.
  controlsRegion: {
    position: 'relative',
  },
  // Over the lost-holds banner and the board, its later siblings.
  controlsRegionAbove: {
    zIndex: 1,
  },
});
