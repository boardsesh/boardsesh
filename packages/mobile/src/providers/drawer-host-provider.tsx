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
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { Climb as QueueClimb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { PlayDrawer, type PlayDrawerHandle, type PlayDrawerOpenOptions } from '../components/play-drawer';
import { LogAscentSheet } from '../components/LogAscentSheet';
import { QueueSheet } from '../components/play-drawer/QueueSheet';
import { QueueAddedSnackbar } from '../components/QueueAddedSnackbar';
import type { QueueItemRowBoard } from '../components/QueueItemRow';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { ClimbActionsSheet } from '../components/ClimbActionsSheet';
import { AddToPlaylistSheet } from '../components/AddToPlaylistSheet';
import { useToggleFavorite } from '../lib/graphql/hooks';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { useQueue } from './queue-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';

export type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
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
  // InlineGradePicker so the consensus chip is centered and outlined
  // without being preselected. Optional — callers that don't have a
  // freshly fetched climb can omit it.
  consensusGradeName?: string;
};

export type OpenPlayDrawerOptions = PlayDrawerOpenOptions & {
  /** Switch the drawer to a different board config before opening (e.g. the
   *  caller is opening a climb that belongs to a board other than the user's
   *  default). The override is applied via state, so the actual open happens
   *  after the new boardConfig has propagated to PlayDrawer's props. */
  boardConfig?: BoardConfig;
};

type DrawerHostValue = {
  /** Currently resolved board config (override OR default board). Null while
   *  the default board is still loading and no override is set. */
  boardConfig: BoardConfig | null;
  openPlayDrawer: (climb: Climb, options?: OpenPlayDrawerOptions) => void;
  openLogAscent: (input: LogAscentInput) => void;
  /** Opens the climb actions bottom sheet for the given climb. Uses the active
   *  boardConfig at the time of opening. */
  openClimbActions: (climb: Climb) => void;
  closeClimbActions: () => void;
  /** Opens the add-to-playlist bottom sheet for the given climb. Snapshots the
   *  active boardConfig (for the angle) at open time. */
  openAddToPlaylist: (climb: Climb) => void;
  /** Opens the queue list sheet (from the play-drawer queue button or the
   *  "Climb added to queue" snackbar's Open action). */
  openQueueSheet: () => void;
};

const DrawerHostContext = createContext<DrawerHostValue | null>(null);

export function useDrawerHost(): DrawerHostValue {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error('useDrawerHost must be used within DrawerHostProvider');
  return context;
}

