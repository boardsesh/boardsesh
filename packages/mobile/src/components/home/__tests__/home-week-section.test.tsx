// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import { buildWeekSummary } from '@boardsesh/profile-stats';
import type { ActivityTick } from '../../../db/queries/get-activity-ticks-local';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn(), openClimb: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => router }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: drawer.openClimb }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficulty: number) => `V${difficulty - 16}` }),
}));
vi.mock('../use-week-summary', () => ({ useWeekSummary: () => undefined }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, chartColors: {}, brandColors: {} }),
}));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../StatusPill', () => ({
  StatusPill: ({ label, testID }: { label: string; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, label),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('p', { 'data-testid': testID }, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': testID }, children),
}));

import { HomeWeekCard } from '../HomeWeekSection';

const TODAY = dayjs('2026-11-18T12:00:00');

function tick(day: string, status: ActivityTick['status'], difficulty: number | null, climbName: string | null = null) {
  return {
    climbedAt: dayjs(`${day}T18:00:00`).toISOString(),
    status,
    difficulty,
    boardType: 'kilter',
    climbUuid: `climb-${day}-${difficulty}`,
    angle: 40,
    climbName,
    layoutId: 8,
    attemptCount: 1,
  } satisfies ActivityTick;
}

const summaryOf = (ticks: ActivityTick[]) => buildWeekSummary(ticks, { today: TODAY });

beforeEach(() => {
  drawer.openClimb.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('HomeWeekCard', () => {
  it('shows only the start line for a climber with nothing logged', () => {
    render(createElement(HomeWeekCard, { summary: summaryOf([]) }));
    expect(screen.getByTestId('home-week-start').textContent).toBe('mobile.home.sections.week.empty');
    expect(screen.queryByTestId('home-week-dots')).toBeNull();
  });

  it('collapses to the start line after four quiet weeks', () => {
    render(createElement(HomeWeekCard, { summary: summaryOf([tick('2026-10-01', 'send', 20)]) }));
    expect(screen.getByTestId('home-week-start')).toBeTruthy();
  });

  it('draws the week: totals, hardest send, the run and the climbed days', () => {
    const summary = summaryOf([
      tick('2026-11-03', 'send', 24),
      tick('2026-11-10', 'send', 22),
      tick('2026-11-16', 'send', 22),
      tick('2026-11-17', 'attempt', 24),
    ]);
    render(createElement(HomeWeekCard, { summary }));
    expect(screen.getByTestId('home-week-totals').textContent).toBe(
      'mobile.home.sections.week.sessions {"count":2} · mobile.home.sections.week.sends {"count":1}',
    );
    expect(screen.getByTestId('home-week-hardest').textContent).toBe(
      'mobile.home.sections.week.hardest {"grade":"V6"}',
    );
    expect(screen.getByTestId('home-week-running').textContent).toBe(
      'mobile.home.sections.week.weeksRunning {"count":3}',
    );
    expect(screen.getAllByTestId('home-week-day-active')).toHaveLength(2);
    expect(screen.queryByTestId('home-week-record')).toBeNull();
  });

  it('reads a week with nothing logged yet as a start, keeping the run', () => {
    const summary = summaryOf([tick('2026-11-03', 'send', 20), tick('2026-11-10', 'send', 20)]);
    render(createElement(HomeWeekCard, { summary }));
    expect(screen.queryByTestId('home-week-totals')).toBeNull();
    expect(screen.getByTestId('home-week-start')).toBeTruthy();
    expect(screen.getByTestId('home-week-running')).toBeTruthy();
    expect(screen.getByTestId('home-week-dots')).toBeTruthy();
  });

  it('names a record with nothing to open when the climb is not on the phone', () => {
    render(createElement(HomeWeekCard, { summary: summaryOf([tick('2026-11-17', 'send', 23)]) }));
    expect(screen.queryByTestId('home-week-record')).toBeNull();
    expect(screen.getByTestId('home-week-record-text')).toBeTruthy();
  });

  it('leaves the run out while it is a single week', () => {
    render(createElement(HomeWeekCard, { summary: summaryOf([tick('2026-11-16', 'send', 20)]) }));
    expect(screen.queryByTestId('home-week-running')).toBeNull();
  });

  it('names a new top grade and opens its climb', () => {
    const summary = summaryOf([tick('2026-11-02', 'send', 22), tick('2026-11-17', 'send', 23, 'Jolly Roger')]);
    render(createElement(HomeWeekCard, { summary }));
    const record = screen.getByTestId('home-week-record');
    expect(record.getAttribute('aria-label')).toBe(
      'mobile.home.sections.week.recordClimb {"record":"mobile.home.sections.week.recordFirstGrade {\\"grade\\":\\"V7\\"}","climb":"Jolly Roger"}',
    );
    fireEvent.click(record);
    expect(drawer.openClimb).toHaveBeenCalledExactlyOnceWith(
      { kind: 'ref', climbUuid: 'climb-2026-11-17-23', boardType: 'kilter', layoutId: 8, angle: 40 },
      { openPlayDrawer: drawer.openPlayDrawer, router },
    );
  });
});
