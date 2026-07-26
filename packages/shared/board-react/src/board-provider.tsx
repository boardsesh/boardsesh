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
  /**
   * The logbook grouped by `${climb_uuid}:${angle}` (see `logbookClimbAngleKey`).
   * Built once per logbook change so per-row consumers (the climb-list
   * ascent-status glyph) read their ticks in O(1) instead of scanning the whole
   * logbook on every render — turning O(rows × logbook) per merge into O(rows).
   */
  logbookByClimbAngle: Map<string, LogbookEntry[]>;
  /**
   * Climb uuids the logbook has actually been fetched for. A uuid missing here
   * means "unknown", not "no ticks" — an empty `logbookByClimbAngle` lookup is
   * ambiguous until the fetch lands, and treating it as "no history" is what
   * let a repeat ascent be offered as a Flash (#3940).
   */
  fetchedLogbookClimbUuids: ReadonlySet<string>;
  getLogbook: (climbUuids: string[]) => Promise<void>;
  saveTick: (options: SaveTickOptions) => Promise<void>;
  saveClimb: (options: SaveClimbOptions) => Promise<SaveClimbResponse>;
  updateClimb: (input: UpdateClimbInput) => Promise<UpdateClimbResponse>;
};

/**
 * The stable half of the board context: identity, auth/init flags, and the
 * callbacks. Excludes `logbook`/`logbookByClimbAngle`, so its value identity
 * does NOT change when the logbook merges — a consumer that only needs
 * `getLogbook`/`saveTick`/`saveClimb`/`updateClimb` (or `boardName`/auth) reads
 * this via `useBoardActions()` and skips the per-merge re-render cascade.
 */
export type BoardActionsContextType = Omit<
  BoardContextType,
  'logbook' | 'logbookByClimbAngle' | 'fetchedLogbookClimbUuids'
>;

/**
 * The volatile half: the logbook and its prebuilt `${climb_uuid}:${angle}`
 * index. Identity changes on every logbook merge, so only the per-row
 * ascent-status reader (`useAscentStatus`) and the tick forms subscribe to it
 * via `useBoardLogbook()` — they SHOULD re-render when ticks change.
 */
export type BoardLogbookContextType = Pick<
  BoardContextType,
  'logbook' | 'logbookByClimbAngle' | 'fetchedLogbookClimbUuids'
>;

// Full context kept for back-compat: web and any consumer wanting everything
// still use `useBoardProvider()`. Its value still changes on a logbook merge
// (it contains the logbook), which is fine for those consumers.
const BoardContext = createContext<BoardContextType | undefined>(undefined);
const BoardActionsContext = createContext<BoardActionsContextType | undefined>(undefined);
const BoardLogbookContext = createContext<BoardLogbookContextType | undefined>(undefined);

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
  const { isAuthenticated, isAuthLoading, resolveActiveSessionId } = useBoardAdapter();
  const [isInitialized, setIsInitialized] = useState(false);
  const [climbUuids, setClimbUuids] = useState<string[]>([]);

  // React Query hooks for fetching + mutations. All shared.
  const { logbook, fetchedUuids: fetchedLogbookClimbUuids } = useLogbookQuery(boardName, climbUuids);
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

  // Stable slice: NO logbook deps, so its identity holds steady across logbook
  // merges. Consumers reading only callbacks/identity (via `useBoardActions`)
  // don't re-render when the user scrolls and ticks merge in mid-fling.
  const actionsValue = useMemo<BoardActionsContextType>(
    () => ({
      boardName,
      boardUuid: boardUuid ?? null,
      isAuthenticated,
      isLoading: isAuthLoading,
      error: null,
      isInitialized,
      getLogbook,
      saveTick,
      saveClimb,
      updateClimb,
    }),
    [boardName, boardUuid, isAuthenticated, isAuthLoading, isInitialized, getLogbook, saveTick, saveClimb, updateClimb],
  );

  // Volatile slice: changes on every merge. Only the ascent-status reader and
  // tick forms subscribe to it.
  const logbookValue = useMemo<BoardLogbookContextType>(
    () => ({ logbook, logbookByClimbAngle, fetchedLogbookClimbUuids }),
    [logbook, logbookByClimbAngle, fetchedLogbookClimbUuids],
  );

  // Full value derived from the two slices so back-compat `useBoardProvider()`
  // consumers keep seeing every field (and the latest logbook).
  const value = useMemo<BoardContextType>(() => ({ ...actionsValue, ...logbookValue }), [actionsValue, logbookValue]);

  return (
    <BoardContext.Provider value={value}>
      <BoardActionsContext.Provider value={actionsValue}>
        <BoardLogbookContext.Provider value={logbookValue}>{children}</BoardLogbookContext.Provider>
      </BoardActionsContext.Provider>
    </BoardContext.Provider>
  );
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

/**
 * Stable board context: identity, auth/init flags, and callbacks — never the
 * logbook. Prefer this over `useBoardProvider()` whenever a component reads only
 * callbacks/identity, so a logbook merge doesn't re-render it.
 */
export function useBoardActions(): BoardActionsContextType {
  const context = useContext(BoardActionsContext);
  if (context === undefined) {
    throw new Error('useBoardActions must be used within a BoardProvider');
  }
  return context;
}

export function useOptionalBoardActions(): BoardActionsContextType | null {
  return useContext(BoardActionsContext) ?? null;
}

/** Volatile logbook context — `logbook` + the `logbookByClimbAngle` index.
 *  Subscribing here re-renders on every logbook merge; only read it where that
 *  is the intent (per-row ascent status, tick forms). */
export function useBoardLogbook(): BoardLogbookContextType {
  const context = useContext(BoardLogbookContext);
  if (context === undefined) {
    throw new Error('useBoardLogbook must be used within a BoardProvider');
  }
  return context;
}

export function useOptionalBoardLogbook(): BoardLogbookContextType | null {
  return useContext(BoardLogbookContext) ?? null;
}

// Only the full `BoardContext` is exported (web reads it directly). The split
// contexts stay module-private so consumers go through the guarded hooks above
// rather than a raw `useContext` that skips the within-provider invariant.
export { BoardContext };
