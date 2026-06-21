// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SummaryResult = {
  data: unknown;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

const hook = vi.hoisted(() => ({
  result: {
    data: undefined as unknown,
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  } as SummaryResult,
}));

const router = vi.hoisted(() => ({ back: vi.fn() }));
const routeParams = vi.hoisted(() => ({
  current: { sessionId: 'session-1' } as { sessionId: string; reviewCandidate?: string },
}));
const storeReview = vi.hoisted(() => ({
  maybeRequestSessionStoreReview: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => router,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useSessionSummary: () => hook.result }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
// Stub the integration summary actions so the real integrations lib (which
// pulls in the native health-workouts/reanimated modules) isn't loaded in the
// node test env.
vi.mock('../../../../src/components/integrations/SaveToAppleHealthButton', () => ({
  SaveToAppleHealthButton: () => createElement('div', { 'data-testid': 'save-apple-health' }),
}));
vi.mock('../../../../src/components/integrations/ShareToStravaButton', () => ({
  ShareToStravaButton: () => createElement('div', { 'data-testid': 'share-strava' }),
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../../src/lib/store-review', () => ({
  SESSION_STORE_REVIEW_CANDIDATE_PARAM: '1',
  STORE_REVIEW_PROMPT_DELAY_MS: 1000,
  isSessionStoreReviewEligible: (summary: { totalSends: number }) => summary.totalSends >= 3,
  maybeRequestSessionStoreReview: storeReview.maybeRequestSessionStoreReview,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
  StyleSheet: { create: (styles: unknown) => styles },
}));

// The screen pulls brandColors from the theme module, which evaluates
// PlatformColor at import time; stub it so the node test env stays happy.
vi.mock('../../../../src/theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../../../src/theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 8 }),
  borderRadius: new Proxy({}, { get: () => 8 }),
}));

// Lightweight component stubs — Button renders its title as a clickable button.
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../../../src/components/Avatar', () => ({ Avatar: () => createElement('div', null) }));
vi.mock('../../../../src/components/SectionHeader', () => ({ SectionHeader: () => createElement('div', null) }));
vi.mock('../../../../src/components/Separator', () => ({ Separator: () => createElement('div', null) }));
vi.mock('../../../../src/components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

// The loaded recap pulls in reanimated, the native climb renderer, and the
// gifted-charts bar chart — none of which load in this node/jsdom env. Stub them
// so the screen's loading/error/store-review logic stays testable in isolation.
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  withDelay: (_delay: unknown, value: unknown) => value,
}));
vi.mock('../../../../src/components/ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => createElement('div', null),
}));
vi.mock('../../../../src/components/you/AvatarGroup', () => ({ AvatarGroup: () => createElement('div', null) }));
vi.mock('../../../../src/components/you/YouCharts', () => ({ StackedBarChart: () => createElement('div', null) }));
vi.mock('../../../../src/components/you/profile-chart-colors', () => ({
  buildSessionGradeBars: () => null,
  gradeBadgeColor: () => '#000000',
}));
vi.mock('../../../../src/components/session/session-stat-tiles', () => ({
  StatTile: () => createElement('div', null),
  GradeTile: () => createElement('div', null),
}));
vi.mock('../../../../src/lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('../../../../src/lib/format-session-when', () => ({ formatSessionWhen: () => 'Sunday morning' }));
vi.mock('../../../../src/theme/animations', () => ({ springs: {}, timing: { fast: 150, normal: 250 } }));
vi.mock('../../../../src/lib/haptics', () => ({ hapticSuccess: () => {} }));

// Imported after mocks so it binds to the stubbed dependencies.
const { default: SessionSummaryScreen } = await import('../summary');

function setSummary(partial: Partial<SummaryResult>) {
  hook.result = {
    data: undefined,
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: hook.result.refetch,
    ...partial,
  };
}

describe('SessionSummaryScreen settled error/empty state', () => {
  beforeEach(() => {
    router.back.mockClear();
    routeParams.current = { sessionId: 'session-1' };
    storeReview.maybeRequestSessionStoreReview.mockReset();
    storeReview.maybeRequestSessionStoreReview.mockResolvedValue(false);
    hook.result.refetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a spinner while the summary is still loading', () => {
    setSummary({ isPending: true, isFetching: true });
    const { queryByText, getByTestId } = render(<SessionSummaryScreen />);
    expect(getByTestId('spinner')).toBeTruthy();
    expect(queryByText('summary.done')).toBeNull();
  });

  it('shows a Done button (not an endless spinner) when the query errors', () => {
    setSummary({ isError: true });
    const { queryByTestId, getByText } = render(<SessionSummaryScreen />);
    expect(queryByTestId('spinner')).toBeNull();
    expect(getByText('summary.done')).toBeTruthy();
    expect(getByText('summary.retry')).toBeTruthy();
    fireEvent.click(getByText('summary.done'));
    expect(router.back).toHaveBeenCalledOnce();
  });

  it('shows the error state (not a spinner) when the query settles with no summary', () => {
    setSummary({ data: undefined, isPending: false, isFetching: false });
    const { queryByTestId, getByText } = render(<SessionSummaryScreen />);
    expect(queryByTestId('spinner')).toBeNull();
    expect(getByText('summary.loadErrorTitle')).toBeTruthy();
    expect(getByText('summary.done')).toBeTruthy();
  });

  it('retry triggers refetch', () => {
    const refetch = vi.fn();
    setSummary({ isError: true });
    hook.result.refetch = refetch;
    const { getByText } = render(<SessionSummaryScreen />);
    fireEvent.click(getByText('summary.retry'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('requests store review once after a review-candidate summary settles', async () => {
    vi.useFakeTimers();
    routeParams.current = { sessionId: 'session-1', reviewCandidate: '1' };
    const summary = {
      sessionId: 'session-1',
      totalSends: 3,
      totalAttempts: 0,
      durationMinutes: null,
      gradeDistribution: [],
      participants: [],
      hardestClimb: null,
      goal: null,
    };
    setSummary({ data: summary });

    render(<SessionSummaryScreen />);
    expect(storeReview.maybeRequestSessionStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(storeReview.maybeRequestSessionStoreReview).toHaveBeenCalledOnce();
    expect(storeReview.maybeRequestSessionStoreReview).toHaveBeenCalledWith(summary);
  });

  it('still requests store review when the summary refetches before the delay expires', async () => {
    vi.useFakeTimers();
    routeParams.current = { sessionId: 'session-1', reviewCandidate: '1' };
    const firstSummary = {
      sessionId: 'session-1',
      totalSends: 3,
      totalAttempts: 0,
      durationMinutes: null,
      gradeDistribution: [],
      participants: [],
      hardestClimb: null,
      goal: null,
    };
    const refetchedSummary = { ...firstSummary };
    setSummary({ data: firstSummary });

    const { rerender } = render(<SessionSummaryScreen />);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    setSummary({ data: refetchedSummary });
    rerender(<SessionSummaryScreen />);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(storeReview.maybeRequestSessionStoreReview).toHaveBeenCalledOnce();
    expect(storeReview.maybeRequestSessionStoreReview).toHaveBeenCalledWith(refetchedSummary);
  });

  it('does not request store review without the post-end route flag', async () => {
    vi.useFakeTimers();
    const summary = {
      sessionId: 'session-1',
      totalSends: 3,
      totalAttempts: 0,
      durationMinutes: null,
      gradeDistribution: [],
      participants: [],
      hardestClimb: null,
      goal: null,
    };
    setSummary({ data: summary });

    render(<SessionSummaryScreen />);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(storeReview.maybeRequestSessionStoreReview).not.toHaveBeenCalled();
  });
});
