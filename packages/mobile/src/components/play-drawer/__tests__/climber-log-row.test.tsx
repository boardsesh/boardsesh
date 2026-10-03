// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) =>
    createElement('span', { 'data-lines': numberOfLines }, children),
}));
vi.mock('../../Avatar', () => ({
  Avatar: ({ name, size }: { name?: string | null; size?: number }) =>
    createElement('i', { 'data-testid': 'avatar', 'data-name': name ?? '', 'data-size': size }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
  }) =>
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
}));
// The marks have their own suite; here they only need to show what they were handed.
vi.mock('../../ascent-marks', () => ({
  AscentStatusMark: ({ status }: { status: string }) => createElement('i', { 'data-testid': `mark-${status}` }),
  GradePill: ({ difficultyId }: { difficultyId: number | null | undefined }) =>
    difficultyId == null ? null : createElement('span', { 'data-testid': 'grade' }, `grade:${difficultyId}`),
  StarNumber: ({ quality }: { quality: number | null | undefined }) =>
    quality == null ? null : createElement('span', { 'data-testid': 'stars' }, `stars:${quality}`),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#primary', primaryFill: '#primaryFill' },
    systemColors: { fill: '#fill', secondaryLabel: '#secondary', separator: '#separator' },
  }),
}));
const relativeTime = vi.hoisted(() => ({ calls: [] as Array<string | null | undefined> }));
vi.mock('../../../lib/format-relative-time', () => ({
  formatRelativeTime: (iso: string | null | undefined) => {
    relativeTime.calls.push(iso);
    return `ago(${iso})`;
  },
}));

import { ClimberLogEarlierRow, ClimberLogRow } from '../ClimberLogRow';
import { groupClimberLogs, type ClimberLog, type ClimberLogGroup } from '../climber-logs';

let nextId = 0;
function log(overrides: Partial<ClimberLog> = {}): ClimberLog {
  nextId += 1;
  return {
    uuid: `log-${nextId}`,
    userId: 'mika',
    userDisplayName: 'Mika Tanaka',
    userAvatarUrl: null,
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 4,
    quality: null,
    effectiveQuality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-03-10T18:00:00',
    ...overrides,
  };
}

function groupOf(...logs: ClimberLog[]): ClimberLogGroup {
  return groupClimberLogs(logs, 40)[0];
}

function renderRow(group: ClimberLogGroup, props: Partial<Parameters<typeof ClimberLogRow>[0]> = {}) {
  const onPressClimber = vi.fn();
  const view = render(createElement(ClimberLogRow, { group, boardAngle: 40, onPressClimber, ...props }));
  return { ...view, onPressClimber };
}

