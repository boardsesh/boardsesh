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
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-testid': 'icon', 'data-name': name }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (difficultyId: number | null | undefined) =>
      difficultyId == null ? null : `grade:${difficultyId}`,
  }),
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

import { ClimberLogBareRow, ClimberLogEarlierFoldRow, ClimberLogEarlierRow, ClimberLogRow } from '../ClimberLogRow';
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

/** The climb is graded 16 at the board's angle, 40°. */
const CLIMB_GRADE = 16;

function groupOf(...logs: ClimberLog[]): ClimberLogGroup {
  return groupClimberLogs(logs, 40, CLIMB_GRADE)[0];
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
    expect(container.textContent).toContain('ago(2026-03-10T18:00:00)');
    expect(getByText('Heel on the start jug').getAttribute('data-lines')).toBe('3');
    expect(container.querySelector('[data-testid="avatar"]')?.getAttribute('data-size')).toBe('32');
  });

  it('falls back to a generic name when the climber has none', () => {
    const { getByText } = renderRow(groupOf(log({ userDisplayName: null })));
    expect(getByText('mobile.climberLogs.unknownClimber')).toBeTruthy();
  });

  it.each([
    ['flash', 1, 'mobile.climberLogs.resultFlash'],
    ['send', 4, 'mobile.climberLogs.resultSentIn:{"count":4}'],
    ['attempt', 6, 'mobile.climberLogs.resultNoSend:{"count":6}'],
    ['attempt', 0, 'mobile.climberLogs.resultNoSend:{"count":1}'],
  ])('says how a %s with %i tries went in words', (status, attemptCount, words) => {
    const { container } = renderRow(groupOf(log({ status, attemptCount })));
    expect(container.textContent).toContain(words);
  });

  it('carries no chip: no status mark, no angle or grade pill, no stars', () => {
    const { container } = renderRow(
      groupOf(log({ comment: 'beta', difficulty: CLIMB_GRADE, quality: 5, effectiveQuality: 5 })),
    );
    expect(container.querySelector('[data-testid^="mark-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="climber-log-angle"]')).toBeNull();
    expect(container.querySelector('[data-testid="stars"]')).toBeNull();
    expect(container.textContent).not.toContain('5');
  });

  it('names the grade only when it disagrees with the climb at the board angle', () => {
    const disagrees = renderRow(groupOf(log({ difficulty: 18 })));
    expect(disagrees.getByText('mobile.climberLogs.gradedIt:{"grade":"grade:18"}')).toBeTruthy();
    disagrees.unmount();

    const agrees = renderRow(groupOf(log({ difficulty: CLIMB_GRADE, comment: 'beta' })));
    expect(agrees.container.textContent).not.toContain('mobile.climberLogs.gradedIt');
    agrees.unmount();

    const elsewhere = renderRow(groupOf(log({ angle: 45, difficulty: 18, comment: 'beta' })));
    expect(elsewhere.container.textContent).not.toContain('mobile.climberLogs.gradedIt');
  });

  it('names any grade given at the board angle when the climb grade is unknown', () => {
    const group = groupClimberLogs([log({ difficulty: CLIMB_GRADE })], 40, null)[0];
    const { getByText } = renderRow(group);
    expect(getByText('mobile.climberLogs.gradedIt:{"grade":"grade:16"}')).toBeTruthy();
  });

  it('mentions the angle only when the log is not at the board angle', () => {
    const here = renderRow(groupOf(log({ angle: 40, comment: 'beta' })));
    expect(here.container.textContent).not.toContain('mobile.climberLogs.resultAtAngle');
    expect(here.container.textContent).not.toContain('40');
    here.unmount();

    const elsewhere = renderRow(groupOf(log({ angle: 45, comment: 'beta' })));
    expect(elsewhere.container.textContent).toContain('mobile.climberLogs.resultAtAngle');
    expect(elsewhere.container.textContent).toContain('"angle":45');
  });

  it('never says "no send" for a climber who sent: the send and its time, then their older note', () => {
    relativeTime.calls = [];
    const { container } = renderRow(
      groupOf(
        log({ status: 'attempt', attemptCount: 5, comment: 'Cannot hold the swing', climbedAt: '2026-01-10T18:00:00' }),
        log({ status: 'send', attemptCount: 2, climbedAt: '2026-03-09T18:00:00' }),
      ),
    );
    expect(container.textContent).toContain('mobile.climberLogs.resultSentIn:{"count":2}');
    expect(container.textContent).not.toContain('mobile.climberLogs.resultNoSend');
    expect(container.textContent).toContain('Cannot hold the swing');
    // The time shown is the send's, not the note's.
    expect(relativeTime.calls).toEqual(['2026-03-09T18:00:00']);
    expect(container.textContent).toContain('ago(2026-03-09T18:00:00)');
    expect(container.textContent).not.toContain('ago(2026-01-10T18:00:00)');
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

    it('is a few plain words on the row when it cannot be pressed', () => {
      const { container, getAllByRole } = renderRow(group());
      expect(container.textContent).toContain('mobile.climberLogs.earlierShort:{"count":2}');
      expect(container.textContent).not.toContain('mobile.climberLogs.earlierDetail');
      expect(getAllByRole('button')).toHaveLength(1);
      // Said to a screen reader too: the label replaces the row's own text.
      expect(getAllByRole('button')[0].getAttribute('aria-label')).toContain('mobile.climberLogs.earlierShort');
    });

    it('is hidden when the rows are cut by the cap', () => {
      const pressable = renderRow(group(), { hideEarlier: true, onPressEarlier: vi.fn() });
      expect(pressable.container.textContent).not.toContain('mobile.climberLogs.earlier');
      pressable.unmount();
      expect(renderRow(group(), { hideEarlier: true }).container.textContent).not.toContain(
        'mobile.climberLogs.earlier',
      );
    });

    it('is absent for a climber with one log', () => {
      const { container } = renderRow(groupOf(log()), { onPressEarlier: vi.fn() });
      expect(container.textContent).not.toContain('mobile.climberLogs.earlier');
    });

    it('becomes its own button when a handler is passed, beside the row button', () => {
      const onPressEarlier = vi.fn();
      const { getAllByRole, onPressClimber } = renderRow(group(), { onPressEarlier, earlierExpanded: true });
      const buttons = getAllByRole('button');
      expect(buttons).toHaveLength(2);
      // Siblings, not nested: a button inside a button is unreachable for a screen reader.
      expect(buttons[0].contains(buttons[1])).toBe(false);
      expect(buttons[1].getAttribute('aria-expanded')).toBe('true');
      expect(buttons[1].textContent).toContain('mobile.climberLogs.earlierDetail');
      expect(buttons[1].textContent).toContain('mobile.climberLogs.earlierLogs:{\\"count\\":2}');
      expect(buttons[1].textContent).toContain('mobile.logbook.tries:{\\"count\\":9}');
      expect(buttons[1].textContent).toContain('mobile.climberLogs.earlierDays:{\\"count\\":2}');

      fireEvent.click(buttons[1]);
      expect(onPressEarlier).toHaveBeenCalledWith('mika');
      expect(onPressClimber).not.toHaveBeenCalled();
    });
  });
});

