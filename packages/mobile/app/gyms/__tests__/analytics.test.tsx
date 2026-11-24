// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createElement, type ReactNode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { GYM_REPORTING_RECEIPT_MS, gymReportingQueryKey } from '@boardsesh/graphql';
import type { GymReachOverview, GymStats } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  viewer: 'viewer-one',
  generation: 1,
  focused: true,
}));

type Children = { children?: ReactNode };
type MenuProps = { actions: { label: string }[]; onSelectIndex: (index: number) => void };
type SegmentedProps = { options: { key: string; label: string }[]; onSelect: (key: string) => void };
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ gymUuid: 'gym-1' }),
  useIsFocused: () => mocks.focused,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, variables?: Record<string, string>) => [key, ...Object.values(variables ?? {})].join(' '),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#8b5cf6' } }),
}));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({
  useStackScreenOptions: () => ({}),
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: mocks.viewer, isLoading: false }),
}));
vi.mock('../../../src/lib/local-user-id', () => ({
  readLocalUserId: async () => mocks.viewer,
}));
vi.mock('../../../src/lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => mocks.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === mocks.generation,
}));
vi.mock('../../../src/lib/graphql/client', () => ({
  getHttpClient: () => ({ request: mocks.request }),
}));
vi.mock('../../../src/components/AppMenu', () => ({
  AppMenu: ({ actions, onSelectIndex }: MenuProps) =>
    createElement(
      'div',
      null,
      actions.map((action, index) =>
        createElement(
          'button',
          { key: action.label, onClick: () => onSelectIndex(index), type: 'button' },
          action.label,
        ),
      ),
    ),
}));
vi.mock('../../../src/components/SegmentedControl', () => ({
  SegmentedControl: ({ options, onSelect }: SegmentedProps) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key), type: 'button' }, option.label),
      ),
    ),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', null, 'Loading'),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-pressed': accessibilityState?.selected },
      children,
    ),
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/gym-directory/GymReportingSettings', () => ({
  GymReportingSettings: ({ saveZone }: { saveZone: (zone: string) => Promise<void> }) =>
    createElement(
      'button',
      {
        onClick: () => void saveZone('America/Denver').catch(() => undefined),
        type: 'button',
      },
      'Save test zone',
    ),
}));

import GymAnalyticsScreen from '../analytics';

