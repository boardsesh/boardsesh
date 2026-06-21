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
import { Platform } from 'react-native';
import { router } from 'expo-router';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { buildBoardPath, formatBoardDisplayName } from '@boardsesh/board-config';
import type { Climb as QueueClimb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { PlayDrawer, type PlayDrawerHandle, type PlayDrawerOpenOptions } from '../components/play-drawer';
import { LogAscentSheet } from '../components/LogAscentSheet';
import { QueueSheet, type QueueSheetHandle } from '../components/play-drawer/QueueSheet';
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
import { useDeferredAfterInteractions } from '../hooks/use-deferred-after-interactions';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { useQueueActions, useQueueSessionControls } from './queue-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';
import { useBoardPresenceControls, type ResolveBoardUuidArgs } from './board-presence-provider';
import { useOptionalBluetoothContext } from './bluetooth-provider';

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
};

export type LogAscentInput = {
  climbUuid: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
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
  /** Analytics-only tag for the `Play Drawer Opened` event's `source`. Lets a
   *  real climb-view (feed/session/beta/playlist) be distinguished from a
   *  queue-nav / accessory tap — the latter open `committedExternally` or with a
   *  `previewQueueItem`, so the default `current_queue_item`/`mobile` heuristic
   *  can't tell them apart. Pulled out before the rest of the options reach
   *  `PlayDrawer.open`, so it never leaks into the drawer itself. */
  source?: 'climb_view' | 'current_queue_item' | 'mobile';
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
};

const DrawerHostContext = createContext<DrawerHostValue | null>(null);

export function useDrawerHost(): DrawerHostValue {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error('useDrawerHost must be used within DrawerHostProvider');
  return context;
}

