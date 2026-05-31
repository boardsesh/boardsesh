// BoardProvider — the mobile source of truth for the user's ACTIVE board, plus
// the board-data surface (logbook / ticks / climb create+update) built on the
// shared, renderer-agnostic `@boardsesh/board-react` hooks.
//
// Active board: persisted in unsecure AsyncStorage (active-board-store), seeded
// from the server default (`useDefaultBoard()`) on first run when there's no
// local pref. `setActiveBoard` writes the local pref AND mirrors the server
// default so other devices stay consistent. Mobile has no `/[board_name]/`
// route, so this provider — not a URL — is how the active board is known.
//
// Platform I/O for the shared hooks is injected via the mobile deps builders
// (see mobile-board-data-deps). The per-climb play-drawer keeps calling the
// shared tick hook directly with its own (override) board; this provider is for
// active-board surfaces (logbook screens, etc.).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BoardName, UpdateClimbInput } from '@boardsesh/shared-schema';
import {
  useLogbook as useSharedLogbook,
  useSaveTick as useSharedSaveTick,
  useSaveClimb as useSharedSaveClimb,
  useUpdateClimb as useSharedUpdateClimb,
  type LogbookEntry,
  type SaveTickOptions,
  type SaveClimbOptions,
  type SaveClimbResponse,
  type UpdateClimbResponse,
} from '@boardsesh/board-react';
import { useAuth } from './auth-provider';
import { useQueue } from './queue-provider';
import {
  useMobileLogbookDeps,
  useMobileSaveTickDeps,
  useMobileSaveClimbDeps,
  useMobileUpdateClimbDeps,
} from './mobile-board-data-deps';
import { useDefaultBoard } from '../lib/graphql/hooks';
import { toBoardName } from '../lib/board-name';
import {
  getActiveBoard,
  setActiveBoard as persistActiveBoard,
  type ActiveBoardConfig,
} from '../lib/active-board-store';

export type { LogbookEntry, TickStatus, SaveTickOptions, SaveClimbOptions } from '@boardsesh/board-react';
export type { ActiveBoardConfig } from '../lib/active-board-store';

type BoardContextValue = {
  activeBoard: ActiveBoardConfig | null;
  boardName: BoardName | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  setActiveBoard: (config: ActiveBoardConfig) => Promise<void>;
  logbook: LogbookEntry[];
  getLogbook: (climbUuids: string[]) => Promise<void>;
  saveTick: (options: SaveTickOptions) => Promise<void>;
  saveClimb: (options: SaveClimbOptions) => Promise<SaveClimbResponse>;
  updateClimb: (input: UpdateClimbInput) => Promise<UpdateClimbResponse>;
};

const BoardContext = createContext<BoardContextValue | undefined>(undefined);

export function BoardProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { sessionId } = useQueue();
  const { data: defaultBoard } = useDefaultBoard();

  const [activeBoard, setActiveBoardState] = useState<ActiveBoardConfig | null>(null);
  const [activeBoardLoaded, setActiveBoardLoaded] = useState(false);
  const [climbUuids, setClimbUuids] = useState<string[]>([]);

  // Load the persisted active board once on mount.
  useEffect(() => {
    let mounted = true;
    getActiveBoard()
      .then((stored) => {
        if (mounted && stored) setActiveBoardState(stored);
      })
      .finally(() => {
        if (mounted) setActiveBoardLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Seed from the server default once, only when there's no local pref yet.
  useEffect(() => {
    if (!activeBoardLoaded || activeBoard || !defaultBoard) return;
    setActiveBoardState({
      boardUuid: defaultBoard.uuid,
      boardName: defaultBoard.boardType,
      layoutId: defaultBoard.layoutId,
      sizeId: defaultBoard.sizeId,
      setIds: defaultBoard.setIds,
      angle: defaultBoard.angle,
    });
  }, [activeBoardLoaded, activeBoard, defaultBoard]);

  const boardName = toBoardName(activeBoard?.boardName);

  const setActiveBoard = useCallback(async (config: ActiveBoardConfig) => {
    // Provider state is the source of truth; persist the pref so it survives
    // relaunch. The legacy ['defaultBoard'] React Query cache that the
    // remaining useDefaultBoard() readers consume is still updated by the
    // caller (the board picker) with the full UserBoard — see issue #2418.
    setActiveBoardState(config);
    await persistActiveBoard(config);
  }, []);

  const getLogbook = useCallback(async (uuids: string[]): Promise<void> => {
    setClimbUuids(uuids);
  }, []);

  // ── Shared board-data hooks, wired with mobile deps ──────────────────────
  const { logbook } = useSharedLogbook(useMobileLogbookDeps(), boardName, climbUuids);
  const saveTickMutation = useSharedSaveTick(useMobileSaveTickDeps(), boardName);
  const saveClimbMutation = useSharedSaveClimb(useMobileSaveClimbDeps(), boardName);
  const updateClimbMutation = useSharedUpdateClimb(useMobileUpdateClimbDeps());

  // Stable wrapper callbacks — mutation objects change identity each render, and
  // the active session id is read at call time. Synced in an effect (not the
  // render body) so Strict/concurrent double-renders never write a half value.
  const saveTickMutateRef = useRef(saveTickMutation.mutateAsync);
  const saveClimbMutateRef = useRef(saveClimbMutation.mutateAsync);
  const updateClimbMutateRef = useRef(updateClimbMutation.mutateAsync);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    saveTickMutateRef.current = saveTickMutation.mutateAsync;
    saveClimbMutateRef.current = saveClimbMutation.mutateAsync;
    updateClimbMutateRef.current = updateClimbMutation.mutateAsync;
    sessionIdRef.current = sessionId;
  });

  const saveTick = useCallback(async (options: SaveTickOptions): Promise<void> => {
    const resolvedSessionId = options.sessionId ?? sessionIdRef.current ?? undefined;
    await saveTickMutateRef.current({ ...options, sessionId: resolvedSessionId });
  }, []);

  const saveClimb = useCallback(async (options: SaveClimbOptions): Promise<SaveClimbResponse> => {
    return saveClimbMutateRef.current(options);
  }, []);

  const updateClimb = useCallback(async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
    return updateClimbMutateRef.current(input);
  }, []);

  const isInitialized = !authLoading && activeBoardLoaded;

  const value = useMemo<BoardContextValue>(
    () => ({
      activeBoard,
      boardName,
      isAuthenticated,
      isLoading: authLoading,
      isInitialized,
      setActiveBoard,
      logbook,
      getLogbook,
      saveTick,
      saveClimb,
      updateClimb,
    }),
    [
      activeBoard,
      boardName,
      isAuthenticated,
      authLoading,
      isInitialized,
      setActiveBoard,
      logbook,
      getLogbook,
      saveTick,
      saveClimb,
      updateClimb,
    ],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardProvider(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (ctx === undefined) {
    throw new Error('useBoardProvider must be used within a BoardProvider');
  }
  return ctx;
}

export function useOptionalBoardProvider(): BoardContextValue | null {
  return useContext(BoardContext) ?? null;
}