describe('ClimberLogBareRow', () => {
  const ana = () => groupOf(log({ userId: 'ana', userDisplayName: 'ana_p', attemptCount: 2 }));
  const jo = () => groupOf(log({ userId: 'jo', userDisplayName: 'jo_dyno', status: 'flash' }));

  function renderBare(props: Partial<Parameters<typeof ClimberLogBareRow>[0]>) {
    const handlers = { onPressClimber: vi.fn(), onPressEarlier: vi.fn() };
    const view = render(
      createElement(ClimberLogBareRow, {
        groups: [ana()],
        wide: false,
        boardAngle: 40,
        ...handlers,
        ...props,
      }),
    );
    return { ...view, ...handlers };
  }

  it('puts two climbers on one line, each its own labelled button to their profile', () => {
    const { getAllByRole, onPressClimber } = renderBare({ groups: [ana(), jo()] });
    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].contains(buttons[1])).toBe(false);
    expect(buttons[0].getAttribute('aria-label')).toContain('"name":"ana_p"');
    expect(buttons[1].getAttribute('aria-label')).toContain('"name":"jo_dyno"');
    expect(buttons[0].textContent).toContain('mobile.climberLogs.resultSentIn:{"count":2}');
    expect(buttons[0].textContent).toContain('ago(2026-03-10T18:00:00)');
    expect(buttons[1].textContent).toContain('mobile.climberLogs.resultFlash');

    fireEvent.click(buttons[1]);
    expect(onPressClimber).toHaveBeenCalledWith('jo');
  });

  it('says only the tries under the "Tried, no send" heading, and the whole result to a screen reader', () => {
    const trier = groupOf(log({ userId: 'bea', status: 'attempt', attemptCount: 5 }));
    const { getByRole } = renderBare({ groups: [trier], underTriedHeading: true });
    const button = getByRole('button');
    expect(button.textContent).toContain('mobile.logbook.tries:{"count":5}');
    expect(button.textContent).not.toContain('mobile.climberLogs.resultNoSend');
    expect(button.getAttribute('aria-label')).toContain('mobile.climberLogs.resultNoSend');
  });

  it('gives a climber with earlier logs a "+N earlier" button beside the cell, not inside it', () => {
    const withHistory = groupOf(
      log({ userId: 'mj' }),
      log({ userId: 'mj', climbedAt: '2026-01-01T10:00:00' }),
      log({ userId: 'mj', climbedAt: '2026-01-02T10:00:00' }),
    );
    const { getAllByRole, onPressClimber, onPressEarlier } = renderBare({
      groups: [withHistory],
      wide: true,
      earlierExpanded: false,
    });
    const [cell, earlier] = getAllByRole('button');
    expect(cell.contains(earlier)).toBe(false);
    expect(earlier.textContent).toContain('mobile.climberLogs.earlierShort:{"count":2}');
    expect(earlier.getAttribute('aria-label')).toContain('mobile.climberLogs.earlierA11y');
    expect(earlier.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(earlier);
    expect(onPressEarlier).toHaveBeenCalledWith('mj');
    expect(onPressClimber).not.toHaveBeenCalled();
  });

  it('has no earlier button on a plain cell', () => {
    expect(renderBare({ groups: [ana()] }).getAllByRole('button')).toHaveLength(1);
  });
});

