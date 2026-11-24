// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_GYM_CLIMB_RANKING_TARGET, GYM_REPORTING_RECEIPT_MS, gymReportingQueryKey } from '@boardsesh/graphql';
import type { GymClimbRankingMode, GymClimbRankingRow, GymClimbRankings } from '@boardsesh/shared-schema';
import { useGymClimbRankings, type GymClimbRankingRequest } from '../use-gym-climb-rankings';

const target: GymClimbRankingRow['target'] = {
  logicalBoardUuid: 'logical-board',
  boardSlug: 'north-wall',
  boardType: 'tension',
  layoutId: 1,
  sizeId: 2,
  setIds: '3,4',
  climbUuid: 'exact-climb',
  name: 'Private ranked climb',
  angle: 30,
  isMirror: true,
  referenceDifficulty: 16,
  shareable: false,
};
const row: GymClimbRankingRow = {
  rank: 1,
  physicalBoardUuid: 'physical-board',
  boardName: 'North wall',
  target,
  sendCount: 12,
  senderCount: 6,
  qualityMean: null,
  voterCount: null,
  commentCount: null,
  authorCount: null,
  gradeDelta: null,
  firstKnownAvailableAt: null,
  lastSendAt: null,
  lastSendEndAt: null,
  lastSendDate: null,
  knownLifetimeDays: null,
  knownWindowDays: null,
  sendsPerDay: null,
};
const initial: GymClimbRankings = {
  status: 'READY',
  mode: 'MOST_SENT',
  quietAvailable: false,
  timeZone: 'America/Denver',
  timeZoneConfigured: true,
  asOf: '2026-11-23T14:00:00.000000Z',
  startAt: '2026-11-16T14:00:00.000000Z',
  rows: [row],
  nextCursor: 'first-cursor',
  truncated: false,
};

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness(request: GymClimbRankingRequest, client = new QueryClient()) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const initialProps = { mode: 'MOST_SENT' as GymClimbRankingMode, credentialEpoch: 1, active: true };
  return renderHook(
    ({ mode, credentialEpoch, active }: typeof initialProps) =>
      useGymClimbRankings({
        viewerId: 'viewer-one',
        gymUuid: 'canonical-gym',
        overviewGymUuid: 'old-gym',
        boardUuid: 'physical-board',
        period: 'week',
        mode,
        active,
        credentialEpoch,
        isCredentialCurrent: () => true,
        request,
      }),
    { initialProps, wrapper },
  );
}

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('climb rankings receipts', () => {
  it('issues one continuation per action and expiry still uses the first receipt', async () => {
    vi.useFakeTimers();
    const later = { ...initial, rows: [{ ...row, rank: 2 }], nextCursor: null };
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ gymClimbRankings: initial })
      .mockResolvedValueOnce({ gymClimbRankings: later })
      .mockRejectedValue(new Error('Temporarily offline'));
    const ranking = harness(transport as GymClimbRankingRequest);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(ranking.result.current.rows.map(({ rank }) => rank)).toEqual([1]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GYM_REPORTING_RECEIPT_MS - 100);
      const load = ranking.result.current.loadMore();
      void ranking.result.current.loadMore();
      await load;
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1]).toEqual({
      input: {
        gymUuid: 'canonical-gym',
        boardUuid: 'physical-board',
        period: 'week',
        mode: 'MOST_SENT',
        cursor: 'first-cursor',
      },
    });
    expect(ranking.result.current.rows.map(({ rank }) => rank)).toEqual([1, 2]);

    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(ranking.result.current.rows).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('purges the full ranked list when continuation reports a changed page', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ gymClimbRankings: initial })
      .mockResolvedValueOnce({ gymClimbRankings: { ...initial, status: 'PAGE_CHANGED' } });
    const ranking = harness(transport as GymClimbRankingRequest);
    await waitFor(() => expect(ranking.result.current.state).toBe('READY'));
    await act(async () => ranking.result.current.loadMore());
    await waitFor(() => expect(ranking.result.current.state).toBe('PAGE_CHANGED'));
    expect(ranking.result.current.rows).toEqual([]);
    expect(ranking.result.current.canLoadMore).toBe(false);
  });

  it('wipes canonical and former gym receipts on denied pagination while keeping other gyms', async () => {
    const client = new QueryClient();
    const oldGym = gymReportingQueryKey('viewer-one', 'old-gym', 'physical-board', 'week');
    const currentGym = gymReportingQueryKey('viewer-one', 'canonical-gym', 'physical-board', 'week');
    const otherGym = gymReportingQueryKey('viewer-one', 'other-gym', null, 'week');
    client.setQueryData(oldGym, { former: true });
    client.setQueryData(currentGym, { current: true });
    client.setQueryData(otherGym, { other: true });
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ gymClimbRankings: initial })
      .mockRejectedValueOnce({ response: { status: 403 } });
    const ranking = harness(transport as GymClimbRankingRequest, client);
    await waitFor(() => expect(ranking.result.current.state).toBe('READY'));
    await act(async () => ranking.result.current.loadMore());
    await waitFor(() => expect(ranking.result.current.state).toBe('DENIED'));
    expect(ranking.result.current.rows).toEqual([]);
    expect(client.getQueryData(oldGym)).toBeUndefined();
    expect(client.getQueryData(currentGym)).toBeUndefined();
    expect(client.getQueryData(otherGym)).toEqual({ other: true });
  });

  it('does not open a late target after even a same-tick network loss and recovery', async () => {
    const pending = deferred<{ gymClimbRankingTarget: typeof target }>();
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ gymClimbRankings: initial })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ gymClimbRankings: { ...initial, rows: [] } });
    const ranking = harness(transport as GymClimbRankingRequest);
    await waitFor(() => expect(ranking.result.current.rows).toHaveLength(1));
    const read = vi.fn(async () => 'photo');
    let selection: Promise<unknown> | undefined;
    act(() => {
      selection = ranking.result.current.resolveTarget(ranking.result.current.rows[0], read);
    });
    expect(transport.mock.calls[1].slice(0, 2)).toEqual([
      GET_GYM_CLIMB_RANKING_TARGET,
      {
        input: {
          gymUuid: 'canonical-gym',
          boardUuid: 'physical-board',
          period: 'week',
          logicalBoardUuid: 'logical-board',
          climbUuid: 'exact-climb',
          angle: 30,
          isMirror: true,
        },
      },
    ]);
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      pending.resolve({ gymClimbRankingTarget: target });
      expect(await selection).toBeNull();
    });
    expect(read).not.toHaveBeenCalled();
    await waitFor(() => expect(ranking.result.current.rows).toEqual([]));
  });

  it('cannot append a late old-mode page after the route selects grade feedback', async () => {
    const latePage = deferred<{ gymClimbRankings: GymClimbRankings }>();
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ gymClimbRankings: initial })
      .mockReturnValueOnce(latePage.promise)
      .mockResolvedValueOnce({ gymClimbRankings: { ...initial, mode: 'GRADE_FEEDBACK', rows: [], nextCursor: null } });
    const ranking = harness(transport as GymClimbRankingRequest);
    await waitFor(() => expect(ranking.result.current.state).toBe('READY'));
    act(() => {
      void ranking.result.current.loadMore();
    });
    ranking.rerender({ active: true, credentialEpoch: 1, mode: 'GRADE_FEEDBACK' });
    await act(async () => latePage.resolve({ gymClimbRankings: { ...initial, rows: [{ ...row, rank: 2 }] } }));
    await waitFor(() => expect(ranking.result.current.report?.mode).toBe('GRADE_FEEDBACK'));
    expect(ranking.result.current.rows).toEqual([]);
  });
});
