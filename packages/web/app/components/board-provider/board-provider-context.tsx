'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { BoardName, ClimbUuid } from '@/app/lib/types';
import type { SaveClimbOptions } from '@/app/lib/api-wrappers/aurora/types';
import { useSession } from 'next-auth/react';
import { useLogbook as useLogbookQuery, type LogbookEntry } from '@/app/hooks/use-logbook';
import { useSaveTick as useSaveTickMutation, type SaveTickOptions } from '@/app/hooks/use-save-tick';
import {
  useSaveClimb as useSaveClimbMutation,
  useUpdateClimb as useUpdateClimbMutation,
  type SaveClimbResponse,
  type UpdateClimbResponse,
} from '@/app/hooks/use-save-climb';
import { usePersistentSessionState } from '@/app/components/persistent-session/persistent-session-context';
import type { UpdateClimbInput } from '@boardsesh/shared-schema';

// Re-export types for backward compatibility
export type { SaveTickOptions } from '@/app/hooks/use-save-tick';
export type { SaveClimbResponse, UpdateClimbResponse } from '@/app/hooks/use-save-climb';
export type { TickStatus, LogbookEntry } from '@/app/hooks/use-logbook';

type BoardContextType = {
  boardName: BoardName;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  logbook: LogbookEntry[];
  getLogbook: (climbUuids: ClimbUuid[]) => Promise<void>;
  saveTick: (options: SaveTickOptions) => Promise<void>;
  saveClimb: (options: Omit<SaveClimbOptions, 'setter_id' | 'user_id'>) => Promise<SaveClimbResponse>;
  updateClimb: (input: UpdateClimbInput) => Promise<UpdateClimbResponse>;
};

const BoardContext = createContext<BoardContextType | undefined>(undefined);

export function BoardProvider({ boardName, children }: { boardName: BoardName; children: React.ReactNode }) {
  const { status: sessionStatus } = useSession();
  const { activeSession } = usePersistentSessionState();
  const [isInitialized, setIsInitialized] = useState(false);
  const [climbUuids, setClimbUuids] = useState<ClimbUuid[]>([]);

  // Use TanStack Query hooks for data fetching and mutations
  const { logbook } = useLogbookQuery(boardName, climbUuids);
  const saveTickMutation = useSaveTickMutation(boardName);
  const saveClimbMutation = useSaveClimbMutation(boardName);
  const updateClimbMutation = useUpdateClimbMutation();

  // Initialize when session status changes
  useEffect(() => {
    if (sessionStatus !== 'loading') {
      setIsInitialized(true);
    }
  }, [sessionStatus]);

  // getLogbook now just sets the climbUuids state; TanStack Query handles the fetch
  const getLogbook = useCallback(async (uuids: ClimbUuid[]): Promise<void> => {
    setClimbUuids(uuids);
  }, []);

  // Wrapper to maintain backward-compatible API.
  // Refs for stable callback identity — mutation objects change reference every
  // render, and the active session id should be read at call time. Synced in an
  // effect (not the render body) so concurrent/Strict-Mode double renders never
  // write through a half-rendered value; the refs are only read inside the
  // async useCallback handlers below, which run after commit.
  const saveTickMutateRef = useRef(saveTickMutation.mutateAsync);
  const saveClimbMutateRef = useRef(saveClimbMutation.mutateAsync);
  const updateClimbMutateRef = useRef(updateClimbMutation.mutateAsync);
  const activeSessionIdRef = useRef(activeSession?.sessionId);
  useEffect(() => {
    saveTickMutateRef.current = saveTickMutation.mutateAsync;
    saveClimbMutateRef.current = saveClimbMutation.mutateAsync;
    updateClimbMutateRef.current = updateClimbMutation.mutateAsync;
    activeSessionIdRef.current = activeSession?.sessionId;
  });

  const saveTick = useCallback(async (options: SaveTickOptions): Promise<void> => {
    const sessionId = options.sessionId ?? activeSessionIdRef.current;
    await saveTickMutateRef.current({
      ...options,
      sessionId,
    });
  }, []);

  const saveClimb = useCallback(
    async (options: Omit<SaveClimbOptions, 'setter_id' | 'user_id'>): Promise<SaveClimbResponse> => {
      return saveClimbMutateRef.current(options);
    },
    [],
  );

  const updateClimb = useCallback(async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
    return updateClimbMutateRef.current(input);
  }, []);

  const isAuthenticated = sessionStatus === 'authenticated';
  const isLoading = sessionStatus === 'loading';

  const value = useMemo<BoardContextType>(
    () => ({
      boardName,
      isAuthenticated,
      isLoading,
      error: null,
      isInitialized,
      logbook,
      getLogbook,
      saveTick,
      saveClimb,
      updateClimb,
    }),
    [boardName, isAuthenticated, isLoading, isInitialized, logbook, getLogbook, saveTick, saveClimb, updateClimb],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardProvider() {
  const context = useContext(BoardContext);
  if (context === undefined) {
    throw new Error('useBoardProvider must be used within a BoardProvider');
  }
  return context;
}

export function useOptionalBoardProvider(): BoardContextType | null {
  return useContext(BoardContext) ?? null;
}

export type { BoardContextType };
export { BoardContext };
