import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { GYM_REPORTING_RECEIPT_MS, gymReportingQueryKey } from '@boardsesh/graphql';
import type { Gym, GymReachOverview, GymStats } from '@boardsesh/shared-schema';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import InsightsTab from '../insights-tab';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  viewer: 'viewer-one',
  status: 'authenticated',
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: `token-for-${mocks.viewer}`, isLoading: false }),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: mocks.viewer } }, status: mocks.status }),
}));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mocks.request }),
}));
vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const gym = { uuid: 'gym-one' } as Gym;
const activeWindow = {
  startAt: '2026-10-31T20:00:00Z',
  endAt: '2026-11-07T21:00:00Z',
  displayCount: 2,
  tickCount: 4,
  uniqueClimbers: 12,
  ascentCount: 3,
};
const report: GymStats = {
  gymName: 'Movement',
  gymUuid: gym.uuid,
  canManageBoardAliases: true,
  boardUuid: null,
  boards: [
    { uuid: 'a', name: 'Wall A', boardType: 'kilter', configurations: [{ uuid: 'a', name: 'Wall A' }] },
    { uuid: 'b', name: 'Wall B', boardType: 'kilter', configurations: [{ uuid: 'b', name: 'Wall B' }] },
  ],
  timeZone: 'America/Denver',
  timeZoneConfigured: true,
  asOf: activeWindow.endAt,
  coverage: {
    observedSince: '2025-11-07T21:00:00Z',
    firstDisplayAt: '2026-01-02T20:00:00Z',
    firstTickAt: null,
    boundaryUncertainCount: 0,
    dateOnlyCount: 0,
    unknownTimeCount: 0,
    includesCurrentBoardHistory: true,
    isPartial: true,
  },
  periodDays: 7,
  current: activeWindow,
  previous: { ...activeWindow, startAt: '2026-10-24T20:00:00Z', endAt: activeWindow.startAt },
  topClimbs: [
    {
      climbUuid: 'climb-a',
      boardType: 'kilter',
      angle: 40,
      name: 'Crimpy Traverse',
      gradeName: 'V4',
      ascentCount: 2,
    },
  ],
  busiestDays: [{ dayOfWeek: 2, ascentCount: 3 }],
};

const count = (value: number) => ({ count: value, coverage: 'complete' as const });
const reachWindow = {
  climbers: count(12),
  firstRecorded: count(4),
  uncertainFirstRecorded: 0,
  sends: count(3),
  sendLoggers: 2,
  sessions: count(2),
};
const reach: GymReachOverview = {
  observationStartedAt: '2025-11-01T00:00:00Z',
  baselineStartAt: '2026-10-17T20:00:00Z',
  current: reachWindow,
  previous: { ...reachWindow, climbers: count(8), sends: count(2) },
  cameBack: { returning: 4, previousClimbers: 8, coverage: 'complete' },
  previousCameBack: { returning: 2, previousClimbers: 8, coverage: 'complete' },
  weeklyTrend: Array.from({ length: 12 }, (_, index) => {
    const monday = Date.UTC(2026, 7, 17) + index * 7 * 86_400_000;
    return {
      startDate: new Date(monday).toISOString().slice(0, 10),
      endDate: new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10),
      inProgress: index === 11,
      climbers: index === 0 ? { count: 0, coverage: 'unavailable' } : count(index),
      sends: count(index === 0 ? 0 : index + 2),
    };
  }),
};

function renderTab() {
  const queryClient = createTestQueryClient();
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <InsightsTab gym={gym} onGymChange={vi.fn()} />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, queryClient };
}

function graphError(code: string) {
  return { response: { errors: [{ extensions: { code } }] } };
}

