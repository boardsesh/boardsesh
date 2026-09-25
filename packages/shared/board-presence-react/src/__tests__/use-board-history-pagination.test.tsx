import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import {
  useBoardHistoryPagination,
  type BoardHistoryPageLoadedInfo,
  type BoardHistoryPagination,
} from '../use-board-history-pagination';
import { BoardPresenceClientContext, BoardPresenceFeedContext } from '../board-presence-provider';
import type { BoardPresenceClient } from '../types';

const climb = (climbUuid: string, seq: number, overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb => ({
  climbUuid,
  seq,
  sentAt: new Date(seq * 1000).toISOString(),
  name: `Climb ${climbUuid}`,
  angle: 40,
  ...overrides,
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClient(overrides: Partial<BoardPresenceClient> = {}) {
  const fetchHistory =
    vi.fn<(boardId: number, opts?: { limit?: number; before?: string }) => Promise<BoardPresenceClimb[]>>();
  const client: BoardPresenceClient = {
    subscribeNowPlaying: vi.fn(() => () => {}),
    fetchRecentClimbs: vi.fn(async () => []),
    fetchStats: vi.fn(async () => ({
      climbsSentCount: 0,
      distinctClimbersCount: 0,
      hardestGrade: null,
      topGrade: null,
      lastSentAt: null,
    })),
    reportClimb: vi.fn(async () => true),
    resolveBoardForSerial: vi.fn(),
    fetchHistory,
    ...overrides,
  };
  return { client, fetchHistory };
}

type ResultBox = { current: BoardHistoryPagination | null };

function ResultReader({
  pageSize,
  onPageLoaded,
  resultBox,
}: {
  pageSize?: number;
  onPageLoaded?: (info: BoardHistoryPageLoadedInfo) => void;
  resultBox: ResultBox;
}) {
  resultBox.current = useBoardHistoryPagination(pageSize, onPageLoaded);
  return null;
}

function TestHarness({
  boardId,
  client,
  history,
  pageSize,
  onPageLoaded,
  resultBox,
}: {
  boardId: number | null;
  client: BoardPresenceClient | null;
  history: BoardPresenceClimb[];
  pageSize?: number;
  onPageLoaded?: (info: BoardHistoryPageLoadedInfo) => void;
  resultBox: ResultBox;
}) {
  return (
    <BoardPresenceClientContext.Provider value={{ boardId, client }}>
      <BoardPresenceFeedContext.Provider value={{ history, stats: null }}>
        <ResultReader pageSize={pageSize} onPageLoaded={onPageLoaded} resultBox={resultBox} />
      </BoardPresenceFeedContext.Provider>
    </BoardPresenceClientContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBoardHistoryPagination', () => {
  it('pages append newest-first and the cursor is the lowest seq across the live window', async () => {
    const { client, fetchHistory } = makeClient();
    const page = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(page.promise);
    const resultBox: ResultBox = { current: null };
    const liveHistory = [climb('c100', 100), climb('c99', 99), climb('c98', 98)];

    render(<TestHarness boardId={1} client={client} history={liveHistory} pageSize={2} resultBox={resultBox} />);

    act(() => resultBox.current?.loadOlder());
    expect(fetchHistory).toHaveBeenCalledWith(1, { limit: 2, before: '98' });
    expect(resultBox.current?.isLoadingOlder).toBe(true);

    await act(async () => {
      page.resolve([climb('c97', 97), climb('c96', 96)]);
      await page.promise;
    });

    expect(resultBox.current?.olderHistory).toEqual([climb('c97', 97), climb('c96', 96)]);
    expect(resultBox.current?.isLoadingOlder).toBe(false);
    expect(resultBox.current?.hasMore).toBe(true);
  });

  it('derives the next cursor from the lowest seq including prior pages', async () => {
    const { client, fetchHistory } = makeClient();
    const firstPage = deferred<BoardPresenceClimb[]>();
    const secondPage = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(secondPage.promise);
    const resultBox: ResultBox = { current: null };
    const liveHistory = [climb('c100', 100)];

    render(<TestHarness boardId={1} client={client} history={liveHistory} pageSize={2} resultBox={resultBox} />);

    act(() => resultBox.current?.loadOlder());
    expect(fetchHistory).toHaveBeenNthCalledWith(1, 1, { limit: 2, before: '100' });
    await act(async () => {
      firstPage.resolve([climb('c99', 99), climb('c98', 98)]);
      await firstPage.promise;
    });

    act(() => resultBox.current?.loadOlder());
    // Cursor now anchors on the lowest seq across live window (100) AND the
    // already-loaded page (99, 98) — 98, not 100.
    expect(fetchHistory).toHaveBeenNthCalledWith(2, 1, { limit: 2, before: '98' });
    await act(async () => {
      secondPage.resolve([climb('c97', 97)]);
      await secondPage.promise;
    });

    expect(resultBox.current?.olderHistory).toEqual([climb('c99', 99), climb('c98', 98), climb('c97', 97)]);
  });

  it('omits the cursor on the very first fetch when nothing is known yet', async () => {
    const { client, fetchHistory } = makeClient();
    fetchHistory.mockResolvedValueOnce([]);
    const resultBox: ResultBox = { current: null };

    render(<TestHarness boardId={1} client={client} history={[]} pageSize={2} resultBox={resultBox} />);

    await act(async () => {
      resultBox.current?.loadOlder();
    });

    expect(fetchHistory).toHaveBeenCalledWith(1, { limit: 2, before: undefined });
  });

  it('dedupes a page entry that overlaps the live window — the known entry wins', async () => {
    const { client, fetchHistory } = makeClient();
    const page = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(page.promise);
    const resultBox: ResultBox = { current: null };
    // Live window already has c100/seq100.
    const liveHistory = [climb('c100', 100)];

    render(<TestHarness boardId={1} client={client} history={liveHistory} pageSize={2} resultBox={resultBox} />);

    act(() => resultBox.current?.loadOlder());
    await act(async () => {
      // The durable query can return a re-resolved variant of an entry the
      // live window already has (different name/fields, same climbUuid+seq
      // key) — it must be dropped, not appended as a duplicate.
      page.resolve([climb('c100', 100, { name: 'Stale Durable Variant' }), climb('c99', 99)]);
      await page.promise;
    });

    expect(resultBox.current?.olderHistory).toEqual([climb('c99', 99)]);
  });

  it('flips hasMore false once a page comes back shorter than pageSize, and further loadOlder calls no-op', async () => {
    const { client, fetchHistory } = makeClient();
    fetchHistory.mockResolvedValueOnce([climb('c99', 99)]);
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    await act(async () => {
      resultBox.current?.loadOlder();
    });

    expect(resultBox.current?.hasMore).toBe(false);
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    act(() => resultBox.current?.loadOlder());
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed page retryable without advancing its cursor', async () => {
    const { client, fetchHistory } = makeClient();
    fetchHistory.mockRejectedValueOnce(new Error('network unavailable'));
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    await act(async () => {
      resultBox.current?.loadOlder();
    });

    expect(resultBox.current?.hasMore).toBe(true);
    expect(resultBox.current?.loadError).toBe(true);
    expect(resultBox.current?.isLoadingOlder).toBe(false);
    expect(resultBox.current?.olderHistory).toEqual([]);

    fetchHistory.mockResolvedValueOnce([]);
    await act(async () => resultBox.current?.loadOlder());
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(resultBox.current?.loadError).toBe(false);
  });

  it('resets paging state on a board switch', async () => {
    const { client, fetchHistory } = makeClient();
    fetchHistory.mockResolvedValueOnce([climb('c99', 99), climb('c98', 98)]);
    const resultBox: ResultBox = { current: null };

    const { rerender } = render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    await act(async () => {
      resultBox.current?.loadOlder();
    });
    expect(resultBox.current?.olderHistory).toHaveLength(2);
    expect(resultBox.current?.hasMore).toBe(true);

    fetchHistory.mockResolvedValueOnce([]);
    rerender(<TestHarness boardId={2} client={client} history={[climb('d1', 5)]} pageSize={2} resultBox={resultBox} />);

    expect(resultBox.current?.olderHistory).toEqual([]);
    expect(resultBox.current?.hasMore).toBe(true);
    expect(resultBox.current?.isLoadingOlder).toBe(false);

    act(() => resultBox.current?.loadOlder());
    // The next fetch anchors on board 2's own live window, not board 1's.
    expect(fetchHistory).toHaveBeenLastCalledWith(2, { limit: 2, before: '5' });
  });

  it('ignores a page that resolves after a board switch (stale generation)', async () => {
    const { client, fetchHistory } = makeClient();
    const boardOnePage = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(boardOnePage.promise);
    const resultBox: ResultBox = { current: null };

    const { rerender } = render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    act(() => resultBox.current?.loadOlder());
    expect(resultBox.current?.isLoadingOlder).toBe(true);

    // Switch boards while board 1's page is still in flight — the reset
    // effect bumps the generation and clears the loading flag.
    rerender(<TestHarness boardId={2} client={client} history={[]} pageSize={2} resultBox={resultBox} />);
    expect(resultBox.current?.isLoadingOlder).toBe(false);

    await act(async () => {
      boardOnePage.resolve([climb('c99', 99), climb('c98', 98)]);
      await boardOnePage.promise;
    });

    // Board 1's late page must not bleed into board 2's state.
    expect(resultBox.current?.olderHistory).toEqual([]);
    expect(resultBox.current?.isLoadingOlder).toBe(false);
    expect(resultBox.current?.hasMore).toBe(true);
  });

  it('ignores a page that resolves after unmount', async () => {
    const { client, fetchHistory } = makeClient();
    const page = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(page.promise);
    const resultBox: ResultBox = { current: null };

    const { unmount } = render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    act(() => resultBox.current?.loadOlder());
    unmount();

    // Resolving after unmount must not throw (the isActive guard swallows the
    // late continuation instead of setting state on an unmounted tree).
    await act(async () => {
      page.resolve([climb('c99', 99), climb('c98', 98)]);
      await page.promise;
    });
  });

  it('coalesces loadOlder calls while a fetch is already in flight', async () => {
    const { client, fetchHistory } = makeClient();
    const page = deferred<BoardPresenceClimb[]>();
    fetchHistory.mockReturnValueOnce(page.promise);
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    act(() => {
      resultBox.current?.loadOlder();
      resultBox.current?.loadOlder();
      resultBox.current?.loadOlder();
    });
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      // Full page (length === pageSize) so `hasMore` stays true and the
      // follow-up call below isn't suppressed by that flag instead.
      page.resolve([climb('c99', 99), climb('c98', 98)]);
      await page.promise;
    });
    expect(resultBox.current?.isLoadingOlder).toBe(false);

    // Once resolved, a fresh call fetches again (not coalesced anymore).
    fetchHistory.mockResolvedValueOnce([]);
    await act(async () => {
      resultBox.current?.loadOlder();
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('no-ops when the active client does not implement fetchHistory', () => {
    const { client } = makeClient({ fetchHistory: undefined });
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness boardId={1} client={client} history={[climb('c100', 100)]} pageSize={2} resultBox={resultBox} />,
    );

    act(() => resultBox.current?.loadOlder());

    expect(resultBox.current?.isLoadingOlder).toBe(false);
    expect(resultBox.current?.olderHistory).toEqual([]);
  });

  it('no-ops when there is no bound board or client', () => {
    const { client, fetchHistory } = makeClient();
    const resultBox: ResultBox = { current: null };

    render(<TestHarness boardId={null} client={client} history={[]} pageSize={2} resultBox={resultBox} />);
    act(() => resultBox.current?.loadOlder());
    expect(fetchHistory).not.toHaveBeenCalled();

    const resultBox2: ResultBox = { current: null };
    render(<TestHarness boardId={1} client={null} history={[]} pageSize={2} resultBox={resultBox2} />);
    act(() => resultBox2.current?.loadOlder());
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('reports the resolved page via onPageLoaded', async () => {
    const { client, fetchHistory } = makeClient();
    fetchHistory.mockResolvedValueOnce([climb('c99', 99)]);
    const onPageLoaded = vi.fn();
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness
        boardId={1}
        client={client}
        history={[climb('c100', 100)]}
        pageSize={2}
        onPageLoaded={onPageLoaded}
        resultBox={resultBox}
      />,
    );

    await act(async () => {
      resultBox.current?.loadOlder();
    });

    expect(onPageLoaded).toHaveBeenCalledWith({ pageSize: 2, returnedCount: 1 });
  });
});

describe('durable chronological pages', () => {
  it('loads the newest page automatically without anchoring to sparse Redis history', async () => {
    const fetchHistoryPage = vi
      .fn<NonNullable<BoardPresenceClient['fetchHistoryPage']>>()
      .mockResolvedValueOnce({ entries: [climb('recent', 10), climb('middle', 9)], nextCursor: 'opaque-page-two' })
      .mockResolvedValueOnce({ entries: [climb('old', 1)], nextCursor: null });
    const { client, fetchHistory } = makeClient({ fetchHistoryPage });
    const resultBox: ResultBox = { current: null };
    await act(async () => {
      render(
        <TestHarness boardId={1} client={client} history={[climb('old', 1)]} pageSize={2} resultBox={resultBox} />,
      );
    });
    expect(fetchHistoryPage).toHaveBeenCalledExactlyOnceWith(1, { limit: 2, before: undefined });
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(resultBox.current?.olderHistory.map((entry) => entry.seq)).toEqual([10, 9]);
    await act(async () => resultBox.current?.loadOlder());
    expect(fetchHistoryPage).toHaveBeenLastCalledWith(1, { limit: 2, before: 'opaque-page-two' });
    expect(resultBox.current?.olderHistory.map((entry) => entry.seq)).toEqual([10, 9, 1]);
    expect(resultBox.current?.hasMore).toBe(false);
  });

  it('retries failed first pages and refreshes after exhaustion', async () => {
    const fetchHistoryPage = vi
      .fn<NonNullable<BoardPresenceClient['fetchHistoryPage']>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ entries: [climb('old', 1)], nextCursor: null })
      .mockResolvedValueOnce({ entries: [climb('new', 2), climb('old', 1)], nextCursor: null });
    const { client } = makeClient({ fetchHistoryPage });
    const resultBox: ResultBox = { current: null };
    await act(async () => {
      render(<TestHarness boardId={1} client={client} history={[]} resultBox={resultBox} />);
    });
    expect(resultBox.current?.loadError).toBe(true);
    expect(resultBox.current?.hasMore).toBe(true);
    await act(async () => resultBox.current?.loadOlder());
    expect(resultBox.current?.hasMore).toBe(false);
    await act(async () => resultBox.current?.refreshHistory());
    expect(fetchHistoryPage).toHaveBeenLastCalledWith(1, { limit: 50, before: undefined });
    expect(resultBox.current?.olderHistory.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(resultBox.current?.loadError).toBe(false);
  });
});
