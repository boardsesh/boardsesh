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
import type { Climb } from '@boardsesh/shared-schema';
import { PlayDrawer, type PlayDrawerHandle, type PlayDrawerOpenOptions } from '../components/play-drawer';
import { LogAscentSheet } from '../components/LogAscentSheet';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { ClimbActionsSheet } from '../components/ClimbActionsSheet';
import { useToggleFavorite } from '../lib/graphql/hooks';
import { useQueue } from './queue-provider';

export type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type LogAscentInput = {
  climbUuid: string;
  climbName: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
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
  const [climbActionsClimb, setClimbActionsClimb] = useState<Climb | null>(null);
  const { addToQueue } = useQueue();
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

  const openClimbActions = useCallback((climb: Climb) => {
    setClimbActionsClimb(climb);
  }, []);

  const closeClimbActions = useCallback(() => {
    setClimbActionsClimb(null);
  }, []);

  // Pin the boardConfig that was active when the sheet opened so it doesn't
  // shift mid-interaction if the user's default board changes.
  const climbActionsBoardConfig = useMemo(
    () => (climbActionsClimb ? activeBoardConfig : null),
    [climbActionsClimb, activeBoardConfig],
  );

  const handleClimbActionsAddToQueue = useCallback(() => {
    if (!climbActionsClimb) return;
    addToQueue({ uuid: randomUUID(), climb: climbActionsClimb });
  }, [climbActionsClimb, addToQueue]);

  const handleClimbActionsToggleFavorite = useCallback(() => {
    if (!climbActionsClimb || !climbActionsBoardConfig) return;
    toggleFavoriteMutate({
      input: {
        boardName: climbActionsBoardConfig.boardName,
        climbUuid: climbActionsClimb.uuid,
        angle: climbActionsBoardConfig.angle,
      },
    });
  }, [climbActionsClimb, climbActionsBoardConfig, toggleFavoriteMutate]);

  const handleClimbActionsTick = useCallback(() => {
    if (!climbActionsClimb || !climbActionsBoardConfig) return;
    setLogAscentInput({
      climbUuid: climbActionsClimb.uuid,
      climbName: climbActionsClimb.name,
      boardName: climbActionsBoardConfig.boardName,
      angle: climbActionsBoardConfig.angle,
      isMirror: false,
      isBenchmark: !!climbActionsClimb.benchmark_difficulty,
      layoutId: climbActionsBoardConfig.layoutId,
      sizeId: climbActionsBoardConfig.sizeId,
      setIds: climbActionsBoardConfig.setIds,
    });
  }, [climbActionsClimb, climbActionsBoardConfig]);

  const value = useMemo<DrawerHostValue>(
    () => ({ boardConfig: activeBoardConfig, openPlayDrawer, openLogAscent, openClimbActions, closeClimbActions }),
    [activeBoardConfig, openPlayDrawer, openLogAscent, openClimbActions, closeClimbActions],
  );

  return (
    <DrawerHostContext.Provider value={value}>
      {children}
      {activeBoardConfig ? <PlayDrawer ref={playDrawerRef} boardConfig={activeBoardConfig} /> : null}
      {logAscentInput ? (
        <LogAscentSheet
          onDismiss={dismissLogAscent}
          climbUuid={logAscentInput.climbUuid}
          climbName={logAscentInput.climbName}
          boardName={logAscentInput.boardName}
          angle={logAscentInput.angle}
          isMirror={logAscentInput.isMirror}
          isBenchmark={logAscentInput.isBenchmark}
          layoutId={logAscentInput.layoutId}
          sizeId={logAscentInput.sizeId}
          setIds={logAscentInput.setIds}
          sessionId={logAscentInput.sessionId}
        />
      ) : null}
      {climbActionsClimb && climbActionsBoardConfig ? (
        <ClimbActionsSheet
          visible
          climb={climbActionsClimb}
          boardName={climbActionsBoardConfig.boardName}
          layoutId={climbActionsBoardConfig.layoutId}
          sizeId={climbActionsBoardConfig.sizeId}
          setIds={climbActionsBoardConfig.setIds}
          angle={climbActionsBoardConfig.angle}
          onAddToQueue={handleClimbActionsAddToQueue}
          onToggleFavorite={handleClimbActionsToggleFavorite}
          onTick={handleClimbActionsTick}
          onClose={closeClimbActions}
        />
      ) : null}
    </DrawerHostContext.Provider>
  );
}
