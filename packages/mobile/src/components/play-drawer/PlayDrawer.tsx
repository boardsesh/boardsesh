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
import {
  AccessibilityInfo,
  Platform,
  View,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { ScrollView, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useAnimatedReaction, useSharedValue, runOnJS } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { reanchorPlaylistSuggestionSource } from '@boardsesh/queue';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { randomUUID } from 'expo-crypto';
import { computeNavigationStateWithSuggestions, boardSupportsMirroring } from '@boardsesh/play-view';
import { climbToQueueItem, resolveCommittableQueueItem } from '../../lib/climb-to-queue-item';
import { formatRenderBoardLabel, resolveClimbRenderBoard, sameRenderBoard } from '../../lib/boards/climb-render-board';
import type { ActiveSubDrawer } from '@boardsesh/play-view';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { DeferredBoard } from './DeferredBoard';
import { BoardRenderUnavailable } from './BoardRenderUnavailable';
import { PlaybackControls } from './PlaybackControls';
import { useMobilePlayback } from './use-mobile-playback';
import { LivePlayDrawerHeader } from './PlayDrawerHeader';
import { copyClimbName } from './copy-climb-name';
import { SwipeableHeader } from './SwipeableHeader';
import { PlayDrawerActionBar } from './PlayDrawerActionBar';
import { WallStatePill } from './WallStatePill';
import { WallStateCallout } from './WallStateCallout';
import { BrowseFrameOverlay } from './BrowseFrameOverlay';
import {
  resolveWallPillState,
  resolveCommitBarModel,
  shouldAdoptLateWallRead,
  shouldArmBusyWallConfirm,
  shouldShowHolderBadge,
} from './wall-state';
import { useWallStateAnnouncer } from './use-wall-state-announcer';
import { useWallClimb } from './use-wall-climb';
import { claimJoinedBrowseNotice, claimSoloBrowseNotice } from './joined-browse-notice';
import { previewNeedsAngleReanchor, reanchorPreviewAtAngle } from './preview-angle-anchor';
import { SwitchBoardOverlay } from './SwitchBoardOverlay';
import { LogAscentSheet } from '../LogAscentSheet';
import { DeferredSections } from './DeferredSections';
import { PanePlaceholder } from './PanePlaceholder';
import {
  computeFirstScreenHeight,
  computeLogbookScrollTarget,
  initialDrawerPreviewItem,
  shouldShowPanePlaceholder,
} from './play-drawer-layout';
import { useBelowFoldContentRequest } from './use-below-fold-content-request';
import { useDrawerDismissGesture } from './use-drawer-dismiss-gesture';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { AddBetaVideoSheet } from '../AddBetaVideoSheet';
import { BleControlSheetHost } from '../ble/BleControlSheetHost';
import { Icon } from '../Icon';
import {
  usePlaylistSuggestionSource,
  useQueueData,
  useQueueActions,
  useQueueSessionId,
  useIsSharedSession,
} from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useSetting } from '../../settings';
import type { OpenClimbActionsOptions } from '../../providers/drawer-host-provider';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { useToggleFavorite, useFavoriteStatus, useClimb } from '../../lib/graphql/hooks';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { resolveTickDefaultGradeName } from '../../lib/boardsesh-grade-display';
import { useShareClimb } from '../../hooks/use-share-climb';
import { useMountedOnFirstOpen } from '../../hooks/use-mounted-on-first-open';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticSuccess } from '../../lib/haptics';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { resolveFavoriteRollback } from './favorite-rollback';
import { getSimilarClimbTapMode, getSwipeNavigationTarget, swipeStaysViewOnly } from './play-drawer-navigation';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { track } from '../../lib/analytics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';

type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerOpenOptions = {
  /**
   * The caller already dispatched `setCurrentClimb` for this climb (the
   * drawer-host queue / suggestion / board-sheet taps and playlist activation
   * do this). The drawer renders from `currentClimbQueueItem` and skips its own
   * commit so the item isn't dispatched twice. No browse latch — the shown climb
   * IS the active climb, so the header pill and the commit row stay stood down.
   */
  committedExternally?: boolean;
  /**
   * View-only preview: show this item in the drawer WITHOUT committing it to the
   * queue. This is the browse latch — the header pill reads "Browsing", the board
   * wears the viewfinder brackets, and the action bar's second row swaps to
   * "Back to live" + "Put on the wall". Used by the explicit "Preview" climb
   * action, the deep-link / standalone climb-page route, the workout builder, and
   * the peer-driven wall climb behind the accessory bar. The lightbulb keeps
   * acting on the active climb, not this preview.
   */
  previewQueueItem?: ClimbQueueItem | null;
  /**
   * The preview is the live wall climb behind the accessory bar — a peer (or
   * another climber on this board) is driving the wall and this climb is lit
   * right now. The pill then reads "On the wall" (the displayed climb IS the lit
   * one) and there's nothing to commit, so only "Back to live" remains. Only
   * meaningful alongside `previewQueueItem`.
   */
  previewIsWallClimb?: boolean;
  /**
   * Playlist source that seeds the drawer's next/previous suggestions for a
   * preview open (the suggestion source isn't on the queue yet). Drives
   * swipe-through-playlist in the drawer without re-dispatching.
   */
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
};

/**
 * The climb the route wants the player to show. `nonce` is bumped by the host on
 * every open request so this re-applies even when navigation is a no-op (the user
 * re-tapping a climb while the player route is already mounted).
 */
export type PlayDrawerOpenTarget = {
  climb: Climb;
  options?: PlayDrawerOpenOptions;
  nonce: number;
};

