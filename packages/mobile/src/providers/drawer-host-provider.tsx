/**
 * DrawerHostProvider mounts PlayDrawer and LogAscentSheet once at the app root
 * and exposes imperative openers via `useDrawerHost()`. This lets the
 * persistent queue control bar (and any screen) open them without each tab
 * having to instantiate its own copy.
 *
 * Default board comes from `useActiveBoard()` (the user's stored pick); callers
 * can override via the second arg to `openPlayDrawer` if needed (e.g. opening a
 * climb from a different board context). The stored active boardConfig is
 * exposed through the context so consumers (like the persistent bar's
 * log-ascent button) don't have to resolve the active board independently.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { router, useSegments } from 'expo-router';
import { tabsActiveSegment } from '../lib/route-segments';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { buildBoardPath, formatBoardDisplayName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { PlayDrawerOpenOptions, PlayDrawerOpenTarget } from '../components/play-drawer';
import { LogAscentSheet } from '../components/LogAscentSheet';
import { QueueSheet, type QueueSheetHandle } from '../components/play-drawer/QueueSheet';
import { useQueueSheetHandlers } from '../components/play-drawer/use-queue-sheet-handlers';
import { QueueAddedSnackbar } from '../components/QueueAddedSnackbar';
import { UndoWallChangeSnackbar } from '../components/board-presence/UndoWallChangeSnackbar';
import { BoardSheet, type BoardSheetClimbAction, type BoardSheetHandle } from '../components/board-presence/BoardSheet';
import type { QueueItemRowBoard } from '../components/QueueItemRow';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../lib/boards/active-board-label';
import { track } from '../lib/analytics';
import { ClimbReactionMenu } from '../components/climb-actions/ClimbReactionMenu';
import { AddBetaVideoSheet } from '../components/AddBetaVideoSheet';
import { AddToPlaylistSheet } from '../components/AddToPlaylistSheet';
import { useProfile, useMyBoards } from '../lib/graphql/hooks';
import { boardLooselyMatches } from '../lib/boards/board-matches';
import { useAuth } from './auth-provider';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { useActiveClimbUuid, useQueueActions, useQueueSessionControls } from './queue-provider';
import { useDeviceLayout } from '../hooks/use-device-layout';
import { resolveDetailPaneSurface } from '../theme/size-class';
import { SIDEBAR_WIDTH } from '../theme/layout';
import { useQueueSnackbar } from './queue-snackbar-provider';
import { useBoardPresenceControls, type ResolveBoardUuidArgs } from './board-presence-provider';
import { useOptionalBluetoothContext } from './bluetooth-provider';
import { dismissManagedSheetAndWait, type DismissAndWaitResult } from './sheet-presentation-provider';

export type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type OpenClimbActionsOptions = {
  /** When set, the climb actions sheet shows an "Edit entry" row wired to this
   *  callback (logbook rows pass it to open the tick editor). */
  onEditEntry?: () => void;
  /** When set, the "Add beta video" action runs this instead of opening the root
   *  beta sheet. The play drawer passes its own in-tree opener so the sheet stacks
   *  above the `/play` fullScreenModal (a root-tree sheet can't — see #3505). It
   *  receives the climb/board snapshot the menu was opened for. */
  onAddBetaVideo?: (climb: Climb, boardConfig: BoardConfig) => void;
  /** When set, the "Tick" action runs this instead of opening the root LogAscent
   *  sheet. The play drawer passes its own in-tree opener so the tick sheet stacks
   *  above the `/play` transparentModal — the root sheet mounts BEHIND it, and
   *  presenting it forces UIKit to dismiss `/play`, dragging the tick sheet down
   *  with it (the "tick sheet closes immediately" bug). Same fix shape as
   *  `onAddBetaVideo` (#3505). Receives the climb/board snapshot the menu opened for. */
  onTick?: (climb: Climb, boardConfig: BoardConfig) => void;
  /** Awaitable close for a native BoardSheet / QueueSheet underneath the custom
   * actions overlay. Omitted when the source is an inline iPad pane. */
  dismissSourceSheet?: () => Promise<DismissAndWaitResult>;
  /** `/play`-owned native-stack close waiter. Threaded from the route because a
   * root overlay cannot safely subscribe to the player's transition events. */
  dismissPlayerAndWait?: () => Promise<DismissAndWaitResult>;
};

export type LogAscentInput = {
  climbUuid: string;
  /** Shown in the tick sheet header so the climber sees what they are logging —
   *  the queue-bar entry point can open this on a climb they are no longer
   *  looking at. */
  climbName?: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  /** Immutable community send count from the climb snapshot at open time. */
  baseAscensionistCount: number;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  // Climb's consensus grade name (just `Climb.difficulty`). Forwarded to
  // GradeSingleSelectRail so the consensus chip is centered and outlined
  // without being preselected. Optional — callers that don't have a
  // freshly fetched climb can omit it.
  consensusGradeName?: string;
};

export function boardConfigsMatch(left: BoardConfig | null, right: BoardConfig | null): boolean {
  if (!left || !right) return false;
  return (
    left.boardName === right.boardName &&
    left.layoutId === right.layoutId &&
    left.sizeId === right.sizeId &&
    left.setIds === right.setIds &&
    left.angle === right.angle
  );
}

export type OpenPlayDrawerOptions = PlayDrawerOpenOptions & {
  /** Switch the drawer to a different board config before opening (e.g. the
   *  caller is opening a climb that belongs to a board other than the user's
   *  default). The override is applied via state, so the actual open happens
   *  after the new boardConfig has propagated to PlayDrawer's props. */
  boardConfig?: BoardConfig;
};

/** Props the iPad right-column PlayDrawer pane consumes (regular width). Mirrors
 *  the `/play` route's PlayDrawer props (see app/play.tsx) so the pane and the
 *  full-screen route render the same drawer; the pane just drives it via
 *  `openTarget` instead of navigating. Null in the context while no board is
 *  resolved. Consumed by `IpadPlayPane`. */