beforeEach(() => {
  mocks.viewer = 'viewer-one';
  mocks.status = 'authenticated';
  mocks.request.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe('InsightsTab', () => {
  it('shows gym-local windows, board scope, recorded activity and existing detail rows', async () => {
    mocks.request.mockResolvedValue({ gymStats: report });
    renderTab();
    expect(await screen.findByText('12 climbers recorded')).toBeTruthy();
    expect(screen.getByText('3 sends logged')).toBeTruthy();
    expect(screen.getByText(/Current period.*Oct 31, 2026.*2:00 PM.*Nov 7, 2026.*2:00 PM/)).toBeTruthy();
    expect(screen.getByText('Gym time zone · America/Denver')).toBeTruthy();
    expect(screen.getByText(/Activity times checked.*Nov 7, 2025.*Nov 7, 2026/)).toBeTruthy();
    expect(screen.getByText(/Earliest display in this check.*Jan 2, 2026/)).toBeTruthy();
    expect(screen.getByText('No climb log with a recorded time found.')).toBeTruthy();
    expect(screen.getByText('Crimpy Traverse')).toBeTruthy();
  });

  it('renders five values and selectable exact trend counts independently from the selected period', async () => {
    mocks.request.mockResolvedValue({ gymStats: { ...report, reachOverview: reach } });
    renderTab();
    await screen.findByText('Climbers recorded');
    for (const title of ['First recorded here', 'Came back', 'Sends logged', 'Sessions', 'Last 12 weeks']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getByText(/4 of 8 recorded climbers/)).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText(/Days with a send, counted once/)).toBeTruthy();
    const missing = screen.getByRole('button', { name: /Aug 17, 2026.*History unavailable/ });
    fireEvent.focus(missing);
    expect(missing.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Aug 17, 2026.*History unavailable/)).toBeTruthy();
    const climbers = screen.getByRole('button', { name: 'Climbers', pressed: true });
    const sends = screen.getByRole('button', { name: 'Sends', pressed: false });
    const selectedCheck = '[data-selected-check]';
    const group = screen.getByRole('group', { name: 'Weekly measure' });
    expect(group.querySelectorAll(selectedCheck)).toHaveLength(1);
    expect(climbers.querySelector(selectedCheck)?.getAttribute('aria-hidden')).toBe('true');
    expect(sends.querySelector(selectedCheck)).toBeNull();
    fireEvent.click(sends);
    expect(climbers.getAttribute('aria-pressed')).toBe('false');
    expect(climbers.querySelector(selectedCheck)).toBeNull();
    expect(sends.getAttribute('aria-pressed')).toBe('true');
    expect(sends.querySelector(selectedCheck)?.getAttribute('aria-hidden')).toBe('true');
    expect(group.querySelectorAll(selectedCheck)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Aug 17, 2026.*0 sends/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Nov 2, 2026.*13 sends.*In progress/ })).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each(['displayCount', 'tickCount'] as const)('keeps the report visible with %s and zero sends', async (source) => {
    mocks.request.mockResolvedValue({
      gymStats: {
        ...report,
        current: { ...activeWindow, tickCount: 0, displayCount: 0, [source]: 1, ascentCount: 0 },
        topClimbs: [],
        busiestDays: [],
      },
    });
    renderTab();
    expect(await screen.findByText('0 sends logged')).toBeTruthy();
    expect(screen.queryByText(/no qualifying board activity/i)).toBeNull();
  });

  it('distinguishes missing history from a period without activity', async () => {
    mocks.request.mockResolvedValue({
      gymStats: {
        ...report,
        current: { ...activeWindow, tickCount: 0, displayCount: 0, ascentCount: 0 },
        coverage: { ...report.coverage, firstDisplayAt: null },
      },
    });
    renderTab();
    expect(await screen.findByText('No activity could be placed in the selected reporting period.')).toBeTruthy();
    expect(screen.getByText(/Activity times checked.*Nov 7, 2025.*Nov 7, 2026/)).toBeTruthy();
    expect(screen.getByText('No display with a recorded time found.')).toBeTruthy();
    expect(screen.getByText('No climb log with a recorded time found.')).toBeTruthy();
    mocks.request.mockResolvedValue({
      gymStats: { ...report, current: { ...activeWindow, tickCount: 0, displayCount: 0, ascentCount: 0 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/No qualifying board activity/)).toBeTruthy();
  });

  it('retries load errors and passes the period and selected physical scope', async () => {
    mocks.request.mockRejectedValueOnce(new Error('transport')).mockResolvedValue({ gymStats: report });
    renderTab();
    expect(await screen.findByText(/Couldn.t load this report/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('12 climbers recorded');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Board scope' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Wall A' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: { input: { gymUuid: gym.uuid, boardUuid: 'a', period: 'week' } },
        }),
      ),
    );
    await screen.findByText('12 climbers recorded');
    const week = screen.getByRole('button', { name: '7 days', pressed: true });
    const month = screen.getByRole('button', { name: '30 days', pressed: false });
    const quarter = screen.getByRole('button', { name: '90 days', pressed: false });
    const selectedCheck = '[data-selected-check]';
    const group = screen.getByRole('group', { name: 'Reporting range' });
    expect(group.querySelectorAll(selectedCheck)).toHaveLength(1);
    expect(week.querySelector(selectedCheck)?.getAttribute('aria-hidden')).toBe('true');
    expect(month.querySelector(selectedCheck)).toBeNull();
    expect(quarter.querySelector(selectedCheck)).toBeNull();
    fireEvent.click(quarter);
    expect(week.getAttribute('aria-pressed')).toBe('false');
    expect(week.querySelector(selectedCheck)).toBeNull();
    expect(month.querySelector(selectedCheck)).toBeNull();
    expect(quarter.getAttribute('aria-pressed')).toBe('true');
    expect(quarter.querySelector(selectedCheck)?.getAttribute('aria-hidden')).toBe('true');
    expect(group.querySelectorAll(selectedCheck)).toHaveLength(1);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: { input: { gymUuid: gym.uuid, boardUuid: 'a', period: 'quarter' } },
        }),
      ),
    );
  });

  it('masks the previously selected report before verifying access again', async () => {
    let rejectRefresh: (error: unknown) => void = () => undefined;
    mocks.request
      .mockResolvedValueOnce({ gymStats: report })
      .mockResolvedValueOnce({ gymStats: { ...report, boardUuid: 'a' } })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      );
    renderTab();
    await screen.findByText('12 climbers recorded');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Board scope' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Wall A' }));
    await screen.findByText('12 climbers recorded');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByTestId('insights-loading');
    expect(screen.queryByText('12 climbers recorded')).toBeNull();
    await act(async () => rejectRefresh(graphError('NOT_FOUND')));
    expect(await screen.findByText(/This board is unavailable/)).toBeTruthy();
    expect(screen.queryByText('Crimpy Traverse')).toBeNull();
    expect(screen.getByRole('button', { name: 'All boards' })).toBeTruthy();
  });

  it('cancels an in-flight previous viewer request and never paints its response', async () => {
    let completePrevious: (result: { gymStats: GymStats }) => void = () => undefined;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completePrevious = resolve;
          }),
      )
      .mockResolvedValueOnce({ gymStats: { ...report, current: { ...activeWindow, uniqueClimbers: 4 } } });
    const { rerender, tree } = renderTab();
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    const firstSignal: AbortSignal = mocks.request.mock.calls[0][0].signal;
    mocks.viewer = 'viewer-two';
    rerender(tree());
    await screen.findByText('4 climbers recorded');
    expect(firstSignal.aborted).toBe(true);
    await act(async () => completePrevious({ gymStats: report }));
    expect(screen.queryByText('12 climbers recorded')).toBeNull();
  });

  it('revalidates on reconnect before rendering the old data again', async () => {
    let rejectRecheck: (error: unknown) => void = () => undefined;
    mocks.request.mockResolvedValueOnce({ gymStats: report }).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRecheck = reject;
        }),
    );
    renderTab();
    await screen.findByText('12 climbers recorded');
    act(() => onlineManager.setOnline(false));
    expect(await screen.findByText(/Offline. Showing the report/)).toBeTruthy();
    act(() => onlineManager.setOnline(true));
    expect(screen.queryByText('12 climbers recorded')).toBeNull();
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    await act(async () => rejectRecheck(graphError('FORBIDDEN')));
    expect(await screen.findByText(/don.t have access/)).toBeTruthy();
    expect(screen.queryByText('Crimpy Traverse')).toBeNull();
  });

  it('drops the receipt when a settings denial arrives during a paused recheck', async () => {
    let denySave: (error: unknown) => void = () => undefined;
    let completeOldRead: (result: { gymStats: GymStats }) => void = () => undefined;
    mocks.request
      .mockResolvedValueOnce({ gymStats: report })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            denySave = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOldRead = resolve;
          }),
      )
      .mockResolvedValueOnce({ gymStats: { ...report, current: { ...activeWindow, uniqueClimbers: 5 } } });
    const { queryClient } = renderTab();
    await screen.findByText('12 climbers recorded');
    fireEvent.click(screen.getByRole('button', { name: 'Edit gym time zone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
    const supersededSignal: AbortSignal = mocks.request.mock.calls[2][0].signal;
    act(() => onlineManager.setOnline(false));
    await screen.findByText(/Offline. Showing the report/);
    await act(async () => denySave(graphError('FORBIDDEN')));
    expect(await screen.findByText(/Go online to check access/)).toBeTruthy();
    expect(supersededSignal.aborted).toBe(true);
    const key = gymReportingQueryKey(JSON.stringify(['viewer-one', null]), gym.uuid, null, 'week');
    expect(queryClient.getQueryState(key)?.fetchStatus).toBe('paused');
    expect(queryClient.getQueryData(key)).toBeUndefined();
    await act(async () => completeOldRead({ gymStats: report }));
    expect(screen.queryByText('12 climbers recorded')).toBeNull();
    expect(screen.queryByText('Crimpy Traverse')).toBeNull();
    expect(queryClient.getQueryData(key)).toBeUndefined();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText('5 climbers recorded')).toBeTruthy();
  });

  it('expires a foreground offline report on its receipt deadline without new input', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    mocks.request.mockResolvedValueOnce({ gymStats: report }).mockRejectedValue(new Error('network failure'));
    const { queryClient } = renderTab();
    const advance = async (duration: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(duration);
      });
    };
    await advance(20);
    expect(screen.getByText('Crimpy Traverse')).toBeTruthy();
    act(() => onlineManager.setOnline(false));
    await advance(10);
    expect(screen.getByText(/Offline. Showing the report/)).toBeTruthy();
    const key = gymReportingQueryKey(JSON.stringify(['viewer-one', null]), gym.uuid, null, 'week');
    const receivedAt = queryClient.getQueryState(key)?.dataUpdatedAt;
    expect(receivedAt).toBeTruthy();
    await advance((receivedAt ?? 0) + GYM_REPORTING_RECEIPT_MS - Date.now() - 1);
    expect(screen.getByText('Crimpy Traverse')).toBeTruthy();
    await advance(2);
    expect(screen.queryByText('Crimpy Traverse')).toBeNull();
    expect(screen.queryByText('12 climbers recorded')).toBeNull();
    expect(screen.getByText(/Go online to check access/)).toBeTruthy();
    expect(queryClient.getQueryData(key)).toBeUndefined();
    act(() => onlineManager.setOnline(true));
    await advance(20);
    expect(screen.getByText(/Couldn.t load this report/)).toBeTruthy();
    act(() => onlineManager.setOnline(false));
    await advance(20);
    expect(screen.queryByText(/Offline. Showing the report/)).toBeNull();
  });

  it('rechecks an open online report when its receipt expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    mocks.request
      .mockResolvedValueOnce({ gymStats: report })
      .mockResolvedValueOnce({ gymStats: { ...report, current: { ...activeWindow, uniqueClimbers: 7 } } });
    renderTab();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByText('12 climbers recorded')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GYM_REPORTING_RECEIPT_MS);
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(screen.getByText('7 climbers recorded')).toBeTruthy();
  });

  it('requires explicit confirmation before grouping two configurations', async () => {
    mocks.request.mockImplementation((request) =>
      Promise.resolve(typeof request === 'object' ? { gymStats: report } : { setGymReportingBoardAlias: true }),
    );
    renderTab();
    await screen.findByText('12 climbers recorded');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Configuration to move' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Wall A' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Physical board' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Wall B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(screen.getByText('Confirm that Wall A and Wall B control the same physical board.')).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(expect.any(String), {
        input: { gymUuid: gym.uuid, boardUuid: 'a', rootBoardUuid: 'b' },
      }),
    );
  });
});