type PlayDrawerProps = {
  boardConfig: BoardConfig;
  onAngleChange?: (angle: number) => void;
  /** When false, the board's angle is fixed — the angle pill is hidden. */
  isAngleAdjustable?: boolean;
  /** Open the queue list sheet (the route hosts its own QueueSheet instance so it
   *  stacks above the player; passed as a prop rather than read via useDrawerHost,
   *  which would target the host's closed-player instance). */
  onOpenQueue: () => void;
  /** When true, the displayed climb belongs to a board other than the user's
   *  active board — render the switch-board overlay over the controls. */
  boardMismatch?: boolean;
  /** Human-readable name of the climb's board, shown in the overlay message. */
  mismatchBoardLabel?: string;
  /** Switch to the climb's board (one-tap if owned, else the board picker). The
   *  drawer passes the board it resolved for the displayed climb when the
   *  mismatch was discovered from the climb rather than handed in as an
   *  override — the host has no override to read in that case. */
  onSwitchBoard?: (boardConfig?: BoardConfig) => void;
  /** Opens the climb reaction menu (DrawerHostProvider's openClimbActions). On iOS
   *  the ellipsis uses this instead of the in-drawer bottom sheet. The drawer passes
   *  its own in-tree beta opener via `options.onAddBetaVideo` so the beta sheet
   *  stacks above the `/play` modal (#3505). */
  onOpenClimbActions?: (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => void;
  /** Supplied only by the `/play` route. The persistent iPad pane omits it. */
  dismissPlayerAndWait?: OpenClimbActionsOptions['dismissPlayerAndWait'];
  /** The climb to show; applied on mount and whenever `nonce` changes. */
  openTarget: PlayDrawerOpenTarget | null;
  /** Rendering context. `'route'` (default) is the full-screen `/play` modal — a
   *  pull-down gesture + the close chevron dismiss it. `'pane'` is the persistent
   *  iPad right-column pane: it's always on screen, so the dismiss gesture, the
   *  close chevron, and the grabber are all suppressed and `router.dismiss()` is
   *  never called. */
  presentation?: 'route' | 'pane';
  /** Pane mode only: include the top safe-area inset above the first screen. False
   *  when a WallStrip is docked above the pane and already owns that inset. Ignored
   *  in route mode (the modal always owns the top inset). */
  paneTopInset?: boolean;
  /**
   * Who is looking. `'anonymous'` is the signed-out reader that
   * `AnonymousClimbView` renders on the web export's read-only climb URL: the
   * board, header, grade and every below-fold read stay, and every write
   * affordance is removed (see PlayDrawerActionBar's `viewer` prop for the full
   * list and why removal beats disabling). Never reachable on native — the whole
   * anonymous branch sits behind `RELAXES_ANONYMOUS_ROUTES`, a literal `false`
   * in the native fork.
   */
  viewer?: 'member' | 'anonymous';
  /** Anonymous only: hand this URL to login. Wired to the tick prompt. */
  onSignIn?: () => void;
};

/**
 * The frames a swipe peek may draw, or null when the neighbouring climb belongs
 * to a different board than the one currently on screen. Board art is one
 * picture: a peek is drawn over it, so a climb whose holds live on another wall
 * has nothing to show there.
 */
function peekFramesOnBoard(
  peek: Climb | null | undefined,
  activeBoardConfig: BoardConfig,
  renderBoardConfig: BoardConfig,
): string | null {
  if (!peek) return null;
  const resolved = resolveClimbRenderBoard(peek, activeBoardConfig);
  return sameRenderBoard(resolved?.boardConfig ?? activeBoardConfig, renderBoardConfig) ? peek.frames : null;
}

// Fallback used for the first-screen reserve before the Logbook header has
// been measured, so the board fits without a visible jump on first open.
// A collapsed section header is a single row (title + summary + chevron).
const DEFAULT_LOGBOOK_HEADER_HEIGHT = 52;

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

/**
 * Full-screen "now playing" player (Spotify-style track view). Rendered as the
 * content of the `app/play.tsx` modal route (`presentation: 'fullScreenModal'`):
 * the native modal VC gives the slide-up present, the swipe-down dismiss, and —
 * crucially — a view-controller stack that the sub-drawers / queue / share sheet
 * present ABOVE (the FullWindowOverlay it replaced could not, since native sheets
 * present off the key window beneath it).
 */
export function PlayDrawer({
  boardConfig,
  onAngleChange,
  isAngleAdjustable = true,
  onOpenQueue,
  boardMismatch = false,
  mismatchBoardLabel,
  onSwitchBoard,
  onOpenClimbActions,
  dismissPlayerAndWait,
  openTarget,
  presentation = 'route',
  paneTopInset = true,
  viewer = 'member',
  onSignIn,
}: PlayDrawerProps) {
  // The signed-out reader on app.boardsesh.com's read-only climb URL.
  const isAnonymous = viewer === 'anonymous';
  // The iPad right-column pane is persistent — it has no dismiss. Suppresses the
  // pull-down dismiss gesture, the close chevron, the grabber, and router.dismiss.
  const isPane = presentation === 'pane';
  const { t } = useTranslation('session');
  // The copy/share affordance strings live in the `climbs` namespace alongside
  // the climb-actions sheet's "Link copied" toast.
  const { t: tClimbs } = useTranslation('climbs');
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // The route is mounted only while the player is open, so the player is "open"
  // for this component's whole lifetime — this gates the board render, favorite
  // fetch, wake lock, and below-fold sections. Intentionally a constant, NOT
  // useIsFocused: a presented sub-drawer / queue sheet must not drop the wake
  // lock or blank the board mid-tick.
  const isSheetOpen = true;
  // Measured viewport of the scroll container; drives first-screen sizing so the
  // below-fold (Beta Videos) peek lands.
  const [sheetViewportHeight, setSheetViewportHeight] = useState(0);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    setSheetViewportHeight((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  }, []);
  // Seeded from the open target rather than left null: the effect that applies
  // the target runs after the first commit, so a pane that already has its climb
  // would otherwise paint one frame of the "Pick a climb" placeholder first.
  const [drawerPreviewItem, setDrawerPreviewItem] = useState<ClimbQueueItem | null>(() =>
    initialDrawerPreviewItem(openTarget),
  );
  const [drawerPreviewSuggestionSource, setDrawerPreviewSuggestionSource] = useState<PlaylistSuggestionSource | null>(
    null,
  );
  // True when the preview is the live wall climb (accessory bar) — the displayed
  // climb IS the one physically lit, which is what the "On the wall" pill states.
  const [drawerPreviewIsWallClimb, setDrawerPreviewIsWallClimb] = useState(false);
  // The wall-state pill's explainer, and the header's measured bottom edge it
  // hangs from. Owned here rather than inside the pill because the callout is an
  // absolute sibling of the swipeable header (so it doesn't ride the swipe
  // translate) — it can't be a child of the 32pt pill in the header's flank.
  //
  // Three states, not a boolean, because the same card serves two very different
  // jobs: `'explainer'` is the tapped card (modal, focused, offers actions) and
  // `'notice'` is the one-shot "you're browsing now" card that appears by itself
  // when a shared session first latches the drawer (no modal, no focus steal).
  const [wallCallout, setWallCallout] = useState<'none' | 'explainer' | 'notice'>('none');
  const [headerBottomY, setHeaderBottomY] = useState(0);
  const [isMirrored, setIsMirrored] = useState(false);
  // Local optimistic override for the heart. `null` means "no local change —
  // show the server's favorite status". A tap sets it optimistically, the
  // mutation's returned `favorited` confirms it, and a failure rolls it back.
  // Cleared on every climb change so the next climb shows its real status.
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | null>(null);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const [addBetaVideoOpen, setAddBetaVideoOpen] = useState(false);
  // Pinned climb/board the reaction menu opened the beta sheet for; null falls back
  // to the live displayedClimb (the "+" button path). See #3505.
  const [betaVideoTarget, setBetaVideoTarget] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  // Pinned climb/board the reaction menu opened the tick sheet for; null falls back
  // to the live displayedClimb (the FAB path). Mirrors betaVideoTarget so a party-
  // session queue/angle change mid-menu can't retarget the sheet.
  const [tickTarget, setTickTarget] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  const {
    requested: belowFoldContentRequested,
    request: requestBelowFoldContent,
    requestFromScrollOffset: requestBelowFoldContentFromScrollOffset,
  } = useBelowFoldContentRequest();
  const resetZoomRef = useRef<(() => void) | null>(null);
  // Set true when the user taps to expand the Logbook peek; the section's next
  // layout then glides it fully into view. Stays armed across the logbook's
  // loading→loaded height growth (so a slow fetch still lands framed) and is
  // disarmed once the user drives the scroll, collapses it, or the climb changes.
  const pendingLogbookScrollRef = useRef(false);

  const handleScrollTowardBelowFold = useCallback(() => {
    requestBelowFoldContent();
    // The user is driving the scroll now — stand down the expand-into-view glide.
    pendingLogbookScrollRef.current = false;
  }, [requestBelowFoldContent]);

  // RNGH ref for the scroll container. The board's swipe + pinch gestures declare
  // themselves simultaneous with it (otherwise the plain RN ScrollView starved
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
      if (offsetY > 0) pendingLogbookScrollRef.current = false;
    },
    [requestBelowFoldContentFromScrollOffset, scrollYSV],
  );
  const handleDismiss = useCallback(() => {
    // The pane is persistent — nothing to dismiss (and no modal to pop).
    if (isPane) return;
    router.dismiss();
  }, [isPane]);

  // The header (title + grade) rides this exact value as the board so they swipe
  // in lockstep; the carousel's gesture writes into it (externalTranslateX). The
  // direction (which climb the header peek shows) tracks the swipe sign.
  const swipeTranslateX = useSharedValue(0);
  // Fling-in-progress flag the gesture sets. PlayDrawer (the host) owns the reset:
  // it leaves translateX where the fling left it (card off-screen, incoming peek
  // covering centre) and snaps it back to 0 only once the new climb has actually
  // rendered — so the swap is invisible instead of flashing the old climb.
  const swipeIsAnimating = useSharedValue(false);

  // The dismiss reads these so it can stand down while a horizontal swipe owns the
  // gesture (offset non-zero) or a fling is still settling (carousel inert) — that's
  // when an accidental downward drift would otherwise yank the drawer down.
  const { gesture: dismissGesture, translateY: dismissTranslateY } = useDrawerDismissGesture({
    onDismiss: handleDismiss,
    scrollYSV,
    scrollRef: scrollGestureRef,
    swipeTranslateX,
    swipeIsAnimating,
  });
  const dismissAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  const [swipeDirection, setSwipeDirection] = useState<'next' | 'prev'>('next');
  useAnimatedReaction(
    () => (swipeTranslateX.value < 0 ? 'next' : 'prev'),
    (direction, previous) => {
      if (direction !== previous) runOnJS(setSwipeDirection)(direction);
    },
  );
  // Freeze the header peek's climb for the fling+commit window, mirroring the
  // board's peek freeze (SwipeBoardCarousel), so the hand-off shows the right
  // title/grade at centre rather than the new climb's neighbour. `peekClimbRef`
  // holds the live value (assigned once peekClimb is computed below) so the
  // capture reads it without making it a callback dep.
  const peekClimbRef = useRef<Climb | null>(null);
  const [isSwipeCommitting, setIsSwipeCommitting] = useState(false);
  const [frozenPeekClimb, setFrozenPeekClimb] = useState<Climb | null>(null);
  const handleSwipeAnimatingChange = useCallback((animating: boolean) => {
    if (animating) setFrozenPeekClimb(peekClimbRef.current);
    setIsSwipeCommitting(animating);
  }, []);
  useAnimatedReaction(
    () => swipeIsAnimating.value,
    (animating, previous) => {
      if (animating !== previous) runOnJS(handleSwipeAnimatingChange)(animating);
    },
  );

  // Logbook section-header height feeds the first-screen reserve so the
  // header teases at the bottom of the full-screen view (the cue that there's
  // more to scroll). Measured because it varies with locale / font scaling.
  const [logbookHeaderHeight, setLogbookHeaderHeight] = useState(0);
  const handleLogbookHeaderLayout = useCallback((measured: number) => {
    setLogbookHeaderHeight((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  }, []);

  const { queue, currentClimbQueueItem } = useQueueData();
  const { setCurrentClimb, nextClimb, previousClimb, addToQueue, noteClimbViewed } = useQueueActions();
  const { sessionId } = useQueueSessionId();
  // "Is anyone else here." Read as one boolean off a dedicated selector context
  // so the ≤1/2s session-stats push and every presence delta cost the drawer
  // nothing — it flips only across the solo ↔ crew boundary.
  const isSharedSession = useIsSharedSession();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const bluetooth = useOptionalBluetoothContext();
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  // App-wide grade resolver: swaps the header grade (label + colour) to the
  // Boardsesh grade when the "Show Boardsesh grades" toggle is on and a trusted
  // one exists, else the legacy Aurora grade. `boardseshActive` also seeds the
  // tick picker's default grade below.
  const { boardseshActive } = useDisplayGrade();
  const { isAuthenticated } = useAuth();

  const displayedQueueItem = drawerPreviewItem ?? currentClimbQueueItem;
  const displayedClimb = displayedQueueItem?.climb;
  // A view-only preview is showing (not the active/wall climb). Commit paths
  // never set `drawerPreviewItem`, so this is true only for genuine previews
  // (workout builder, logbook/cross-board, the peer-driven accessory wall climb).
  const isPreview = drawerPreviewItem != null;

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
  const showBoardMismatch = boardMismatch || climbBoardMismatch;
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

  const boardRenderData = useMemo(() => {
    const parsedSetIds = setIds.split(',').map(Number);
    return getBoardRenderData({
      boardName: boardName as BoardName,
      layoutId,
      sizeId,
      setIds: parsedSetIds,
    });
  }, [boardName, layoutId, sizeId, setIds]);

  // Real favorite status for the heart, keyed on (boardName, climbUuid, angle).
  // Gated on the sheet being open so it doesn't fetch while the drawer is closed.
  // The displayed state is the local optimistic override when set, otherwise the
  // server's truth — so the heart reflects whether the climb is already a favorite
  // on open, and a single tap can't invert reality (the previous always-false
  // local state silently un-favorited already-favorited climbs).
  // `favorites` is `requireAuthenticated` on the backend, and the heart is hidden
  // anonymously anyway — arming it would fire a query that can only 401 on every
  // read-only open. The hook re-checks the session itself; this is the local half.
  const { data: serverFavorited } = useFavoriteStatus(boardName, displayedClimb?.uuid ?? null, angle, {
    enabled: isSheetOpen && !isAnonymous,
  });
  const isFavorited = favoriteOverride ?? serverFavorited ?? false;
  // Lit visual, pending pulse, and the connect/disconnect tap — shared with the
  // toolbar bulb via `useLightbulbControl`, so both light identically (this
  // device, or a session peer driving the wall) and run one connect path. The
  // press action keys on THIS device's BLE; `lightbulbConnected` (below) carries
  // that to the action bar for the accessibility label.
  const {
    lit: lightbulbActive,
    localConnected: bluetoothConnected,
    pending: lightbulbPending,
    onPress: handleLightbulb,
  } = useLightbulbControl();
  const navigationSuggestionSource = drawerPreviewSuggestionSource ?? playlistSuggestionSource;
  const navigationState = useMemo(
    () => computeNavigationStateWithSuggestions(queue, displayedQueueItem, navigationSuggestionSource),
    [queue, displayedQueueItem, navigationSuggestionSource],
  );

  // The climb the header peek shows while swiping — the one being swiped toward.
  const peekClimb =
    swipeDirection === 'next' ? (navigationState.nextItem?.climb ?? null) : (navigationState.prevItem?.climb ?? null);
  peekClimbRef.current = peekClimb;
  // During the commit hand-off use the frozen climb (captured at fling start) so
  // the peek doesn't jump to the new climb's neighbour mid-swap.
  const headerPeekClimb = isSwipeCommitting ? frozenPeekClimb : peekClimb;
  const headerPeekBoard = useMemo(
    () => resolveClimbRenderBoard(headerPeekClimb, boardConfig)?.boardConfig ?? renderBoardConfig,
    [headerPeekClimb, boardConfig, renderBoardConfig],
  );

  // The swipe peeks paint the neighbouring climbs' holds under the CURRENT
  // board art. A neighbour from another board has no holds there, so it would
  // peek as an empty wall (or, worse, light unrelated holds that happen to share
  // ids). Withhold its frames and let the board swap on commit instead (#5099).
  const nextPeekFrames = useMemo(
    () => peekFramesOnBoard(navigationState.nextItem?.climb, boardConfig, renderBoardConfig),
    [navigationState.nextItem, boardConfig, renderBoardConfig],
  );
  const prevPeekFrames = useMemo(
    () => peekFramesOnBoard(navigationState.prevItem?.climb, boardConfig, renderBoardConfig),
    [navigationState.prevItem, boardConfig, renderBoardConfig],
  );

  // Host-owned post-fling reset: once the swiped-to climb has actually rendered
  // (the displayed queue item changes), snap the shared swipe offset back to 0 and
  // clear the fling flag. Doing it here — after the new content is on screen —
  // means the frozen incoming peek covered the swap, so there's no flash. Keyed on
  // the queue ITEM uuid (unique per position) so duplicate climbs still reset.
  const displayedQueueItemUuid = displayedQueueItem?.uuid;
  useEffect(() => {
    if (swipeIsAnimating.value) {
      swipeTranslateX.value = 0;
      swipeIsAnimating.value = false;
    }
  }, [displayedQueueItemUuid, swipeIsAnimating, swipeTranslateX]);

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

  // Auto-close tick bar and drop the favorite override when climb changes, so the
  // new climb's heart shows its real (server) status rather than the previous
  // climb's optimistic value.
  const displayedClimbUuid = displayedClimb?.uuid;
  useEffect(() => {
    setIsTickBarActive(false);
    setFavoriteOverride(null);
    // A new climb's Logbook re-lays out from scratch — don't let a stale expand
    // intent auto-scroll it.
    pendingLogbookScrollRef.current = false;
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
    const timer = setTimeout(() => setSharedBrowseLatched(false), SHARED_BROWSE_LATCH_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [isSharedSession]);
  // What the gestures and the chrome both read. Live crew OR a latch that armed
  // while there was one.
  const browseByDefault = isSharedSession || sharedBrowseLatched;

  // --- Wall state (header pill + commit row + viewfinder) --------------------
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
  });
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
  });
  // The latch as the board overlay sees it. It follows the latch itself, NOT the
  // commit row: on the wrong board the row stands down (its controls would be
  // dead under the switch-board scrim) while the climber is still very much
  // browsing. A signed-out reader is always in a preview — that is what keeps
  // the queue untouched — so the whole feature is suppressed for them.
  const showBrowseFrame = browseLatchActive && !isAnonymous;
  // "Back to live" only clears a pinned preview, so it's offered whenever one is
  // pinned — including the `live`-pill previews the latch gate above excludes,
  // where returning to the committed head is still a real (and truthful) action.
  const canReturnToCommittedClimb = isPreview && !isAnonymous;

  const { markLatchExit, suppressBrowseAnnouncement } = useWallStateAnnouncer({
    pillState: wallPillState,
    climbName: displayedClimb?.name ?? null,
  });

  const handleOpenWallCallout = useCallback(() => setWallCallout('explainer'), []);
  const handleCloseWallCallout = useCallback(() => setWallCallout('none'), []);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const measured = Math.round(y + height);
    setHeaderBottomY((previous) => (Math.abs(previous - measured) > 2 ? measured : previous));
  }, []);
  // An explainer about a state that just changed is stale, so the callout stands
  // down whenever the state or the climb under it moves. This also dismisses the
  // one-shot notice on the climber's next navigation, which is the point at which
  // they've clearly read it.
  useEffect(() => {
    setWallCallout('none');
  }, [wallPillState, displayedClimbUuid]);

  // Something silently changed what a swipe does, so say so — once. Fires the
  // first time the latch actually engages: joining a crew, or (solo) the first
  // navigation that stays view-only because board lighting is off for swipes and
  // taps. Either way it is the moment the new rule becomes visible rather than
  // merely true.
  //
  // The solo half is gated on a wall being reachable at all. With no board
  // connected, no session and nothing lit, "the wall stays put" is a sentence
  // about something the climber hasn't got — and the commit button reads "Set
  // active" there for the same reason.
  //
  // Declared AFTER the dismiss effect above so the same commit can't close the
  // card it just opened: the latch engaging usually moves the pill state and the
  // climb at once, and effects run in declaration order.
  const wallReachable = commitBarModel.commitLabel === 'putOnWall';
  useEffect(() => {
    if (isAnonymous || !browseLatchActive) return;
    const claimed = isSharedSession ? claimJoinedBrowseNotice(sessionId) : wallReachable && claimSoloBrowseNotice();
    if (!claimed) return;
    setWallCallout('notice');
    // The card is the visual half; this is the spoken one, and it is spoken on
    // both platforms. A live region on a card that MOUNTS already holding its
    // text is not a content change, so TalkBack can miss it — and the drawer can
    // open straight into a browse (a crew climb-list tap), where there is no
    // state transition for the wall-state announcer to narrate either. Its browse
    // sentence stands down when this speaks, so one moment gets one sentence.
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
    setIsMirrored(false);
    // Close the callout explicitly rather than trusting the stale-state effect
    // above: previewing the committed climb itself changes neither
    // `wallPillState` nor `displayedClimbUuid` on exit, which would strand the
    // explainer (and its focus trap) open with its action already spent.
    setWallCallout('none');
  }, [markLatchExit]);

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
  }, [activeAngle]);

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
  }, [previewClimbAtAngle, angle]);

  const { showToast } = useToast();

  const shareClimb = useShareClimb({
    climb: displayedClimb ?? null,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
  });

  // Android can throw on share cancellation; surface anything we didn't expect
  // rather than silently swallowing the rejection.
  const handleShare = useCallback(() => {
    if (!displayedClimb) return;
    // Tracks share intent (like the actions-menu site), not share completion.
    track(SHARED_EVENTS.ClimbShared, {
      method: 'share',
      source: 'play_drawer',
      climbUuid: displayedClimb.uuid,
      boardName,
      layoutId,
    });
    shareClimb().catch((error) => {
      console.warn('[playDrawer] share failed:', error);
      showToast(t('playView.shareError'), 'error');
    });
  }, [shareClimb, displayedClimb, boardName, layoutId, showToast, t]);

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

  const openDrawer = useCallback(
    (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      const previewItem = options?.previewQueueItem ?? null;
      const playlistSuggestionSource = options?.playlistSuggestionSource ?? null;
      // Fresh active open (search / list / LogbookTab / a tick in the feed / a
      // profile climb / the accessory bar's own current climb): the climb becomes
      // current unless it already is, so re-opening the current climb doesn't
      // re-append it. A fresh-uuid item on a genuinely new selection is
      // intentional (re-tapping starts a fresh pass — see queue setCurrentClimb).
      const isFreshActiveOpen = !previewItem && !options?.committedExternally;
      const isAlreadyCurrent = currentClimbQueueItem?.climb.uuid === selectedClimb.uuid;
      // ...except in a crew, where the same taps are a LOOK. Tapping a peer's
      // tick in the session feed, or a row in your own logbook, must not move the
      // shared queue and blank the climb someone is mid-attempt on — the deep-link
      // opener already reasons this way and passes `preview: true`. Gated here
      // rather than at each opener because the openers are many (feed, Logbook,
      // Sessions, session detail, profile, notifications) and every one of them
      // is the same gesture: show me this climb.
      //
      // Reads the LATCH, like every other gesture gate in this file, not the live
      // roster: a peer's phone dropping off the wifi for a moment must not turn
      // the tap the climber is already making into a queue write.
      const opensAsBrowse = isFreshActiveOpen && !isAlreadyCurrent && browseByDefault;
      // A view-only preview is shown without committing; the browse chrome keys
      // off this. Commit paths (committedExternally) and solo fresh active opens
      // leave it null so the drawer renders the real currentClimbQueueItem.
      const pinnedItem = previewItem ?? (opensAsBrowse ? climbToQueueItem(selectedClimb) : null);
      setDrawerPreviewItem(pinnedItem);
      setDrawerPreviewSuggestionSource(pinnedItem ? playlistSuggestionSource : null);
      setDrawerPreviewIsWallClimb(pinnedItem ? (options?.previewIsWallClimb ?? false) : false);
      // Opening a COMMITTED climb is the third latch exit: the queue-sheet tap,
      // a playlist activation and the accessory-of-current open all deliberately
      // put a climb up, so they land the drawer live rather than mid-browse. A
      // preview open leaves the latch alone — the arm effect picks it up if a
      // crew is present.
      if (!pinnedItem) setSharedBrowseLatched(false);
      setIsMirrored(false);
      // Drop any stale optimistic heart so the opened climb shows its real
      // (server) favorite status rather than a leftover from the last climb.
      setFavoriteOverride(null);
      setIsTickBarActive(false);
      setActiveSubDrawer('none');
      if (isFreshActiveOpen && !isAlreadyCurrent && !opensAsBrowse) {
        setCurrentClimb(climbToQueueItem(selectedClimb), { playlistSuggestionSource: null });
      }
    },
    [currentClimbQueueItem, setCurrentClimb, browseByDefault],
  );

  // Apply the host's open target. A new target is a fresh object with a bumped
  // nonce, so its identity changes on every open request — this fires on mount
  // (first open) AND when the user re-taps a climb while the route is already up
  // (where `router.navigate('/play')` is a no-op). Defined AFTER the `[activeAngle]`
  // preview-clear effect so that on a board-override open (angle + target both
  // change) the preview this sets wins over that effect's clear. The ref keeps
  // the latest `openDrawer` without making it a dep (we key only on the target).
  const openDrawerRef = useRef(openDrawer);
  openDrawerRef.current = openDrawer;
  useEffect(() => {
    if (!openTarget) return;
    openDrawerRef.current(openTarget.climb, openTarget.options);
  }, [openTarget]);

  const handlePrev = useCallback(() => {
    const previewTarget = getSwipeNavigationTarget({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      targetItem: navigationState.prevItem,
      lightOnSwipe,
      inSharedSession: browseByDefault,
    });
    if (previewTarget.viewOnly) {
      if (!previewTarget.targetItem) return;
      setDrawerPreviewItem(previewTarget.targetItem);
      // A previewed climb is drawn on the board, so it is a view — but this
      // branch never touches the queue, so the provider's current-climb effect
      // will not see it. Report it here (issue #2202).
      noteClimbViewed(previewTarget.targetItem.climb.uuid);
      // Swiping off the lit climb makes "this is the wall climb" false — the
      // flag means displayed-equals-wall, and the wall didn't move.
      setDrawerPreviewIsWallClimb(false);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      return;
    }
    // Always-live: navigation commits the shared current climb for everyone.
    setDrawerPreviewItem(null);
    setDrawerPreviewIsWallClimb(false);
    previousClimb();
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [
    drawerPreviewSuggestionSource,
    drawerPreviewItem,
    navigationState.prevItem,
    previousClimb,
    lightOnSwipe,
    noteClimbViewed,
    browseByDefault,
  ]);

  const handleNext = useCallback(() => {
    const previewTarget = getSwipeNavigationTarget({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      targetItem: navigationState.nextItem,
      lightOnSwipe,
      inSharedSession: browseByDefault,
    });
    if (previewTarget.viewOnly) {
      if (!previewTarget.targetItem) return;
      setDrawerPreviewItem(previewTarget.targetItem);
      // See handlePrev: a previewed climb is on the board, and nothing in this
      // branch reaches the queue, so the view is reported from here.
      noteClimbViewed(previewTarget.targetItem.climb.uuid);
      // See handlePrev: displayed-equals-wall stops being true the moment the
      // swipe lands somewhere else.
      setDrawerPreviewIsWallClimb(false);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      return;
    }
    // Always-live: navigation commits the shared current climb for everyone.
    setDrawerPreviewItem(null);
    setDrawerPreviewIsWallClimb(false);
    nextClimb();
    setIsMirrored(false);
    // The favorite override is cleared by the climb-change effect.
  }, [
    drawerPreviewSuggestionSource,
    drawerPreviewItem,
    navigationState.nextItem,
    nextClimb,
    lightOnSwipe,
    noteClimbViewed,
    browseByDefault,
  ]);

  // Commit the browse latch: the previewed climb becomes the current queue item,
  // the latch drops, and the lightbulb (which acts on the current climb) now
  // drives this one. Wired to the commit row's "Put on the wall" / "Set active".
  const handleSetActive = useCallback(() => {
    if (!drawerPreviewItem) return;
    // First tap on a wall someone else moved mid-browse: ask instead of taking
    // it. Only under the browse latch — that is what makes
    // `wallUuidAtLatchStartRef` mean "the wall as it was when you started
    // looking around"; without one there is no before-and-after to compare. And
    // only with a crew (`browseByDefault`: one is here, or was when the latch
    // armed): "Someone just lit X" needs a someone. A solo climber with
    // `lightOnSwipe` off is latched too, and the one way THEIR wall moves under
    // a preview is their own lightbulb tap — asking them to confirm over their
    // own climb would be the question asked of nobody.
    if (
      !busyWallConfirmArmed &&
      browseLatchActive &&
      browseByDefault &&
      shouldArmBusyWallConfirm({
        wallClimbUuid,
        wallUuidAtLatchStart: wallUuidAtLatchStartRef.current,
        displayedClimbUuid: displayedClimbUuid ?? null,
      })
    ) {
      setBusyWallConfirmArmed(true);
      // The bubble is untouchable, so the words have to reach a screen reader
      // some other way. Android hears the confirm row's polite live region;
      // saying it here as well would read it twice, so this is the other half
      // (amendment B).
      if (Platform.OS !== 'android') {
        AccessibilityInfo.announceForAccessibility(
          t('playView.wallState.commitOverride.body', { name: wallClimb.name ?? '' }),
        );
      }
      return;
    }
    markLatchExit('commit');
    setBusyWallConfirmArmed(false);
    // Launder the item first. Browsing a suggestion track walks onto transient
    // `playlist-peek:<uuid>` items, and `toQueueItemWireInput` sends `item.uuid`
    // verbatim — committing one straight would put a uuid on the wire that no
    // peer can reconcile against their queue. Same helper `nextClimb()` uses.
    const { item } = resolveCommittableQueueItem(drawerPreviewItem);
    // Re-anchor the track on the climb actually going up. Browsing moves
    // `drawerPreviewItem` swipe by swipe but never touches the source, so after a
    // walk from A to Z the source still says the pass began at A — and committing
    // that verbatim would aim next/previous and the remaining count at A's
    // neighbours, several swipes behind where the climber is standing.
    setCurrentClimb(item, {
      playlistSuggestionSource: reanchorPlaylistSuggestionSource(drawerPreviewSuggestionSource, item.climb?.uuid),
    });
    setSharedBrowseLatched(false);
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setDrawerPreviewIsWallClimb(false);
    // Mirroring is drawer-local per displayed climb and every other navigation
    // resets it (see `handleBackToLive`). The commit has to as well: the
    // auto-sender lights the committed item's own `climb.mirrored`, so a mirror
    // toggled while previewing would leave the drawer showing the climb flipped
    // and the wall showing it straight.
    setIsMirrored(false);
  }, [
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setCurrentClimb,
    markLatchExit,
    busyWallConfirmArmed,
    browseLatchActive,
    browseByDefault,
    wallClimbUuid,
    wallClimb.name,
    displayedClimbUuid,
    t,
  ]);

  const handleMirror = useCallback(() => {
    const nextMirrored = !isMirrored;
    setIsMirrored(nextMirrored);
    // The wall doesn't follow the toggle by itself: the AutoSender keys off
    // the queue item's own `climb.mirrored`, not this drawer-local state, so
    // without an explicit re-push the LEDs would keep showing the previous
    // orientation. isConnected means this device holds the BLE link (and
    // therefore drives the wall).
    //
    // Not while a preview is pinned, though: the wall is showing the LIVE climb
    // and the drawer is showing something else, so this write would put a climb
    // nobody committed on the board — the loudest possible outcome for a toggle
    // that reads as "flip the picture I'm looking at". Mirrored previews are an
    // on-screen thing until the climber commits; the auto-sender then re-pushes
    // the committed item.
    if (!isPreview && bluetooth?.isConnected && displayedClimb?.frames) {
      void bluetooth.sendFramesToBoard(displayedClimb.frames, nextMirrored);
    }
  }, [isMirrored, bluetooth, displayedClimb, isPreview]);

  const handleToggleFavorite = useCallback(() => {
    if (!displayedClimb) return;
    hapticSuccess();
    const nextIsFavorited = !isFavorited;
    const previousOverride = favoriteOverride;
    setFavoriteOverride(nextIsFavorited);
    track(SHARED_EVENTS.FavoriteToggle, {
      action: nextIsFavorited ? 'added' : 'removed',
      climbUuid: displayedClimb.uuid,
      boardName,
      layoutId,
      source: 'mobile_play_drawer',
    });
    toggleFavoriteMutate(
      {
        input: {
          boardName,
          climbUuid: displayedClimb.uuid,
          angle,
        },
        currentlyFavorited: isFavorited,
      },
      {
        // Reconcile to the server's authoritative result — the backend toggles
        // off the real DB state, so this is the truth even if our optimistic
        // guess was wrong.
        onSuccess: (response) => {
          setFavoriteOverride(response.toggleFavorite.favorited);
        },
        // Roll back the optimistic flip and tell the user it didn't stick, rather
        // than leaving the heart diverged from the server. Only undo OUR flip,
        // though: if a newer tap (or a climb change, which resets the override to
        // null) has since moved the heart, this late error must not clobber the
        // current state with this tap's stale previous value.
        onError: () => {
          setFavoriteOverride((current) => resolveFavoriteRollback(current, nextIsFavorited, previousOverride));
          showToast(t('playView.favoriteError'), 'error');
        },
      },
    );
  }, [displayedClimb, isFavorited, favoriteOverride, boardName, layoutId, angle, toggleFavoriteMutate, showToast, t]);

  const handleLightbulbLongPress = useCallback(() => {
    if (!bluetooth?.isConnected) return;
    // Reveal the BLE controls (Re-light / Disconnect) rather than disconnecting
    // blind — keeps the destructive action behind a labelled menu.
    setBleControlVisible(true);
  }, [bluetooth]);

  // Beta Videos "+" button: null target → the sheet tracks the live displayedClimb.
  const handleOpenAddBetaVideo = useCallback(() => {
    setBetaVideoTarget(null);
    setAddBetaVideoOpen(true);
  }, []);

  // Reaction-menu beta: pin the climb/board the menu was opened for so a party-session
  // queue/angle change mid-menu can't retarget the sheet (#3505).
  const handleOpenAddBetaVideoForClimb = useCallback((targetClimb: Climb, targetBoardConfig: BoardConfig) => {
    setBetaVideoTarget({ climb: targetClimb, boardConfig: targetBoardConfig });
    setAddBetaVideoOpen(true);
  }, []);

  // Reaction-menu tick: open the drawer's OWN in-tree tick sheet (it stacks above
  // the `/play` modal) instead of the root LogAscent sheet, which mounts behind
  // `/play` — presenting it dismisses `/play` and the tick sheet closes on its own.
  // Pin the climb/board the menu was opened for so a mid-menu queue change can't
  // retarget it. QuickTickOpened is tracked by useClimbActions (source climb_actions).
  const handleOpenTickForClimb = useCallback((targetClimb: Climb, targetBoardConfig: BoardConfig) => {
    resetZoomRef.current?.();
    setTickTarget({ climb: targetClimb, boardConfig: targetBoardConfig });
    setIsTickBarActive(true);
  }, []);

  // Don't clear betaVideoTarget here: the sheet is still animating out and reads
  // from it, so nulling it mid-dismiss would swap the shown climb for a frame. The
  // next open overwrites it (the "+" path to null, the reaction path to its snapshot).
  const handleCloseAddBetaVideo = useCallback(() => {
    setAddBetaVideoOpen(false);
  }, []);

  const handleOpenActions = useCallback(() => {
    // iOS: open the floating reaction menu (over the drawer) instead of the in-drawer
    // bottom sheet. Android keeps the bottom sheet.
    if (Platform.OS === 'ios' && onOpenClimbActions && displayedClimb) {
      // Hand the reaction menu the drawer's OWN beta opener so the share-your-beta
      // sheet presents inside the `/play` modal (above it) rather than the root
      // sheet, which can't stack over the fullScreenModal (#3505).
      onOpenClimbActions(displayedClimb, undefined, {
        onAddBetaVideo: handleOpenAddBetaVideoForClimb,
        onTick: handleOpenTickForClimb,
      });
      return;
    }
    setActiveSubDrawer('actions');
  }, [onOpenClimbActions, displayedClimb, handleOpenAddBetaVideoForClimb, handleOpenTickForClimb]);

  // Arm (expand) / disarm (collapse) the scroll-into-view for the Logbook peek.
  const handleLogbookToggle = useCallback((expanded: boolean) => {
    pendingLogbookScrollRef.current = expanded;
  }, []);

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
    // Null target → the in-tree tick sheet tracks the live displayedClimb.
    setTickTarget(null);
    setIsTickBarActive(true);
  }, [trackTickOpened]);

  // Long-press opens the same QuickTickBar as a short press; LogAscentSheet
  // has been retired in favour of a single ticking surface (see PR #2366).
  const handleTickFabLongPress = handleTickFabPress;

  const handleTickBarDismiss = useCallback(() => {
    setIsTickBarActive(false);
  }, []);

  const handleResetZoomReady = useCallback((resetFn: () => void) => {
    resetZoomRef.current = resetFn;
  }, []);

  const handleSimilarClimbPress = useCallback(
    async (similarClimb: Climb) => {
      const queueItem = climbToQueueItem(similarClimb);
      // A signed-out reader swaps what the drawer is showing and writes nothing:
      // no queue entry they cannot carry anywhere, and no `setCurrentClimb`,
      // which is what re-arms the BLE auto-sender. Similar Climbs is the only
      // affordance in the anonymous view that could otherwise still drive a
      // wall, so it takes the preview path the wrong-board drawer already uses.
      //
      // A member in a crew takes the same path for a different reason: the member
      // branch below writes TWICE (append to the shared queue, then take the
      // wall), which is the loudest possible outcome for the idlest possible
      // intent. Browsing is what the tap means there.
      if (getSimilarClimbTapMode(viewer, { inSharedSession: browseByDefault }) === 'preview') {
        setDrawerPreviewItem(queueItem);
        setDrawerPreviewSuggestionSource(null);
        // Same as the swipe preview branches: a previewed climb is drawn on the
        // board but never reaches the queue, so report the view here (#2202).
        noteClimbViewed(queueItem.climb.uuid);
        // A different climb is on screen now, so it is not the lit one.
        setDrawerPreviewIsWallClimb(false);
        setIsMirrored(false);
        setIsTickBarActive(false);
        return;
      }
      // A similar climb can be set on another board, so this add may raise the
      // cross-board prompt. Wait for it: backing out has to leave the drawer on
      // the climb they were already looking at, not activate the one they just
      // declined to queue.
      if ((await addToQueue(queueItem)) === 'cancelled') return;
      // Tapping a similar climb activates it (commit), so it's never a preview —
      // clear any preview that was showing.
      setDrawerPreviewItem(null);
      setDrawerPreviewSuggestionSource(null);
      setIsMirrored(false);
      // The favorite override is cleared by the climb-change effect.
      setIsTickBarActive(false);
      setCurrentClimb(queueItem, { playlistSuggestionSource: null });
    },
    [addToQueue, setCurrentClimb, viewer, noteClimbViewed, browseByDefault],
  );

  // The first screen is sized so the action bar stays visible and the Logbook
  // header teases at the bottom across board sizes — the carousel fits
  // the leftover space (SwipeBoardCarousel contains the board). Reserve the
  // DeferredSections top padding, the logbook header, and a small margin so that
  // header peeks just above the fold. The home-indicator inset belongs to the
  // scroll view's paddingBottom only — counting it here too would shrink the
  // board by that inset twice.
  const firstScreenReserve =
    spacing[3] + (logbookHeaderHeight > 0 ? logbookHeaderHeight : DEFAULT_LOGBOOK_HEADER_HEIGHT) + spacing[2];
  // Size the first screen from the MEASURED viewport (the scroll container fills
  // the full window), falling back to windowHeight pre-layout. The reserve leaves
  // the Logbook header peeking below the fold.
  const firstScreenHeight = computeFirstScreenHeight(sheetViewportHeight || windowHeight, firstScreenReserve);
  // Named because the wall-state callout needs it too: it hangs off the header's
  // measured bottom edge, and that measurement is relative to the a11y-trap
  // wrapper INSIDE this padding, not to the first screen itself.
  const firstScreenPaddingTop = isPane && !paneTopInset ? spacing[2] : insets.top + spacing[2];

  // When the user expands the Logbook peek, glide it fully into view. Fires on the
  // section's layout (re-firing as a slow logbook fetch grows it) while armed.
  // The Logbook is the first below-fold section, so it starts right after the
  // fixed-height first screen, past the DeferredSections top padding.
  const handleLogbookSectionLayout = useCallback(
    (sectionHeight: number) => {
      if (!pendingLogbookScrollRef.current) return;
      const target = computeLogbookScrollTarget({
        firstScreenHeight,
        topPadding: spacing[3],
        sectionHeight,
        viewport: sheetViewportHeight || windowHeight,
        topInset: insets.top,
        bottomInset: insets.bottom,
        margin: spacing[2],
      });
      scrollRef.current?.scrollTo({ y: target, animated: true });
    },
    [firstScreenHeight, sheetViewportHeight, windowHeight, insets.bottom, insets.top],
  );

  const ascentCount = displayedClimb?.userAscents ?? 0;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);

  // Lazy-mount the sub-sheet hosts: each native ModalBottomSheet host is only
  // instantiated the first time its sheet opens, not on the drawer's mount
  // frame, then stays mounted so dismiss animations and re-opens behave as
  // before. Trims ~5 Android Compose host instantiations off the open.
  const climbActionsVisible = activeSubDrawer === 'actions';
  const angleSelectorVisible = activeSubDrawer === 'angleSelector';
  const mountClimbActions = useMountedOnFirstOpen(climbActionsVisible);
  const mountAddBetaVideo = useMountedOnFirstOpen(addBetaVideoOpen);
  const mountAngleSelector = useMountedOnFirstOpen(angleSelectorVisible);
  const mountLogAscent = useMountedOnFirstOpen(isTickBarActive);
  const mountBleControl = useMountedOnFirstOpen(bleControlVisible);
  const showPanePlaceholder = shouldShowPanePlaceholder(isPane, displayedClimb != null);

  return (
    // Transparent root — the play route paints the full-screen GlassSurface
    // behind this on its cheap first frame (so the native present can start
    // before this heavier content mounts). See app/play.tsx.
    <View style={styles.root}>
      {showPanePlaceholder ? (
        <PanePlaceholder
          title={t('playView.paneEmpty.title')}
          subtitle={t('playView.paneEmpty.subtitle')}
          paddingTop={(paneTopInset ? insets.top : 0) + spacing[8]}
          paddingBottom={insets.bottom}
        />
      ) : (
        <GestureDetector gesture={dismissGesture.enabled(!isPane)}>
          <Animated.View style={[styles.content, dismissAnimatedStyle]}>
            <ScrollView
              ref={scrollRef}
              nestedScrollEnabled
              // No top/bottom rubber-band: at the top, a downward drag is the
              // dismiss (the drawer translates) — a simultaneous scroll bounce would
              // fight it and read as double movement.
              bounces={false}
              overScrollMode="never"
              style={styles.content}
              contentContainerStyle={{ paddingBottom: insets.bottom }}
              onLayout={handleViewportLayout}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onScrollBeginDrag={handleScrollTowardBelowFold}
            >
              {displayedClimb && (
                <>
                  {/* The firstScreen container owns the top safe area, so the grabber +
                close + climb name sit at the very top. In the pane a docked WallStrip
                can already own the top inset (paneTopInset=false). */}
                  <View style={[styles.firstScreen, { height: firstScreenHeight, paddingTop: firstScreenPaddingTop }]}>
                    {/* Everything the wall-state callout covers. Wrapped so the
                        callout can trap assistive tech the way a modal does: iOS
                        gets `accessibilityViewIsModal` on the callout itself,
                        Android has no such thing, so TalkBack would otherwise
                        wander the drawer "behind" the open card. Only the TAPPED
                        explainer traps: the one-shot notice appeared on its own,
                        so it never takes the drawer away from a screen reader. */}
                    <View
                      style={styles.firstScreenContent}
                      accessibilityElementsHidden={wallCallout === 'explainer'}
                      importantForAccessibility={wallCallout === 'explainer' ? 'no-hide-descendants' : 'auto'}
                    >
                      <View style={styles.topRow}>
                        {/* The persistent pane has no dismiss, so it shows no grabber or
                          close chevron; the route keeps both. */}
                        {!isPane ? (
                          <>
                            <View style={sheetStyles.indicator} />
                            <Pressable
                              onPress={handleDismiss}
                              accessibilityRole="button"
                              accessibilityLabel={t('playView.closeAria')}
                              style={styles.closeButton}
                              hitSlop={8}
                            >
                              <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
                            </Pressable>
                          </>
                        ) : null}
                      </View>

                      {/* Title + grade swipe with the board: same translateX, same
                        tilt/fling; the next climb's header slides in edge-adjacent.
                        Wrapped only to measure where the header ends, which is what
                        the wall-state callout hangs from. */}
                      <View onLayout={handleHeaderLayout}>
                        <SwipeableHeader
                          swipeTranslateX={swipeTranslateX}
                          viewportWidth={windowWidth}
                          current={
                            <LivePlayDrawerHeader
                              climb={displayedClimb}
                              boardName={boardName as BoardName}
                              layoutId={layoutId}
                              angle={angle}
                              // What the WALL is doing rides the header's leading slot
                              // (left of the name, opposite the grade). It's absent
                              // entirely when there are no wall stakes, so the plain solo
                              // header keeps today's mirrored-flank centring.
                              leading={
                                wallPillState ? (
                                  <WallStatePill state={wallPillState} onPress={handleOpenWallCallout} />
                                ) : undefined
                              }
                              onLongPressName={handleCopyName}
                            />
                          }
                          peek={
                            headerPeekClimb ? (
                              <LivePlayDrawerHeader
                                climb={headerPeekClimb}
                                boardName={headerPeekBoard.boardName as BoardName}
                                layoutId={headerPeekBoard.layoutId}
                                angle={headerPeekBoard.angle}
                                // The incoming header reserves the same flank the
                                // current one spends on the pill, so the name and
                                // its attribute glyphs slide across at a fixed
                                // position instead of stepping mid-swipe. Invisible
                                // and a11y-hidden: it holds space, it claims nothing.
                                leading={
                                  wallPillState ? <WallStatePill state={wallPillState} reserveOnly /> : undefined
                                }
                              />
                            ) : null
                          }
                        />
                      </View>

                      <View style={styles.boardSection}>
                        {/* Viewfinder brackets while browsing: you're looking through a
                            lens, not driving the wall. Absolute + pointerEvents none, so
                            the board keeps every pixel and every gesture. */}
                        {showBrowseFrame ? <BrowseFrameOverlay /> : null}
                        {boardRenderData ? (
                          <DeferredBoard
                            open={isSheetOpen}
                            boardName={boardName as BoardName}
                            boardRenderData={boardRenderData}
                            layoutId={layoutId}
                            sizeId={sizeId}
                            setIds={setIds}
                            currentFrames={displayedClimb.frames}
                            currentFrameOverride={playback.isAnimatable ? playback.currentFrameString : null}
                            nextFrames={nextPeekFrames}
                            prevFrames={prevPeekFrames}
                            mirrored={isMirrored}
                            canSwipeNext={navigationState.canNext}
                            canSwipePrevious={navigationState.canPrevious}
                            onSwipeNext={handleNext}
                            onSwipePrevious={handlePrev}
                            onResetZoomReady={handleResetZoomReady}
                            enabled={!isTickBarActive}
                            scrollRef={scrollGestureRef}
                            swipeTranslateX={swipeTranslateX}
                            swipeIsAnimating={swipeIsAnimating}
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
                      </View>

                      {/* Controls region — gated by the switch-board overlay when the
                    displayed climb is on a board the user isn't currently on.
                    Board art + swipe above stay interactive for viewing. The
                    controls are wrapped so assistive tech can't reach them while
                    gated (on BOTH platforms — the scrim's accessibilityViewIsModal
                    is iOS-only); the overlay itself stays a sibling so its
                    "Switch board" action remains focusable. */}
                      <View style={styles.controlsRegion}>
                        <View
                          accessibilityElementsHidden={showBoardMismatch}
                          importantForAccessibility={showBoardMismatch ? 'no-hide-descendants' : 'auto'}
                        >
                          {playback.isAnimatable && (
                            <PlaybackControls
                              frameIndex={playback.frameIndex}
                              frameCount={playback.frameCount}
                              isPlaying={playback.isPlaying}
                              speed={playback.speed}
                              paceMs={playback.paceMs}
                              peerFrameMismatch={playback.peerFrameMismatch}
                              onPlay={playback.play}
                              onPause={playback.pause}
                              onSeek={playback.seek}
                              onSpeedChange={playback.setSpeed}
                            />
                          )}

                          <PlayDrawerActionBar
                            canSwipePrevious={navigationState.canPrevious}
                            canSwipeNext={navigationState.canNext}
                            isMirrored={isMirrored}
                            supportsMirroring={supportsMirroring}
                            isFavorited={isFavorited}
                            remainingQueueCount={navigationState.remainingCount}
                            lightbulbActive={lightbulbActive}
                            lightbulbConnected={bluetoothConnected}
                            lightbulbPending={lightbulbPending}
                            autoDisconnectWarning={bluetooth?.autoDisconnectWarning ?? false}
                            lightbulbLongPressEnabled={bluetoothConnected}
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
                            // The pill owns the driver's face whenever it renders the
                            // avatar; suppress the lightbulb pip so the same face never
                            // shows twice in the drawer.
                            showHolderBadge={shouldShowHolderBadge(wallPillState)}
                            // While the browse latch is up the second row carries the
                            // latch's own controls instead of the utilities — same 64pt
                            // row, no added height.
                            secondaryMode={commitBarModel.mode}
                            showBackToLive={commitBarModel.showBackToLive}
                            showPutOnWall={commitBarModel.showPutOnWall}
                            // Someone moved the wall mid-browse: the same two
                            // controls become Keep theirs / Put mine up, so the
                            // second tap on the filled button is the commit and
                            // the text button is still the way out.
                            showConfirm={commitBarModel.showConfirm}
                            wallClimbName={wallClimb.name}
                            commitLabel={commitBarModel.commitLabel}
                            onBackToLive={handleBackToLive}
                            onCommit={handleSetActive}
                            ascentCount={ascentCount}
                            onPrevClick={handlePrev}
                            onNextClick={handleNext}
                            onMirror={handleMirror}
                            onToggleFavorite={handleToggleFavorite}
                            onLightbulb={handleLightbulb}
                            onLightbulbLongPress={handleLightbulbLongPress}
                            onOpenActions={handleOpenActions}
                            onOpenQueue={onOpenQueue}
                            onShare={handleShare}
                            onTickPress={handleTickFabPress}
                            onTickLongPress={handleTickFabLongPress}
                            viewer={viewer}
                            onSignInPress={onSignIn}
                            currentAngle={activeAngle}
                            onOpenAngleSelector={isAngleAdjustable ? handleOpenAngleSelector : undefined}
                          />
                        </View>

                        {showBoardMismatch && onSwitchBoard ? (
                          <SwitchBoardOverlay boardLabel={switchBoardLabel ?? ''} onSwitchBoard={handleSwitchBoard} />
                        ) : null}
                      </View>
                    </View>

                    {/* The pill's explainer. A sibling of the a11y-trap wrapper (so
                        the trap can hide everything it covers) and of the swipeable
                        header (so it doesn't ride the swipe translate), overlaying
                        board art — zero layout cost, which is why it isn't a sheet.
                        `headerBottomY` is measured inside the wrapper, so the first
                        screen's own top padding is added back here. */}
                    {wallCallout !== 'none' && wallPillState ? (
                      <WallStateCallout
                        state={wallPillState}
                        presentation={wallCallout}
                        top={firstScreenPaddingTop + headerBottomY + spacing[1]}
                        // Offered whenever a preview is pinned, NOT only under the
                        // browse latch: on the wrong board the commit row stands down
                        // (its controls would be dead under the switch-board scrim),
                        // and this callout — in the header, outside that scrim — is
                        // then the only way back to the committed climb short of
                        // dismissing the drawer.
                        //
                        // "Browse from here" is still withheld. A crew already
                        // browses by default, so the action only means anything to a
                        // SOLO climber — and there it needs a latch that isn't keyed
                        // on the session. Offering it before that exists would
                        // promise a browse the very next swipe would commit.
                        onBackToLive={canReturnToCommittedClimb ? handleBackToLive : undefined}
                        onDismiss={handleCloseWallCallout}
                      />
                    ) : null}
                  </View>

                  {/* Below-fold deferred sections. The wrapper joins the
                      callout's assistive-tech trap: Android has no
                      accessibilityViewIsModal, so every ScrollView sibling of
                      the callout must hide itself while it's open or TalkBack
                      walks straight past the scrim into the logbook. Touches go
                      dead too — the Logbook header deliberately peeks below the
                      fixed-height first screen, outside the callout's scrim, and
                      a tap there must not scroll the logbook behind an open
                      modal. */}
                  <View
                    accessibilityElementsHidden={wallCallout === 'explainer'}
                    importantForAccessibility={wallCallout === 'explainer' ? 'no-hide-descendants' : 'auto'}
                    pointerEvents={wallCallout === 'explainer' ? 'none' : 'auto'}
                  >
                    <DeferredSections
                      climb={displayedClimb}
                      boardName={boardName}
                      layoutId={layoutId}
                      sizeId={sizeId}
                      setIds={setIds}
                      angle={angle}
                      enabled={isSheetOpen}
                      contentEnabled={belowFoldContentRequested}
                      onSimilarClimbPress={handleSimilarClimbPress}
                      onLogbookHeaderLayout={handleLogbookHeaderLayout}
                      onLogbookSectionLayout={handleLogbookSectionLayout}
                      onLogbookToggle={handleLogbookToggle}
                      onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
                    />
                  </View>
                </>
              )}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      )}

      {/* Sub-drawers: @expo/ui native .sheet()s presented from within the player
          route's view controller, so they stack ABOVE it. On iOS the ellipsis
          routes to ClimbReactionMenu via onOpenClimbActions, so activeSubDrawer
          never becomes 'actions' there. Mounted on first open, then kept. */}
      {mountClimbActions && (
        <ClimbActionsSheet
          visible={climbActionsVisible}
          climb={displayedClimb ?? null}
          boardName={boardName as BoardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
          onAddToQueue={() => {
            if (displayedClimb) {
              void addToQueue({
                uuid: randomUUID(),
                climb: displayedClimb,
              });
            }
          }}
          onToggleFavorite={handleToggleFavorite}
          onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
          dismissPlayerAndWait={dismissPlayerAndWait}
          onClose={handleCloseSubDrawer}
        />
      )}

      {/* Sub-drawer: Share your beta — opened from the action sheet's "Add beta
          video" row or the Beta Videos section "+" button. Mounted on first open. */}
      {mountAddBetaVideo && (
        <AddBetaVideoSheet
          visible={addBetaVideoOpen}
          climb={betaVideoTarget?.climb ?? displayedClimb ?? null}
          boardName={(betaVideoTarget?.boardConfig.boardName ?? boardName) as BoardName}
          layoutId={betaVideoTarget?.boardConfig.layoutId ?? layoutId}
          angle={betaVideoTarget?.boardConfig.angle ?? angle}
          onClose={handleCloseAddBetaVideo}
        />
      )}

      {/* Sub-drawer: Angle selector. Mounted on first open, then toggled via `visible`. */}
      {mountAngleSelector && (
        <AngleSelectorSheet
          visible={angleSelectorVisible}
          onClose={handleCloseSubDrawer}
          boardName={boardConfig.boardName}
          layoutId={boardConfig.layoutId}
          // Per-angle stats are read against the board above; a climb from
          // another board has none there, so ask for none.
          climbUuid={climbBoardMismatch ? undefined : displayedClimb?.uuid}
          currentAngle={activeAngle}
          onAngleChange={(newAngle) => {
            onAngleChange?.(newAngle);
            handleCloseSubDrawer();
          }}
        />
      )}

      {/* Tick sheet — a 60% sub-drawer so the climb image stays visible while
          logging. Presents over the player route. The displayedClimb guard stays;
          the host is mounted on first open. */}
      {mountLogAscent &&
        displayedClimb &&
        (() => {
          // The reaction-menu path pins its own climb/board snapshot; the FAB path
          // leaves tickTarget null and tracks the live displayedClimb + active board.
          const tickClimb = tickTarget?.climb ?? displayedClimb;
          return (
            <LogAscentSheet
              visible={isTickBarActive}
              onClose={handleTickBarDismiss}
              climbUuid={tickClimb.uuid}
              climbName={tickClimb.name}
              boardName={tickTarget?.boardConfig.boardName ?? boardName}
              angle={tickTarget?.boardConfig.angle ?? angle}
              isMirror={isMirrored}
              isBenchmark={tickClimb.benchmark_difficulty != null}
              baseAscensionistCount={tickClimb.ascensionist_count ?? 0}
              layoutId={tickTarget?.boardConfig.layoutId ?? layoutId}
              sizeId={tickTarget?.boardConfig.sizeId ?? sizeId}
              setIds={tickTarget?.boardConfig.setIds ?? setIds}
              sessionId={sessionId}
              // The tick picker opens on the Boardsesh grade (when the toggle is on and
              // a trusted one exists) instead of the Aurora consensus, so a logged grade
              // defaults to what the app now shows. Only the DEFAULT changes — the saved
              // tick value stays on the Aurora scale and null until the climber picks.
              consensusGradeName={resolveTickDefaultGradeName(tickClimb, boardseshActive) ?? tickClimb.difficulty}
            />
          );
        })()}

      {/* BLE controls (Re-light / Turn off all lights / Disconnect), opened by the
          lightbulb long-press. Hosted here so it presents ABOVE the player route
          (the app-root instance would land behind it). Mounted on first open. */}
      {mountBleControl && <BleControlSheetHost visible={bleControlVisible} onClose={handleCloseBleControl} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  firstScreen: {
    width: '100%',
  },
  // Takes the whole first screen so the board section inside keeps its flex:1
  // share; exists only to give the wall-state callout a sibling it can hide from
  // assistive tech while it's open.
  firstScreenContent: {
    flex: 1,
  },
  // Centers the grabber; the close button overlays the left edge.
  topRow: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 0,
    left: spacing[2],
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(120, 120, 128, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
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
});