const activeWindow = {
  startAt: '2026-11-01T00:00:00Z',
  endAt: '2026-11-08T00:00:00Z',
  displayCount: 1,
  tickCount: 0,
  uniqueClimbers: 2,
  ascentCount: 0,
};
const report: GymStats = {
  gymName: 'Test Gym',
  gymUuid: 'gym-1',
  canManageBoardAliases: true,
  boardUuid: null,
  boards: [
    {
      uuid: 'board-1',
      name: 'Wall One',
      boardType: 'kilter',
      configurations: [{ uuid: 'board-1', name: 'Wall One' }],
    },
  ],
  asOf: activeWindow.endAt,
  timeZone: 'UTC',
  timeZoneConfigured: false,
  coverage: {
    observedSince: '2025-11-08T00:00:00Z',
    firstDisplayAt: activeWindow.startAt,
    firstTickAt: null,
    dateOnlyCount: 0,
    boundaryUncertainCount: 0,
    unknownTimeCount: 0,
    includesCurrentBoardHistory: false,
    isPartial: true,
  },
  periodDays: 7,
  current: activeWindow,
  previous: { ...activeWindow, startAt: '2026-10-24T00:00:00Z', endAt: activeWindow.startAt },
  topClimbs: [],
  busiestDays: [],
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

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <GymAnalyticsScreen />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, queryClient };
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.viewer = 'viewer-one';
  mocks.generation = 1;
  mocks.focused = true;
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe('GymAnalyticsScreen', () => {
  it('opens display-only data with zero sends and applies a physical board, range and zone', async () => {
    mocks.request.mockResolvedValue({ gymStats: report });
    renderScreen();
    expect(await screen.findByText('gymReporting.climbers 2')).toBeTruthy();
    expect(screen.getByText('gymReporting.sends 0')).toBeTruthy();
    expect(screen.getByText('gymReporting.utcFallback')).toBeTruthy();
    expect(screen.getByText(/gymReporting.observationWindow.*Nov 8, 2025.*Nov 8, 2026/)).toBeTruthy();
    expect(screen.getByText(/gymReporting.firstDisplay.*Nov 1, 2026/)).toBeTruthy();
    expect(screen.getByText('gymReporting.noTimedTick')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Wall One' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: { input: { gymUuid: 'gym-1', boardUuid: 'board-1', period: 'week' } },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'gymReporting.rangeDays 90' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: { input: { gymUuid: 'gym-1', boardUuid: 'board-1', period: 'quarter' } },
        }),
      ),
    );
  });

  it('shows five cards and lets a screen-reader user select exact weekly counts', async () => {
    mocks.request.mockResolvedValue({ gymStats: { ...report, reachOverview: reach } });
    renderScreen();
    await screen.findByText('gymReach.climbers');
    for (const title of [
      'gymReach.first',
      'gymReach.returned',
      'gymReach.sends',
      'gymReach.sessions',
      'gymReach.trend',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('gymReach.returnedDefinition 4 8')).toBeTruthy();
    const missing = screen.getByRole('button', { name: /Aug 17, 2026.*gymReach.missing/ });
    fireEvent.click(missing);
    expect(missing.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'gymReach.trendSends' }));
    expect(
      screen.getByRole('button', { name: /Aug 17, 2026.*gymReach.weekSends 0/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /Nov 2, 2026.*gymReach.weekSends 13.*gymReach.inProgress/ }),
    ).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('shows null exact observations independently from date-only reporting activity', async () => {
    mocks.request.mockResolvedValue({
      gymStats: {
        ...report,
        current: { ...activeWindow, displayCount: 0, tickCount: 1 },
        coverage: { ...report.coverage, firstDisplayAt: null, dateOnlyCount: 1 },
      },
    });
    renderScreen();
    expect(await screen.findByText('gymReporting.climbers 2')).toBeTruthy();
    expect(screen.getByText(/gymReporting.observationWindow.*Nov 8, 2025.*Nov 8, 2026/)).toBeTruthy();
    expect(screen.getByText('gymReporting.noTimedDisplay')).toBeTruthy();
    expect(screen.getByText('gymReporting.noTimedTick')).toBeTruthy();
    expect(screen.getByText('gymReporting.dateOnly 1')).toBeTruthy();
  });

  it('keeps the selected range through route refocus and removes revoked results', async () => {
    mocks.request.mockResolvedValue({ gymStats: report });
    const { rerender, tree } = renderScreen();
    await screen.findByText('gymReporting.climbers 2');
    fireEvent.click(screen.getByRole('button', { name: 'gymReporting.rangeDays 30' }));
    await screen.findByText('gymReporting.climbers 2');
    mocks.focused = false;
    rerender(tree());
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
    mocks.request.mockRejectedValue({ response: { errors: [{ extensions: { code: 'FORBIDDEN' } }] } });
    mocks.focused = true;
    rerender(tree());
    await screen.findByText('gymReporting.denied');
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        variables: { input: { gymUuid: 'gym-1', boardUuid: null, period: 'month' } },
      }),
    );
  });

  it('retires a denied settings read while offline and ignores the aborted response', async () => {
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
      .mockResolvedValueOnce({ gymStats: { ...report, current: { ...activeWindow, uniqueClimbers: 3 } } });
    const { queryClient } = renderScreen();
    await screen.findByText('gymReporting.climbers 2');
    fireEvent.click(screen.getByRole('button', { name: 'Save test zone' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'gymReporting.refresh' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
    const supersededSignal: AbortSignal = mocks.request.mock.calls[2][0].signal;
    act(() => onlineManager.setOnline(false));
    await screen.findByText(/gymReporting.stale/);
    await act(async () => denySave({ response: { errors: [{ extensions: { code: 'NOT_FOUND' } }] } }));
    expect(await screen.findByText('gymReporting.offline')).toBeTruthy();
    expect(supersededSignal.aborted).toBe(true);
    const queryKey = gymReportingQueryKey(mocks.viewer, 'gym-1', null, 'week');
    expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe('paused');
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    await act(async () => completeOldRead({ gymStats: report }));
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText('gymReporting.climbers 3')).toBeTruthy();
  });

  it('hides a continuously foregrounded offline report at the verification deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    mocks.request.mockResolvedValueOnce({ gymStats: report }).mockRejectedValue(new Error('network failure'));
    const { queryClient } = renderScreen();
    const advance = async (duration: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(duration);
      });
    };
    await advance(20);
    expect(screen.getByText('gymReporting.climbers 2')).toBeTruthy();
    act(() => onlineManager.setOnline(false));
    await advance(10);
    expect(screen.getByText(/gymReporting.stale/)).toBeTruthy();
    const queryKey = gymReportingQueryKey(mocks.viewer, 'gym-1', null, 'week');
    const receivedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
    expect(receivedAt).toBeTruthy();
    await advance((receivedAt ?? 0) + GYM_REPORTING_RECEIPT_MS - Date.now() - 1);
    expect(screen.getByText('gymReporting.climbers 2')).toBeTruthy();
    await advance(2);
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
    expect(screen.queryByText(/gymReporting.stale/)).toBeNull();
    expect(screen.getByText('gymReporting.offline')).toBeTruthy();
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    act(() => onlineManager.setOnline(true));
    await advance(20);
    expect(screen.getByText('gymReporting.loadError')).toBeTruthy();
    act(() => onlineManager.setOnline(false));
    await advance(20);
    expect(screen.queryByText(/gymReporting.stale/)).toBeNull();
  });

  it('cancels outstanding data when the signed-in account changes', async () => {
    let completePrevious: (result: { gymStats: GymStats }) => void = () => undefined;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completePrevious = resolve;
          }),
      )
      .mockResolvedValueOnce({ gymStats: { ...report, current: { ...activeWindow, uniqueClimbers: 1 } } });
    const { rerender, tree } = renderScreen();
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    const firstSignal: AbortSignal = mocks.request.mock.calls[0][0].signal;
    mocks.viewer = 'viewer-two';
    mocks.generation += 1;
    rerender(tree());
    await screen.findByText('gymReporting.climbers 1');
    expect(firstSignal.aborted).toBe(true);
    await act(async () => completePrevious({ gymStats: report }));
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
  });
});
