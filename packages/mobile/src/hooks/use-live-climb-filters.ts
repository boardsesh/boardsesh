import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../lib/climb-filter-types';

export type ClimbFilterSelection = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
};

type FilterSession = { id: number; scopeKey: string };

type LiveClimbFiltersOptions = {
  scopeKey: string | null;
  selection: ClimbFilterSelection;
  onSelectionChange: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
  onDismiss: (selection: ClimbFilterSelection) => void;
};

/** Keeps presentation separate from committed preferences. An old sheet cannot
 * close a newly opened one or publish a selection into a different board/login. */
export function useLiveClimbFilters(options: LiveClimbFiltersOptions) {
  const [session, setSession] = useState<FilterSession | null>(null);
  const sessionRef = useRef<FilterSession | null>(null);
  const nextSessionIdRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selectionRef = useRef(options.selection);
  selectionRef.current = options.selection;

  const openFilters = useCallback(() => {
    const { scopeKey } = optionsRef.current;
    if (scopeKey === null || sessionRef.current?.scopeKey === scopeKey) return;
    const nextSession = { id: ++nextSessionIdRef.current, scopeKey };
    sessionRef.current = nextSession;
    setSession(nextSession);
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
      selectionRef.current = { filters, boardFilters };
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

/** Only the filter pair waits. The screen's existing name debounce is not
 * repeated here. Closing and board/login changes use the latest pair at once. */
export function useDebouncedClimbFilterSelection(
  selection: ClimbFilterSelection,
  editing: boolean,
  scopeKey: string | null,
  sessionId: number | null,
): ClimbFilterSelection {
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