export function DrawerHostProvider({ children }: { children: ReactNode }) {
  const playDrawerRef = useRef<PlayDrawerHandle>(null);
  const { data: activeBoard } = useActiveBoard();
  const [boardConfigOverride, setBoardConfigOverride] = useState<BoardConfig | null>(null);
  const [logAscentInput, setLogAscentInput] = useState<LogAscentInput | null>(null);
  const [climbActions, setClimbActions] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  const [playlistClimb, setPlaylistClimb] = useState<{ climb: Climb; boardConfig: BoardConfig } | null>(null);
  // `mounted` controls whether QueueSheet is in the tree (so its suggestion
  // query only runs while open); `visible` drives the present/dismiss animation.
  // Splitting them lets a programmatic close play the dismiss animation before
  // unmounting instead of vanishing instantly.
  const [queueSheetMounted, setQueueSheetMounted] = useState(false);
  const [queueSheetVisible, setQueueSheetVisible] = useState(false);
  const { addToQueue, setCurrentClimb, sessionId } = useQueue();
  const { visible: snackbarVisible, nonce: snackbarNonce, dismissSnackbar } = useQueueSnackbar();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();

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

  // Keep a ref so the otherwise empty-dep `openClimbActions` callback can
  // snapshot the current board config without churning its identity.
  const activeBoardConfigRef = useRef(activeBoardConfig);
  activeBoardConfigRef.current = activeBoardConfig;

  const openPlayDrawer = useCallback((climb: Climb, options?: OpenPlayDrawerOptions) => {
    const { boardConfig: override, ...openOptions } = options ?? {};
    if (override) {
      pendingOverrideOpenRef.current = { climb, options: openOptions };
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

  const openLogAscent = useCallback((input: LogAscentInput) => {
    setLogAscentInput(input);
  }, []);

  const dismissLogAscent = useCallback(() => setLogAscentInput(null), []);

  // Snapshot the board config at open time so the sheet's per-row handlers
  // (queue / favorite / tick) keep operating on the same angle even if the
  // user switches their active board mid-interaction.
  const openClimbActions = useCallback((climb: Climb) => {
    const boardConfig = activeBoardConfigRef.current;
    if (!boardConfig) return;
    setClimbActions({ climb, boardConfig });
  }, []);

  const closeClimbActions = useCallback(() => {
    setClimbActions(null);
  }, []);

  const openAddToPlaylist = useCallback((climb: Climb) => {
    const boardConfig = activeBoardConfigRef.current;
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

  const openQueueSheet = useCallback(() => {
    setQueueSheetMounted(true);
    setQueueSheetVisible(true);
  }, []);
  // Request an animated close (flip `visible`; the sheet's dismiss animation then
  // fires onDismissed → unmount).
  const requestCloseQueueSheet = useCallback(() => setQueueSheetVisible(false), []);
  const handleQueueSheetDismissed = useCallback(() => {
    setQueueSheetVisible(false);
    setQueueSheetMounted(false);
  }, []);
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

  // Tap a queue item → make it current and show it in the play drawer.
  const handleQueueClimbPress = useCallback(
    (item: ClimbQueueItem) => {
      setCurrentClimb(item);
      openPlayDrawer(item.climb, { setAsCurrent: false });
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
      setCurrentClimb(item, { playlistSuggestionSource: source });
      openPlayDrawer(climb, { setAsCurrent: false });
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

  const value = useMemo<DrawerHostValue>(
    () => ({
      boardConfig: activeBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openQueueSheet,
    }),
    [
      activeBoardConfig,
      openPlayDrawer,
      openLogAscent,
      openClimbActions,
      closeClimbActions,
      openAddToPlaylist,
      openQueueSheet,
    ],
  );

  return (
    <DrawerHostContext.Provider value={value}>
      {children}
      {activeBoardConfig ? <PlayDrawer ref={playDrawerRef} boardConfig={activeBoardConfig} /> : null}
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
          boardName={climbActions.boardConfig.boardName}
          layoutId={climbActions.boardConfig.layoutId}
          sizeId={climbActions.boardConfig.sizeId}
          setIds={climbActions.boardConfig.setIds}
          angle={climbActions.boardConfig.angle}
          onAddToQueue={handleClimbActionsAddToQueue}
          onToggleFavorite={handleClimbActionsToggleFavorite}
          onTick={handleClimbActionsTick}
          onClose={closeClimbActions}
        />
      ) : null}
      {playlistClimb ? (
        <AddToPlaylistSheet
          visible
          climb={playlistClimb.climb}
          angle={playlistClimb.boardConfig.angle}
          onClose={closeAddToPlaylist}
        />
      ) : null}
      {queueSheetMounted && queueBoard ? (
        <QueueSheet
          visible={queueSheetVisible}
          board={queueBoard}
          onClose={requestCloseQueueSheet}
          onDismissed={handleQueueSheetDismissed}
          onClimbPress={handleQueueClimbPress}
          onSuggestionPress={handleQueueSuggestionPress}
          onTickHistory={handleQueueTickHistory}
        />
      ) : null}
      <QueueAddedSnackbar
        visible={snackbarVisible}
        nonce={snackbarNonce}
        onDismiss={dismissSnackbar}
        onOpen={handleSnackbarOpen}
      />
    </DrawerHostContext.Provider>
  );
}
