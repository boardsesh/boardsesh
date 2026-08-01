import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardClimbRecentSender, BoardPresenceStats } from '@boardsesh/shared-schema';
import { BoardPresenceClientContext, BoardPresenceFeedContext } from '../board-presence-provider';
import type { BoardPresenceClient } from '../types';
import {
  useBoardClimbRecentSenders,
  type BoardClimbRecentSendersOptions,
  type BoardClimbRecentSendersState,
} from '../use-board-climb-recent-senders';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (result: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const sender = (userId: string): BoardClimbRecentSender => ({
  userId,
  displayName: `Climber ${userId}`,
  avatarUrl: null,
  lastSentAt: '2026-07-31T12:00:00.000Z',
});

const stats = (lastSentAt: string | null): BoardPresenceStats => ({
  climbsSentCount: 1,
  distinctClimbersCount: 1,
  hardestGrade: 'V5',
  hardestSend: null,
  topGrade: 'V5',
  lastSentAt,
});

function makeClient() {
  const fetchClimbRecentSenders =
    vi.fn<(boardId: number, climbUuid: string, angle: number) => Promise<BoardClimbRecentSender[]>>();
  const client: BoardPresenceClient = {
    subscribeNowPlaying: vi.fn(() => () => {}),
    fetchRecentClimbs: vi.fn(async () => []),
    fetchClimbRecentSenders,
    fetchStats: vi.fn(async () => stats(null)),
    reportClimb: vi.fn(async () => true),
    resolveBoardForSerial: vi.fn(),
  };
  return { client, fetchClimbRecentSenders };
}

type ResultBox = { current: BoardClimbRecentSendersState | null };

function ResultReader({ options, resultBox }: { options: BoardClimbRecentSendersOptions; resultBox: ResultBox }) {
  resultBox.current = useBoardClimbRecentSenders(options);
  return null;
}

function TestHarness({
  boardId,
  client,
  feedStats,
  options,
  resultBox,
}: {
  boardId: number | null;
  client: BoardPresenceClient | null;
  feedStats: BoardPresenceStats | null;
  options: BoardClimbRecentSendersOptions;
  resultBox: ResultBox;
}) {
  return (
    <BoardPresenceClientContext.Provider value={{ boardId, client }}>
      <BoardPresenceFeedContext.Provider value={{ history: [], stats: feedStats }}>
        <ResultReader options={options} resultBox={resultBox} />
      </BoardPresenceFeedContext.Provider>
    </BoardPresenceClientContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBoardClimbRecentSenders', () => {
  it('fetches the displayed board, climb, and angle', async () => {
    const { client, fetchClimbRecentSenders } = makeClient();
    fetchClimbRecentSenders.mockResolvedValueOnce([sender('u1'), sender('u2')]);
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness
        boardId={9}
        client={client}
        feedStats={stats('2026-07-31T12:00:00.000Z')}
        options={{ climbUuid: ' climb-1 ', angle: 40 }}
        resultBox={resultBox}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchClimbRecentSenders).toHaveBeenCalledWith(9, 'climb-1', 40);
    expect(resultBox.current?.senders).toEqual([sender('u1'), sender('u2')]);
    expect(resultBox.current?.isLoading).toBe(false);
  });

  it('clears the previous climb immediately and ignores a stale response after a switch', async () => {
    const { client, fetchClimbRecentSenders } = makeClient();
    const firstRequest = deferred<BoardClimbRecentSender[]>();
    const secondRequest = deferred<BoardClimbRecentSender[]>();
    fetchClimbRecentSenders.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise);
    const resultBox: ResultBox = { current: null };

    const { rerender } = render(
      <TestHarness
        boardId={1}
        client={client}
        feedStats={null}
        options={{ climbUuid: 'first', angle: 40 }}
        resultBox={resultBox}
      />,
    );

    rerender(
      <TestHarness
        boardId={2}
        client={client}
        feedStats={null}
        options={{ climbUuid: 'second', angle: 45 }}
        resultBox={resultBox}
      />,
    );
    expect(resultBox.current?.senders).toEqual([]);

    await act(async () => {
      firstRequest.resolve([sender('stale')]);
      await firstRequest.promise;
    });
    expect(resultBox.current?.senders).toEqual([]);

    await act(async () => {
      secondRequest.resolve([sender('current')]);
      await secondRequest.promise;
    });
    expect(resultBox.current?.senders).toEqual([sender('current')]);
  });

  it('refetches when BoardStatsUpdated replaces the stats snapshot', async () => {
    const { client, fetchClimbRecentSenders } = makeClient();
    fetchClimbRecentSenders.mockResolvedValueOnce([sender('before')]).mockResolvedValueOnce([sender('after')]);
    const resultBox: ResultBox = { current: null };
    const options = { climbUuid: 'climb-1', angle: 40 };
    const initialStats = stats('2026-07-31T12:00:00.000Z');

    const { rerender } = render(
      <TestHarness boardId={1} client={client} feedStats={initialStats} options={options} resultBox={resultBox} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultBox.current?.senders).toEqual([sender('before')]);

    rerender(
      <TestHarness
        boardId={1}
        client={client}
        feedStats={{ ...initialStats }}
        options={options}
        resultBox={resultBox}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchClimbRecentSenders).toHaveBeenCalledTimes(2);
    expect(resultBox.current?.senders).toEqual([sender('after')]);
  });

  it('degrades to no byline for disabled, incomplete, or unsupported clients', () => {
    const { client, fetchClimbRecentSenders } = makeClient();
    const resultBox: ResultBox = { current: null };
    const { rerender } = render(
      <TestHarness
        boardId={1}
        client={client}
        feedStats={null}
        options={{ climbUuid: 'climb-1', angle: 40, enabled: false }}
        resultBox={resultBox}
      />,
    );
    expect(fetchClimbRecentSenders).not.toHaveBeenCalled();

    rerender(
      <TestHarness
        boardId={1}
        client={{ ...client, fetchClimbRecentSenders: undefined }}
        feedStats={null}
        options={{ climbUuid: 'climb-1', angle: 40 }}
        resultBox={resultBox}
      />,
    );
    expect(resultBox.current).toEqual({ senders: [], isLoading: false });
  });

  it('hides a first-load error instead of leaking it into wall chrome', async () => {
    const { client, fetchClimbRecentSenders } = makeClient();
    fetchClimbRecentSenders.mockRejectedValueOnce(new Error('offline'));
    const resultBox: ResultBox = { current: null };

    render(
      <TestHarness
        boardId={1}
        client={client}
        feedStats={null}
        options={{ climbUuid: 'climb-1', angle: 40 }}
        resultBox={resultBox}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(resultBox.current).toEqual({ senders: [], isLoading: false });
  });
});