export type PlayDrawerPaneProps = {
  boardConfig: BoardConfig;
  onAngleChange: (angle: number) => void;
  isAngleAdjustable: boolean;
  onOpenQueue: () => void;
  boardMismatch: boolean;
  mismatchBoardLabel: string | undefined;
  onSwitchBoard: (climbBoardConfig?: BoardConfig) => void;
  onOpenClimbActions: (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => void;
  /** The climb to show in the pane, with a bumped nonce per selection so the pane
   *  re-applies even when the same climb is re-tapped. Set by `openPlayDrawer` on
   *  iPad regular width (where it drives the pane instead of the `/play` route). */
  openTarget: PlayDrawerOpenTarget | null;
};

/** Props for the iPad "Now on the wall" column (regular landscape) — the same
 *  wall feed / history / stats / switch-board content the BoardSheet modal shows,
 *  rendered inline. Mirrors the BoardSheet props passed below; null while no board
 *  is resolved. Consumed by `IpadWallColumn`. */
export type NowOnTheWallColumnProps = {
  boardLabel: string | null;
  boardConfig: BoardConfig | null;
  onSwitchBoard: () => void;
  onClimbPress: (action: BoardSheetClimbAction) => void;
  onAddToQueue: (action: BoardSheetClimbAction) => void;
  onOpenPlaylist: (action: BoardSheetClimbAction) => void;
  onOpenActions: (action: BoardSheetClimbAction) => void;
};

type DrawerHostValue = {
  /** User's stored active board config. Temporary PlayDrawer overrides are not
   *  reflected here, so persistent queue/log-ascent surfaces stay bound to the
   *  selected board. Null while the stored board is still loading. */
  boardConfig: BoardConfig | null;
  openPlayDrawer: (climb: Climb, options?: OpenPlayDrawerOptions) => void;
  openLogAscent: (input: LogAscentInput) => void;
  /** Opens the climb actions bottom sheet for the given climb. Uses the active
   *  boardConfig at the time of opening. Pass `onEditEntry` (logbook context) to
   *  add an "Edit entry" row that edits the tick the climb was opened from. */
  openClimbActions: (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => void;
  closeClimbActions: () => void;
  /** Opens the add-to-playlist bottom sheet for the given climb. Snapshots the
   *  active boardConfig (for the angle) at open time. */
  openAddToPlaylist: (climb: Climb, boardConfigOverride?: BoardConfig) => void;
  /** Opens the share-your-beta sheet for the given climb. Snapshots the active
   *  boardConfig (for the angle) at open time. Used by the iOS climb context menu's
   *  shared action list (useClimbActions). */
  openAddBetaVideo: (climb: Climb, boardConfigOverride?: BoardConfig) => void;
  /** Opens the queue list sheet (from the play-drawer queue button or the
   *  "Climb added to queue" snackbar's Open action). */
  openQueueSheet: () => void;
  /** Opens the board sheet ("now on the wall" — wall feed, history, stats, and a
   *  separate Switch-board control). Wired to the board glyph when the
   *  `board-presence` flag is on. */
  openBoardSheet: () => void;
  /** Props for the iPad right-column PlayDrawer pane (regular width); null while
   *  no board is resolved. Consumed by `IpadPlayPane` in the shell. On iPad regular
   *  width `openPlayDrawer` drives this pane instead of the `/play` route. */
  playDrawerPaneProps: PlayDrawerPaneProps | null;
  /** Props for the iPad "Now on the wall" column (regular landscape); null while
   *  no board is resolved. Consumed by `IpadWallColumn` in the shell. */
  boardPanelProps: NowOnTheWallColumnProps | null;
  /** True when `openPlayDrawer` lands in the iPad shell's persistent right-column
   *  pane (regular-width master-detail) rather than the `/play` route / bottom
   *  sheet — a selection fills the pane beside the list instead of covering it. */
  usesDetailPane: boolean;
};

const DrawerHostContext = createContext<DrawerHostValue | null>(null);

/**
 * Data-backed sheet state that survives the dismiss animation. `open(value)`
 * shows it; `close()` requests the animated close (flips `visible` false) but
 * keeps the data mounted; `clearIfClosed()` (wired to the sheet's onFullyDismissed)
 * drops the data only once the animation has settled and the sheet wasn't
 * re-opened — so the native Host never unmounts mid-animation (an iOS freeze
 * vector) and the content doesn't blank out while sliding away.
 */
function useDeferredSheetData<T>(): {
  data: T | null;
  visible: boolean;
  open: (value: T) => void;
  close: () => void;
  clearIfClosed: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const open = useCallback((value: T) => {
    setData(value);
    setVisible(true);
  }, []);
  const close = useCallback(() => setVisible(false), []);
  const clearIfClosed = useCallback(() => {
    if (!visibleRef.current) setData(null);
  }, []);
  return { data, visible, open, close, clearIfClosed };
}

export function useDrawerHost(): DrawerHostValue {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error('useDrawerHost must be used within DrawerHostProvider');
  return context;
}

/**
 * The volatile player state the `app/play.tsx` route reads to render PlayDrawer:
 * the override-inclusive board, the mismatch gate, the angle/switch handlers, and
 * the open target (which changes on every open). Split out of DrawerHostContext
 * so the wide `useDrawerHost()` consumers (persistent bar, capsules, screens)
 * don't re-render every time the player opens — only the route, which is the sole
 * consumer of this context, does.
 */
type PlayDrawerRouteValue = {
  /** The drawer board, INCLUDING a temporary override (foreign-board climb). Null
   *  while the stored board is still loading. */
  activeBoardConfig: BoardConfig | null;
  isAngleAdjustable: boolean;
  boardMismatch: boolean;
  mismatchBoardLabel?: string;
  onAngleChange: (angle: number) => void;
  onSwitchBoard: (climbBoardConfig?: BoardConfig) => void;
  /** Run from the route's unmount cleanup: clears the board override + open
   *  target so the next open starts clean. */
  onPlayDrawerClosed: () => void;
  /** Report that the route has applied this target, so the close above knows
   *  which one it is allowed to clear. */
  onPlayDrawerTargetConsumed: (nonce: number) => void;
  /** The climb to show, with a bumped nonce per open so the route re-applies even
   *  when `router.navigate('/play')` is a no-op (re-tap while already open). */
  playTarget: PlayDrawerOpenTarget | null;
};

const PlayDrawerRouteContext = createContext<PlayDrawerRouteValue | null>(null);

/**
 * The climb a list should show as selected when it is NOT the queue's current
 * climb — i.e. the drawer was opened as a view-only preview and never wrote the
 * queue.
 *
 * Lists highlight their active row off `useActiveClimbUuid()`, which by
 * construction only moves when the queue does. That was fine while every row tap
 * committed; once a tap could open a preview instead, the highlight could never
 * follow the tap, and a climber tapping down a filtered list got no feedback that
 * anything had been selected at all.
 *
 * Its own context, memoized on the uuid, for the same reason
 * `PlayDrawerRouteContext` is separate: the consumers are virtualized lists, and
 * the wide `useDrawerHost()` value changes on every open.
 */
type PreviewedClimbValue = { previewedClimbUuid: string | null };

const PreviewedClimbContext = createContext<PreviewedClimbValue>({ previewedClimbUuid: null });

/**
 * The previewed climb's uuid, or null when the queue's current climb is the
 * honest answer. Resolve a row's selected state as
 * `previewedClimbUuid ?? activeClimbUuid`.
 */
export function usePreviewedClimbUuid(): string | null {
  return useContext(PreviewedClimbContext).previewedClimbUuid;
}

export function usePlayDrawerRoute(): PlayDrawerRouteValue {
  const context = useContext(PlayDrawerRouteContext);
  if (!context) throw new Error('usePlayDrawerRoute must be used within DrawerHostProvider');
  return context;
}

export function DrawerHostProvider({ children }: { children: ReactNode }) {
  // The climb to show in the player route, with a per-open nonce so a re-tap
  // while `/play` is already up still re-applies (navigate is a no-op then). The
  // route consumes this via usePlayDrawerRoute and runs PlayDrawer's openDrawer.
  const [playTarget, setPlayTarget] = useState<PlayDrawerOpenTarget | null>(null);
  const playTargetNonceRef = useRef(0);
  // See PreviewedClimbContext. Set when an open is preview-shaped (the caller
  // pinned a queue item the queue never receives), cleared when an open commits —
  // from then on `activeClimbUuid` is accurate and tracks onward swipes too.
  //
  // Deliberately NOT cleared when the drawer closes. On a phone the player is a
  // modal route, so the list is not on screen while it is open — clearing on
  // dismiss would mean the highlight only ever existed where nobody could see it,
  // which is the bug this is here to fix. It reads as "the climb you last had
  // up", and outliving the drawer is what makes that sentence useful.
  const [previewedClimbUuid, setPreviewedClimbUuid] = useState<string | null>(null);
  // ...but it IS cleared when the queue's committed climb moves on. A preview
  // outlives the drawer as "the climb you last had up" only until something is
  // actually put up after it: an explicit Preview of A followed by a swipe that
  // commits B (solo, `lightOnSwipe` on) must highlight B, not keep pointing at
  // A until the next list tap. Keys on the head CHANGING after mount — a
  // re-render with the same head leaves the highlight alone — and a first
  // commit from an empty queue counts as a change, since "tap a row, then swipe
  // to commit" is the common shape and the head arriving under a pre-hydration
  // preview is not.
  const activeClimbUuid = useActiveClimbUuid();
  const previousActiveClimbUuidRef = useRef(activeClimbUuid);
  useEffect(() => {
    if (previousActiveClimbUuidRef.current === activeClimbUuid) return;
    previousActiveClimbUuidRef.current = activeClimbUuid;
    setPreviewedClimbUuid(null);
  }, [activeClimbUuid]);
  // The nonce of the last target the player route actually applied. See
  // `onPlayDrawerClosed` for why "consumed" and not "latest" is the right test.
  const consumedPlayTargetNonceRef = useRef(0);
  const onPlayDrawerTargetConsumed = useCallback((nonce: number) => {
    consumedPlayTargetNonceRef.current = nonce;
  }, []);
  // iPad regular width shows the PlayDrawer inline in the right-column pane
  // (IpadPlayPane) instead of the full-screen `/play` route. `paneTarget` is the
  // pane's equivalent of `playTarget`: the selected climb with a per-selection
  // nonce so re-tapping the same climb still re-applies it in the pane.
  const [paneTarget, setPaneTarget] = useState<PlayDrawerOpenTarget | null>(null);
  const paneTargetNonceRef = useRef(0);
  // QueueSheet stays mounted (whenever a board is resolved) and is opened via its
  // imperative handle. gorhom `present()` driven from a `visible`-prop effect is
  // a silent no-op in this app, so we present/dismiss synchronously from the
  // handler — the same pattern PlayDrawer uses.
  const queueSheetRef = useRef<QueueSheetHandle>(null);
  const boardSheetRef = useRef<BoardSheetHandle>(null);
  const { data: activeBoard } = useActiveBoard();
  // iPad regular width hosts the PlayDrawer as a persistent right-column pane
  // rather than the `/play` route. `usesDetailPane` mirrors the shell's pane
  // budget (resolveDetailPaneSurface — the tightest regular portraits fall back
  // to the route + compact sheets). A ref lets the empty-dep `openPlayDrawer`
  // read it without churning its identity.
  const { width: windowWidth } = useWindowDimensions();
  const { widthClass } = useDeviceLayout();
  // The "On the Wall" kiosk tab hides the shell's detail pane (it IS the wall
  // surface and needs the full content pane), so a climb open there must fall back
  // to the `/play` route instead of a paneTarget that lands in an unmounted pane.
  // Folding it into `usesDetailPane` also makes the effect below clear a stale
  // paneTarget when the wall tab becomes focused.
  const onWallTab = tabsActiveSegment(useSegments()) === 'wall';
  const usesDetailPane =
    resolveDetailPaneSurface({ width: windowWidth, widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane' && !onWallTab;
  const usesDetailPaneRef = useRef(usesDetailPane);
  usesDetailPaneRef.current = usesDetailPane;
  // Auth gates two things here. (1) myBoards requires authentication: running it
  // while logged out throws "Authentication required to perform this operation"
  // (pure noise in error tracking) and returns nothing useful — every other call
  // site gates the same way. (2) "Add beta video" keys off auth state, not
  // profile?.id, which can lag behind a fresh sign-in (profile query still
  // resolving) and would show the action in the play drawer but not here.
  // PlayDrawer uses the same predicate.
  const { isAuthenticated } = useAuth();
  const { data: myBoardsConn } = useMyBoards(undefined, { enabled: isAuthenticated });
  const [boardConfigOverride, setBoardConfigOverride] = useState<BoardConfig | null>(null);
  // These sheets stay mounted through their dismiss animation (see
  // useDeferredSheetData) so the native Host never tears down mid-animation. The
  // open/close/clear callbacks are stable; only data/visible change, and those
  // are read in render (not in the context value), so consumers don't churn.
  const {
    data: logAscentData,
    visible: logAscentVisible,
    open: openLogAscentSheet,
    close: closeLogAscentSheet,
    clearIfClosed: clearLogAscentSheet,
  } = useDeferredSheetData<LogAscentInput>();
  const {
    data: playlistData,
    visible: playlistVisible,
    open: openPlaylistSheet,
    close: closePlaylistSheet,
    clearIfClosed: clearPlaylistSheet,
  } = useDeferredSheetData<{ climb: Climb; boardConfig: BoardConfig }>();
  const {
    data: betaVideoData,
    visible: betaVideoVisible,
    open: openBetaVideoSheet,
    close: closeBetaVideoSheet,
    clearIfClosed: clearBetaVideoSheet,
  } = useDeferredSheetData<{ climb: Climb; boardConfig: BoardConfig }>();
  const [climbActions, setClimbActions] = useState<{
    climb: Climb;
    boardConfig: BoardConfig;
    onEditEntry?: () => void;
    onAddBetaVideo?: (climb: Climb, boardConfig: BoardConfig) => void;
    onTick?: (climb: Climb, boardConfig: BoardConfig) => void;
    dismissSourceSheet?: () => Promise<DismissAndWaitResult>;
    dismissPlayerAndWait?: () => Promise<DismissAndWaitResult>;
  } | null>(null);
  const { addToQueue, setSessionBoardPath, setCurrentClimb } = useQueueActions();
  const { sessionId } = useQueueSessionControls();
  const setActiveBoard = useSetActiveBoard();
  const {
    visible: snackbarVisible,
    nonce: snackbarNonce,
    dismissSnackbar,
    undoWallChangeVisible,
    undoWallChangeNonce,
    dismissUndoWallChangeSnackbar,
  } = useQueueSnackbar();
  const bluetooth = useOptionalBluetoothContext();
  const {
    enabled: boardPresenceEnabled,
    boardId: boardPresenceBoardId,
    resolveAndBindBoardByUuid,
    resetPresence,
  } = useBoardPresenceControls();
  const boardPresenceBoardIdRef = useRef(boardPresenceBoardId);
  boardPresenceBoardIdRef.current = boardPresenceBoardId;
  const { data: profile } = useProfile();
  // Read at the app root (resolved by interaction time) and passed to the reaction
  // menu so its mount-time enter animation uses the real value, not the hook's
  // conservative `true` default.
  const reduceMotion = useReduceMotion();

  // The user's STORED active board as a BoardConfig (never the override). Used
  // by non-drawer surfaces and to decide whether a climb opened with a board
  // override is genuinely a different board (→ switch-board gate) or the same
  // board (→ drop the override and render against the user's precise board).
  const storedActiveBoardConfig = useMemo<BoardConfig | null>(() => {
    if (!activeBoard) return null;
    return {
      boardName: activeBoard.boardType,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      angle: activeBoard.angle,
    };
  }, [activeBoard]);

  const activeBoardConfig: BoardConfig | null = useMemo(
    () => boardConfigOverride ?? storedActiveBoardConfig,
    [boardConfigOverride, storedActiveBoardConfig],
  );

  const selectedBoardPresenceBoard = useMemo<ResolveBoardUuidArgs | null>(() => {
    if (!activeBoard) return null;
    return { boardUuid: activeBoard.uuid };
  }, [activeBoard?.uuid]);

  useEffect(() => {
    if (!boardPresenceEnabled) return;
    if (!selectedBoardPresenceBoard) {
      resetPresence();
      return;
    }
    void resolveAndBindBoardByUuid(selectedBoardPresenceBoard);
  }, [boardPresenceEnabled, selectedBoardPresenceBoard, resolveAndBindBoardByUuid, resetPresence]);

  // Keep refs so otherwise empty-dep open callbacks can snapshot the relevant
  // board config without churning their identity. `activeBoardConfigRef` is the
  // drawer board (including a temporary override); `storedActiveBoardConfigRef`
  // is the user's selected board and is what non-drawer surfaces use.
  const activeBoardConfigRef = useRef(activeBoardConfig);
  activeBoardConfigRef.current = activeBoardConfig;
  const storedActiveBoardConfigRef = useRef(storedActiveBoardConfig);
  storedActiveBoardConfigRef.current = storedActiveBoardConfig;
  const boardConfigOverrideRef = useRef(boardConfigOverride);
  boardConfigOverrideRef.current = boardConfigOverride;
  const myBoardsRef = useRef(myBoardsConn);
  myBoardsRef.current = myBoardsConn;

  const openPlayDrawer = useCallback((climb: Climb, options?: OpenPlayDrawerOptions) => {
    // Pull `boardConfig` out so it doesn't reach the open target.
    const { boardConfig: override, ...openOptions } = options ?? {};
    // Set the board override BEFORE navigating so the route reads the right board
    // from `activeBoardConfig` (reactive) on mount — no requestAnimationFrame /
    // pending-replay dance. Only set an override that genuinely differs from the
    // stored board; otherwise drop it so the drawer renders against the user's
    // precise board (and clears any leftover override from a prior open).
    if (override && !boardConfigsMatch(override, storedActiveBoardConfigRef.current)) {
      setBoardConfigOverride(override);
    } else {
      setBoardConfigOverride(null);
    }
    setPreviewedClimbUuid(openOptions.previewQueueItem ? climb.uuid : null);
    // iPad regular width hosts the drawer as a persistent right-column pane, so
    // drive it in place instead of navigating to `/play`. The pane reads
    // `paneTarget` via playDrawerPaneProps and re-applies on the bumped nonce (a
    // re-tap of the same climb still re-applies). No router.navigate → no modal.
    if (usesDetailPaneRef.current) {
      paneTargetNonceRef.current += 1;
      setPaneTarget({ climb, options: openOptions, nonce: paneTargetNonceRef.current });
      return;
    }
    // Stash the target (bumped nonce) and navigate. When `/play` is already up the
    // navigate is a no-op, but the new nonce re-applies the target in place.
    playTargetNonceRef.current += 1;
    setPlayTarget({ climb, options: openOptions, nonce: playTargetNonceRef.current });
    router.navigate('/play');
  }, []);

  // Drop the pane's selected climb when the pane goes away (a resize into compact,
  // or a narrow-regular split where the /play route takes over), so a later return
  // to the pane starts from the current climb rather than a stale selection.
  useEffect(() => {
    if (!usesDetailPane) setPaneTarget(null);
  }, [usesDetailPane]);

  // Reset on route unmount (close): drop the board override so non-drawer surfaces
  // snap back to the stored board, and clear the open target so a stray remount
  // can't replay a stale climb.
  const onPlayDrawerClosed = useCallback(() => {
    // A target written since the last one the route applied belongs to a tap the
    // route has not served yet (see below). Its board override was set in the
    // same `openPlayDrawer` call and the next mount reads the board from
    // `activeBoardConfig`, so the override has to survive with it — cleared here,
    // a dismiss-window tap on a climb from another board would replay against
    // the stored board with no way back to the one it was tapped on.
    const targetPending = playTargetNonceRef.current !== consumedPlayTargetNonceRef.current;
    if (!targetPending) setBoardConfigOverride(null);
    // Only drop the target this close was actually for. The reset runs from the
    // route's UNMOUNT cleanup — the end of the dismiss animation — and the list
    // underneath is live and tappable for that whole window (and for the pull-down
    // that precedes it). A tap landing there sets a fresh target and finds
    // `router.navigate('/play')` a no-op because the route is still in the stack,
    // so an unguarded reset then nulls the target that tap just wrote and the
    // drawer comes back on the previous climb. It reads as a dead tap.
    //
    // So the reset clears only a target the route actually CONSUMED. One that was
    // written but never applied belongs to a tap that has not been served yet —
    // replaying it on the next mount is the whole point, not a stale-climb bug.
    // Previously the race was survivable by accident: every opener also wrote the
    // queue, so the drawer still landed on the tapped climb even when the target
    // was lost. Preview-shaped opens do not write the queue, which is what turned
    // a latent race into a reproducible dead tap.
    setPlayTarget((current) => (current && current.nonce === consumedPlayTargetNonceRef.current ? null : current));
  }, []);

  // Apply an angle change made from the play drawer's angle selector.
  const handleAngleChange = useCallback(
    (newAngle: number) => {
      const cfg = activeBoardConfigRef.current;
      if (boardConfigOverride) {
        // Guard against the override's current angle, not the base board's.
        if (newAngle === boardConfigOverride.angle) return;
        // The drawer is showing a climb from a board other than the user's
        // stored active board. Update only the override (so the drawer reflects
        // the change) — do NOT rewrite the stored active board's angle, which
        // belongs to a different board. Tick/feed climbs opened via
        // openClimbInPlayDrawer routinely set an override, so this is the live
        // path for them; keep the angle write targeting the board actually shown.
        setBoardConfigOverride((prev) => (prev ? { ...prev, angle: newAngle } : prev));
      } else {
        if (cfg && newAngle === cfg.angle) return;
        // Fixed-angle boards can't be adjusted — do nothing (the pill is also
        // hidden for them, this is the safety net).
        if (activeBoard?.isAngleAdjustable === false) return;
        // Persist to the active board (the angle source of truth). Writing the
        // ['activeBoard'] cache re-grades the climb list (its search key includes
        // the angle) and triggers the queue re-grade effect in QueueProvider.
        if (activeBoard && newAngle !== activeBoard.angle) {
          void setActiveBoard({ ...activeBoard, angle: newAngle });
        }
      }

      track(SHARED_EVENTS.AngleChanged, {
        angle: newAngle,
        boardName: cfg?.boardName,
        layoutId: cfg?.layoutId,
        sizeId: cfg?.sizeId,
        setIds: cfg?.setIds,
        source: 'mobile_play_drawer',
        partyMode: sessionId !== null,
      });

      // Broadcast to party members (no-op in solo). Build the path from the
      // board the drawer is actually showing, with the new angle.
      if (cfg) {
        void setSessionBoardPath(buildBoardPath(cfg.boardName, cfg.layoutId, cfg.sizeId, cfg.setIds, newAngle));
      }
    },
    [activeBoard, boardConfigOverride, sessionId, setActiveBoard, setSessionBoardPath],
  );

  const openLogAscent = openLogAscentSheet;

  // Snapshot the board config at open time so the sheet's per-row handlers
  // (queue / favorite / tick) keep operating on the same angle even if the
  // user switches their active board mid-interaction.
  const openClimbActions = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => {
      const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
      if (!boardConfig) return;
      setClimbActions({
        climb,
        boardConfig,
        onEditEntry: options?.onEditEntry,
        onAddBetaVideo: options?.onAddBetaVideo,
        onTick: options?.onTick,
        dismissSourceSheet: options?.dismissSourceSheet,
        dismissPlayerAndWait: options?.dismissPlayerAndWait,
      });
    },
    [],
  );

  const closeClimbActions = useCallback(() => {
    setClimbActions(null);
  }, []);

  const openAddToPlaylist = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig) => {
      const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
      if (!boardConfig) return;
      openPlaylistSheet({ climb, boardConfig });
    },
    [openPlaylistSheet],
  );

  const closeAddToPlaylist = closePlaylistSheet;

  // Single parameterized beta-video opener (mirrors openAddToPlaylist), used both by
  // the reaction menu's shared action list (useClimbActions) and by PlayDrawer.
  // Falls back to the stored active board, not the override-inclusive one, so a
  // temporary drawer board override can't leak into the beta-video surface.
  const openAddBetaVideo = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig) => {
      const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
      if (!boardConfig) return;
      openBetaVideoSheet({ climb, boardConfig });
    },
    [openBetaVideoSheet],
  );

  const closeAddBetaVideo = closeBetaVideoSheet;

  // Present the always-mounted queue sheet imperatively. Calling `present()`
  // synchronously from the handler (rather than from a `visible`-prop effect)
  // is what actually shows the sheet — see QueueSheetHandle for the gorhom
  // no-op this avoids.
  const openQueueSheet = useCallback(() => {
    queueSheetRef.current?.present();
  }, []);
  // Request an animated close. The sheet's dismiss animation plays and it stays
  // mounted, ready to be re-presented on the next open.
  const requestCloseQueueSheet = useCallback(() => {
    queueSheetRef.current?.dismiss();
  }, []);
  const dismissQueueSheetAndWait = useCallback((): Promise<DismissAndWaitResult> => {
    return dismissManagedSheetAndWait(queueSheetRef.current);
  }, []);

  // Board sheet: present imperatively via the ref, exactly like the queue sheet
  // and Play Drawer. gorhom's present() from a `visible`-prop effect is a silent
  // no-op in this build.
  const openBoardSheet = useCallback(() => {
    track(SHARED_EVENTS.BoardSheetOpened, {
      boardId: boardPresenceBoardIdRef.current ?? undefined,
      source: 'board_pill',
    });
    boardSheetRef.current?.present();
  }, []);
  const requestCloseBoardSheet = useCallback(() => boardSheetRef.current?.dismiss(), []);
  const dismissBoardSheetAndWait = useCallback((): Promise<DismissAndWaitResult> => {
    return dismissManagedSheetAndWait(boardSheetRef.current);
  }, []);
  // Snackbar "Open": dismiss the snackbar, then open the queue sheet.
  const handleSnackbarOpen = useCallback(() => {
    dismissSnackbar();
    openQueueSheet();
  }, [dismissSnackbar, openQueueSheet]);

  // The queue sheet renders climbs against the active board (thumbnails + tick).
  const queueBoard = useMemo<QueueItemRowBoard | null>(() => {
    if (!storedActiveBoardConfig) return null;
    return {
      boardName: storedActiveBoardConfig.boardName as BoardName,
      layoutId: storedActiveBoardConfig.layoutId,
      sizeId: storedActiveBoardConfig.sizeId,
      setIds: storedActiveBoardConfig.setIds,
      angle: storedActiveBoardConfig.angle,
    };
  }, [storedActiveBoardConfig]);

  // The four QueueSheet row handlers, shared with the play-route's QueueSheet
  // instance via useQueueSheetHandlers so the two can't drift. This host instance
  // dismisses its own sheet (requestCloseQueueSheet).
  const {
    handleClimbPress: handleQueueClimbPress,
    handleOpenActions: handleQueueOpenActions,
    handleSuggestionPress: handleQueueSuggestionPress,
    handleTickHistory: handleQueueTickHistory,
  } = useQueueSheetHandlers({
    setCurrentClimb,
    openPlayDrawer,
    openClimbActions,
    openLogAscent,
    storedBoardConfig: storedActiveBoardConfig,
    sessionId,
    requestCloseQueueSheet,
    dismissQueueSheetAndWait,
  });

  // Switch-board control inside the board sheet: dismiss the sheet, then open
  // the existing board switcher (today's board-glyph destination).
  const handleSwitchBoardFromSheet = useCallback(() => {
    track(SHARED_EVENTS.BoardSwapInvokedFromSheet, { boardId: boardPresenceBoardIdRef.current ?? undefined });
    requestCloseBoardSheet();
    router.push('/boards');
  }, [requestCloseBoardSheet]);

  // Switch-board control inside the play drawer's mismatch overlay. One-tap when
  // the user already owns the climb's board (set it active and clear the override
  // so the drawer shows the now-active board and the overlay clears); otherwise
  // route to the board picker, mirroring the playlist mismatch banner.
  const handleSwitchBoardFromDrawer = useCallback(
    (climbBoardConfig?: BoardConfig) => {
      // The board the drawer resolved for the climb it is SHOWING wins; the
      // opener's override is only the fallback. An override is pinned once, at
      // open time, but the drawer can then be swiped onto a climb from a third
      // board — and it is the shown climb that the overlay names, so switching
      // to the opener's board would send the climber somewhere the prompt never
      // mentioned (#5099).
      const override = climbBoardConfig ?? boardConfigOverrideRef.current;
      if (!override) return;
      const owned = myBoardsRef.current?.boards.find((board) =>
        boardLooselyMatches({ boardName: board.boardType, layoutId: board.layoutId }, override),
      );
      if (owned) {
        // boardLooselyMatches ignores angle, so `owned`'s stored angle can differ
        // from the climb's override angle. Switch to the board CARRYING the override
        // angle so the climb keeps rendering at the same angle and the now-enabled
        // queue/tick/favorite/LED controls act on it — unless the board's angle is
        // fixed, in which case its own angle stands.
        const switchedBoard = owned.isAngleAdjustable === false ? owned : { ...owned, angle: override.angle };
        const switchedConfig: BoardConfig = {
          boardName: switchedBoard.boardType,
          layoutId: switchedBoard.layoutId,
          sizeId: switchedBoard.sizeId,
          setIds: switchedBoard.setIds,
          angle: switchedBoard.angle,
        };
        // `boardLooselyMatches` only compares name + layout, so the "owned" board
        // it found can BE the board the climber is already on. Setting it active
        // changes nothing and the prompt that sent them here never clears, so
        // hand them the picker instead of a button that does nothing (#5099).
        if (!boardConfigsMatch(switchedConfig, storedActiveBoardConfigRef.current)) {
          void setActiveBoard(switchedBoard);
          setBoardConfigOverride(null);
          return;
        }
      }
      // Dismiss the player route, then route to the board picker.
      router.dismiss();
      router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/home' } });
    },
    [setActiveBoard],
  );

  // The switch-board gate fires only when the drawer is showing a climb from a
  // genuinely DIFFERENT board model (board name + layout) than the user's stored
  // active board — not merely a different size/sets/angle on the same board
  // (e.g. a board-sheet climb logged at another angle keeps its override without
  // a gate). A null stored board (user hasn't picked one) also counts as a
  // mismatch, prompting them to choose a board to control.
  const boardMismatch =
    boardConfigOverride != null && !boardLooselyMatches(boardConfigOverride, storedActiveBoardConfig);
  const mismatchBoardLabel = useMemo(
    () => (boardConfigOverride ? formatBoardDisplayName(boardConfigOverride.boardName) : undefined),
    [boardConfigOverride],
  );

  const handleBoardSheetClimbPress = useCallback(
    (action: BoardSheetClimbAction) => {
      const item = climbToQueueItem(action.climb, { uuid: action.queueItemUuid ?? undefined });
      const boardConfigOverride = boardConfigsMatch(action.boardConfig, storedActiveBoardConfigRef.current)
        ? undefined
        : action.boardConfig;
      setCurrentClimb(item);
      openPlayDrawer(action.climb, {
        committedExternally: true,
        boardConfig: boardConfigOverride,
      });
    },
    [openPlayDrawer, setCurrentClimb],
  );

  const handleBoardSheetAddToQueue = useCallback(
    (action: BoardSheetClimbAction) => {
      void addToQueue(climbToQueueItem(action.climb));
    },
    [addToQueue],
  );

  const handleBoardSheetOpenPlaylist = useCallback(
    (action: BoardSheetClimbAction) => {
      openAddToPlaylist(action.climb, action.boardConfig);
    },
    [openAddToPlaylist],
  );

  const handleBoardSheetModalOpenActions = useCallback(
    (action: BoardSheetClimbAction) => {
      openClimbActions(action.climb, action.boardConfig, { dismissSourceSheet: dismissBoardSheetAndWait });
    },
    [openClimbActions, dismissBoardSheetAndWait],
  );

  // The regular-width iPad wall surface is a persistent inline pane, not the
  // BoardSheet modal. Never hand it a modal dismiss callback: doing so could close
  // an unrelated hidden/reopening sheet or abort a valid create navigation.
  const handleBoardPanelOpenActions = useCallback(
    (action: BoardSheetClimbAction) => {
      openClimbActions(action.climb, action.boardConfig);
    },
    [openClimbActions],
  );

  // Undo a wall change YOU just caused. Queue navigation is untouched; the
  // Bluetooth provider re-lights the captured target over BLE first, then
  // re-reports it to board presence.
  const handleUndoWallChange = useCallback(() => {
    if (!bluetooth) {
      dismissUndoWallChangeSnackbar();
      return;
    }
    void bluetooth.undoWallChange().finally(() => {
      dismissUndoWallChangeSnackbar();
    });
  }, [bluetooth, dismissUndoWallChangeSnackbar]);

  const boardSheetLabel = useMemo(() => formatActiveBoardLabel(activeBoard), [activeBoard]);

  const isAngleAdjustable = activeBoard?.isAngleAdjustable ?? true;

  // One source of truth for the iPad pane's PlayDrawer props, mirroring the `/play`
  // route's props (see app/play.tsx). `boardConfig` is the override-inclusive
  // active board so a foreign-board climb renders on its own board; `openTarget`
  // is the pane's selected climb. Null while no board is resolved.
  const playDrawerPaneProps = useMemo<PlayDrawerPaneProps | null>(
    () =>
      activeBoardConfig
        ? {
            boardConfig: activeBoardConfig,
            onAngleChange: handleAngleChange,
            isAngleAdjustable,
            onOpenQueue: openQueueSheet,
            boardMismatch,
            mismatchBoardLabel,
            onSwitchBoard: handleSwitchBoardFromDrawer,
            onOpenClimbActions: openClimbActions,
            openTarget: paneTarget,
          }
        : null,
    [
      activeBoardConfig,
      handleAngleChange,
      isAngleAdjustable,
      openQueueSheet,
      boardMismatch,
      mismatchBoardLabel,
      handleSwitchBoardFromDrawer,
      openClimbActions,
      paneTarget,
    ],
  );

  // Props for the iPad "Now on the wall" column — the same handlers passed to the
  // BoardSheet modal below, surfaced via context so the inline column renders the
  // identical wall feed. Mirrors playDrawerPaneProps; null while no board resolved.
  const boardPanelProps = useMemo<NowOnTheWallColumnProps | null>(
    () =>
      storedActiveBoardConfig
        ? {
            boardLabel: boardSheetLabel,
            boardConfig: storedActiveBoardConfig,
            onSwitchBoard: handleSwitchBoardFromSheet,
            onClimbPress: handleBoardSheetClimbPress,
            onAddToQueue: handleBoardSheetAddToQueue,
            onOpenPlaylist: handleBoardSheetOpenPlaylist,
            onOpenActions: handleBoardPanelOpenActions,
          }
        : null,
    [
      storedActiveBoardConfig,
      boardSheetLabel,
      handleSwitchBoardFromSheet,
      handleBoardSheetClimbPress,
      handleBoardSheetAddToQueue,
      handleBoardSheetOpenPlaylist,
      handleBoardPanelOpenActions,
    ],
  );

  const value = useMemo<DrawerHostValue>(
    () => ({
      boardConfig: storedActiveBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openAddBetaVideo,
      openQueueSheet,
      openBoardSheet,
      playDrawerPaneProps,
      boardPanelProps,
      usesDetailPane,
    }),
    [
      storedActiveBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openAddBetaVideo,
      openQueueSheet,
      openBoardSheet,
      playDrawerPaneProps,
      boardPanelProps,
      usesDetailPane,
    ],
  );

  const previewedClimbValue = useMemo<PreviewedClimbValue>(() => ({ previewedClimbUuid }), [previewedClimbUuid]);

  // Volatile player state for the `app/play.tsx` route (separate context — see
  // PlayDrawerRouteValue — so the wide useDrawerHost consumers don't re-render
  // when this changes on every open).
  const routeValue = useMemo<PlayDrawerRouteValue>(
    () => ({
      activeBoardConfig,
      isAngleAdjustable,
      boardMismatch,
      mismatchBoardLabel,
      onAngleChange: handleAngleChange,
      onSwitchBoard: handleSwitchBoardFromDrawer,
      onPlayDrawerClosed,
      onPlayDrawerTargetConsumed,
      playTarget,
    }),
    [
      activeBoardConfig,
      isAngleAdjustable,
      boardMismatch,
      mismatchBoardLabel,
      handleAngleChange,
      handleSwitchBoardFromDrawer,
      onPlayDrawerClosed,
      onPlayDrawerTargetConsumed,
      playTarget,
    ],
  );

  return (
    <DrawerHostContext.Provider value={value}>
      <PreviewedClimbContext.Provider value={previewedClimbValue}>
        <PlayDrawerRouteContext.Provider value={routeValue}>
          {children}
          {logAscentData ? (
            <LogAscentSheet
              visible={logAscentVisible}
              onClose={closeLogAscentSheet}
              onFullyDismissed={clearLogAscentSheet}
              climbUuid={logAscentData.climbUuid}
              climbName={logAscentData.climbName}
              boardName={logAscentData.boardName}
              angle={logAscentData.angle}
              isMirror={logAscentData.isMirror}
              isBenchmark={logAscentData.isBenchmark}
              baseAscensionistCount={logAscentData.baseAscensionistCount}
              layoutId={logAscentData.layoutId}
              sizeId={logAscentData.sizeId}
              setIds={logAscentData.setIds}
              sessionId={logAscentData.sessionId}
              consensusGradeName={logAscentData.consensusGradeName}
            />
          ) : null}
          {betaVideoData ? (
            <AddBetaVideoSheet
              visible={betaVideoVisible}
              climb={betaVideoData.climb}
              boardName={betaVideoData.boardConfig.boardName as BoardName}
              layoutId={betaVideoData.boardConfig.layoutId}
              angle={betaVideoData.boardConfig.angle}
              onClose={closeAddBetaVideo}
              onFullyDismissed={clearBetaVideoSheet}
            />
          ) : null}
          {playlistData ? (
            <AddToPlaylistSheet
              visible={playlistVisible}
              climb={playlistData.climb}
              boardName={playlistData.boardConfig.boardName as BoardName}
              layoutId={playlistData.boardConfig.layoutId}
              sizeId={playlistData.boardConfig.sizeId}
              setIds={playlistData.boardConfig.setIds}
              angle={playlistData.boardConfig.angle}
              onClose={closeAddToPlaylist}
              onFullyDismissed={clearPlaylistSheet}
            />
          ) : null}
          {queueBoard ? (
            <QueueSheet
              ref={queueSheetRef}
              board={queueBoard}
              onClose={requestCloseQueueSheet}
              onClimbPress={handleQueueClimbPress}
              onOpenActions={handleQueueOpenActions}
              onSuggestionPress={handleQueueSuggestionPress}
              onTickHistory={handleQueueTickHistory}
            />
          ) : null}
          <BoardSheet
            ref={boardSheetRef}
            boardLabel={boardSheetLabel}
            boardConfig={storedActiveBoardConfig}
            onClose={requestCloseBoardSheet}
            onSwitchBoard={handleSwitchBoardFromSheet}
            onClimbPress={handleBoardSheetClimbPress}
            onAddToQueue={handleBoardSheetAddToQueue}
            onOpenPlaylist={handleBoardSheetOpenPlaylist}
            onOpenActions={handleBoardSheetModalOpenActions}
          />
          {/* Rendered after the queue/board sheets so its iOS FullWindowOverlay mounts as a
          later sibling and floats above them when a row inside those sheets is
          long-pressed (RN-screens doesn't strictly guarantee cross-overlay z-order). */}
          {climbActions ? (
            <ClimbReactionMenu
              key={climbActions.climb.uuid}
              climb={climbActions.climb}
              boardConfig={climbActions.boardConfig}
              currentUserId={profile?.id ?? null}
              isAuthenticated={isAuthenticated}
              onEditEntry={climbActions.onEditEntry}
              onAddBetaVideo={climbActions.onAddBetaVideo}
              onTick={climbActions.onTick}
              dismissSourceSheet={climbActions.dismissSourceSheet}
              dismissPlayerAndWait={climbActions.dismissPlayerAndWait}
              reduceMotion={reduceMotion}
              onClose={closeClimbActions}
            />
          ) : null}
          <QueueAddedSnackbar
            visible={snackbarVisible}
            nonce={snackbarNonce}
            onDismiss={dismissSnackbar}
            onOpen={handleSnackbarOpen}
          />
          <UndoWallChangeSnackbar
            visible={undoWallChangeVisible}
            nonce={undoWallChangeNonce}
            onDismiss={dismissUndoWallChangeSnackbar}
            onUndo={handleUndoWallChange}
          />
        </PlayDrawerRouteContext.Provider>
      </PreviewedClimbContext.Provider>
    </DrawerHostContext.Provider>
  );
}