describe('ClimberLogEarlierRow', () => {
  it('shows the result, the time and the note of one earlier log, with no mark', () => {
    const earlier = log({ status: 'attempt', attemptCount: 3, comment: 'Barn door on the last move' });
    const { getByText, container } = render(
      createElement(ClimberLogEarlierRow, { log: earlier, boardAngle: 40, climbGradeId: CLIMB_GRADE }),
    );
    expect(container.querySelector('[data-testid^="mark-"]')).toBeNull();
    expect(getByText('mobile.climberLogs.resultNoSend:{"count":3}')).toBeTruthy();
    expect(getByText('Barn door on the last move')).toBeTruthy();
    expect(getByText(`ago(${earlier.climbedAt})`)).toBeTruthy();
  });

  it('says "at 35°" for a log away from the board angle', () => {
    const earlier = log({ angle: 35, attemptCount: 2 });
    const { container } = render(
      createElement(ClimberLogEarlierRow, { log: earlier, boardAngle: 40, climbGradeId: CLIMB_GRADE }),
    );
    expect(container.textContent).toContain('mobile.climberLogs.resultAtAngle');
    expect(container.textContent).toContain('"angle":35');
  });
});

describe('ClimberLogEarlierFoldRow', () => {
  it('counts the folded sends, naming the angle only away from the board angle', () => {
    const here = render(createElement(ClimberLogEarlierFoldRow, { angle: 40, count: 10, boardAngle: 40 }));
    expect(here.getByText('mobile.climberLogs.foldSends:{"count":10}')).toBeTruthy();
    here.unmount();

    const elsewhere = render(createElement(ClimberLogEarlierFoldRow, { angle: 35, count: 6, boardAngle: 40 }));
    expect(elsewhere.getByText('mobile.climberLogs.foldSendsAtAngle:{"count":6,"angle":35}')).toBeTruthy();
  });
});
