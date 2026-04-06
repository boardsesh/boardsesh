// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React, { createContext, useContext, useRef, useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import type { Climb, SearchRequestPagination, ParsedBoardRouteParameters } from '@/app/lib/types';
import type { ClimbQueueItem } from '../../queue-control/types';

// Re-define the types locally to avoid importing from QueueContext (which pulls in the full dep tree)
interface CurrentClimbDataType {
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
}

interface QueueListDataType {
  queue: ClimbQueueItem[];
}

interface SearchDataType {
  climbSearchParams: SearchRequestPagination;
  climbSearchResults: Climb[] | null;
  suggestedClimbs: Climb[];
  totalSearchResultCount: number | null;
  hasMoreResults: boolean;
  isFetchingClimbs: boolean;
  isFetchingNextPage: boolean;
  hasDoneFirstFetch: boolean;
  parsedParams: ParsedBoardRouteParameters;
}

interface SessionDataType {
  viewOnlyMode: boolean;
  isSessionActive: boolean;
  sessionId: string | null;
  sessionSummary: unknown;
  sessionGoal: string | null;
  connectionState: string;
  canMutate: boolean;
  isDisconnected: boolean;
  users: unknown[];
  clientId: string | null;
  isLeader: boolean;
  isBackendMode: boolean;
  hasConnected: boolean;
  connectionError: Error | null;
}

// Create standalone contexts to test the isolation pattern without importing the full QueueContext module
const CurrentClimbContext = createContext<CurrentClimbDataType | undefined>(undefined);
const QueueListContext = createContext<QueueListDataType | undefined>(undefined);
const SearchContext = createContext<SearchDataType | undefined>(undefined);
const SessionContext = createContext<SessionDataType | undefined>(undefined);

// Standalone hooks (same pattern as the real ones)
function useCurrentClimb(): CurrentClimbDataType {
  const ctx = useContext(CurrentClimbContext);
  if (!ctx) throw new Error('missing CurrentClimbContext');
  return ctx;
}
function useQueueList(): QueueListDataType {
  const ctx = useContext(QueueListContext);
  if (!ctx) throw new Error('missing QueueListContext');
  return ctx;
}
function useSearchData(): SearchDataType {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error('missing SearchContext');
  return ctx;
}
function useSessionData(): SessionDataType {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('missing SessionContext');
  return ctx;
}

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    setter_username: 'tester',
    name: 'Test Climb',
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '5',
    quality_average: '3.5',
    stars: 4,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeClimbQueueItem(overrides: Partial<ClimbQueueItem> = {}): ClimbQueueItem {
  return {
    climb: makeClimb(),
    uuid: 'queue-item-1',
    ...overrides,
  };
}

function makeParsedParams(overrides: Partial<ParsedBoardRouteParameters> = {}): ParsedBoardRouteParameters {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: [1],
    angle: 40,
    ...overrides,
  };
}

function makeSearchParams(overrides: Partial<SearchRequestPagination> = {}): SearchRequestPagination {
  return {
    gradeAccuracy: 1,
    maxGrade: 30,
    minAscents: 0,
    minGrade: 0,
    minRating: 0,
    sortBy: 'popular',
    sortOrder: 'desc',
    name: '',
    onlyClassics: false,
    onlyTallClimbs: false,
    settername: [],
    setternameSuggestion: '',
    holdsFilter: {},
    hideAttempted: false,
    hideCompleted: false,
    showOnlyAttempted: false,
    showOnlyCompleted: false,
    onlyDrafts: false,
    page: 0,
    pageSize: 20,
    ...overrides,
  };
}

function makeCurrentClimbData(overrides: Partial<CurrentClimbDataType> = {}): CurrentClimbDataType {
  return {
    currentClimbQueueItem: makeClimbQueueItem(),
    currentClimb: makeClimb(),
    ...overrides,
  };
}

function makeQueueListData(overrides: Partial<QueueListDataType> = {}): QueueListDataType {
  return {
    queue: [makeClimbQueueItem()],
    ...overrides,
  };
}

function makeSearchData(overrides: Partial<SearchDataType> = {}): SearchDataType {
  return {
    climbSearchParams: makeSearchParams(),
    climbSearchResults: null,
    suggestedClimbs: [],
    totalSearchResultCount: null,
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
    hasDoneFirstFetch: false,
    parsedParams: makeParsedParams(),
    ...overrides,
  };
}