describe('ClimberLogRow', () => {
  it('shows the name, the relative time and the note', () => {
    relativeTime.calls = [];
    const { getByText, container } = renderRow(groupOf(log({ comment: '  Heel on the start jug  ' })));

    expect(getByText('Mika Tanaka')).toBeTruthy();
    // Recency goes through the one frozen-clock door, never a formatter of its own.
    expect(relativeTime.calls).toEqual(['2026-03-10T18:00:00']);
    expect(getByText('ago(2026-03-10T18:00:00)')).toBeTruthy();
    expect(getByText('Heel on the start jug').getAttribute('data-lines')).toBe('3');
    expect(container.querySelector('[data-testid="avatar"]')?.getAttribute('data-size')).toBe('36');
  });

  it('falls back to a generic name when the climber has none', () => {
    const { getByText } = renderRow(groupOf(log({ userDisplayName: null })));
    expect(getByText('mobile.climberLogs.unknownClimber')).toBeTruthy();
  });

  it.each([
    ['flash', 1, 'mark-flash', 'mobile.climberLogs.resultFlash'],
    ['send', 4, 'mark-send', 'mobile.climberLogs.resultSentIn:{"count":4}'],
    ['attempt', 6, 'mark-attempt', 'mobile.climberLogs.resultNoSend:{"count":6}'],
    ['attempt', 0, 'mark-attempt', 'mobile.climberLogs.resultNoSend:{"count":1}'],
  ])('words a %s with %i tries', (status, attemptCount, mark, words) => {
    const { getByText, getByTestId } = renderRow(groupOf(log({ status, attemptCount })));
    expect(getByTestId(mark)).toBeTruthy();
    expect(getByText(words)).toBeTruthy();
  });

  it('shows the grade they gave, and no pill without one', () => {
    const graded = renderRow(groupOf(log({ difficulty: 18 })));
    expect(graded.getByText('grade:18')).toBeTruthy();
    graded.unmount();
    expect(renderRow(groupOf(log({ difficulty: null }))).queryByTestId('grade')).toBeNull();
  });

  it('prefers the effective rating over the raw one', () => {
    const cases: Array<[number | null, number | null, string]> = [
      [null, 4, 'stars:4'],
      [3, null, 'stars:3'],
      [2, 5, 'stars:5'],
    ];
    for (const [quality, effectiveQuality, shown] of cases) {
      const view = renderRow(groupOf(log({ quality, effectiveQuality })));
      expect(view.getByTestId('stars').textContent).toBe(shown);
      view.unmount();
    }
  });

  it('shows no stars on a log with no send', () => {
    const { queryByTestId } = renderRow(groupOf(log({ status: 'attempt', quality: 4, effectiveQuality: 4 })));
    expect(queryByTestId('stars')).toBeNull();
  });

  it('fills the angle pill only when the log is at the board angle', () => {
    const here = renderRow(groupOf(log({ angle: 40 })));
    expect(here.getByTestId('climber-log-angle-here').textContent).toBe('40°');
    expect(here.queryByTestId('climber-log-angle-other')).toBeNull();
    here.unmount();

    const elsewhere = renderRow(groupOf(log({ angle: 45 })));
    expect(elsewhere.getByTestId('climber-log-angle-other').textContent).toBe('45°');
    expect(elsewhere.queryByTestId('climber-log-angle-here')).toBeNull();
  });

  it('opens the climber once per press', () => {
    const { getByRole, onPressClimber } = renderRow(groupOf(log()));
    fireEvent.click(getByRole('button'));
    expect(onPressClimber).toHaveBeenCalledTimes(1);
    expect(onPressClimber).toHaveBeenCalledWith('mika');
  });

  describe('the earlier-logs line', () => {
    const group = () =>
      groupOf(
        log({ comment: 'beta' }),
        log({ status: 'attempt', attemptCount: 5, climbedAt: '2026-03-01T18:00:00' }),
        log({ status: 'attempt', attemptCount: 4, climbedAt: '2026-03-03T18:00:00' }),
      );

    it('reads logs, tries and days as plain text when it cannot be pressed', () => {
      const { container, getAllByRole } = renderRow(group());
      expect(container.textContent).toContain('mobile.climberLogs.earlierDetail');
      expect(container.textContent).toContain('mobile.climberLogs.earlierLogs:{\\"count\\":2}');
      expect(container.textContent).toContain('mobile.logbook.tries:{\\"count\\":9}');
      expect(container.textContent).toContain('mobile.climberLogs.earlierDays:{\\"count\\":2}');
      expect(getAllByRole('button')).toHaveLength(1);
    });

    it('is hidden when the rows are cut by the cap', () => {
      const { container } = renderRow(group(), { hideEarlier: true, onPressEarlier: vi.fn() });
      expect(container.textContent).not.toContain('mobile.climberLogs.earlierDetail');
    });

    it('is absent for a climber with one log', () => {
      const { container } = renderRow(groupOf(log()), { onPressEarlier: vi.fn() });
      expect(container.textContent).not.toContain('mobile.climberLogs.earlierDetail');
    });

    it('becomes its own button when a handler is passed, beside the row button', () => {
      const onPressEarlier = vi.fn();
      const { getAllByRole, onPressClimber } = renderRow(group(), { onPressEarlier, earlierExpanded: true });
      const buttons = getAllByRole('button');
      expect(buttons).toHaveLength(2);
      // Siblings, not nested: a button inside a button is unreachable for a screen reader.
      expect(buttons[0].contains(buttons[1])).toBe(false);
      expect(buttons[1].getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(buttons[1]);
      expect(onPressEarlier).toHaveBeenCalledWith('mika');
      expect(onPressClimber).not.toHaveBeenCalled();
    });
  });
});

describe('ClimberLogEarlierRow', () => {
  it('shows the result, the time and the note of one earlier log', () => {
    const earlier = log({ status: 'attempt', attemptCount: 3, comment: 'Barn door on the last move' });
    const { getByText, getByTestId } = render(createElement(ClimberLogEarlierRow, { log: earlier, boardAngle: 40 }));
    expect(getByTestId('mark-attempt')).toBeTruthy();
    expect(getByText('mobile.climberLogs.resultNoSend:{"count":3}')).toBeTruthy();
    expect(getByText('Barn door on the last move')).toBeTruthy();
    expect(getByText(`ago(${earlier.climbedAt})`)).toBeTruthy();
  });
});
