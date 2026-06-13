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
import { useSaveClimb as useSaveClimbMutation, useUpdateClimb as useUpdateClimbMutation } from './use-save-climb';
import { logbookClimbAngleKey, type LogbookEntry } from './logbook-keys';
import type { SaveTickOptions } from './tick-helpers';
import type { SaveClimbOptions, SaveClimbResponse, UpdateClimbResponse } from './climb-helpers';

export type BoardContextType = {
  /**
   * Nullable: web normally has a concrete board from the route, mobile
   * resolves it asynchronously. Consumers should treat null as "no board
   * yet" — mutations throw rather than send an empty boardType.
   */
  boardName: BoardName | null;
  /**
   * UUID of the active board entity when the user is on a named-board route
   * (`/b/<slug>/...`). Null on the legacy config route, which doesn't
   * reference a specific board entity, and on platforms that resolve the
   * board by config alone.
   */
  boardUuid: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  logbook: LogbookEntry[];
  /** Timestamp for the latest tick this client saved in the active session. */
  lastSavedTickAt: string | null;
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
  updateClimb: (input: UpdateClimbInput) => Promise<UpdateClimbResponse>;
};

const BoardContext = createContext<BoardContextType | undefined>(undefined);

export function BoardProvider({
  boardName,
  boardUuid,
  children,
}: {
  boardName: BoardName | null;
  /**
   * Active board entity UUID. Set by named-board routes (`/b/<slug>/...`) so
   * ticks attach to that exact board even when the climber doesn't own it
   * (e.g. a seeded gym board). Omit on the legacy config route, which doesn't
   * reference a specific board entity.
   */
  boardUuid?: string;
  children: ReactNode;
}) {
  const { isAuthenticated, isAuthLoading, resolveActiveSessionId, lastSavedTickAt = null } = useBoardAdapter();
  const [isInitialized, setIsInitialized] = useState(false);
  const [climbUuids, setClimbUuids] = useState<string[]>([]);

  // React Query hooks for fetching + mutations. All shared.
  const { logbook } = useLogbookQuery(boardName, climbUuids);
  const saveTickMutation = useSaveTickMutation(boardName);
  const saveClimbMutation = useSaveClimbMutation(boardName);
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
  const updateClimbMutateRef = useRef(updateClimbMutation.mutateAsync);
  useEffect(() => {
    saveTickMutateRef.current = saveTickMutation.mutateAsync;
    saveClimbMutateRef.current = saveClimbMutation.mutateAsync;
    updateClimbMutateRef.current = updateClimbMutation.mutateAsync;
  });

  // Mirror the active board uuid into a ref so the stable empty-dep saveTick
  // callback always injects the latest value without taking boardUuid as a dep.
  const boardUuidRef = useRef(boardUuid);
  useEffect(() => {
    boardUuidRef.current = boardUuid;
  });

  const saveTick = useCallback(
    async (options: SaveTickOptions): Promise<void> => {
      const resolvedSessionId = options.sessionId ?? resolveActiveSessionId() ?? undefined;
      await saveTickMutateRef.current({
        ...options,
        sessionId: resolvedSessionId,
        boardUuid: options.boardUuid ?? boardUuidRef.current,
      });
    },
    [resolveActiveSessionId],
  );

  const saveClimb = useCallback(async (options: SaveClimbOptions): Promise<SaveClimbResponse> => {
    return saveClimbMutateRef.current(options);
  }, []);

  const updateClimb = useCallback(async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
    return updateClimbMutateRef.current(input);
  }, []);

  const value = useMemo<BoardContextType>(
    () => ({
      boardName,
      boardUuid: boardUuid ?? null,
      isAuthenticated,
      isLoading: isAuthLoading,
      error: null,
      isInitialized,
      logbook,
      lastSavedTickAt,
      logbookByClimbAngle,
      getLogbook,
      saveTick,
      saveClimb,
      updateClimb,
    }),
    [
      boardName,
      boardUuid,
      isAuthenticated,
      isAuthLoading,
      isInitialized,
      logbook,
      lastSavedTickAt,
      logbookByClimbAngle,
      getLogbook,
      saveTick,
      saveClimb,
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
