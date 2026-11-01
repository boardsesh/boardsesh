import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../lib/climb-filter-types';

export type ClimbFilterSelection = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
};

type FilterSession = { id: number; scopeKey: string };

/**
 * `S` is the whole selection the query reads. The Climbs list's is the filter
 * pair; a list with more in it (a playlist's sort and "Fits my board") passes a
 * wider object, so those wait out the same debounce as the filters and one
 * settled change is one request.
 */
type LiveClimbFiltersOptions<S extends ClimbFilterSelection> = {
  scopeKey: string | null;
  selection: S;
  onSelectionChange: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
  onDismiss: (selection: S) => void;
};

/** Keeps presentation separate from committed preferences. An old sheet cannot
 * close a newly opened one or publish a selection into a different board/login. */
export function useLiveClimbFilters<S extends ClimbFilterSelection>(options: LiveClimbFiltersOptions<S>) {
  const [session, setSession] = useState<FilterSession | null>(null);
  const sessionRef = useRef<FilterSession | null>(null);
  const nextSessionIdRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selectionRef = useRef(options.selection);
  selectionRef.current = options.selection;

  // True when this call opened the sheet; false when there is no board or it is
  // already open, so a caller can tell a real opening from a no-op.
  const openFilters = useCallback((): boolean => {
    const { scopeKey } = optionsRef.current;
    if (scopeKey === null || sessionRef.current?.scopeKey === scopeKey) return false;
    const nextSession = { id: ++nextSessionIdRef.current, scopeKey };
    sessionRef.current = nextSession;
    setSession(nextSession);
    return true;
  }, []);

  // External navigation/search cancellation ends the presentation without
  // recording a recent. The preferences have already been committed.
  const hideFilters = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
  }, []);

  const runWhileOpen = useCallback(
    (callback: () => void) => {
      const currentSession = sessionRef.current;
      if (
        currentSession &&
        currentSession.id === session?.id &&
        currentSession.scopeKey === optionsRef.current.scopeKey
      )
        callback();
    },
    [session?.id],
  );

  const onSelectionChange = useCallback(
    (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => {
      const currentSession = sessionRef.current;
      if (
        !currentSession ||
        currentSession.id !== session?.id ||
        currentSession.scopeKey !== optionsRef.current.scopeKey
      )
        return;
      // Synchronous snapshot: a last tap followed by a close in the same batch
      // must finalize the selection even before the parent's next render.
      selectionRef.current = { ...selectionRef.current, filters, boardFilters };
      optionsRef.current.onSelectionChange(filters, boardFilters);
    },
    [session?.id],
  );

  const closeFilters = useCallback(() => {
    const currentSession = sessionRef.current;
    if (!currentSession || currentSession.id !== session?.id || currentSession.scopeKey !== optionsRef.current.scopeKey)
      return;
    const finalSelection = selectionRef.current;
    sessionRef.current = null;
    setSession(null);
    optionsRef.current.onDismiss(finalSelection);
  }, [session?.id]);

  useEffect(() => {
    if (sessionRef.current && sessionRef.current.scopeKey !== options.scopeKey) hideFilters();
  }, [options.scopeKey, hideFilters]);

  useEffect(
    () => () => {
      sessionRef.current = null;
    },
    [],
  );

  const showFilters = session !== null && session.scopeKey === options.scopeKey;
  const querySelection = useDebouncedClimbFilterSelection(
    options.selection,
    showFilters,
    options.scopeKey,
    session?.id ?? null,
  );

  return { showFilters, openFilters, hideFilters, closeFilters, onSelectionChange, runWhileOpen, querySelection };
}

const FILTER_QUERY_DEBOUNCE_MS = 250;

/** Only the selection waits (the filter pair, plus whatever else a list put in
 * it). The screen's existing name debounce is not repeated here. Closing and
 * board/login changes use the latest selection at once. */
export function useDebouncedClimbFilterSelection<S extends ClimbFilterSelection>(
  selection: S,
  editing: boolean,
  scopeKey: string | null,
  sessionId: number | null,
): S {
  const [settled, setSettled] = useState(() => ({ scopeKey, sessionId, selection }));
  const sessionStartRef = useRef({ scopeKey, sessionId, selection });
  if (!editing || sessionStartRef.current.scopeKey !== scopeKey || sessionStartRef.current.sessionId !== sessionId) {
    sessionStartRef.current = { scopeKey, sessionId, selection };
  }
  useEffect(() => {
    if (!editing) {
      setSettled({ scopeKey, sessionId, selection });
      return;
    }
    const timeout = setTimeout(() => setSettled({ scopeKey, sessionId, selection }), FILTER_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [selection, editing, scopeKey, sessionId]);

  return useMemo(
    () =>
      !editing
        ? selection
        : settled.scopeKey === scopeKey && settled.sessionId === sessionId
          ? settled.selection
          : sessionStartRef.current.selection,
    [selection, editing, scopeKey, sessionId, settled],
  );
}
