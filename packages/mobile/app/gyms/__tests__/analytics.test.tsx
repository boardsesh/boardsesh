// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createElement, type ChangeEvent, type ReactNode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { GYM_REPORTING_RECEIPT_MS, gymReportingQueryKey } from '@boardsesh/graphql';
import type {
  GymAngleUsageRow,
  GymBusyTimes,
  GymGradeCollectionPage,
  GymGradeComparison,
  GymReachOverview,
  GymStats,
} from '@boardsesh/shared-schema';
import type { GymAngleUsageListRow } from '../../../src/components/gym-directory/GymAngleUsage';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  gradeRequest: vi.fn(),
  viewer: 'viewer-one',
  generation: 1,
  focused: true,
  selectionCheckmark: '#007f66',
  selectionSeparator: '#999999',
}));

type Children = { children?: ReactNode };
type PressProps = Children & {
  accessibilityLabel?: string;
  accessibilityState?: { expanded?: boolean };
  onPress?: () => void;
};
type FlashListProps = {
  data: GymAngleUsageListRow[];
  renderItem: (entry: { item: GymAngleUsageListRow }) => ReactNode;
  keyExtractor: (item: GymAngleUsageListRow) => string;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
};
type LayoutProps = Children & { style?: { flexDirection?: string } };
type ScrollProps = Children & { horizontal?: boolean; contentContainerStyle?: LayoutProps['style'] };
type MenuProps = { actions: { label: string }[]; onSelectIndex: (index: number) => void };
type SegmentedProps = { options: { key: string; label: string }[]; onSelect: (key: string) => void };
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityState }: PressProps) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-expanded': accessibilityState?.expanded,
      },
      children,
    ),
  ScrollView: ({ children, horizontal, contentContainerStyle }: ScrollProps) =>
    createElement(
      'div',
      horizontal
        ? { 'data-testid': 'horizontal-native-scroll', 'data-content-direction': contentContainerStyle?.flexDirection }
        : null,
      children,
    ),
  View: ({ children, style }: LayoutProps) =>
    createElement('div', { 'data-layout-direction': style?.flexDirection }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 320, fontScale: 1 }),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent }: FlashListProps) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
      ListFooterComponent,
    ),
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
  useTheme: () => ({
    systemColors: { separator: mocks.selectionSeparator },
    brandColors: { primary: '#8b5cf6' },
    selection: { checkmark: mocks.selectionCheckmark },
  }),
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
  getHttpClient: () => ({
    request: (request: { document?: string } | string, variables?: unknown) => {
      const document = typeof request === 'string' ? request : request.document;
      return /(?:GymGradeComparison|GymGradeCollectionOptions|SetGymGradeCollection)/.test(document ?? '')
        ? mocks.gradeRequest(request)
        : variables === undefined
          ? mocks.request(request)
          : mocks.request(request, variables);
    },
  }),
}));
vi.mock('../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (grade: number) => 'V' + grade }),
}));
vi.mock('../../../src/components/ModalSheet', () => ({
  ModalSheet: ({ children, header }: Children & { header: ReactNode }) =>
    createElement('div', { role: 'dialog' }, header, children),
}));
vi.mock('../../../src/components/AccessibleBottomSheetTextInput', () => ({
  AccessibleBottomSheetTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) =>
    createElement('input', {
      value,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
      'aria-label': accessibilityLabel,
    }),
}));
vi.mock('../../../src/components/sheet-presentation', () => ({
  BottomSheetFlatList: ({
    data,
    keyExtractor,
    renderItem,
  }: {
    data?: GymGradeCollectionPage['collections'];
    keyExtractor: (item: GymGradeCollectionPage['collections'][number]) => string;
    renderItem: (info: { item: GymGradeCollectionPage['collections'][number] }) => ReactNode;
  }) =>
    createElement(
      'div',
      null,
      data?.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    ),
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
vi.mock('../../../src/components/PressableSurface', () => {
  const Pressable = ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    style?: { borderColor?: string }[];
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-pressed': accessibilityState?.selected,
        'data-border-color': Array.isArray(style)
          ? style.findLast((entry) => entry?.borderColor)?.borderColor
          : undefined,
      },
      children,
    );
  return { PressableSurface: Pressable, StaticPressableSurface: Pressable };
});
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

const busyWeekdays = Array.from({ length: 7 }, (_, index) => ({
  dayOfWeek: index + 1,
  eligibleDates: index === 2 ? 0 : 12,
  recordedClimbers: index === 0 ? 36 : 0,
}));
const busyTimes: GymBusyTimes = {
  status: 'ready',
  startDate: '2026-08-09',
  endDate: '2026-11-06',
  firstCoveredDate: '2026-08-10',
  coveredDates: 72,
  instantDisplays: 4,
  instantTicks: 3,
  dateOnlyRecords: 0,
  unplacedDateOnlyRecords: 0,
  unknownTimeRecords: 0,
  hasUnboundedUnknownTime: false,
  weekdays: busyWeekdays,
  hours: busyWeekdays.flatMap((entry) =>
    Array.from({ length: 24 }, (_, hour) => ({
      ...entry,
      hour,
      recordedClimbers: entry.dayOfWeek === 1 && hour === 0 ? 36 : 0,
    })),
  ),
};

const activeWindow = {
  startAt: '2026-11-01T00:00:00Z',
  endAt: '2026-11-08T00:00:00Z',
  displayCount: 1,
  tickCount: 0,
  uniqueClimbers: 2,
  ascentCount: 0,
};
const unknownAngle = { tickCount: 0, sendCount: 0, displayCount: 0 };
const angle = (degrees: number): GymAngleUsageRow => ({
  angle: degrees,
  distinctClimberCount: 2,
  climberDayCount: 3,
  tickCount: 4,
  sendCount: 1,
  displayCount: 2,
  unresolvedLocalDateTickCount: 1,
});
const tiedLabel = 'gymReporting.angleUsage.tied 40°, 45° 2';

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
    {
      uuid: 'board-2',
      name: 'Wall Two',
      boardType: 'kilter',
      configurations: [{ uuid: 'board-2', name: 'Wall Two' }],
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
  angleUsage: [
    { boardUuid: 'board-1', knownAngleClimberCount: 3, angles: [angle(45), angle(40)], unknownAngle },
    { boardUuid: 'board-2', knownAngleClimberCount: 2, angles: [angle(35)], unknownAngle },
  ],
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

const emptyGrades: GymGradeComparison = {
  gymUuid: report.gymUuid,
  asOf: activeWindow.endAt,
  startAt: activeWindow.startAt,
  timeZone: report.timeZone,
  availableCount: 0,
  sendCount: 0,
  grades: [],
  boards: [],
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
  mocks.gradeRequest.mockReset().mockResolvedValue({ gymGradeComparison: emptyGrades });
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
  it('renders the full 90-day chart and exact numeric view with no overview activity', async () => {
    mocks.request.mockResolvedValue({
      gymStats: { ...report, busyTimes, current: { ...activeWindow, displayCount: 0, tickCount: 0 } },
    });
    renderScreen();
    expect(await screen.findByText('gymBusyTimes.title')).toBeTruthy();
    const heatmap = screen.getByTestId('horizontal-native-scroll');
    expect(heatmap.getAttribute('data-content-direction')).toBe('column');
    expect(heatmap.children).toHaveLength(8);
    expect(Array.from(heatmap.children, (row) => row.getAttribute('data-layout-direction'))).toEqual(
      Array(8).fill('row'),
    );
    const chartButtons = screen.getAllByRole('button', { name: /gymBusyTimes\.(dayDetail|hourDetail|noDates)/ });
    expect(chartButtons).toHaveLength(175);
    const weekday = screen.getByRole('button', { name: /gymBusyTimes\.dayDetail.*Tuesday/ });
    expect(weekday.dataset.borderColor).toBe(mocks.selectionSeparator);
    fireEvent.click(weekday);
    expect(weekday.dataset.borderColor).toBe(mocks.selectionCheckmark);
    const zero = screen.getByRole('button', {
      name: /gymBusyTimes\.hourDetail.*Tuesday.*hourSpan 12:00 AM 1:00 AM 0 0 12/,
    });
    expect(zero.dataset.borderColor).toBe(mocks.selectionSeparator);
    fireEvent.click(zero);
    expect(zero.getAttribute('aria-pressed')).toBe('true');
    expect(zero.dataset.borderColor).toBe(mocks.selectionCheckmark);
    expect(screen.getByText(/gymBusyTimes\.hourDetail.*Tuesday.*hourSpan 12:00 AM 1:00 AM 0 0 12/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'gymBusyTimes.numbers' }));
    const wednesday = screen.getByRole('button', { name: 'Wednesday' });
    expect(wednesday.dataset.borderColor).toBe(mocks.selectionSeparator);
    fireEvent.click(wednesday);
    expect(wednesday.dataset.borderColor).toBe(mocks.selectionCheckmark);
    expect(screen.getAllByText(/gymBusyTimes.noDates.*Wednesday.*gymBusyTimes.hourSpan/)).toHaveLength(24);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

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

  it.each([false, true])('places time-zone settings before charts only when unset (%s)', async (configured) => {
    mocks.request.mockResolvedValue({ gymStats: { ...report, timeZoneConfigured: configured } });
    renderScreen();
    const settingsButton = await screen.findByRole('button', { name: 'Save test zone' });
    const recordedClimbers = screen.getByText('gymReporting.climbers 2');
    const position = settingsButton.compareDocumentPosition(recordedClimbers);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(!configured);
    expect(screen.getAllByRole('button', { name: 'Save test zone' })).toHaveLength(1);
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

  it('opens accessible angle details and replaces them when the verified physical scope changes', async () => {
    mocks.request
      .mockResolvedValueOnce({ gymStats: report })
      .mockResolvedValueOnce({
        gymStats: { ...report, boardUuid: 'board-2', angleUsage: [report.angleUsage[1]] },
      })
      .mockResolvedValueOnce({
        gymStats: {
          ...report,
          boardUuid: 'board-2',
          periodDays: 90,
          angleUsage: [
            {
              boardUuid: 'board-2',
              knownAngleClimberCount: 0,
              angles: [],
              unknownAngle: { ...unknownAngle, displayCount: 1 },
            },
          ],
        },
      });
    renderScreen();
    expect(await screen.findByText(tiedLabel)).toBeTruthy();
    expect(screen.getByText('gymReporting.angleUsage.single 35° 2')).toBeTruthy();
    const row = screen.getByRole('button', { name: /^40°.*66.67%.*climberDays 3/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(screen.getByText('gymReporting.angleUsage.climberDays 3')).toBeTruthy();
    expect(screen.getByText('gymReporting.angleUsage.unresolvedDates 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Wall Two' }));
    await waitFor(() => expect(screen.queryByText(tiedLabel)).toBeNull());
    const nextAngle = await screen.findByRole('button', { name: /^35°/ });
    expect(nextAngle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('gymReporting.angleUsage.climberDays 3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'gymReporting.rangeDays 90' }));
    expect(await screen.findByText('gymReporting.angleUsage.unknown')).toBeTruthy();
    expect(screen.getByText('gymReporting.angleUsage.displays 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^35°/ })).toBeNull();
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
    expect(screen.queryByText(tiedLabel)).toBeNull();
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
    expect(screen.getByText(tiedLabel)).toBeTruthy();
    await advance(2);
    expect(screen.queryByText('gymReporting.climbers 2')).toBeNull();
    expect(screen.queryByText(tiedLabel)).toBeNull();
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
      .mockResolvedValueOnce({
        gymStats: { ...report, angleUsage: [], current: { ...activeWindow, uniqueClimbers: 1 } },
      });
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
    expect(screen.queryByText(tiedLabel)).toBeNull();
  });
  it('keeps the playlist picker open while a denied choice and its private names are retired', async () => {
    mocks.request.mockResolvedValue({ gymStats: report });
    let completeGradeRefresh!: (payload: { gymGradeComparison: GymGradeComparison }) => void;
    let completePickerRefresh!: (payload: { gymGradeCollectionOptions: GymGradeCollectionPage }) => void;
    let gradeReads = 0;
    let pickerReads = 0;
    const choice = { uuid: 'withdrawn', name: 'Withdrawn candidate' };
    const replacement = { uuid: 'replacement', name: 'Replacement candidate' };
    const board = {
      boardUuid: report.boards[0].uuid,
      physicalBoardUuid: report.boards[0].uuid,
      boardName: report.boards[0].name,
      kind: 'LED_COLLECTION',
      status: 'READY',
      included: true,
      variantCount: 1,
      collectionName: 'Old private selection',
    } as const;
    const initial: GymGradeComparison = {
      ...emptyGrades,
      availableCount: 1,
      grades: [{ boardType: 'kilter', difficultyId: null, availableCount: 1, sendCount: 0 }],
      boards: [board],
    };
    const unavailable: GymGradeComparison = {
      ...emptyGrades,
      boards: [
        {
          ...board,
          status: 'COLLECTION_UNAVAILABLE',
          included: false,
          variantCount: 0,
          collectionName: null,
        },
      ],
    };
    const after: GymGradeComparison = { ...initial, boards: [{ ...board, collectionName: 'New private selection' }] };
    mocks.gradeRequest.mockImplementation(
      (request: { document: string; variables: { input: { playlistUuid?: string } } }) => {
        if (request.document.includes('query GetGymGradeComparison')) {
          if (++gradeReads === 1) return Promise.resolve({ gymGradeComparison: initial });
          if (gradeReads === 2) {
            return new Promise((resolve) => {
              completeGradeRefresh = resolve;
            });
          }
          return Promise.resolve({ gymGradeComparison: after });
        }
        if (request.document.includes('query GetGymGradeCollectionOptions')) {
          if (++pickerReads === 1) {
            return Promise.resolve({ gymGradeCollectionOptions: { collections: [choice], nextCursor: null } });
          }
          if (pickerReads === 2) {
            return new Promise((resolve) => {
              completePickerRefresh = resolve;
            });
          }
          return Promise.resolve({ gymGradeCollectionOptions: { collections: [replacement], nextCursor: null } });
        }
        if (request.variables.input.playlistUuid === choice.uuid) {
          return Promise.reject({ response: { errors: [{ extensions: { code: 'COLLECTION_UNAVAILABLE' } }] } });
        }
        return Promise.resolve({ setGymGradeCollection: true });
      },
    );

    renderScreen();
    await screen.findByText(/Old private selection/);
    fireEvent.click(screen.getByRole('button', { name: 'gymGradeComparison.change' }));
    fireEvent.click(await screen.findByRole('button', { name: choice.name }));
    expect(await screen.findByText('gymGradeComparison.incompatible')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('gymReporting.climbers 2')).toBeTruthy();
    expect(screen.queryByText(/Old private selection/)).toBeNull();
    expect(screen.queryByText(choice.name)).toBeNull();

    await waitFor(() => {
      expect(completeGradeRefresh).toBeDefined();
      expect(completePickerRefresh).toBeDefined();
    });
    await act(async () => {
      completeGradeRefresh({ gymGradeComparison: unavailable });
      completePickerRefresh({ gymGradeCollectionOptions: { collections: [replacement], nextCursor: null } });
    });
    fireEvent.click(await screen.findByRole('button', { name: replacement.name }));
    expect(await screen.findByText(/New private selection/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('gymReporting.climbers 2')).toBeTruthy();
  });
});
