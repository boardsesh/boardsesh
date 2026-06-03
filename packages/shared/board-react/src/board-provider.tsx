// Shared BoardProvider — single React component used by both web and mobile.
// Wires the per-platform `BoardAdapter` into the data-access surface
// (`useBoardProvider()`) that climb screens, queue mutations, and form
// components consume. Adapter-side wiring is what differs per platform;
// the orchestration and the public surface are the same.

import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { BoardName, UpdateClimbInput } from '@boardsesh/shared-schema';
import { useBoardAdapter } from './adapter';
import { useLogbook as useLogbookQuery } from './use-logbook';
import { useSaveTick as useSaveTickMutation } from './use-save-tick';
import {
  useSaveClimb as useSaveClimbMutation,
  useSaveMoonBoardClimb as useSaveMoonBoardClimbMutation,
  useUpdateClimb as useUpdateClimbMutation,
} from './use-save-climb';
import { logbookClimbAngleKey, type LogbookEntry } from './logbook-keys';
import type { SaveTickOptions } from './tick-helpers';
import type {
  SaveClimbOptions,
  SaveClimbResponse,
  SaveMoonBoardClimbOptions,
  UpdateClimbResponse,
} from './climb-helpers';

export type BoardContextType = {
  /**
   * Nullable: web normally has a concrete board from the route, mobile
   * resolves it asynchronously. Consumers should treat null as "no board
   * yet" — mutations throw rather than send an empty boardType.
   */
  boardName: BoardName | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  logbook: LogbookEntry[];
  /**
   * The logbook grouped by `${climb_uuid}:${angle}` (see `logbookClimbAngleKey`).
   * Built once per logbook change so per-row consumers (the climb-list
   * ascent-status glyph) read their ticks in O(1) instead of scanning the whole
   * logbook on every render — turning O(rows × logbook) per merge into O(rows).
   */
  logbookByClimbAngle: Map<string, LogbookEntry[]>;
  getLogbook: (climbUuids: string[]) => Promise<void>;
  saveTick: (options: SaveTickOptions) => Promise<void>;
  saveClimb: (options: SaveClimbOptions) => Promise<SaveClimbResponse>;
  saveMoonBoardClimb: (options: SaveMoonBoardClimbOptions) => Promise<SaveClimbResponse>;
  updateClimb: (input: UpdateClimbInput) => Promise<UpdateClimbResponse>;
};

const BoardContext = createContext<BoardContextType | undefined>(undefined);

export function BoardProvider({ boardName, children }: { boardName: BoardName | null; children: ReactNode }) {
  const { isAuthenticated, isAuthLoading, resolveActiveSessionId } = useBoardAdapter();
  const [isInitialized, setIsInitialized] = useState(false);
  const [climbUuids, setClimbUuids] = useState<string[]>([]);

  // React Query hooks for fetching + mutations. All shared.
  const { logbook } = useLogbookQuery(boardName, climbUuids);
  const saveTickMutation = useSaveTickMutation(boardName);
  const saveClimbMutation = useSaveClimbMutation(boardName);
  const saveMoonBoardClimbMutation = useSaveMoonBoardClimbMutation();
  const updateClimbMutation = useUpdateClimbMutation();

  // Flip isInitialized once auth has resolved. Latched: once true, stays
  // true even if auth re-enters a loading state (e.g. token refresh).
  useEffect(() => {
    if (!isAuthLoading) {
      setIsInitialized(true);
    }
  }, [isAuthLoading]);

  const getLogbook = useCallback(async (uuids: string[]): Promise<void> => {
    setClimbUuids(uuids);
  }, []);

  // Group the logbook by climb+angle once whenever it changes. Each scrolled
  // page of climbs merges fresh ticks into a new `logbook` array, so without
  // this index every visible row re-runs a full `logbook.filter(...)` on every
  // merge (O(rows × logbook)); the index makes each row an O(1) lookup.
  const logbookByClimbAngle = useMemo<Map<string, LogbookEntry[]>>(() => {
    const index = new Map<string, LogbookEntry[]>();
    for (const entry of logbook) {
      const key = logbookClimbAngleKey(entry.climb_uuid, entry.angle);
      const bucket = index.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        index.set(key, [entry]);
      }
    }
    return index;
  }, [logbook]);

  // Stable callback identity for saveTick/saveClimb/updateClimb. React Query
  // mutation objects produce a fresh `mutateAsync` reference on every render,
  // so capture them in refs that are updated *after* commit (useEffect) —
  // never during render, which would be unsafe under React 18 strict / async
  // rendering. Empty-dep `useCallback` then keeps the public callback stable.
  const saveTickMutateRef = useRef(saveTickMutation.mutateAsync);
  const saveClimbMutateRef = useRef(saveClimbMutation.mutateAsync);
  const saveMoonBoardClimbMutateRef = useRef(saveMoonBoardClimbMutation.mutateAsync);
  const updateClimbMutateRef = useRef(updateClimbMutation.mutateAsync);
  useEffect(() => {
    saveTickMutateRef.current = saveTickMutation.mutateAsync;
    saveClimbMutateRef.current = saveClimbMutation.mutateAsync;
    saveMoonBoardClimbMutateRef.current = saveMoonBoardClimbMutation.mutateAsync;
    updateClimbMutateRef.current = updateClimbMutation.mutateAsync;
  });

  const saveTick = useCallback(
    async (options: SaveTickOptions): Promise<void> => {
      const resolvedSessionId = options.sessionId ?? resolveActiveSessionId() ?? undefined;
      await saveTickMutateRef.current({
        ...options,
        sessionId: resolvedSessionId,
      });
    },
    [resolveActiveSessionId],
  );

  const saveClimb = useCallback(async (options: SaveClimbOptions): Promise<SaveClimbResponse> => {
    return saveClimbMutateRef.current(options);
  }, []);

  const saveMoonBoardClimb = useCallback(async (options: SaveMoonBoardClimbOptions): Promise<SaveClimbResponse> => {
    return saveMoonBoardClimbMutateRef.current(options);
  }, []);

  const updateClimb = useCallback(async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
    return updateClimbMutateRef.current(input);
  }, []);

  const value = useMemo<BoardContextType>(
    () => ({
      boardName,
      isAuthenticated,
      isLoading: isAuthLoading,
      error: null,
      isInitialized,
      logbook,
      logbookByClimbAngle,
      getLogbook,
      saveTick,
      saveClimb,
      saveMoonBoardClimb,
      updateClimb,
    }),
    [
      boardName,
      isAuthenticated,
      isAuthLoading,
      isInitialized,
      logbook,
      logbookByClimbAngle,
      getLogbook,
      saveTick,
      saveClimb,
      saveMoonBoardClimb,
      updateClimb,
    ],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardProvider(): BoardContextType {
  const context = useContext(BoardContext);
  if (context === undefined) {
    throw new Error('useBoardProvider must be used within a BoardProvider');
  }
  return context;
}

export function useOptionalBoardProvider(): BoardContextType | null {
  return useContext(BoardContext) ?? null;
}

export { BoardContext };
