/**
 * DrawerHostProvider mounts PlayDrawer and LogAscentSheet once at the app root
 * and exposes imperative openers via `useDrawerHost()`. This lets the
 * persistent queue control bar (and any screen) open them without each tab
 * having to instantiate its own copy.
 *
 * Default board comes from `useActiveBoard()` (the user's stored pick); callers
 * can override via the second arg to `openPlayDrawer` if needed (e.g. opening a
 * climb from a different board context). The active boardConfig is exposed
 * through the context so consumers (like the persistent bar's log-ascent
 * button) don't have to resolve the active board independently.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
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
import { ClimbActionsSheet } from '../components/ClimbActionsSheet';
import { AddBetaVideoSheet } from '../components/AddBetaVideoSheet';
import { AddToPlaylistSheet } from '../components/AddToPlaylistSheet';
import { useToggleFavorite, useProfile, useMyBoards } from '../lib/graphql/hooks';
import { boardLooselyMatches } from '../lib/boards/board-matches';
import { useAuth } from './auth-provider';
import { favoritesStore } from '@boardsesh/climb-actions';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { useQueueActions, useQueueSessionControls } from './queue-provider';
import { useDeviceLayout } from '../hooks/use-device-layout';
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

/** The props both PlayDrawer presentations consume — the bottom sheet (compact)
 *  and the iPad right-column pane (regular). Built once in the host. */
export type PlayDrawerPaneProps = {
  boardConfig: BoardConfig;
  onAngleChange: (angle: number) => void;
  isAngleAdjustable: boolean;
  onOpenQueue: () => void;
  boardMismatch: boolean;
  mismatchBoardLabel: string | undefined;
  onSwitchBoard: () => void;
  /** Climb to preview in the pane without committing it as current (iPad pane
   *  only); null when the pane should show `currentClimbQueueItem`. */
  previewItem: ClimbQueueItem | null;
  /** Playlist source for pane previews so next/previous can walk the source list. */
  previewPlaylistSuggestionSource: PlaylistSuggestionSource | null;
  /** Called by the pane once the current climb changes, so the host drops the
   *  preview and the pane falls back to `currentClimbQueueItem`. */
  onPreviewConsumed: () => void;
};

type PanePreview = {
  item: ClimbQueueItem;
  boardConfigOverride: BoardConfig | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
};

/** Props for the iPad "Now on the wall" column (regular landscape) — the same
 *  wall feed / history / stats / switch-board content as the BoardSheet modal,
 *  rendered inline. Mirrors {@link PlayDrawerPaneProps}; null while no board is
 *  resolved. Consumed by `IpadWallColumn` in the shell. */