function makeSessionData(overrides: Partial<SessionDataType> = {}): SessionDataType {
  return {
    viewOnlyMode: false,
    isSessionActive: false,
    sessionId: null,
    sessionSummary: null,
    sessionGoal: null,
    connectionState: 'idle',
    canMutate: true,
    isDisconnected: false,
    users: [],
    clientId: null,
    isLeader: false,
    isBackendMode: false,
    hasConnected: false,
    connectionError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test wrapper that exposes setters for each context independently
// ---------------------------------------------------------------------------

function createTestWrapper() {
  let setCurrentClimb: React.Dispatch<React.SetStateAction<CurrentClimbDataType>>;
  let setQueueList: React.Dispatch<React.SetStateAction<QueueListDataType>>;
  let setSearch: React.Dispatch<React.SetStateAction<SearchDataType>>;
  let setSession: React.Dispatch<React.SetStateAction<SessionDataType>>;

  const Wrapper = ({ children }: { children: React.ReactNode }) => {
    const [currentClimb, _setCurrentClimb] = useState<CurrentClimbDataType>(makeCurrentClimbData());
    const [queueList, _setQueueList] = useState<QueueListDataType>(makeQueueListData());
    const [search, _setSearch] = useState<SearchDataType>(makeSearchData());
    const [session, _setSession] = useState<SessionDataType>(makeSessionData());

    setCurrentClimb = _setCurrentClimb;
    setQueueList = _setQueueList;
    setSearch = _setSearch;
    setSession = _setSession;

    return (
      <CurrentClimbContext.Provider value={currentClimb}>
        <QueueListContext.Provider value={queueList}>
          <SearchContext.Provider value={search}>
            <SessionContext.Provider value={session}>
              {children}
            </SessionContext.Provider>
          </SearchContext.Provider>
        </QueueListContext.Provider>
      </CurrentClimbContext.Provider>
    );
  };

  return {
    Wrapper,
    update: {
      currentClimb: (v: CurrentClimbDataType) => act(() => setCurrentClimb(v)),
      queueList: (v: QueueListDataType) => act(() => setQueueList(v)),
      search: (v: SearchDataType) => act(() => setSearch(v)),
      session: (v: SessionDataType) => act(() => setSession(v)),
    },
  };
}

// ---------------------------------------------------------------------------
// Render counter helper
// ---------------------------------------------------------------------------

function useWithRenderCount<T>(useHook: () => T) {
  const count = useRef(0);
  count.current++;
  const data = useHook();
  return { data, renderCount: count };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fine-grained context split isolation', () => {
  it('useCurrentClimb does not re-render when queue changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useCurrentClimb), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    // Update queue list context -- should NOT trigger a re-render for useCurrentClimb
    update.queueList({
      queue: [
        makeClimbQueueItem({ uuid: 'new-item-1' }),
        makeClimbQueueItem({ uuid: 'new-item-2' }),
      ],
    });

    expect(result.current.renderCount.current).toBe(initialRenderCount);
  });

  it('useQueueList does not re-render when currentClimb changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useQueueList), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    // Update current climb context -- should NOT trigger a re-render for useQueueList
    update.currentClimb(
      makeCurrentClimbData({
        currentClimbQueueItem: makeClimbQueueItem({
          uuid: 'different-item',
          climb: makeClimb({ uuid: 'different-climb', name: 'Different Climb' }),
        }),
        currentClimb: makeClimb({ uuid: 'different-climb', name: 'Different Climb' }),
      }),
    );

    expect(result.current.renderCount.current).toBe(initialRenderCount);
  });

  it('useSearchData does not re-render when currentClimb or queue changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useSearchData), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    // Update current climb context
    update.currentClimb(
      makeCurrentClimbData({
        currentClimbQueueItem: makeClimbQueueItem({ uuid: 'changed' }),
      }),
    );

    // Update queue list context
    update.queueList({
      queue: [makeClimbQueueItem({ uuid: 'q1' }), makeClimbQueueItem({ uuid: 'q2' })],
    });

    expect(result.current.renderCount.current).toBe(initialRenderCount);
  });

  it('useSessionData does not re-render when currentClimb or queue changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useSessionData), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    // Update current climb context
    update.currentClimb(
      makeCurrentClimbData({
        currentClimbQueueItem: makeClimbQueueItem({ uuid: 'x' }),
      }),
    );

    // Update queue list context
    update.queueList({ queue: [] });

    expect(result.current.renderCount.current).toBe(initialRenderCount);
  });

  it('useCurrentClimb re-renders when its own data changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useCurrentClimb), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    const newClimb = makeClimb({ uuid: 'updated-climb', name: 'Updated Climb' });
    const newItem = makeClimbQueueItem({ uuid: 'updated-item', climb: newClimb });

    update.currentClimb({
      currentClimbQueueItem: newItem,
      currentClimb: newClimb,
    });

    // Should have re-rendered
    expect(result.current.renderCount.current).toBeGreaterThan(initialRenderCount);
    // Should return the updated values
    expect(result.current.data.currentClimb?.uuid).toBe('updated-climb');
    expect(result.current.data.currentClimbQueueItem?.uuid).toBe('updated-item');
  });

  it('useQueueList re-renders when its own data changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useQueueList), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    update.queueList({
      queue: [
        makeClimbQueueItem({ uuid: 'a' }),
        makeClimbQueueItem({ uuid: 'b' }),
        makeClimbQueueItem({ uuid: 'c' }),
      ],
    });

    expect(result.current.renderCount.current).toBeGreaterThan(initialRenderCount);
    expect(result.current.data.queue).toHaveLength(3);
  });

  it('useSearchData re-renders when its own data changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useSearchData), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    update.search(
      makeSearchData({
        isFetchingClimbs: true,
        climbSearchResults: [makeClimb({ uuid: 'result-1' })],
      }),
    );

    expect(result.current.renderCount.current).toBeGreaterThan(initialRenderCount);
    expect(result.current.data.isFetchingClimbs).toBe(true);
    expect(result.current.data.climbSearchResults).toHaveLength(1);
  });

  it('useSessionData re-renders when its own data changes', () => {
    const { Wrapper, update } = createTestWrapper();

    const { result } = renderHook(() => useWithRenderCount(useSessionData), {
      wrapper: Wrapper,
    });

    const initialRenderCount = result.current.renderCount.current;

    update.session(
      makeSessionData({
        isSessionActive: true,
        sessionId: 'session-123',
        connectionState: 'connected',
      }),
    );

    expect(result.current.renderCount.current).toBeGreaterThan(initialRenderCount);
    expect(result.current.data.isSessionActive).toBe(true);
    expect(result.current.data.sessionId).toBe('session-123');
  });

  it('hooks return correct initial data', () => {
    const { Wrapper } = createTestWrapper();

    const { result: currentClimbResult } = renderHook(() => useCurrentClimb(), {
      wrapper: Wrapper,
    });
    const { result: queueListResult } = renderHook(() => useQueueList(), {
      wrapper: Wrapper,
    });
    const { result: searchResult } = renderHook(() => useSearchData(), {
      wrapper: Wrapper,
    });
    const { result: sessionResult } = renderHook(() => useSessionData(), {
      wrapper: Wrapper,
    });

    // CurrentClimb
    expect(currentClimbResult.current.currentClimbQueueItem).not.toBeNull();
    expect(currentClimbResult.current.currentClimb?.uuid).toBe('climb-1');

    // QueueList
    expect(queueListResult.current.queue).toHaveLength(1);
    expect(queueListResult.current.queue[0].uuid).toBe('queue-item-1');

    // Search
    expect(searchResult.current.climbSearchResults).toBeNull();
    expect(searchResult.current.isFetchingClimbs).toBe(false);
    expect(searchResult.current.parsedParams.board_name).toBe('kilter');

    // Session
    expect(sessionResult.current.isSessionActive).toBe(false);
    expect(sessionResult.current.connectionState).toBe('idle');
    expect(sessionResult.current.users).toHaveLength(0);
  });

  it('changing one context does not trigger re-renders in any other context subscriber', () => {
    // To test cross-context isolation we need multiple independent consumer
    // components sharing a single provider tree. We achieve this by rendering
    // a custom component that uses React.memo children, each subscribing to
    // exactly one context, with render counts tracked via refs exposed through
    // a shared mutable store.

    const counts = {
      currentClimb: 0,
      queueList: 0,
      search: 0,
      session: 0,
    };

    // Each consumer is memo'd so parent re-renders alone won't bump the counter --
    // only context value changes will.
    const CurrentClimbConsumer = React.memo(function CurrentClimbConsumer() {
      counts.currentClimb++;
      useCurrentClimb();
      return null;
    });

    const QueueListConsumer = React.memo(function QueueListConsumer() {
      counts.queueList++;
      useQueueList();
      return null;
    });

    const SearchConsumer = React.memo(function SearchConsumer() {
      counts.search++;
      useSearchData();
      return null;
    });

    const SessionConsumer = React.memo(function SessionConsumer() {
      counts.session++;
      useSessionData();
      return null;
    });

    let setCurrentClimb: React.Dispatch<React.SetStateAction<CurrentClimbDataType>>;
    let setQueueList: React.Dispatch<React.SetStateAction<QueueListDataType>>;
    let setSearch: React.Dispatch<React.SetStateAction<SearchDataType>>;
    let setSession: React.Dispatch<React.SetStateAction<SessionDataType>>;

    function TestTree() {
      const [currentClimb, _setCurrentClimb] = useState<CurrentClimbDataType>(makeCurrentClimbData());
      const [queueList, _setQueueList] = useState<QueueListDataType>(makeQueueListData());
      const [search, _setSearch] = useState<SearchDataType>(makeSearchData());
      const [session, _setSession] = useState<SessionDataType>(makeSessionData());

      setCurrentClimb = _setCurrentClimb;
      setQueueList = _setQueueList;
      setSearch = _setSearch;
      setSession = _setSession;

      return (
        <CurrentClimbContext.Provider value={currentClimb}>
          <QueueListContext.Provider value={queueList}>
            <SearchContext.Provider value={search}>
              <SessionContext.Provider value={session}>
                <CurrentClimbConsumer />
                <QueueListConsumer />
                <SearchConsumer />
                <SessionConsumer />
              </SessionContext.Provider>
            </SearchContext.Provider>
          </QueueListContext.Provider>
        </CurrentClimbContext.Provider>
      );
    }

    // Use renderHook just to mount the tree (the hook itself is a no-op)
    renderHook(() => null, { wrapper: TestTree });

    // Snapshot initial render counts (each component rendered once on mount)
    const initialCounts = { ...counts };

    // Update ONLY session context
    act(() => setSession(makeSessionData({ isSessionActive: true, sessionId: 'ses-1' })));

    // Only session consumer should have re-rendered
    expect(counts.currentClimb).toBe(initialCounts.currentClimb);
    expect(counts.queueList).toBe(initialCounts.queueList);
    expect(counts.search).toBe(initialCounts.search);
    expect(counts.session).toBeGreaterThan(initialCounts.session);

    // Update snapshot
    const afterSessionCounts = { ...counts };

    // Update ONLY search context
    act(() => setSearch(makeSearchData({ hasDoneFirstFetch: true })));

    // Only search consumer should have re-rendered
    expect(counts.currentClimb).toBe(afterSessionCounts.currentClimb);
    expect(counts.queueList).toBe(afterSessionCounts.queueList);
    expect(counts.search).toBeGreaterThan(afterSessionCounts.search);
    expect(counts.session).toBe(afterSessionCounts.session);

    // Update snapshot
    const afterSearchCounts = { ...counts };

    // Update ONLY currentClimb context
    act(() =>
      setCurrentClimb(
        makeCurrentClimbData({
          currentClimbQueueItem: makeClimbQueueItem({ uuid: 'new-cc' }),
        }),
      ),
    );

    expect(counts.currentClimb).toBeGreaterThan(afterSearchCounts.currentClimb);
    expect(counts.queueList).toBe(afterSearchCounts.queueList);
    expect(counts.search).toBe(afterSearchCounts.search);
    expect(counts.session).toBe(afterSearchCounts.session);

    // Update snapshot
    const afterCurrentClimbCounts = { ...counts };

    // Update ONLY queueList context
    act(() => setQueueList({ queue: [makeClimbQueueItem({ uuid: 'ql-new' })] }));

    expect(counts.currentClimb).toBe(afterCurrentClimbCounts.currentClimb);
    expect(counts.queueList).toBeGreaterThan(afterCurrentClimbCounts.queueList);
    expect(counts.search).toBe(afterCurrentClimbCounts.search);
    expect(counts.session).toBe(afterCurrentClimbCounts.session);
  });
});