export function DrawerHostProvider({ children }: { children: ReactNode }) {
  const playDrawerRef = useRef<PlayDrawerHandle>(null);
  // QueueSheet stays mounted (whenever a board is resolved) and is opened via its
  // imperative handle. gorhom `present()` driven from a `visible`-prop effect is
  // a silent no-op in this app, so we present/dismiss synchronously from the
  // handler — the same pattern PlayDrawer uses.
  const queueSheetRef = useRef<QueueSheetHandle>(null);
  const boardSheetRef = useRef<BoardSheetHandle>(null);
  const { data: activeBoard } = useActiveBoard();
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
  const [logAscentInput, setLogAscentInput] = useState<LogAscentInput | null>(null);
  const [climbActions, setClimbActions] = useState<{
    climb: Climb;
    boardConfig: BoardConfig;
    onEditEntry?: () => void;
  } | null>(null);
  const [playlistClimb, setPlaylistClimb] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  const [betaVideoClimb, setBetaVideoClimb] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
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

  // Climb to open after the boardConfig override has committed. We can't
  // open synchronously inside openPlayDrawer when an override is supplied
  // because the new override hasn't propagated to PlayDrawer's `boardConfig`
  // prop yet — a single requestAnimationFrame is unreliable on low-end
  // Android. Stash the climb (plus the caller's open options) here and let
  // the useEffect below open the drawer when activeBoardConfig actually
  // matches the override.
  const pendingOverrideOpenRef = useRef<{ climb: Climb; options: PlayDrawerOpenOptions } | null>(null);

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
  const activeBoardMountKey = activeBoard?.uuid ?? 'none';
  const androidActiveBoardSheetsReady = useDeferredAfterInteractions(
    Platform.OS === 'android' && activeBoardConfig != null,
    activeBoardMountKey,
    500,
  );
  const mountedActiveBoardConfig =
    activeBoardConfig != null && (Platform.OS !== 'android' || androidActiveBoardSheetsReady)
      ? activeBoardConfig
      : null;

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
    // Pull `source` out alongside `boardConfig` so neither reaches PlayDrawer.open
    // — `source` is analytics-only and would otherwise leak into the drawer.
    const { boardConfig: override, source: openSource, ...openOptions } = options ?? {};
    const boardConfig = override ?? storedActiveBoardConfigRef.current;
    track(SHARED_EVENTS.PlayDrawerOpened, {
      climbUuid: climb.uuid,
      boardName: boardConfig?.boardName,
      layoutId: boardConfig?.layoutId,
      source:
        openSource ??
        (openOptions.committedExternally || openOptions.previewQueueItem != null ? 'current_queue_item' : 'mobile'),
    });
    if (override) {
      pendingOverrideOpenRef.current = { climb, options: openOptions };
      if (boardConfigsMatch(override, activeBoardConfigRef.current)) {
        pendingOverrideOpenRef.current = null;
        playDrawerRef.current?.open(climb, openOptions);
        return;
      }
      setBoardConfigOverride(override);
      return;
    }
    setBoardConfigOverride(null);
    pendingOverrideOpenRef.current = null;
    playDrawerRef.current?.open(climb, openOptions);
  }, []);

  // Open after the override has flowed through `activeBoardConfig` into
  // PlayDrawer's props.
  useEffect(() => {
    if (!pendingOverrideOpenRef.current) return;
    if (!activeBoardConfig) return;
    const { climb, options } = pendingOverrideOpenRef.current;
    pendingOverrideOpenRef.current = null;
    playDrawerRef.current?.open(climb, options);
  }, [activeBoardConfig]);

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

  const openLogAscent = useCallback((input: LogAscentInput) => {
    setLogAscentInput(input);
  }, []);

  const dismissLogAscent = useCallback(() => setLogAscentInput(null), []);

  // Snapshot the board config at open time so the sheet's per-row handlers
  // (queue / favorite / tick) keep operating on the same angle even if the
  // user switches their active board mid-interaction.
  const openClimbActions = useCallback(
    (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => {
      const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
      if (!boardConfig) return;
      setClimbActions({ climb, boardConfig, onEditEntry: options?.onEditEntry });
    },
    [],
  );

  const closeClimbActions = useCallback(() => {
    setClimbActions(null);
  }, []);

  const openAddToPlaylist = useCallback((climb: Climb, boardConfigOverride?: BoardConfig) => {
    const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
    if (!boardConfig) return;
    setPlaylistClimb({ climb, boardConfig });
  }, []);

  const closeAddToPlaylist = useCallback(() => {
    setPlaylistClimb(null);
  }, []);

  // Single parameterized beta-video opener (mirrors openAddToPlaylist), used both by
  // the reaction menu's shared action list (useClimbActions) and by PlayDrawer.
  // Falls back to the stored active board, not the override-inclusive one, so a
  // temporary drawer board override can't leak into the beta-video surface.
  const openAddBetaVideo = useCallback((climb: Climb, boardConfigOverride?: BoardConfig) => {
    const boardConfig = boardConfigOverride ?? storedActiveBoardConfigRef.current;
    if (!boardConfig) return;
    setBetaVideoClimb({ climb, boardConfig });
  }, []);

  const closeAddBetaVideo = useCallback(() => {
    setBetaVideoClimb(null);
  }, []);

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

  // Tap a queue item → make it current (for the whole session, always-live) and
  // show it in the play drawer.
  const handleQueueClimbPress = useCallback(
    (item: ClimbQueueItem) => {
      setCurrentClimb(item);
      openPlayDrawer(item.climb, { committedExternally: true });
      requestCloseQueueSheet();
    },
    [setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Long-press a queue row → open the climb reaction menu over the queue sheet. The
  // queue renders against the active board, so the default boardConfig is correct.
  const handleQueueOpenActions = useCallback(
    (item: ClimbQueueItem) => {
      openClimbActions(item.climb);
    },
    [openClimbActions],
  );

  // Tap a suggestion → activate it with a suggestion source built from the
  // suggestions list (so the play drawer can keep swiping forward through them)
  // and show it.
  const handleQueueSuggestionPress = useCallback(
    (climb: QueueClimb, source: PlaylistSuggestionSource) => {
      const item = climbToQueueItem(climb, { suggested: true });
      const schemaClimb = item.climb as Climb;
      setCurrentClimb(item, { playlistSuggestionSource: source });
      openPlayDrawer(schemaClimb, { committedExternally: true });
      requestCloseQueueSheet();
    },
    [setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Tick a history climb → open the log-ascent sheet (stacks above the queue
  // sheet, which stays open beneath) pre-filled with the active session.
  // Deps: only `sessionId` — `storedActiveBoardConfigRef` is a stable ref read at call
  // time (intentionally not a dep). If that ref ever becomes state, add it here.
  const handleQueueTickHistory = useCallback(
    (item: ClimbQueueItem) => {
      const boardConfig = storedActiveBoardConfigRef.current;
      if (!boardConfig) return;
      setLogAscentInput({
        climbUuid: item.climb.uuid,
        boardName: boardConfig.boardName,
        angle: boardConfig.angle,
        isMirror: item.climb.mirrored === true,
        isBenchmark: !!item.climb.benchmark_difficulty,
        layoutId: boardConfig.layoutId,
        sizeId: boardConfig.sizeId,
        setIds: boardConfig.setIds,
        sessionId,
        consensusGradeName: item.climb.difficulty,
      });
    },
    [sessionId],
  );

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
  const handleSwitchBoardFromDrawer = useCallback(() => {
    const override = boardConfigOverrideRef.current;
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
      void setActiveBoard(switchedBoard);
      setBoardConfigOverride(null);
      return;
    }
    playDrawerRef.current?.close();
    router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/home' } });
  }, [setActiveBoard]);

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
      addToQueue(climbToQueueItem(action.climb));
    },
    [addToQueue],
  );

  const handleBoardSheetOpenPlaylist = useCallback(
    (action: BoardSheetClimbAction) => {
      openAddToPlaylist(action.climb, action.boardConfig);
    },
    [openAddToPlaylist],
  );

  const handleBoardSheetOpenActions = useCallback(
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
    ],
  );

  return (
    <DrawerHostContext.Provider value={value}>
      {children}
      {mountedActiveBoardConfig ? (
        <PlayDrawer
          ref={playDrawerRef}
          boardConfig={mountedActiveBoardConfig}
          onAngleChange={handleAngleChange}
          isAngleAdjustable={activeBoard?.isAngleAdjustable ?? true}
          onOpenQueue={openQueueSheet}
          boardMismatch={boardMismatch}
          mismatchBoardLabel={mismatchBoardLabel}
          onSwitchBoard={handleSwitchBoardFromDrawer}
          onOpenClimbActions={openClimbActions}
        />
      ) : null}
      {logAscentInput ? (
        <LogAscentSheet
          visible
          onDismiss={dismissLogAscent}
          climbUuid={logAscentInput.climbUuid}
          boardName={logAscentInput.boardName}
          angle={logAscentInput.angle}
          isMirror={logAscentInput.isMirror}
          isBenchmark={logAscentInput.isBenchmark}
          layoutId={logAscentInput.layoutId}
          sizeId={logAscentInput.sizeId}
          setIds={logAscentInput.setIds}
          sessionId={logAscentInput.sessionId}
          consensusGradeName={logAscentInput.consensusGradeName}
        />
      ) : null}
      {betaVideoClimb ? (
        <AddBetaVideoSheet
          visible
          climb={betaVideoClimb.climb}
          boardName={betaVideoClimb.boardConfig.boardName as BoardName}
          layoutId={betaVideoClimb.boardConfig.layoutId}
          angle={betaVideoClimb.boardConfig.angle}
          onClose={closeAddBetaVideo}
        />
      ) : null}
      {playlistClimb ? (
        <AddToPlaylistSheet
          visible
          climb={playlistClimb.climb}
          boardName={playlistClimb.boardConfig.boardName as BoardName}
          layoutId={playlistClimb.boardConfig.layoutId}
          sizeId={playlistClimb.boardConfig.sizeId}
          setIds={playlistClimb.boardConfig.setIds}
          angle={playlistClimb.boardConfig.angle}
          onClose={closeAddToPlaylist}
        />
      ) : null}
      {mountedActiveBoardConfig && queueBoard ? (
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
        onOpenActions={handleBoardSheetOpenActions}
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
    </DrawerHostContext.Provider>
  );
}