export type NowOnTheWallColumnProps = {
  boardLabel: string | null;
  boardConfig: BoardConfig | null;
  onSwitchBoard: () => void;
  onClimbPress: (action: BoardSheetClimbAction) => void;
  onAddToQueue: (action: BoardSheetClimbAction) => void;
  onOpenPlaylist: (action: BoardSheetClimbAction) => void;
  onOpenActions: (action: BoardSheetClimbAction) => void;
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

function boardConfigsMatch(left: BoardConfig | null, right: BoardConfig | null): boolean {
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
  /** Currently resolved board config (override OR default board). Null while
   *  the default board is still loading and no override is set. */
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
  /** Opens the queue list sheet (from the play-drawer queue button or the
   *  "Climb added to queue" snackbar's Open action). */
  openQueueSheet: () => void;
  /** Opens the board sheet ("now on the wall" — wall feed, history, stats, and a
   *  separate Switch-board control). Wired to the board glyph when the
   *  `board-presence` flag is on. */
  openBoardSheet: () => void;
  /** Props for the iPad right-column PlayDrawer pane (regular width); null while
   *  no board is resolved. Consumed by `IpadPlayPane` in the shell. */
  playDrawerPaneProps: PlayDrawerPaneProps | null;
  /** Props for the iPad "Now on the wall" column (regular landscape); null while
   *  no board is resolved. Consumed by `IpadWallColumn` in the shell. */
  boardPanelProps: NowOnTheWallColumnProps | null;
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
  const { data: myBoardsConn } = useMyBoards();
  const [boardConfigOverride, setBoardConfigOverride] = useState<BoardConfig | null>(null);
  const [logAscentInput, setLogAscentInput] = useState<LogAscentInput | null>(null);
  const [climbActions, setClimbActions] = useState<{
    climb: Climb;
    boardConfig: BoardConfig;
    onEditEntry?: () => void;
  } | null>(null);
  const [playlistClimb, setPlaylistClimb] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  const [betaVideoClimb, setBetaVideoClimb] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  // iPad pane only: a climb to PREVIEW in the right-column pane without committing
  // it as the queue's current (e.g. a `setAsCurrent: false` open from the feed /
  // beta / a climb view). The pane shows this over `currentClimbQueueItem`; it is
  // dropped once the current climb changes (a list tap's async activate commits,
  // or the user navigates), so the pane shows one continuous climb. Compact width
  // never sets it — there the bottom sheet handles previews via its own state.
  const [panePreview, setPanePreview] = useState<PanePreview | null>(null);
  const panePreviewRef = useRef(panePreview);
  panePreviewRef.current = panePreview;
  const clearPanePreview = useCallback(() => {
    const preview = panePreviewRef.current;
    if (preview?.boardConfigOverride) {
      setBoardConfigOverride((currentOverride) =>
        boardConfigsMatch(currentOverride, preview.boardConfigOverride) ? null : currentOverride,
      );
    }
    setPanePreview(null);
  }, []);
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
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const { data: profile } = useProfile();
  // Gate "Add beta video" on auth state, not profile?.id — the latter can lag
  // behind a fresh sign-in (profile query still resolving), which would show the
  // action in the play drawer but not here. PlayDrawer uses the same predicate.
  const { isAuthenticated } = useAuth();
  // On the regular-width iPad shell the PlayDrawer renders as the persistent
  // right-column pane (IpadPlayPane), so the bottom-sheet PlayDrawer is not
  // mounted and `openPlayDrawer` just makes the climb current — the pane shows
  // `currentClimbQueueItem`. A ref keeps `openPlayDrawer`'s identity stable.
  const { widthClass } = useDeviceLayout();
  const isRegular = widthClass === 'regular';
  const isRegularRef = useRef(isRegular);
  isRegularRef.current = isRegular;

  // Climb to open after the boardConfig override has committed. We can't
  // open synchronously inside openPlayDrawer when an override is supplied
  // because the new override hasn't propagated to PlayDrawer's `boardConfig`
  // prop yet — a single requestAnimationFrame is unreliable on low-end
  // Android. Stash the climb (plus the caller's open options) here and let
  // the useEffect below open the drawer when activeBoardConfig actually
  // matches the override.
  const pendingOverrideOpenRef = useRef<{ climb: Climb; options: PlayDrawerOpenOptions } | null>(null);

  const activeBoardConfig: BoardConfig | null = useMemo(() => {
    if (boardConfigOverride) return boardConfigOverride;
    if (!activeBoard) return null;
    return {
      boardName: activeBoard.boardType,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      angle: activeBoard.angle,
    };
  }, [boardConfigOverride, activeBoard]);

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

  // Keep a ref so the otherwise empty-dep `openClimbActions` callback can
  // snapshot the current board config without churning its identity.
  const activeBoardConfigRef = useRef(activeBoardConfig);
  activeBoardConfigRef.current = activeBoardConfig;

  // The user's STORED active board as a BoardConfig (never the override). Used
  // to decide whether a climb opened with a board override is genuinely a
  // different board (→ switch-board gate) or the same board (→ drop the override
  // and render against the user's precise board).
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
  const boardConfigOverrideRef = useRef(boardConfigOverride);
  boardConfigOverrideRef.current = boardConfigOverride;
  const myBoardsRef = useRef(myBoardsConn);
  myBoardsRef.current = myBoardsConn;

  const openPlayDrawer = useCallback(
    (climb: Climb, options?: OpenPlayDrawerOptions) => {
      // Pull `source` out alongside `boardConfig` so neither reaches PlayDrawer.open
      // — `source` is analytics-only and would otherwise leak into the drawer.
      const { boardConfig: override, source: openSource, ...openOptions } = options ?? {};
      const boardConfig = override ?? activeBoardConfigRef.current;
      track(SHARED_EVENTS.PlayDrawerOpened, {
        climbUuid: climb.uuid,
        boardName: boardConfig?.boardName,
        layoutId: boardConfig?.layoutId,
        source:
          openSource ??
          (openOptions.committedExternally || openOptions.previewQueueItem != null ? 'current_queue_item' : 'mobile'),
      });
      if (isRegularRef.current) {
        // iPad pane: there is no sheet to present. Apply the board override (so the
        // pane renders against the climb's board), then either commit the climb as
        // current or preview it in the pane.
        setBoardConfigOverride(override ?? null);
        pendingOverrideOpenRef.current = null;
        const selectedItem =
          openOptions.previewQueueItem ??
          climbToQueueItem(climb, { suggested: openOptions.playlistSuggestionSource != null });
        if (openOptions.committedExternally) {
          setPanePreview(null);
        } else if (openOptions.previewQueueItem) {
          // View-only opens (feed / beta / climb view, and the list tap whose own
          // async activate commits next) show the climb in the pane without
          // committing it. Without this the tap is a no-op on iPad; the pane drops
          // the preview once the current climb changes (see PlayDrawer's effect).
          setPanePreview({
            item: selectedItem,
            boardConfigOverride: override ?? null,
            playlistSuggestionSource: openOptions.playlistSuggestionSource ?? null,
          });
        } else {
          setPanePreview(null);
          setCurrentClimb(selectedItem, {
            playlistSuggestionSource: openOptions.playlistSuggestionSource ?? null,
          });
        }
        return;
      }
      if (override) {
        pendingOverrideOpenRef.current = { climb, options: openOptions };
        setBoardConfigOverride(override);
        return;
      }
      setBoardConfigOverride(null);
      pendingOverrideOpenRef.current = null;
      playDrawerRef.current?.open(climb, openOptions);
    },
    [setCurrentClimb],
  );

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
      const boardConfig = boardConfigOverride ?? activeBoardConfigRef.current;
      if (!boardConfig) return;
      setClimbActions({ climb, boardConfig, onEditEntry: options?.onEditEntry });
    },
    [],
  );

  const closeClimbActions = useCallback(() => {
    setClimbActions(null);
  }, []);

  const openAddToPlaylist = useCallback((climb: Climb, boardConfigOverride?: BoardConfig) => {
    const boardConfig = boardConfigOverride ?? activeBoardConfigRef.current;
    if (!boardConfig) return;
    setPlaylistClimb({ climb, boardConfig });
  }, []);

  const closeAddToPlaylist = useCallback(() => {
    setPlaylistClimb(null);
  }, []);

  const handleClimbActionsAddToQueue = useCallback(() => {
    if (!climbActions) return;
    addToQueue({ uuid: randomUUID(), climb: climbActions.climb });
  }, [climbActions, addToQueue]);

  const handleClimbActionsToggleFavorite = useCallback(() => {
    if (!climbActions) return;
    const isNowFavorited = !favoritesStore.getIsFavorited(climbActions.climb.uuid);
    track(SHARED_EVENTS.FavoriteToggle, {
      action: isNowFavorited ? 'added' : 'removed',
      climbUuid: climbActions.climb.uuid,
      boardName: climbActions.boardConfig.boardName,
      layoutId: climbActions.boardConfig.layoutId,
      source: 'mobile_climb_actions',
    });
    toggleFavoriteMutate({
      input: {
        boardName: climbActions.boardConfig.boardName,
        climbUuid: climbActions.climb.uuid,
        angle: climbActions.boardConfig.angle,
      },
    });
  }, [climbActions, toggleFavoriteMutate]);

  const handleClimbActionsTick = useCallback(() => {
    if (!climbActions) return;
    setLogAscentInput({
      climbUuid: climbActions.climb.uuid,
      boardName: climbActions.boardConfig.boardName,
      angle: climbActions.boardConfig.angle,
      isMirror: false,
      isBenchmark: !!climbActions.climb.benchmark_difficulty,
      layoutId: climbActions.boardConfig.layoutId,
      sizeId: climbActions.boardConfig.sizeId,
      setIds: climbActions.boardConfig.setIds,
      consensusGradeName: climbActions.climb.difficulty,
    });
  }, [climbActions]);

  const handleClimbActionsOpenPlaylist = useCallback(() => {
    if (!climbActions) return;
    setPlaylistClimb({
      climb: climbActions.climb,
      boardConfig: climbActions.boardConfig,
    });
  }, [climbActions]);

  const handleClimbActionsAddBetaVideo = useCallback(() => {
    if (!climbActions) return;
    // ClimbActionsSheet fires this then calls onClose (which clears climbActions).
    // We snapshot climb + boardConfig into betaVideoClimb here, so the beta-video
    // sheet holds its own copy and never reads from climbActions after it's null —
    // the open-then-close ordering in ClimbActionsSheet stays incidental, not load-bearing.
    setBetaVideoClimb({
      climb: climbActions.climb,
      boardConfig: climbActions.boardConfig,
    });
  }, [climbActions]);

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
    if (!activeBoardConfig) return null;
    return {
      boardName: activeBoardConfig.boardName as BoardName,
      layoutId: activeBoardConfig.layoutId,
      sizeId: activeBoardConfig.sizeId,
      setIds: activeBoardConfig.setIds,
      angle: activeBoardConfig.angle,
    };
  }, [activeBoardConfig]);

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
  // Deps: only `sessionId` — `activeBoardConfigRef` is a stable ref read at call
  // time (intentionally not a dep). If that ref ever becomes state, add it here.
  const handleQueueTickHistory = useCallback(
    (item: ClimbQueueItem) => {
      const boardConfig = activeBoardConfigRef.current;
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
      const boardConfigOverride = boardConfigsMatch(action.boardConfig, activeBoardConfigRef.current)
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

  // One source of truth for the PlayDrawer props across both presentations: the
  // bottom sheet (compact, rendered below) and the iPad pane (regular, rendered
  // by IpadPlayPane from this context value).
  const playDrawerPaneProps = useMemo<PlayDrawerPaneProps | null>(
    () =>
      activeBoardConfig
        ? {
            boardConfig: activeBoardConfig,
            onAngleChange: handleAngleChange,
            isAngleAdjustable: activeBoard?.isAngleAdjustable ?? true,
            onOpenQueue: openQueueSheet,
            boardMismatch,
            mismatchBoardLabel,
            onSwitchBoard: handleSwitchBoardFromDrawer,
            previewItem: panePreview?.item ?? null,
            previewPlaylistSuggestionSource: panePreview?.playlistSuggestionSource ?? null,
            onPreviewConsumed: clearPanePreview,
          }
        : null,
    [
      activeBoardConfig,
      handleAngleChange,
      activeBoard?.isAngleAdjustable,
      openQueueSheet,
      boardMismatch,
      mismatchBoardLabel,
      handleSwitchBoardFromDrawer,
      panePreview,
      clearPanePreview,
    ],
  );

  // Props for the iPad "Now on the wall" column — the same handlers passed to the
  // BoardSheet modal below, surfaced via context so the inline column renders the
  // identical wall feed. Mirrors playDrawerPaneProps; null while no board resolved.
  const boardPanelProps = useMemo<NowOnTheWallColumnProps | null>(
    () =>
      activeBoardConfig
        ? {
            boardLabel: boardSheetLabel,
            boardConfig: activeBoardConfig,
            onSwitchBoard: handleSwitchBoardFromSheet,
            onClimbPress: handleBoardSheetClimbPress,
            onAddToQueue: handleBoardSheetAddToQueue,
            onOpenPlaylist: handleBoardSheetOpenPlaylist,
            onOpenActions: handleBoardSheetOpenActions,
          }
        : null,
    [
      activeBoardConfig,
      boardSheetLabel,
      handleSwitchBoardFromSheet,
      handleBoardSheetClimbPress,
      handleBoardSheetAddToQueue,
      handleBoardSheetOpenPlaylist,
      handleBoardSheetOpenActions,
    ],
  );

  const value = useMemo<DrawerHostValue>(
    () => ({
      boardConfig: activeBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openQueueSheet,
      openBoardSheet,
      playDrawerPaneProps,
      boardPanelProps,
    }),
    [
      activeBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openQueueSheet,
      openBoardSheet,
      playDrawerPaneProps,
      boardPanelProps,
    ],
  );

  return (
    <DrawerHostContext.Provider value={value}>
      {children}
      {/* Bottom-sheet PlayDrawer — compact only. On the regular-width iPad shell
          the same drawer renders as the persistent right column (IpadPlayPane),
          so mounting the sheet here too would double its sub-sheets + state. */}
      {activeBoardConfig && !isRegular ? (
        <PlayDrawer
          ref={playDrawerRef}
          boardConfig={activeBoardConfig}
          onAngleChange={handleAngleChange}
          isAngleAdjustable={activeBoard?.isAngleAdjustable ?? true}
          onOpenQueue={openQueueSheet}
          boardMismatch={boardMismatch}
          mismatchBoardLabel={mismatchBoardLabel}
          onSwitchBoard={handleSwitchBoardFromDrawer}
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
      {climbActions ? (
        <ClimbActionsSheet
          visible
          climb={climbActions.climb}
          boardName={climbActions.boardConfig.boardName as BoardName}
          layoutId={climbActions.boardConfig.layoutId}
          sizeId={climbActions.boardConfig.sizeId}
          setIds={climbActions.boardConfig.setIds}
          angle={climbActions.boardConfig.angle}
          currentUserId={profile?.id ?? null}
          onAddToQueue={handleClimbActionsAddToQueue}
          onOpenPlaylist={handleClimbActionsOpenPlaylist}
          onToggleFavorite={handleClimbActionsToggleFavorite}
          onTick={handleClimbActionsTick}
          onEditEntry={climbActions.onEditEntry}
          onAddBetaVideo={isAuthenticated ? handleClimbActionsAddBetaVideo : undefined}
          onClose={closeClimbActions}
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
      {queueBoard ? (
        <QueueSheet
          ref={queueSheetRef}
          board={queueBoard}
          onClose={requestCloseQueueSheet}
          onClimbPress={handleQueueClimbPress}
          onSuggestionPress={handleQueueSuggestionPress}
          onTickHistory={handleQueueTickHistory}
        />
      ) : null}
      <BoardSheet
        ref={boardSheetRef}
        boardLabel={boardSheetLabel}
        boardConfig={activeBoardConfig}
        onClose={requestCloseBoardSheet}
        onSwitchBoard={handleSwitchBoardFromSheet}
        onClimbPress={handleBoardSheetClimbPress}
        onAddToQueue={handleBoardSheetAddToQueue}
        onOpenPlaylist={handleBoardSheetOpenPlaylist}
        onOpenActions={handleBoardSheetOpenActions}
      />
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
